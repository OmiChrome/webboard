/**
 * A simulated Arduino Uno that behaves like the real thing on the wire:
 *
 *  - toggling DTR resets it into an emulated Optiboot bootloader that speaks
 *    STK500v1, so the *real* uploader code is exercised end-to-end;
 *  - after upload (or ~1 s of bootloader silence) it runs the flashed machine
 *    code on avr8js (the open-source AVR simulator that powers Wokwi);
 *  - USART0 is bridged to the serial stream, GPIO/PWM is exposed for the UI,
 *    and A0–A5 can be driven from the UI.
 */
import {
  AVRADC,
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  CPU,
  PinState,
  adcConfig,
  avrInstruction,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
} from 'avr8js';
import { Emitter, type Signals, type Transport } from './types';

const F_CPU = 16_000_000;
const FLASH_SIZE = 32 * 1024;
const BOOTLOADER_START = 0x7e00;
const SIGNATURE = [0x1e, 0x95, 0x0f];

export type BoardState = 'idle' | 'bootloader' | 'running';

export interface PinSnapshot {
  /** Duty cycle 0..1 per Arduino pin D0..D19 over the last frame (0 for inputs). */
  duty: number[];
  /** true where the pin is configured as an output. */
  output: boolean[];
  state: BoardState;
  cycles: number;
}

export interface VirtualUnoOptions {
  /** Drive the simulation from a timer (browser). Tests may advance manually. */
  autoRun?: boolean;
  bootTimeoutMs?: number;
}

export class VirtualUno implements Transport {
  readonly kind = 'virtual' as const;
  readonly label = 'Virtual Uno (simulated)';
  readonly flash = new Uint8Array(FLASH_SIZE).fill(0xff);
  /** Voltages (0–5 V) applied to A0–A5. */
  readonly analogIn = [2.5, 0, 0, 0, 0, 0];

  state: BoardState = 'idle';
  onState: ((s: BoardState) => void) | null = null;

  private emitter = new Emitter();
  private _open = false;
  private baud = 115200;
  private dtr = false;
  private nowMs = 0;
  private bootDeadline = 0;
  private bootTimeout: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastWall = 0;
  private stk = new StkEmulator(this);

  private sim: Simulation | null = null;
  private rxQueue: number[] = [];
  private txBuf: number[] = [];

  constructor(opts: VirtualUnoOptions = {}) {
    this.bootTimeout = opts.bootTimeoutMs ?? 1000;
    if (opts.autoRun ?? true) this.startClock();
  }

  get isOpen() {
    return this._open;
  }

  /** Whether a program is present in flash. */
  get programmed() {
    return this.flash.subarray(0, 16).some((b) => b !== 0xff);
  }

  // ---- Transport ----------------------------------------------------------

  async open(baudRate: number) {
    this.baud = baudRate;
    this._open = true;
    // Opening the port asserts DTR which resets a real Uno.
    this.dtr = true;
    this.reset();
  }

  async close() {
    this._open = false;
    this.dtr = false;
  }

  async setBaudRate(baudRate: number) {
    this.baud = baudRate;
  }

  async write(data: Uint8Array) {
    if (this.state === 'bootloader') {
      for (const b of data) this.stk.feed(b);
    } else if (this.state === 'running') {
      for (const b of data) this.rxQueue.push(b);
    }
  }

  async setSignals(s: Signals) {
    if (s.dtr !== undefined) {
      const rising = s.dtr && !this.dtr;
      this.dtr = s.dtr;
      if (rising) this.reset();
    }
  }

  subscribe(fn: (d: Uint8Array) => void) {
    return this.emitter.subscribe(fn);
  }

  // ---- Board lifecycle ----------------------------------------------------

  reset() {
    this.sim = null;
    this.rxQueue = [];
    this.stk.reset();
    this.setState('bootloader');
    this.bootDeadline = this.nowMs + this.bootTimeout;
  }

  /** Called by the bootloader emulation whenever a valid command arrives. */
  kickBootloader() {
    this.bootDeadline = this.nowMs + this.bootTimeout;
  }

  /** Optiboot leaves via watchdog reset straight into the application. */
  leaveBootloader() {
    this.startApp();
  }

  /** Load a program directly (skipping the bootloader), e.g. for previews. */
  loadProgram(image: Uint8Array) {
    this.flash.fill(0xff);
    this.flash.set(image.subarray(0, BOOTLOADER_START));
    this.startApp();
  }

  respond(bytes: number[]) {
    if (!this._open) return;
    const data = Uint8Array.from(bytes);
    setTimeout(() => this.emitter.emit(data), 0);
  }

  private setState(s: BoardState) {
    this.state = s;
    this.onState?.(s);
  }

  private startApp() {
    if (!this.programmed) {
      this.setState('idle');
      return;
    }
    this.sim = new Simulation(this.flash, this.analogIn, (b) => this.txBuf.push(b));
    this.setState('running');
  }

  // ---- Clock --------------------------------------------------------------

  private startClock() {
    this.lastWall = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(now - this.lastWall, 50);
      this.lastWall = now;
      this.advance(dt);
    }, 10);
  }

  /** Advance simulated time by `ms` milliseconds. */
  advance(ms: number) {
    this.nowMs += ms;
    if (this.state === 'bootloader' && this.nowMs >= this.bootDeadline) this.startApp();
    const sim = this.sim;
    if (sim) {
      sim.run(Math.floor(ms * (F_CPU / 1000)), this.rxQueue);
      this.flushTx(sim.usartBaud);
    }
  }

  private flushTx(sketchBaud: number) {
    if (!this.txBuf.length) return;
    let bytes = this.txBuf;
    this.txBuf = [];
    if (!this._open) return;
    // A real board prints garbage when the monitor baud doesn't match.
    if (sketchBaud && Math.abs(sketchBaud - this.baud) / this.baud > 0.05) {
      bytes = bytes.map((b) => (b * 37 + 0x80) & 0xff);
    }
    this.emitter.emit(Uint8Array.from(bytes));
  }

  snapshot(): PinSnapshot {
    if (!this.sim) return { duty: new Array(20).fill(0), output: new Array(20).fill(false), state: this.state, cycles: 0 };
    return { ...this.sim.sample(), state: this.state };
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sim = null;
  }
}

// ---------------------------------------------------------------------------

/** One running instance of the ATmega328P. */
class Simulation {
  readonly cpu: CPU;
  readonly usart: AVRUSART;
  private ports: AVRIOPort[];
  private adc: AVRADC;
  private level = new Array<number>(20).fill(0);
  private lastEdge = new Array<number>(20).fill(0);
  private highCycles = new Array<number>(20).fill(0);
  private windowStart = 0;

  constructor(flash: Uint8Array, private analogIn: number[], onTx: (b: number) => void) {
    const prog = new Uint16Array(FLASH_SIZE / 2);
    for (let i = 0; i < prog.length; i++) prog[i] = flash[2 * i] | (flash[2 * i + 1] << 8);
    this.cpu = new CPU(prog);
    new AVRTimer(this.cpu, timer0Config);
    new AVRTimer(this.cpu, timer1Config);
    new AVRTimer(this.cpu, timer2Config);
    this.usart = new AVRUSART(this.cpu, usart0Config, F_CPU);
    this.usart.onByteTransmit = onTx;
    this.adc = new AVRADC(this.cpu, adcConfig);
    const portB = new AVRIOPort(this.cpu, portBConfig);
    const portC = new AVRIOPort(this.cpu, portCConfig);
    const portD = new AVRIOPort(this.cpu, portDConfig);
    this.ports = [portD, portB, portC];
    // Arduino pin numbering: D0-7 = PORTD, D8-13 = PORTB0-5, A0-5 (14-19) = PORTC0-5.
    const offsets = [0, 8, 14];
    this.ports.forEach((port, idx) => {
      port.addListener((value, old) => {
        const changed = value ^ old;
        for (let bit = 0; bit < 8; bit++) {
          if (!(changed & (1 << bit))) continue;
          const pin = offsets[idx] + bit;
          if (pin >= 20) continue;
          this.edge(pin, (value >> bit) & 1);
        }
      });
    });
  }

  get usartBaud() {
    return this.usart.txEnable ? this.usart.baudRate : 0;
  }

  private edge(pin: number, v: number) {
    const now = this.cpu.cycles;
    if (this.level[pin]) this.highCycles[pin] += now - this.lastEdge[pin];
    this.level[pin] = v;
    this.lastEdge[pin] = now;
  }

  run(cycles: number, rx: number[]) {
    for (let i = 0; i < 6; i++) this.adc.channelValues[i] = this.analogIn[i];
    const cpu = this.cpu;
    const end = cpu.cycles + cycles;
    while (cpu.cycles < end) {
      if (rx.length && this.usart.rxEnable && !this.usart.rxBusy) this.usart.writeByte(rx.shift()!);
      for (let k = 0; k < 1000 && cpu.cycles < end; k++) {
        avrInstruction(cpu);
        cpu.tick();
      }
    }
  }

  sample(): Omit<PinSnapshot, 'state'> {
    const now = this.cpu.cycles;
    const span = Math.max(1, now - this.windowStart);
    const duty: number[] = [];
    const output: boolean[] = [];
    const offsets = [0, 8, 14];
    for (let pin = 0; pin < 20; pin++) {
      const portIdx = pin < 8 ? 0 : pin < 14 ? 1 : 2;
      const st = this.ports[portIdx].pinState(pin - offsets[portIdx]);
      const isOut = st === PinState.High || st === PinState.Low;
      let high = this.highCycles[pin];
      if (this.level[pin]) high += now - Math.max(this.lastEdge[pin], this.windowStart);
      duty.push(isOut ? Math.min(1, high / span) : 0);
      output.push(isOut);
      this.highCycles[pin] = 0;
      if (this.level[pin]) this.lastEdge[pin] = now;
    }
    this.windowStart = now;
    return { duty, output, cycles: now };
  }
}

// ---------------------------------------------------------------------------

/** Byte-level emulation of Optiboot's STK500v1 command set. */
class StkEmulator {
  private buf: number[] = [];
  private address = 0; // byte address

  constructor(private board: VirtualUno) {}

  reset() {
    this.buf = [];
    this.address = 0;
  }

  private expectedLength(): number | null {
    const b = this.buf;
    switch (b[0]) {
      case 0x30: // GET_SYNC
      case 0x50: // ENTER_PROGMODE
      case 0x51: // LEAVE_PROGMODE
      case 0x75: // READ_SIGN
        return 2;
      case 0x41: // GET_PARAMETER
        return 3;
      case 0x55: // LOAD_ADDRESS
        return 4;
      case 0x56: // UNIVERSAL
        return 6;
      case 0x74: // READ_PAGE
        return 5;
      case 0x45: // SET_DEVICE_EXT
        return 7;
      case 0x42: // SET_DEVICE
        return 22;
      case 0x64: // PROG_PAGE: cmd, sizeHi, sizeLo, memtype, data..., EOP
        if (b.length < 3) return null;
        return 5 + ((b[1] << 8) | b[2]);
      default:
        return 1;
    }
  }

  feed(byte: number) {
    this.buf.push(byte);
    const need = this.expectedLength();
    if (need === null || this.buf.length < need) return;
    const cmd = this.buf.splice(0, need);
    if (cmd.length === 1 || cmd[cmd.length - 1] !== 0x20) {
      this.board.respond([0x15]); // STK_NOSYNC
      return;
    }
    this.board.kickBootloader();
    this.handle(cmd);
  }

  private handle(c: number[]) {
    const ok = (...data: number[]) => this.board.respond([0x14, ...data, 0x10]);
    switch (c[0]) {
      case 0x30:
      case 0x42:
      case 0x45:
      case 0x50:
        return ok();
      case 0x41: {
        const p = c[1];
        return ok(p === 0x81 ? 8 : p === 0x82 ? 3 : 0x03);
      }
      case 0x55:
        this.address = ((c[2] << 8) | c[1]) * 2;
        return ok();
      case 0x56:
        return ok(0x00);
      case 0x64: {
        const size = (c[1] << 8) | c[2];
        const data = c.slice(4, 4 + size);
        if (c[3] === 0x46 && this.address + size <= BOOTLOADER_START) {
          this.board.flash.set(data, this.address);
        }
        return ok();
      }
      case 0x74: {
        const size = (c[1] << 8) | c[2];
        const out = Array.from(this.board.flash.subarray(this.address, this.address + size));
        return ok(...out);
      }
      case 0x75:
        return ok(...SIGNATURE);
      case 0x51:
        ok();
        setTimeout(() => this.board.leaveBootloader(), 5);
        return;
    }
  }
}
