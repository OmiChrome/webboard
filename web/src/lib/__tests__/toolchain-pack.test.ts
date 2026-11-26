import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { unpack } from '../wasm/toolchain';

const dir = new URL('../../../public/toolchain/', import.meta.url);
const built = existsSync(new URL('sysroot.pack.gz', dir));

describe.skipIf(!built)('prepared toolchain bundle', () => {
  const files = built ? unpack(gunzipSync(readFileSync(new URL('sysroot.pack.gz', dir)))) : new Map();
  it('contains everything the browser build needs', () => {
    for (const p of ['/arduino/core/Arduino.h', '/arduino/variant/pins_arduino.h', '/sysroot/avr/include/avr/io.h',
      '/sysroot/avr/include/avr/iom328p.h', '/libs/crtatmega328p.o', '/libs/libarduino.a', '/libs/libc.a', '/ldscripts/avr5.xn']) {
      expect(files.has(p), p).toBe(true);
    }
  });
  it('is pruned to the ATmega328P', () => {
    expect(files.has('/sysroot/avr/include/avr/iom2560.h')).toBe(false);
    const total = [...files.values()].reduce((a, b) => a + b.length, 0);
    expect(total).toBeLessThan(8e6);
  });
  it('archive has a symbol index so ld only pulls what a sketch uses', () => {
    const a = files.get('/libs/libarduino.a')!;
    expect(new TextDecoder().decode(a.subarray(0, 8))).toBe('!<arch>\n');
    expect(new TextDecoder().decode(a.subarray(8, 9))).toBe('/');
  });
});
