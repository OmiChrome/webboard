/**
 * Compiling sketches. By default everything happens in the browser with the
 * WebAssembly toolchain (see ./wasm/toolchain.ts) — no server, no install.
 * Optionally a self-hosted compile server (../../server) can be configured in
 * Settings, e.g. for slower devices.
 */
import type { Progress, ToolchainResult } from './wasm/toolchain';

export interface BoardDef {
  id: string;
  name: string;
  mcu: string;
  define: string;
  uploadBaud: number;
  signature: [number, number, number];
}

export const BOARDS: BoardDef[] = [
  { id: 'uno', name: 'Arduino Uno', mcu: 'atmega328p', define: 'ARDUINO_AVR_UNO', uploadBaud: 115200, signature: [0x1e, 0x95, 0x0f] },
  { id: 'nano', name: 'Arduino Nano', mcu: 'atmega328p', define: 'ARDUINO_AVR_NANO', uploadBaud: 115200, signature: [0x1e, 0x95, 0x0f] },
  { id: 'nano-old', name: 'Arduino Nano (old bootloader)', mcu: 'atmega328p', define: 'ARDUINO_AVR_NANO', uploadBaud: 57600, signature: [0x1e, 0x95, 0x0f] },
];

export interface Diagnostic {
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
}

export interface CompileResult {
  ok: boolean;
  hex?: string;
  log: string;
  diagnostics: Diagnostic[];
  flash_used?: number;
  flash_max?: number;
  ram_used?: number;
  ram_max?: number;
  cached?: boolean;
  timings?: Record<string, number>;
  source: 'wasm' | 'server' | 'offline-example';
}

export interface Example {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  source: string;
  hex: string;
  flash_used: number;
  ram_used: number;
}

export type { Progress };

const BASE = import.meta.env.BASE_URL;

let examplesPromise: Promise<Example[]> | null = null;
export function loadExamples(): Promise<Example[]> {
  examplesPromise ??= fetch(`${BASE}examples.json`).then((r) => r.json());
  return examplesPromise;
}

export function serverUrl(): string {
  try {
    return localStorage.getItem('bitbench.server') ?? '';
  } catch {
    return '';
  }
}

// ---- in-browser compiler (Web Worker) ------------------------------------

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: ToolchainResult | null) => void; reject: (e: Error) => void; onProgress?: (p: Progress) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./wasm/compiler.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data as { id: number; type: string; progress?: Progress; result?: ToolchainResult; error?: string };
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') p.onProgress?.(msg.progress!);
    else {
      pending.delete(msg.id);
      if (msg.type === 'done') p.resolve(msg.result ?? null);
      else p.reject(new Error(msg.error));
    }
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'compiler worker crashed'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function callWorker(msg: Record<string, unknown>, onProgress?: (p: Progress) => void) {
  const id = nextId++;
  return new Promise<ToolchainResult | null>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ ...msg, id, base: new URL(`${BASE}toolchain/`, location.href).href });
  });
}

/** Start downloading the compiler in the background (e.g. when the browser is idle). */
export function warmUpCompiler(onProgress?: (p: Progress) => void) {
  return callWorker({ type: 'warmup' }, onProgress);
}

export const wasmSupported = () =>
  typeof WebAssembly === 'object' && typeof Worker === 'function' && typeof DecompressionStream === 'function';

export class CompileUnavailableError extends Error {}

export async function compileSketch(
  boardId: string,
  source: string,
  opts: { onProgress?: (p: Progress) => void; signal?: AbortSignal } = {},
): Promise<CompileResult> {
  const board = BOARDS.find((b) => b.id === boardId)!;
  const server = serverUrl();
  try {
    if (server) {
      const res = await fetch(`${server}/api/compile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ board: boardId, source }),
        signal: opts.signal,
      });
      const body = await res.json();
      if (!res.ok && body.error) throw new Error(body.error);
      return { ...body, source: 'server' };
    }
    if (!wasmSupported()) throw new Error('this browser lacks WebAssembly workers');
    const r = (await callWorker({ type: 'compile', source, define: board.define }, opts.onProgress))!;
    return { ...r, source: 'wasm' };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // Last resort: an unmodified example can still be flashed from the bundled build.
    const examples = await loadExamples().catch(() => []);
    const ex = examples.find((x) => x.source.trim() === source.trim());
    if (ex && board.uploadBaud === 115200) {
      return {
        ok: true,
        hex: ex.hex,
        log: `Compiler unavailable (${(e as Error).message}) — using the precompiled build of "${ex.title}".\nSketch uses ${ex.flash_used} bytes of program storage space.\n`,
        diagnostics: [],
        flash_used: ex.flash_used,
        ram_used: ex.ram_used,
        source: 'offline-example',
      };
    }
    throw new CompileUnavailableError(`Compiler unavailable: ${(e as Error).message}`);
  }
}
