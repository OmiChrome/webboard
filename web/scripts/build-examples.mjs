// Build-time: precompile the bundled examples (official Arduino core, same
// preprocessing as the browser) with the native avr-gcc, into
// public/examples.json. The app ships these so unmodified examples flash
// instantly and also work if WebAssembly is unavailable. Run after
// prepare-toolchain.mjs. Needs gcc-avr + avr-libc at build time only.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preprocessSketch } from '../src/lib/arduino/preprocess.ts';

const here = dirname(fileURLToPath(import.meta.url));
const native = join(here, '../.toolchain-native');
const examplesDir = join(here, '../../examples');
const include = [
  'arduino/core', 'arduino/variant', 'arduino/libraries/Wire/src', 'arduino/libraries/SPI/src', 'libraries/Servo/src',
].map((d) => `-I${join(native, d)}`);
const flags = ['-mmcu=atmega328p', '-DF_CPU=16000000L', '-DARDUINO=10819', '-DARDUINO_AVR_UNO', '-DARDUINO_ARCH_AVR',
  '-Os', '-std=gnu++11', '-fpermissive', '-fno-exceptions', '-fno-threadsafe-statics', '-fno-rtti',
  '-ffunction-sections', '-fdata-sections', '-w'];

const index = JSON.parse(readFileSync(join(examplesDir, 'index.json'), 'utf8'));
const out = [];
for (const ex of index) {
  const source = readFileSync(join(examplesDir, ex.id, `${ex.id}.ino`), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'bb-ex-'));
  writeFileSync(join(dir, 'sketch.ino.cpp'), preprocessSketch(source));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
  run('avr-g++', [...flags, ...include, '-c', 'sketch.ino.cpp', '-o', 'sketch.o']);
  run('avr-gcc', ['-mmcu=atmega328p', '-Os', '-Wl,--gc-sections', 'sketch.o', join(native, 'libs/libarduino.a'), '-lm', '-o', 'sketch.elf']);
  run('avr-objcopy', ['-O', 'ihex', '-R', '.eeprom', 'sketch.elf', 'sketch.hex']);
  const size = run('avr-size', ['-A', 'sketch.elf']);
  const sec = (n) => Number((size.match(new RegExp(`^\\${n}\\s+(\\d+)`, 'm')) ?? [0, 0])[1]);
  const flash = sec('.text') + sec('.data');
  const ram = sec('.data') + sec('.bss');
  out.push({ ...ex, board: 'uno', source, hex: readFileSync(join(dir, 'sketch.hex'), 'utf8'), flash_used: flash, ram_used: ram });
  console.log(`${ex.id.padEnd(16)} ${String(flash).padStart(6)} bytes flash ${String(ram).padStart(5)} bytes ram`);
  rmSync(dir, { recursive: true, force: true });
}
writeFileSync(join(here, '../public/examples.json'), JSON.stringify(out, null, 2));
