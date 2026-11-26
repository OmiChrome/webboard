import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Editor } from './components/Editor';
import { BoardPanel } from './components/BoardPanel';
import { Plotter } from './components/Plotter';
import { BOARDS, compileSketch, loadExamples, warmUpCompiler, wasmSupported, serverUrl, type CompileResult, type Diagnostic, type Example, type Progress } from './lib/compile';
import { parseIntelHex } from './lib/hex';
import { parsePlotLine } from './lib/plot';
import { BLANK_SKETCH, loadCurrentId, loadSketches, newId, saveCurrentId, saveSketches, type Sketch } from './lib/storage';
import type { Transport, TransportKind } from './lib/serial/types';
import { VirtualUno } from './lib/serial/virtual';
import { WebSerialTransport } from './lib/serial/webserial';
import { WebUsbSerial } from './lib/serial/webusb';
import { uploadStk500v1 } from './lib/upload/stk500v1';
import { Icon } from './components/Icon';

type Tab = 'output' | 'monitor' | 'plotter';
type Busy = null | { kind: 'compile'; label: string; fraction?: number } | { kind: 'upload'; phase: string; fraction: number };
type LogLine = { text: string; tone?: 'error' | 'ok' | 'muted' };

const BAUDS = [9600, 19200, 38400, 57600, 115200];
const MAX_LINES = 1500;

const PORT_KINDS: { kind: TransportKind; label: string; supported: () => boolean; hint: string }[] = [
  { kind: 'virtual', label: 'Virtual Uno (simulator)', supported: () => true, hint: 'Runs in the browser, no hardware needed' },
  { kind: 'webserial', label: 'USB serial port (Web Serial)', supported: WebSerialTransport.isSupported, hint: 'Desktop Chrome/Edge, ChromeOS, Android 17+' },
  { kind: 'webusb', label: 'USB device (WebUSB driver)', supported: WebUsbSerial.isSupported, hint: 'Android Chrome: CH340, CP210x, FTDI, CDC boards' },
];

function usePrefersDark() {
  const [dark, setDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const fn = () => setDark(mq.matches);
    mq?.addEventListener('change', fn);
    return () => mq?.removeEventListener('change', fn);
  }, []);
  return dark;
}

export default function App() {
  const dark = usePrefersDark();
  const [examples, setExamples] = useState<Example[]>([]);
  const [sketches, setSketches] = useState<Sketch[]>(() => loadSketches());
  const [currentId, setCurrentId] = useState<string | null>(() => loadCurrentId());
  const [boardId, setBoardId] = useState('uno');
  const [portKind, setPortKind] = useState<TransportKind>('virtual');
  const [connection, setConnection] = useState<{ label: string; kind: TransportKind } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [log, setLog] = useState<LogLine[]>([{ text: 'Welcome to Bitbench. Pick an example, then press Upload.', tone: 'muted' }]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [lastBuild, setLastBuild] = useState<CompileResult | null>(null);
  const [tab, setTab] = useState<Tab>('output');
  const [baud, setBaud] = useState(115200);
  const [monitor, setMonitor] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [lineEnding, setLineEnding] = useState('\n');
  const [autoscroll, setAutoscroll] = useState(true);
  const [drawer, setDrawer] = useState(false);

  const transport = useRef<Transport | null>(null);
  const virtual = useRef<VirtualUno | null>(null);
  const unsub = useRef<(() => void) | null>(null);
  const uploading = useRef(false);
  const lineBuf = useRef('');
  const pendingLines = useRef<string[]>([]);
  const plotSeries = useRef(new Map<string, number[]>());
  const builtFor = useRef<{ source: string; board: string } | null>(null);
  const monitorEnd = useRef<HTMLDivElement>(null);

  const current = sketches.find((s) => s.id === currentId) ?? null;
  const board = BOARDS.find((b) => b.id === boardId)!;

  const appendLog = useCallback((text: string, tone?: LogLine['tone']) => {
    setLog((l) => [...l.slice(-400), ...text.split('\n').filter((t, i, a) => t || i < a.length - 1).map((t) => ({ text: t, tone }))]);
  }, []);

  // ---- examples & sketches -------------------------------------------------
  useEffect(() => {
    loadExamples()
      .then((ex) => {
        setExamples(ex);
        setSketches((list) => {
          if (list.length) return list;
          const blink = ex.find((e) => e.id === 'Blink');
          const first: Sketch = { id: newId(), name: 'Blink', source: blink?.source ?? BLANK_SKETCH, updatedAt: Date.now(), exampleId: 'Blink' };
          setCurrentId(first.id);
          return [first];
        });
      })
      .catch(() => appendLog('Could not load examples.', 'error'));
  }, [appendLog]);

  // Local-first: persist on every change (sketches are small).
  useEffect(() => saveSketches(sketches), [sketches]);

  useEffect(() => {
    if (currentId) saveCurrentId(currentId);
    else if (sketches[0]) setCurrentId(sketches[0].id);
  }, [currentId, sketches]);

  const openExample = (ex: Example) => {
    const existing = sketches.find((s) => s.exampleId === ex.id && s.source === ex.source);
    if (existing) setCurrentId(existing.id);
    else {
      const s: Sketch = { id: newId(), name: ex.title.replace(/\s+/g, ''), source: ex.source, updatedAt: Date.now(), exampleId: ex.id };
      setSketches((l) => [s, ...l]);
      setCurrentId(s.id);
    }
    setDiagnostics([]);
    setDrawer(false);
  };

  const newSketch = () => {
    const n = sketches.filter((s) => s.name.startsWith('sketch')).length + 1;
    const s: Sketch = { id: newId(), name: `sketch${n}`, source: BLANK_SKETCH, updatedAt: Date.now() };
    setSketches((l) => [s, ...l]);
    setCurrentId(s.id);
    setDrawer(false);
  };

  const deleteSketch = (id: string) => {
    setSketches((l) => l.filter((s) => s.id !== id));
    if (id === currentId) setCurrentId(null);
  };

  const renameSketch = (id: string) => {
    const s = sketches.find((x) => x.id === id);
    const name = window.prompt('Rename sketch', s?.name)?.trim();
    if (name) setSketches((l) => l.map((x) => (x.id === id ? { ...x, name } : x)));
  };

  const onEdit = useCallback(
    (source: string) => {
      setSketches((l) => l.map((s) => (s.id === currentId ? { ...s, source, updatedAt: Date.now() } : s)));
    },
    [currentId],
  );

  // ---- serial monitor plumbing ---------------------------------------------
  useEffect(() => {
    const t = setInterval(() => {
      if (!pendingLines.current.length) return;
      const lines = pendingLines.current;
      pendingLines.current = [];
      setMonitor((m) => {
        const next = m.concat(lines);
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    }, 50);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (autoscroll) monitorEnd.current?.scrollIntoView({ block: 'end' });
  }, [monitor, autoscroll]);

  const attach = useCallback((t: Transport) => {
    unsub.current?.();
    const decoder = new TextDecoder();
    unsub.current = t.subscribe((data) => {
      if (uploading.current) return;
      lineBuf.current += decoder.decode(data, { stream: true });
      const parts = lineBuf.current.split('\n');
      lineBuf.current = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.replace(/\r$/, '');
        pendingLines.current.push(line);
        const point = parsePlotLine(line);
        if (point) {
          for (const [k, v] of Object.entries(point)) {
            const arr = plotSeries.current.get(k) ?? [];
            arr.push(v);
            if (arr.length > 300) arr.shift();
            plotSeries.current.set(k, arr);
          }
        }
      }
    });
  }, []);

  const disconnect = useCallback(async () => {
    unsub.current?.();
    unsub.current = null;
    await transport.current?.close().catch(() => {});
    transport.current = null;
    setConnection(null);
  }, []);

  const connect = useCallback(
    async (kind: TransportKind = portKind): Promise<Transport | null> => {
      try {
        await disconnect();
        let t: Transport;
        if (kind === 'virtual') {
          virtual.current ??= new VirtualUno();
          t = virtual.current;
        } else if (kind === 'webserial') {
          t = await WebSerialTransport.request();
        } else {
          t = await WebUsbSerial.request();
        }
        await t.open(baud);
        transport.current = t;
        attach(t);
        setConnection({ label: t.label, kind });
        appendLog(`Connected: ${t.label}`, 'ok');
        return t;
      } catch (e) {
        const msg = (e as Error).message;
        if ((e as Error).name !== 'NotFoundError') appendLog(`Connect failed: ${msg}`, 'error');
        return null;
      }
    },
    [portKind, baud, attach, disconnect, appendLog],
  );

  // Fetch the compiler in the background once the page is idle, so the first
  // Verify/Upload is fast. Cached by the service worker afterwards (offline OK).
  useEffect(() => {
    if (!wasmSupported() || serverUrl()) return;
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const start = () => void warmUpCompiler().catch(() => {});
    const t = idle ? setTimeout(() => idle(start), 2500) : setTimeout(start, 2500);
    return () => clearTimeout(t);
  }, []);

  // Auto-connect the virtual board on first load so the demo just works.
  useEffect(() => {
    void connect('virtual');
    return () => virtual.current?.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- build & upload --------------------------------------------------------
  const verify = useCallback(async (): Promise<CompileResult | null> => {
    if (!current) return null;
    setBusy({ kind: 'compile', label: 'Compiling…' });
    setTab('output');
    appendLog(`Compiling ${current.name}.ino for ${board.name}…`, 'muted');
    const t0 = performance.now();
    try {
      let announced = false;
      const res = await compileSketch(board.id, current.source, {
        onProgress: (p: Progress) => {
          if (p.stage === 'download') {
            if (!announced) {
              announced = true;
              appendLog(`Downloading the in-browser compiler (${((p.total ?? 0) / 1e6).toFixed(1)} MB, first time only)…`, 'muted');
            }
            setBusy({ kind: 'compile', label: `Downloading compiler ${((p.loaded ?? 0) / 1e6).toFixed(1)} / ${((p.total ?? 0) / 1e6).toFixed(1)} MB`, fraction: (p.loaded ?? 0) / (p.total || 1) });
          } else {
            const labels = { compile: 'Compiling…', assemble: 'Assembling…', link: 'Linking…', hex: 'Writing HEX…' } as const;
            setBusy({ kind: 'compile', label: labels[p.stage], fraction: { compile: 0.25, assemble: 0.6, link: 0.75, hex: 0.9 }[p.stage] });
          }
        },
      });
      setDiagnostics(res.diagnostics ?? []);
      appendLog(res.log.trimEnd(), res.ok ? undefined : 'error');
      if (res.ok) {
        const where = res.source === 'wasm' ? 'in your browser' : res.source === 'server' ? 'on the server' : 'from the precompiled example';
        appendLog(`Done compiling ${where} in ${Math.round(performance.now() - t0)} ms${res.cached ? ' (cached)' : ''}.`, 'ok');
        setLastBuild(res);
        builtFor.current = { source: current.source, board: board.id };
      } else {
        appendLog('Compilation failed.', 'error');
        builtFor.current = null;
      }
      return res;
    } catch (e) {
      appendLog((e as Error).message, 'error');
      return null;
    } finally {
      setBusy(null);
    }
  }, [current, board, appendLog]);

  const upload = useCallback(async () => {
    if (!current || busy) return;
    // Pick the port first: browsers only allow the picker right after a click.
    let t = transport.current;
    if (!t || connection?.kind !== portKind) t = await connect(portKind);
    if (!t) return;
    const build =
      builtFor.current?.source === current.source && builtFor.current.board === board.id && lastBuild?.ok ? lastBuild : await verify();
    if (!build?.ok || !build.hex) return;
    const image = parseIntelHex(build.hex).data;
    uploading.current = true;
    setBusy({ kind: 'upload', phase: 'reset', fraction: 0 });
    appendLog(`Uploading ${image.length} bytes to ${t.label} @ ${board.uploadBaud} baud…`, 'muted');
    try {
      await uploadStk500v1(t, image, {
        baudRate: board.uploadBaud,
        signature: board.signature,
        log: (l) => appendLog(l),
        onProgress: (phase, fraction) => setBusy({ kind: 'upload', phase, fraction }),
      });
      appendLog('Upload complete.', 'ok');
      setMonitor([]);
      plotSeries.current.clear();
    } catch (e) {
      appendLog(`Upload failed: ${(e as Error).message}`, 'error');
    } finally {
      await t.setBaudRate(baud).catch(() => {});
      lineBuf.current = '';
      uploading.current = false;
      setBusy(null);
    }
  }, [current, busy, connection, portKind, connect, board, lastBuild, verify, appendLog, baud]);

  const send = async () => {
    const t = transport.current;
    if (!t || !input) return;
    await t.write(new TextEncoder().encode(input + lineEnding));
    setInput('');
  };

  const changeBaud = async (b: number) => {
    setBaud(b);
    await transport.current?.setBaudRate(b).catch(() => {});
  };

  const exportHex = () => {
    if (!lastBuild?.hex || !current) return;
    const url = URL.createObjectURL(new Blob([lastBuild.hex], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${current.name}.ino.hex` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const usage = useMemo(() => {
    if (!lastBuild?.flash_used) return null;
    const max = lastBuild.flash_max ?? 32256;
    return { pct: Math.round((lastBuild.flash_used / max) * 100), used: lastBuild.flash_used, max, ram: lastBuild.ram_used };
  }, [lastBuild]);

  const showBoard = connection?.kind === 'virtual' && virtual.current;

  return (
    <div className={`app ${showBoard ? 'with-board' : ''}`}>
      <header className="topbar">
        <button className="icon-btn only-mobile" aria-label="Sketches" onClick={() => setDrawer((d) => !d)}>
          <Icon name="menu" />
        </button>
        <div className="brand">
          <Icon name="logo" />
          <span>Bitbench</span>
        </div>
        <div className="actions">
          <button className="btn" onClick={verify} disabled={!!busy} title="Verify (Ctrl+R)">
            <Icon name="check" /> <span className="lbl">Verify</span>
          </button>
          <button className="btn primary" onClick={upload} disabled={!!busy} title="Upload (Ctrl+U)" data-testid="upload">
            <Icon name="arrow" /> <span className="lbl">Upload</span>
          </button>
        </div>
        <div className="targets">
          <select aria-label="Board" value={boardId} onChange={(e) => setBoardId(e.target.value)}>
            {BOARDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Connection"
            value={portKind}
            onChange={(e) => {
              const k = e.target.value as TransportKind;
              setPortKind(k);
              if (k === 'virtual') void connect('virtual');
            }}
          >
            {PORT_KINDS.map((p) => (
              <option key={p.kind} value={p.kind} disabled={!p.supported()} title={p.hint}>
                {p.label}
                {p.supported() ? '' : ' — not supported here'}
              </option>
            ))}
          </select>
          {connection && connection.kind === portKind ? (
            <button className="btn ghost" onClick={disconnect} title={connection.label}>
              <span className="dot on" /> <span className="lbl">Disconnect</span>
            </button>
          ) : (
            <button className="btn ghost" onClick={() => connect()}>
              <span className="dot" /> <span className="lbl">Connect</span>
            </button>
          )}
        </div>
        {busy && (
          <div className="progress" role="status" aria-live="polite">
            <span className="progress-label">{busy.kind === 'compile' ? busy.label : `Uploading: ${busy.phase} ${Math.round(busy.fraction * 100)}%`}</span>
            <span className="bar" style={{ '--p': busy.fraction ?? 0.3 } as React.CSSProperties} />
          </div>
        )}
      </header>

      <aside className={`sidebar ${drawer ? 'open' : ''}`}>
        <div className="side-section">
          <div className="side-head">
            <h2>My sketches</h2>
            <button className="icon-btn" aria-label="New sketch" onClick={newSketch} title="New sketch">
              <Icon name="plus" />
            </button>
          </div>
          <ul className="list">
            {sketches.map((s) => (
              <li key={s.id} className={s.id === currentId ? 'active' : ''}>
                <button className="list-item" onClick={() => (setCurrentId(s.id), setDrawer(false), setDiagnostics([]))}>
                  <Icon name="file" />
                  <span>{s.name}.ino</span>
                </button>
                <button className="icon-btn tiny" aria-label={`Rename ${s.name}`} onClick={() => renameSketch(s.id)}>
                  <Icon name="edit" />
                </button>
                <button className="icon-btn tiny" aria-label={`Delete ${s.name}`} onClick={() => deleteSketch(s.id)}>
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="side-section">
          <h2>Examples</h2>
          <ul className="list examples">
            {examples.map((ex) => (
              <li key={ex.id}>
                <button className="list-item ex" onClick={() => openExample(ex)} data-testid={`example-${ex.id}`}>
                  <strong>{ex.title}</strong>
                  <small>{ex.summary}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <details className="side-section settings">
          <summary>Settings &amp; device support</summary>
          <label>
            Compile server URL (optional)
            <input
              placeholder="blank = compile in this browser"
              defaultValue={(() => {
                try {
                  return localStorage.getItem('bitbench.server') ?? '';
                } catch {
                  return '';
                }
              })()}
              onBlur={(e) => {
                try {
                  localStorage.setItem('bitbench.server', e.target.value.trim().replace(/\/$/, ''));
                } catch {
                  /* ignore */
                }
              }}
            />
          </label>
          <ul className="caps">
            <li className={WebSerialTransport.isSupported() ? 'yes' : 'no'}>Web Serial</li>
            <li className={WebUsbSerial.isSupported() ? 'yes' : 'no'}>WebUSB</li>
            <li className={wasmSupported() ? 'yes' : 'no'}>WASM compiler</li>
            <li className={'serviceWorker' in navigator ? 'yes' : 'no'}>Offline (PWA)</li>
          </ul>
        </details>
      </aside>
      {drawer && <div className="scrim only-mobile" onClick={() => setDrawer(false)} />}

      <main className="editor-wrap">
        <div className="tabbar">
          <span className="filename">
            <Icon name="file" /> {current ? `${current.name}.ino` : 'No sketch'}
          </span>
          {errorCount > 0 && <span className="badge error">{errorCount} error{errorCount > 1 ? 's' : ''}</span>}
          {usage && (
            <span className="usage" title={`${usage.used} / ${usage.max} bytes flash, ${usage.ram ?? '?'} bytes RAM`}>
              <span className="meter">
                <span style={{ width: `${Math.max(2, usage.pct)}%` }} />
              </span>
              {usage.pct}% flash
            </span>
          )}
        </div>
        {current && (
          <Editor
            docId={current.id}
            value={current.source}
            onChange={onEdit}
            diagnostics={diagnostics}
            dark={dark}
            onVerify={verify}
            onUpload={upload}
          />
        )}
      </main>

      {showBoard && (
        <aside className="board-wrap">
          <BoardPanel board={virtual.current!} />
        </aside>
      )}

      <section className="panel">
        <div className="panel-tabs" role="tablist">
          {(['output', 'monitor', 'plotter'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'output' ? 'Output' : t === 'monitor' ? 'Serial Monitor' : 'Plotter'}
            </button>
          ))}
          <span className="spacer" />
          {tab === 'output' && lastBuild?.hex && (
            <button className="btn small ghost" onClick={exportHex}>
              Export .hex
            </button>
          )}
          {tab !== 'output' && (
            <>
              <select aria-label="Baud rate" value={baud} onChange={(e) => changeBaud(Number(e.target.value))}>
                {BAUDS.map((b) => (
                  <option key={b} value={b}>
                    {b} baud
                  </option>
                ))}
              </select>
              <button
                className="btn small ghost"
                onClick={() => {
                  setMonitor([]);
                  plotSeries.current.clear();
                }}
              >
                Clear
              </button>
            </>
          )}
          {tab === 'output' && (
            <button className="btn small ghost" onClick={() => setLog([])}>
              Clear
            </button>
          )}
        </div>
        {tab === 'output' && (
          <pre className="log" data-testid="log">
            {log.map((l, i) => (
              <div key={i} className={l.tone}>
                {l.text}
              </div>
            ))}
          </pre>
        )}
        {tab === 'monitor' && (
          <div className="monitor">
            <pre className="log" data-testid="monitor">
              {monitor.length ? monitor.join('\n') : connection ? 'Waiting for data…' : 'Not connected.'}
              <div ref={monitorEnd} />
            </pre>
            <form
              className="send"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <input
                aria-label="Message to send"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={connection ? 'Message to send' : 'Connect a board first'}
                disabled={!connection}
              />
              <select aria-label="Line ending" value={lineEnding} onChange={(e) => setLineEnding(e.target.value)}>
                <option value="">No line ending</option>
                <option value={'\n'}>Newline</option>
                <option value={'\r\n'}>CR + LF</option>
              </select>
              <label className="check">
                <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} /> Autoscroll
              </label>
              <button className="btn small" disabled={!connection}>
                Send
              </button>
            </form>
          </div>
        )}
        {tab === 'plotter' && <Plotter series={plotSeries} />}
      </section>
    </div>
  );
}
