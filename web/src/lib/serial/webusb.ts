/**
 * USB-to-serial drivers implemented on top of WebUSB.
 *
 * Android Chrome exposes WebUSB but (until Android 17 + Chrome 148) not wired
 * Web Serial, so to talk to an Arduino from a phone we drive the USB-serial
 * chip ourselves, the same way Android apps built on usb-serial-for-android
 * or the Linux kernel drivers do:
 *
 *   - CDC-ACM  : genuine Uno/Mega (ATmega16U2), Leonardo, Nano Every, RP2040, ESP32-S2/S3
 *   - CH340/1  : most clone Uno/Nano boards
 *   - CP210x   : NodeMCU / many ESP32 dev boards
 *   - FTDI     : old Nano, Duemilanove, FTDI cables
 *
 * The protocol constants follow the Linux drivers (cdc-acm.c, ch341.c,
 * cp210x.c, ftdi_sio.c).
 */
import { Emitter, type Signals, type Transport } from './types';

export type ChipFamily = 'cdc' | 'ch34x' | 'cp210x' | 'ftdi';

interface KnownId {
  vendorId: number;
  productId?: number;
  family: ChipFamily;
  name: string;
}

export const KNOWN_DEVICES: KnownId[] = [
  { vendorId: 0x2341, family: 'cdc', name: 'Arduino' },
  { vendorId: 0x2a03, family: 'cdc', name: 'Arduino (.org)' },
  { vendorId: 0x1a86, productId: 0x7523, family: 'ch34x', name: 'CH340' },
  { vendorId: 0x1a86, productId: 0x5523, family: 'ch34x', name: 'CH341' },
  { vendorId: 0x1a86, productId: 0x7522, family: 'ch34x', name: 'CH340K' },
  { vendorId: 0x10c4, productId: 0xea60, family: 'cp210x', name: 'CP2102' },
  { vendorId: 0x10c4, productId: 0xea70, family: 'cp210x', name: 'CP2105' },
  { vendorId: 0x0403, productId: 0x6001, family: 'ftdi', name: 'FT232R' },
  { vendorId: 0x0403, productId: 0x6015, family: 'ftdi', name: 'FT231X' },
  { vendorId: 0x2e8a, family: 'cdc', name: 'Raspberry Pi RP2040' },
  { vendorId: 0x303a, family: 'cdc', name: 'Espressif USB' },
  { vendorId: 0x239a, family: 'cdc', name: 'Adafruit' },
];

export const USB_FILTERS: USBDeviceFilter[] = [
  ...KNOWN_DEVICES.map((d) => (d.productId != null ? { vendorId: d.vendorId, productId: d.productId } : { vendorId: d.vendorId })),
  { classCode: 0x02 }, // any CDC device
];

export function identify(device: Pick<USBDevice, 'vendorId' | 'productId' | 'configuration' | 'configurations'>): KnownId | null {
  const exact = KNOWN_DEVICES.find((d) => d.vendorId === device.vendorId && d.productId === device.productId);
  if (exact) return exact;
  const byVendor = KNOWN_DEVICES.find((d) => d.vendorId === device.vendorId && d.productId == null);
  if (byVendor) return byVendor;
  const cfg = device.configuration ?? device.configurations?.[0];
  const hasCdc = cfg?.interfaces.some((i) => i.alternates.some((a) => a.interfaceClass === 0x02 || a.interfaceClass === 0x0a));
  return hasCdc ? { vendorId: device.vendorId, family: 'cdc', name: 'CDC-ACM' } : null;
}

/** Common plumbing: claims interfaces, pumps the IN endpoint, writes to OUT. */
abstract class UsbSerialBase implements Transport {
  readonly kind = 'webusb' as const;
  protected emitter = new Emitter();
  protected inEp = 0;
  protected outEp = 0;
  protected inPacket = 64;
  protected dataIface = 0;
  protected claimed: number[] = [];
  protected dtr = false;
  protected rts = false;
  private reading = false;
  private _open = false;

  constructor(
    protected device: USBDevice,
    readonly chip: string,
  ) {}

  get label() {
    return `${this.device.productName || this.chip} (${this.chip}, USB)`;
  }
  get isOpen() {
    return this._open;
  }

  protected abstract init(baud: number): Promise<void>;
  abstract setBaudRate(baud: number): Promise<void>;
  protected abstract applySignals(): Promise<void>;

  /** Find bulk endpoints on the given interface. */
  protected pickEndpoints(ifaceNumber: number) {
    const iface = this.device.configuration!.interfaces.find((i) => i.interfaceNumber === ifaceNumber)!;
    const alt = iface.alternate ?? iface.alternates[0];
    for (const ep of alt.endpoints) {
      if (ep.type !== 'bulk') continue;
      if (ep.direction === 'in') {
        this.inEp = ep.endpointNumber;
        this.inPacket = ep.packetSize;
      } else this.outEp = ep.endpointNumber;
    }
    if (!this.inEp || !this.outEp) throw new Error('no bulk endpoints found');
  }

  protected async claim(n: number) {
    try {
      await this.device.claimInterface(n);
    } catch (e) {
      throw new Error(
        `Could not claim USB interface ${n}. On desktop the OS serial driver usually owns it — use "Web Serial" instead. (${(e as Error).message})`,
      );
    }
    this.claimed.push(n);
  }

  async open(baud: number) {
    if (!this.device.opened) await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    await this.init(baud);
    this._open = true;
    this.dtr = true;
    this.rts = true;
    await this.applySignals();
    this.startReading();
  }

  private startReading() {
    this.reading = true;
    const loop = async () => {
      while (this.reading) {
        try {
          const r = await this.device.transferIn(this.inEp, Math.max(this.inPacket, 64));
          if (r.status === 'stall') {
            await this.device.clearHalt('in', this.inEp);
            continue;
          }
          if (r.data && r.data.byteLength) {
            const bytes = this.decodeIn(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
            if (bytes.length) this.emitter.emit(bytes);
          }
        } catch {
          this.reading = false;
        }
      }
    };
    void loop();
  }

  /** Hook for chips that frame their IN data (FTDI). */
  protected decodeIn(bytes: Uint8Array): Uint8Array {
    return bytes.slice();
  }

  async write(data: Uint8Array) {
    await this.device.transferOut(this.outEp, data as BufferSource);
  }

  async setSignals(s: Signals) {
    if (s.dtr !== undefined) this.dtr = s.dtr;
    if (s.rts !== undefined) this.rts = s.rts;
    await this.applySignals();
  }

  async close() {
    this.reading = false;
    this._open = false;
    for (const n of this.claimed) await this.device.releaseInterface(n).catch(() => {});
    this.claimed = [];
    await this.device.close().catch(() => {});
  }

  subscribe(fn: (d: Uint8Array) => void) {
    return this.emitter.subscribe(fn);
  }

  protected ctrlOut(
    recipient: USBRecipient,
    request: number,
    value: number,
    index: number,
    data?: Uint8Array,
    requestType: USBRequestType = 'vendor',
  ) {
    const setup: USBControlTransferParameters = { requestType, recipient, request, value, index };
    return data ? this.device.controlTransferOut(setup, data as BufferSource) : this.device.controlTransferOut(setup);
  }
}

// ---------------------------------------------------------------------------

export class CdcAcmTransport extends UsbSerialBase {
  private commIface = 0;

  protected async init(baud: number) {
    const ifaces = this.device.configuration!.interfaces;
    const cls = (i: USBInterface) => (i.alternate ?? i.alternates[0]).interfaceClass;
    const comm = ifaces.find((i) => cls(i) === 0x02);
    const data = ifaces.find((i) => cls(i) === 0x0a);
    if (!data) throw new Error('no CDC data interface');
    this.commIface = comm?.interfaceNumber ?? data.interfaceNumber;
    this.dataIface = data.interfaceNumber;
    if (comm) await this.claim(comm.interfaceNumber);
    await this.claim(data.interfaceNumber);
    this.pickEndpoints(this.dataIface);
    await this.setBaudRate(baud);
  }

  async setBaudRate(baud: number) {
    // SET_LINE_CODING: dwDTERate (LE u32), bCharFormat=0 (1 stop), bParityType=0, bDataBits=8
    const lc = new Uint8Array([baud & 0xff, (baud >> 8) & 0xff, (baud >> 16) & 0xff, (baud >>> 24) & 0xff, 0, 0, 8]);
    await this.ctrlOut('interface', 0x20, 0, this.commIface, lc, 'class');
  }

  protected async applySignals() {
    // SET_CONTROL_LINE_STATE
    const v = (this.dtr ? 1 : 0) | (this.rts ? 2 : 0);
    await this.ctrlOut('interface', 0x22, v, this.commIface, undefined, 'class');
  }
}

// ---------------------------------------------------------------------------

const CH341_REQ_WRITE_REG = 0x9a;
const CH341_REQ_SERIAL_INIT = 0xa1;
const CH341_REQ_MODEM_CTRL = 0xa4;
const CH341_LCR_ENABLE_RX = 0x80;
const CH341_LCR_ENABLE_TX = 0x40;
const CH341_LCR_CS8 = 0x03;

/** CH341 baud divisor, as computed by Linux ch341.c (ch341_get_divisor, simplified). */
export function ch341Divisor(baud: number): number {
  const BAUDBASE_FACTOR = 1532620800;
  let factor = Math.floor(BAUDBASE_FACTOR / baud);
  let divisor = 3;
  while (factor > 0xfff0 && divisor) {
    factor >>= 3;
    divisor--;
  }
  if (factor > 0xfff0) throw new Error(`baud ${baud} too low for CH34x`);
  factor = 0x10000 - factor;
  // bit 7 of the divisor byte: "no buffering" — required by newer chips.
  return (factor & 0xff00) | divisor | 0x80;
}

export class Ch34xTransport extends UsbSerialBase {
  protected async init(baud: number) {
    await this.claim(0);
    this.pickEndpoints(0);
    await this.ctrlOut('device', CH341_REQ_SERIAL_INIT, 0, 0);
    await this.setBaudRate(baud);
  }

  async setBaudRate(baud: number) {
    await this.ctrlOut('device', CH341_REQ_WRITE_REG, 0x1312, ch341Divisor(baud));
    await this.ctrlOut('device', CH341_REQ_WRITE_REG, 0x2518, CH341_LCR_ENABLE_RX | CH341_LCR_ENABLE_TX | CH341_LCR_CS8);
  }

  protected async applySignals() {
    // Active-low: bit 5 = DTR, bit 6 = RTS.
    const v = ~((this.dtr ? 0x20 : 0) | (this.rts ? 0x40 : 0)) & 0xff;
    await this.ctrlOut('device', CH341_REQ_MODEM_CTRL, v, 0);
  }
}

// ---------------------------------------------------------------------------

const CP210X_IFC_ENABLE = 0x00;
const CP210X_SET_LINE_CTL = 0x03;
const CP210X_SET_MHS = 0x07;
const CP210X_SET_BAUDRATE = 0x1e;

export class Cp210xTransport extends UsbSerialBase {
  protected async init(baud: number) {
    const n = this.device.configuration!.interfaces[0].interfaceNumber;
    this.dataIface = n;
    await this.claim(n);
    this.pickEndpoints(n);
    await this.ctrlOut('interface', CP210X_IFC_ENABLE, 1, n);
    await this.ctrlOut('interface', CP210X_SET_LINE_CTL, 0x0800, n); // 8 data bits, no parity, 1 stop
    await this.setBaudRate(baud);
  }

  async setBaudRate(baud: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, baud, true);
    await this.ctrlOut('interface', CP210X_SET_BAUDRATE, 0, this.dataIface, b);
  }

  protected async applySignals() {
    // Low byte: DTR bit0, RTS bit1. High byte: write masks.
    const v = 0x0300 | (this.dtr ? 1 : 0) | (this.rts ? 2 : 0);
    await this.ctrlOut('interface', CP210X_SET_MHS, v, this.dataIface);
  }
}

// ---------------------------------------------------------------------------

/** FTDI FT232R baud encoding: 3 MHz base clock with 1/8 sub-integer steps. */
export function ftdiBaud(baud: number): { value: number; index: number } {
  const frac = [0, 3, 2, 4, 1, 5, 6, 7];
  const div8 = Math.round((3_000_000 * 8) / baud);
  let int = div8 >> 3;
  const f = frac[div8 & 7];
  if (int === 1 && f === 0) int = 0; // 3 Mbaud special case
  const encoded = int | (f << 14);
  return { value: encoded & 0xffff, index: (encoded >> 16) & 0xffff };
}

export class FtdiTransport extends UsbSerialBase {
  protected async init(baud: number) {
    const n = this.device.configuration!.interfaces[0].interfaceNumber;
    this.dataIface = n;
    await this.claim(n);
    this.pickEndpoints(n);
    await this.ctrlOut('device', 0x00, 0, n + 1); // reset
    await this.ctrlOut('device', 0x04, 0x0008, n + 1); // 8N1
    await this.setBaudRate(baud);
  }

  async setBaudRate(baud: number) {
    const { value, index } = ftdiBaud(baud);
    await this.ctrlOut('device', 0x03, value, (index << 8) | (this.dataIface + 1));
  }

  protected async applySignals() {
    await this.ctrlOut('device', 0x01, 0x0100 | (this.dtr ? 1 : 0), this.dataIface + 1);
    await this.ctrlOut('device', 0x01, 0x0200 | (this.rts ? 2 : 0), this.dataIface + 1);
  }

  /** Every IN packet starts with two modem-status bytes. */
  protected decodeIn(bytes: Uint8Array): Uint8Array {
    const out: number[] = [];
    const pkt = this.inPacket || 64;
    for (let off = 0; off < bytes.length; off += pkt) {
      const end = Math.min(off + pkt, bytes.length);
      for (let i = off + 2; i < end; i++) out.push(bytes[i]);
    }
    return Uint8Array.from(out);
  }
}

// ---------------------------------------------------------------------------

export function transportForDevice(device: USBDevice): Transport {
  const id = identify(device);
  switch (id?.family) {
    case 'ch34x':
      return new Ch34xTransport(device, id.name);
    case 'cp210x':
      return new Cp210xTransport(device, id.name);
    case 'ftdi':
      return new FtdiTransport(device, id.name);
    case 'cdc':
      return new CdcAcmTransport(device, id.name);
    default:
      throw new Error(`Unsupported USB device ${device.vendorId.toString(16)}:${device.productId.toString(16)}`);
  }
}

export const WebUsbSerial = {
  isSupported: () => typeof navigator !== 'undefined' && 'usb' in navigator,
  async request(): Promise<Transport> {
    const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    return transportForDevice(device);
  },
};
