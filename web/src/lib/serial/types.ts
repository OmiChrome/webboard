/**
 * A byte-stream connection to a board, independent of how we reach it:
 * Web Serial (desktop), WebUSB + userland driver (Android), or the virtual
 * board (demo / tests).
 */
export type TransportKind = 'webserial' | 'webusb' | 'virtual';

export interface Signals {
  dtr?: boolean;
  rts?: boolean;
}

export type DataListener = (data: Uint8Array) => void;

export interface Transport {
  readonly kind: TransportKind;
  readonly label: string;
  readonly isOpen: boolean;
  open(baudRate: number): Promise<void>;
  close(): Promise<void>;
  setBaudRate(baudRate: number): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  setSignals(signals: Signals): Promise<void>;
  /** Subscribe to incoming bytes. Returns an unsubscribe function. */
  subscribe(fn: DataListener): () => void;
}

/** Shared listener bookkeeping for transports. */
export class Emitter {
  private listeners = new Set<DataListener>();
  subscribe(fn: DataListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(data: Uint8Array) {
    for (const l of this.listeners) l(data);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Buffered reader with timeouts on top of a Transport, used by uploaders. */
export class ByteReader {
  private buf: number[] = [];
  private wake: (() => void) | null = null;
  private unsub: () => void;

  constructor(t: Transport) {
    this.unsub = t.subscribe((d) => {
      for (const b of d) this.buf.push(b);
      this.wake?.();
    });
  }

  drain() {
    this.buf.length = 0;
  }

  async read(n: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      const left = deadline - Date.now();
      if (left <= 0) throw new TimeoutError(`timed out waiting for ${n} byte(s), got ${this.buf.length}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
    return Uint8Array.from(this.buf.splice(0, n));
  }

  dispose() {
    this.unsub();
  }
}

export class TimeoutError extends Error {}
