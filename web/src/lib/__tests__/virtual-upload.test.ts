import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseIntelHex } from '../hex';
import { VirtualUno } from '../serial/virtual';
import { uploadStk500v1 } from '../upload/stk500v1';

type Example = { id: string; hex: string; source: string };
const examples: Example[] = JSON.parse(readFileSync(new URL('../../../public/examples.json', import.meta.url), 'utf8'));
const hexOf = (id: string) => parseIntelHex(examples.find((e) => e.id === id)!.hex).data;

const boards: VirtualUno[] = [];
function board() {
  const b = new VirtualUno({ autoRun: true });
  boards.push(b);
  return b;
}
afterEach(() => boards.splice(0).forEach((b) => b.dispose()));

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('STK500v1 upload to the virtual Uno', () => {
  it('uploads, verifies and runs Blink (LED on pin 13 toggles)', async () => {
    const b = board();
    const phases: string[] = [];
    const image = hexOf('Blink');
    await uploadStk500v1(b, image, { baudRate: 115200, onProgress: (p) => phases.at(-1) !== p && phases.push(p) });
    expect(phases).toEqual(['reset', 'sync', 'write', 'verify', 'done']);
    expect([...b.flash.subarray(0, image.length)]).toEqual([...image]);
    await until(() => b.state === 'running');
    const seen = new Set<number>();
    await until(() => {
      const s = b.snapshot();
      seen.add(s.duty[13] > 0.5 ? 1 : 0);
      return seen.size === 2;
    }, 3000);
    expect(b.snapshot().output[13]).toBe(true);
  });

  it('runs HelloSerial and streams output to the serial monitor', async () => {
    const b = board();
    let text = '';
    await uploadStk500v1(b, hexOf('HelloSerial'), { baudRate: 115200 });
    b.subscribe((d) => (text += new TextDecoder().decode(d)));
    await until(() => text.includes('tick 1'));
    expect(text).toContain('Hello from Bitbench!');
    expect(text).toMatch(/tick 0 {2}uptime\(ms\)=\d+/);
  });

  it('echoes serial input in uppercase (RX path)', async () => {
    const b = board();
    let text = '';
    await uploadStk500v1(b, hexOf('EchoUppercase'), { baudRate: 115200 });
    b.subscribe((d) => (text += new TextDecoder().decode(d)));
    await until(() => text.includes('Type something'));
    await b.write(new TextEncoder().encode('hi uno\n'));
    await until(() => text.includes('HI UNO'));
  });

  it('runs SerialCommands (String parsing, full Arduino core)', async () => {
    const b = board();
    let text = '';
    await uploadStk500v1(b, hexOf('SerialCommands'), { baudRate: 115200 });
    b.subscribe((d) => (text += new TextDecoder().decode(d)));
    await until(() => text.includes('Commands:'));
    await b.write(new TextEncoder().encode('Blink 2\n'));
    await until(() => text.includes('Blinked 2 times (total 2)'));
  });

  it('produces PWM on pin 9 for Fade', async () => {
    const b = board();
    await uploadStk500v1(b, hexOf('Fade'), { baudRate: 115200 });
    await until(() => b.state === 'running');
    const duties: number[] = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      duties.push(b.snapshot().duty[9]);
    }
    const mid = duties.filter((d) => d > 0.1 && d < 0.9);
    expect(mid.length).toBeGreaterThan(3);
  });

  it('prints garbage when the monitor baud does not match', async () => {
    const b = board();
    await uploadStk500v1(b, hexOf('HelloSerial'), { baudRate: 115200 });
    let text = '';
    await b.setBaudRate(9600);
    b.subscribe((d) => (text += new TextDecoder().decode(d)));
    await b.setSignals({ dtr: false });
    await b.setSignals({ dtr: true });
    await until(() => text.length > 20);
    expect(text).not.toContain('Hello');
  });

  it('fails cleanly on a signature mismatch', async () => {
    const b = board();
    await expect(uploadStk500v1(b, hexOf('Blink'), { baudRate: 115200, signature: [0x1e, 0x98, 0x01] })).rejects.toThrow(/signature/);
  });
});
