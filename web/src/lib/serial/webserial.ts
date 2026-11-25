import { Emitter, type Signals, type Transport } from './types';

/** Web Serial API transport (Chrome/Edge desktop, ChromeOS, Android 17+ Chrome 148+). */
export class WebSerialTransport implements Transport {
  readonly kind = 'webserial' as const;
  private emitter = new Emitter();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private pump: Promise<void> | null = null;
  private baud = 115200;
  private _open = false;

  constructor(private port: SerialPort) {}

  static isSupported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  static async request(): Promise<WebSerialTransport> {
    const port = await navigator.serial.requestPort({});
    return new WebSerialTransport(port);
  }

  get label() {
    const info = this.port.getInfo();
    if (info.usbVendorId != null) {
      return `Serial ${hex4(info.usbVendorId)}:${hex4(info.usbProductId ?? 0)}`;
    }
    return 'Serial port';
  }

  get isOpen() {
    return this._open;
  }

  async open(baudRate: number) {
    if (this._open) await this.close();
    this.baud = baudRate;
    await this.port.open({ baudRate, bufferSize: 4096 });
    this._open = true;
    this.startPump();
  }

  private startPump() {
    const readable = this.port.readable;
    if (!readable) return;
    const reader = readable.getReader();
    this.reader = reader;
    this.pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) this.emitter.emit(value);
        }
      } catch {
        /* port lost / closed */
      } finally {
        reader.releaseLock();
      }
    })();
  }

  async close() {
    if (!this._open) return;
    this._open = false;
    try {
      await this.reader?.cancel();
      await this.pump;
    } catch {
      /* ignore */
    }
    this.reader = null;
    await this.port.close().catch(() => {});
  }

  async setBaudRate(baudRate: number) {
    if (baudRate === this.baud && this._open) return;
    // Web Serial cannot change baud on an open port: reopen.
    await this.close();
    await this.open(baudRate);
  }

  async write(data: Uint8Array) {
    const writer = this.port.writable!.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  async setSignals(s: Signals) {
    await this.port.setSignals({
      ...(s.dtr !== undefined && { dataTerminalReady: s.dtr }),
      ...(s.rts !== undefined && { requestToSend: s.rts }),
    });
  }

  subscribe(fn: (d: Uint8Array) => void) {
    return this.emitter.subscribe(fn);
  }
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0');
