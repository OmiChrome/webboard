import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { cpp } from '@codemirror/lang-cpp';
import { oneDark } from '@codemirror/theme-one-dark';
import { setDiagnostics, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { Diagnostic } from '../lib/compile';

interface Props {
  docId: string;
  value: string;
  onChange: (v: string) => void;
  diagnostics: Diagnostic[];
  dark: boolean;
  onVerify: () => void;
  onUpload: () => void;
}

const lightTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--text-3)', border: 'none' },
  '.cm-activeLineGutter, .cm-activeLine': { backgroundColor: 'var(--active-line)' },
});

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { paddingBottom: '40vh' },
});

export function Editor({ docId, value, onChange, diagnostics, dark, onVerify, onUpload }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const cbs = useRef({ onChange, onVerify, onUpload });
  cbs.current = { onChange, onVerify, onUpload };

  // (Re)create the editor when a different sketch is opened.
  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        cpp(),
        lintGutter(),
        baseTheme,
        themeComp.current.of(dark ? oneDark : lightTheme),
        keymap.of([
          indentWithTab,
          { key: 'Mod-r', preventDefault: true, run: () => (cbs.current.onVerify(), true) },
          { key: 'Mod-u', preventDefault: true, run: () => (cbs.current.onUpload(), true) },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cbs.current.onChange(u.state.doc.toString());
        }),
        EditorView.contentAttributes.of({ 'aria-label': 'Sketch editor' }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  useEffect(() => {
    view.current?.dispatch({ effects: themeComp.current.reconfigure(dark ? oneDark : lightTheme) });
  }, [dark]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const ds: CmDiagnostic[] = diagnostics
      .filter((d) => d.severity !== 'note' && d.line >= 1 && d.line <= doc.lines)
      .map((d) => {
        const line = doc.line(d.line);
        const from = Math.min(line.from + Math.max(0, d.column - 1), line.to);
        return { from, to: Math.max(from, line.to), severity: d.severity === 'error' ? 'error' : 'warning', message: d.message };
      });
    v.dispatch(setDiagnostics(v.state, ds));
  }, [diagnostics]);

  return <div className="editor" ref={host} />;
}
