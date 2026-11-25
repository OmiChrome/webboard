/**
 * STK500v1 uploader — the protocol spoken by Optiboot (Uno, Nano, Pro Mini)
 * and the classic ATmegaBOOT. Equivalent to `avrdude -c arduino`.
 */
import { ByteReader, sleep, TimeoutError, type Transport } from '../serial/types';

const STK = {
  OK: 0x10,
  INSYNC: 0x14,
  CRC_EOP: 0x20,
  GET_SYNC: 0x30,
  GET_PARAMETER: 0x41,
  SET_DEVICE: 0x42,
  ENTER_PROGMODE: 0x50,
  LEAVE_PROGMODE: 0x51,
  LOAD_ADDRESS: 0x55,
  UNIVERSAL: 0x56,
  PROG_PAGE: 0x64,
  READ_PAGE: 0x74,
  READ_SIGN: 0x75,
} as const;

export interface UploadOptions {
  baudRate: number;
  pageSize?: number;
  signature?: [number, number, number];
  verify?: boolean;
  onProgress?: (phase: 'reset' | 'sync' | 'write' | 'verify' | 'done', fraction: number) => void;
  log?: (line: string) => void;
}

export class UploadError extends Error {}

export async function uploadStk500v1(t: Transport, image: Uint8Array, opts: UploadOptions) {
  const pageSize = opts.pageSize ?? 128;
  const signature = opts.signature ?? [0x1e, 0x95, 0x0f]; // ATmega328P
  const log = opts.log ?? (() => {});
  const progress = opts.onProgress ?? (() => {});

  if (!t.isOpen) await t.open(opts.baudRate);
  else await t.setBaudRate(opts.baudRate);

  const rd = new ByteReader(t);
  try {
    // Auto-reset: pulse DTR/RTS like avrdude's arduino programmer.
    progress('reset', 0);
    log('Resetting board (DTR/RTS pulse)…');
    await t.setSignals({ dtr: false, rts: false });
    await sleep(250);
    await t.setSignals({ dtr: true, rts: true });
    await sleep(50);
    rd.drain();

    progress('sync', 0);
    let synced = false;
    for (let attempt = 0; attempt < 10 && !synced; attempt++) {
      await t.write(Uint8Array.of(STK.GET_SYNC, STK.CRC_EOP));
      try {
        await expectOk(rd, 200);
        synced = true;
      } catch {
        rd.drain();
      }
    }
    if (!synced) throw new UploadError('Board did not respond (no STK500 sync). Check the board type, port and that nothing else holds the port.');
    rd.drain();
    log('In sync with bootloader.');

    await cmd(t, rd, [STK.READ_SIGN]);
    const sig = await rd.read(3, 500);
    await expectByte(rd, STK.OK, 500);
    log(`Device signature: ${[...sig].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' ')}`);
    if (sig[0] !== signature[0] || sig[1] !== signature[1] || sig[2] !== signature[2]) {
      throw new UploadError('Device signature mismatch — wrong board selected?');
    }

    await cmd(t, rd, [STK.ENTER_PROGMODE]);
    await expectByte(rd, STK.OK, 500);

    const pages = Math.ceil(image.length / pageSize);
    for (let p = 0; p < pages; p++) {
      const addr = p * pageSize;
      const chunk = new Uint8Array(pageSize).fill(0xff);
      chunk.set(image.subarray(addr, addr + pageSize));
      await loadAddress(t, rd, addr);
      await cmd(t, rd, [STK.PROG_PAGE, (pageSize >> 8) & 0xff, pageSize & 0xff, 0x46, ...chunk]);
      await expectByte(rd, STK.OK, 1000);
      progress('write', (p + 1) / pages);
    }
    log(`Wrote ${image.length} bytes in ${pages} pages.`);

    if (opts.verify !== false) {
      for (let p = 0; p < pages; p++) {
        const addr = p * pageSize;
        await loadAddress(t, rd, addr);
        await cmd(t, rd, [STK.READ_PAGE, (pageSize >> 8) & 0xff, pageSize & 0xff, 0x46]);
        const got = await rd.read(pageSize, 1000);
        await expectByte(rd, STK.OK, 500);
        const want = image.subarray(addr, addr + pageSize);
        for (let i = 0; i < want.length; i++) {
          if (got[i] !== want[i]) throw new UploadError(`Verify failed at 0x${(addr + i).toString(16)}`);
        }
        progress('verify', (p + 1) / pages);
      }
      log('Verified OK.');
    }

    await cmd(t, rd, [STK.LEAVE_PROGMODE]);
    await expectByte(rd, STK.OK, 500);
    progress('done', 1);
    log('Done — sketch is running.');
  } catch (e) {
    if (e instanceof TimeoutError) throw new UploadError(`Upload timed out: ${e.message}`);
    throw e;
  } finally {
    rd.dispose();
  }
}

async function cmd(t: Transport, rd: ByteReader, bytes: number[]) {
  await t.write(Uint8Array.from([...bytes, STK.CRC_EOP]));
  await expectByte(rd, STK.INSYNC, 1000);
}

async function loadAddress(t: Transport, rd: ByteReader, byteAddr: number) {
  const word = byteAddr >> 1;
  await cmd(t, rd, [STK.LOAD_ADDRESS, word & 0xff, (word >> 8) & 0xff]);
  await expectByte(rd, STK.OK, 500);
}

async function expectByte(rd: ByteReader, value: number, timeout: number) {
  const [b] = await rd.read(1, timeout);
  if (b !== value) throw new UploadError(`Protocol error: expected 0x${value.toString(16)}, got 0x${b.toString(16)}`);
}

async function expectOk(rd: ByteReader, timeout: number) {
  await expectByte(rd, STK.INSYNC, timeout);
  await expectByte(rd, STK.OK, timeout);
}

export { STK };
