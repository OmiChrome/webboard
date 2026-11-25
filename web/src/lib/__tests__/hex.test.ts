import { describe, expect, it } from 'vitest';
import { HexParseError, parseIntelHex, toIntelHex } from '../hex';

describe('Intel HEX', () => {
  it('round-trips binary data', () => {
    const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
    const img = parseIntelHex(toIntelHex(data));
    expect(img.size).toBe(300);
    expect([...img.data]).toEqual([...data]);
  });

  it('handles extended linear address records', () => {
    const hex = ':020000040001F9\n:0400000001020304F2\n:00000001FF\n';
    const img = parseIntelHex(hex, 0x20000);
    expect(img.size).toBe(0x10004);
    expect([...img.data.subarray(0x10000)]).toEqual([1, 2, 3, 4]);
    expect(img.data[0]).toBe(0xff);
  });

  it('rejects bad checksums and missing EOF', () => {
    expect(() => parseIntelHex(':0400000001020304F3\n:00000001FF')).toThrow(HexParseError);
    expect(() => parseIntelHex(':0400000001020304F2\n')).toThrow(/end-of-file/);
  });
});
