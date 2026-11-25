import { describe, expect, it } from 'vitest';
import { Ch34xTransport, CdcAcmTransport, ch341Divisor, ftdiBaud, identify, transportForDevice, Cp210xTransport, FtdiTransport } from '../serial/webusb';

/** Minimal fake USBDevice that records control transfers and echoes bulk OUT to IN. */
function fakeDevice(opts: { vendorId: number; productId: number; ifaces: { n: number; cls: number; eps?: boolean }[] }) {
  const controls: { setup: USBControlTransferParameters; data?: number[] }[] = [];
  const pendingIn: Uint8Array[] = [];
  let waiter: (() => void) | null = null;
  const interfaces = opts.ifaces.map((i) => {
    const alt = {
      interfaceClass: i.cls,
      endpoints: i.eps === false ? [] : [
        { endpointNumber: 2, direction: 'in', type: 'bulk', packetSize: 64 },
        { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 64 },
      ],
    };
    return { interfaceNumber: i.n, alternate: alt, alternates: [alt] };
  });
  const device = {
    vendorId: opts.vendorId,
    productId: opts.productId,
    productName: 'Fake',
    opened: false,
    configuration: { interfaces },
    configurations: [{ interfaces }],
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    async selectConfiguration() {},
    async claimInterface() {},
    async releaseInterface() {},
    async clearHalt() {},
    async controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource) {
      controls.push({ setup, data: data ? [...new Uint8Array(data as ArrayBuffer)] : undefined });
      return { status: 'ok', bytesWritten: 0 };
    },
    async transferOut(_ep: number, data: BufferSource) {
      pendingIn.push(new Uint8Array(data as ArrayBuffer).slice());
      waiter?.();
      return { status: 'ok', bytesWritten: 0 };
    },
    async transferIn() {
      while (!pendingIn.length) await new Promise<void>((r) => (waiter = r));
      const d = pendingIn.shift()!;
      return { status: 'ok', data: new DataView(d.buffer) };
    },
  };
  return { device: device as unknown as USBDevice, controls };
}

describe('device identification', () => {
  it('maps VID/PID to chip families', () => {
    const ch = fakeDevice({ vendorId: 0x1a86, productId: 0x7523, ifaces: [{ n: 0, cls: 0xff }] });
    expect(identify(ch.device)?.family).toBe('ch34x');
    expect(transportForDevice(ch.device)).toBeInstanceOf(Ch34xTransport);
    const uno = fakeDevice({ vendorId: 0x2341, productId: 0x0043, ifaces: [{ n: 0, cls: 2, eps: false }, { n: 1, cls: 0x0a }] });
    expect(transportForDevice(uno.device)).toBeInstanceOf(CdcAcmTransport);
    expect(transportForDevice(fakeDevice({ vendorId: 0x10c4, productId: 0xea60, ifaces: [{ n: 0, cls: 0xff }] }).device)).toBeInstanceOf(Cp210xTransport);
    expect(transportForDevice(fakeDevice({ vendorId: 0x0403, productId: 0x6001, ifaces: [{ n: 0, cls: 0xff }] }).device)).toBeInstanceOf(FtdiTransport);
    const generic = fakeDevice({ vendorId: 0x1234, productId: 0x1, ifaces: [{ n: 0, cls: 2, eps: false }, { n: 1, cls: 0x0a }] });
    expect(identify(generic.device)?.family).toBe('cdc');
  });
});

describe('baud encodings', () => {
  it('computes CH341 divisors matching the Linux driver', () => {
    // Values from Linux ch341.c for common rates (with bit 7 "no buffering").
    expect(ch341Divisor(115200).toString(16)).toBe('cc83');
    expect(ch341Divisor(57600).toString(16)).toBe('9883');
    expect(ch341Divisor(9600).toString(16)).toBe('b282');
  });
  it('computes FTDI divisors', () => {
    expect(ftdiBaud(9600)).toEqual({ value: 0x4138, index: 0 });
    expect(ftdiBaud(115200)).toEqual({ value: 0x001a, index: 0 });
  });
});

describe('CH340 driver', () => {
  it('initialises the chip and toggles DTR/RTS (active low)', async () => {
    const { device, controls } = fakeDevice({ vendorId: 0x1a86, productId: 0x7523, ifaces: [{ n: 0, cls: 0xff }] });
    const t = new Ch34xTransport(device, 'CH340');
    await t.open(115200);
    const reqs = controls.map((c) => [c.setup.request, c.setup.value, c.setup.index]);
    expect(reqs).toContainEqual([0xa1, 0, 0]);
    expect(reqs).toContainEqual([0x9a, 0x1312, 0xcc83]);
    expect(reqs).toContainEqual([0x9a, 0x2518, 0xc3]);
    expect(reqs.at(-1)).toEqual([0xa4, 0x9f, 0]); // DTR+RTS asserted
    await t.setSignals({ dtr: false, rts: false });
    expect(controls.at(-1)!.setup.value).toBe(0xff);
    await t.close();
  });

  it('streams bytes in both directions', async () => {
    const { device } = fakeDevice({ vendorId: 0x1a86, productId: 0x7523, ifaces: [{ n: 0, cls: 0xff }] });
    const t = new Ch34xTransport(device, 'CH340');
    await t.open(9600);
    const got = new Promise<number[]>((r) => t.subscribe((d) => r([...d])));
    await t.write(Uint8Array.of(1, 2, 3));
    expect(await got).toEqual([1, 2, 3]);
    await t.close();
  });
});

describe('CDC-ACM driver', () => {
  it('sends SET_LINE_CODING and SET_CONTROL_LINE_STATE to the comm interface', async () => {
    const { device, controls } = fakeDevice({ vendorId: 0x2341, productId: 0x43, ifaces: [{ n: 0, cls: 2, eps: false }, { n: 1, cls: 0x0a }] });
    const t = new CdcAcmTransport(device, 'Arduino');
    await t.open(115200);
    const lc = controls.find((c) => c.setup.request === 0x20)!;
    expect(lc.setup.requestType).toBe('class');
    expect(lc.data).toEqual([0x00, 0xc2, 0x01, 0x00, 0, 0, 8]);
    expect(controls.at(-1)!.setup).toMatchObject({ request: 0x22, value: 3, index: 0 });
    await t.close();
  });
});

describe('FTDI driver', () => {
  it('strips the two status bytes from each IN packet', () => {
    const t = new FtdiTransport(fakeDevice({ vendorId: 0x0403, productId: 0x6001, ifaces: [{ n: 0, cls: 0xff }] }).device, 'FT232R');
    const out = (t as unknown as { decodeIn(b: Uint8Array): Uint8Array }).decodeIn(Uint8Array.of(0x31, 0x60, 65, 66));
    expect([...out]).toEqual([65, 66]);
  });
});
