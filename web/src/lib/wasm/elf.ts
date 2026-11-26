/** Read section sizes from a 32-bit little-endian ELF (enough for avr-size). */
export function elfSectionSizes(elf: Uint8Array): Record<string, number> {
  const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (dv.getUint32(0) !== 0x7f454c46) throw new Error('not an ELF file');
  const shoff = dv.getUint32(0x20, true);
  const shentsize = dv.getUint16(0x2e, true);
  const shnum = dv.getUint16(0x30, true);
  const shstrndx = dv.getUint16(0x32, true);
  const sh = (i: number) => shoff + i * shentsize;
  const strOff = dv.getUint32(sh(shstrndx) + 0x10, true);
  const out: Record<string, number> = {};
  for (let i = 0; i < shnum; i++) {
    const nameOff = dv.getUint32(sh(i), true);
    let end = strOff + nameOff;
    while (elf[end]) end++;
    const name = new TextDecoder().decode(elf.subarray(strOff + nameOff, end));
    out[name] = dv.getUint32(sh(i) + 0x14, true);
  }
  return out;
}

export function avrUsage(elf: Uint8Array) {
  const s = elfSectionSizes(elf);
  const text = s['.text'] ?? 0;
  const data = s['.data'] ?? 0;
  const bss = s['.bss'] ?? 0;
  const noinit = s['.noinit'] ?? 0;
  return { flash: text + data, ram: data + bss + noinit };
}
