/** Intel HEX parsing (record types 00, 01, 02, 04). */

export interface FirmwareImage {
  /** Flat binary starting at address 0, padded with 0xFF. */
  data: Uint8Array;
  /** Number of bytes from 0 to the highest written address. */
  size: number;
}

export class HexParseError extends Error {}

export function parseIntelHex(text: string, maxSize = 1 << 20): FirmwareImage {
  const buf = new Uint8Array(maxSize).fill(0xff);
  let base = 0;
  let size = 0;
  let sawEof = false;
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line) continue;
    if (line[0] !== ':') throw new HexParseError(`line ${ln + 1}: missing ':'`);
    const bytes = hexToBytes(line.slice(1), ln + 1);
    if (bytes.length < 5) throw new HexParseError(`line ${ln + 1}: record too short`);
    const len = bytes[0];
    if (bytes.length !== len + 5) throw new HexParseError(`line ${ln + 1}: length mismatch`);
    const sum = bytes.reduce((a, b) => (a + b) & 0xff, 0);
    if (sum !== 0) throw new HexParseError(`line ${ln + 1}: bad checksum`);
    const addr = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const payload = bytes.subarray(4, 4 + len);
    switch (type) {
      case 0x00: {
        const at = base + addr;
        if (at + len > maxSize) throw new HexParseError(`line ${ln + 1}: address 0x${at.toString(16)} out of range`);
        buf.set(payload, at);
        size = Math.max(size, at + len);
        break;
      }
      case 0x01:
        sawEof = true;
        break;
      case 0x02:
        base = ((payload[0] << 8) | payload[1]) << 4;
        break;
      case 0x04:
        base = ((payload[0] << 8) | payload[1]) << 16;
        break;
      case 0x03:
      case 0x05:
        break; // start address records: irrelevant for flashing
      default:
        throw new HexParseError(`line ${ln + 1}: unknown record type ${type}`);
    }
    if (sawEof) break;
  }
  if (!sawEof) throw new HexParseError('missing end-of-file record');
  return { data: buf.slice(0, size), size };
}

function hexToBytes(s: string, ln: number): Uint8Array {
  if (s.length % 2) throw new HexParseError(`line ${ln}: odd number of hex digits`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(s.substr(i * 2, 2), 16);
    if (Number.isNaN(v)) throw new HexParseError(`line ${ln}: invalid hex`);
    out[i] = v;
  }
  return out;
}

/** Encode a binary image as Intel HEX (16-byte records). Used in tests and for "export .hex". */
export function toIntelHex(data: Uint8Array): string {
  const lines: string[] = [];
  for (let off = 0; off < data.length; off += 16) {
    const chunk = data.subarray(off, Math.min(off + 16, data.length));
    const rec = [chunk.length, (off >> 8) & 0xff, off & 0xff, 0, ...chunk];
    const sum = (0x100 - (rec.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
    lines.push(':' + [...rec, sum].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(''));
  }
  lines.push(':00000001FF');
  return lines.join('\n') + '\n';
}
