/** Client for the Bitbench compile server, with an offline fallback. */

export interface BoardDef {
  id: string;
  name: string;
  mcu: string;
  uploadBaud: number;
  signature: [number, number, number];
}

export const BOARDS: BoardDef[] = [
  { id: 'uno', name: 'Arduino Uno', mcu: 'atmega328p', uploadBaud: 115200, signature: [0x1e, 0x95, 0x0f] },
  { id: 'nano', name: 'Arduino Nano', mcu: 'atmega328p', uploadBaud: 115200, signature: [0x1e, 0x95, 0x0f] },
  { id: 'nano-old', name: 'Arduino Nano (old bootloader)', mcu: 'atmega328p', uploadBaud: 57600, signature: [0x1e, 0x95, 0x0f] },
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
  source: 'server' | 'offline-example';
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

let examplesPromise: Promise<Example[]> | null = null;
export function loadExamples(): Promise<Example[]> {
  examplesPromise ??= fetch(`${import.meta.env.BASE_URL}examples.json`).then((r) => r.json());
  return examplesPromise;
}

export function serverUrl(): string {
  try {
    return localStorage.getItem('bitbench.server') ?? '';
  } catch {
    return '';
  }
}

export class CompileUnavailableError extends Error {}

export async function compileSketch(board: string, source: string, signal?: AbortSignal): Promise<CompileResult> {
  try {
    const res = await fetch(`${serverUrl()}/api/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ board, source }),
      signal,
    });
    const body = await res.json();
    if (!res.ok && body.error) throw new Error(body.error);
    return { ...body, source: 'server' };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // Offline: an unmodified example can still be flashed from the bundled build.
    const examples = await loadExamples().catch(() => []);
    const ex = examples.find((x) => x.source.trim() === source.trim());
    if (ex && board !== 'nano-old') {
      return {
        ok: true,
        hex: ex.hex,
        log: `Compile server unreachable — using the precompiled build of "${ex.title}".\nSketch uses ${ex.flash_used} bytes of program storage space.\n`,
        diagnostics: [],
        flash_used: ex.flash_used,
        ram_used: ex.ram_used,
        source: 'offline-example',
      };
    }
    throw new CompileUnavailableError(
      `Could not reach the compile server (${(e as Error).message}). Unmodified examples still work offline.`,
    );
  }
}
