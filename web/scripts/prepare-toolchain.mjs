// Build-time: turn @horang-corp/avr-gcc-wasm into a small, cacheable,
// web-optimised toolchain under public/toolchain/:
//
//   cc1plus|avr-as|avr-ld|avr-objcopy .mjs   Emscripten glue (JS)
//   ...wasm.gz                              WebAssembly, gzip -9 (13.8 MB -> ~4.5 MB for cc1plus)
//   sysroot.pack.gz                         headers + libs + Arduino core archive in one gzip blob
//
// The sysroot is pruned to what an ATmega328P build needs (the avr-libc
// headers for ~300 other chips are 95% of the size), debug info is stripped,
// and the Arduino core + libraries are packed into libarduino.a so the
// linker only pulls in the objects a sketch actually uses (like the IDE's core.a).
//
// Requires binutils-avr (avr-ar, avr-strip) at build time only. End users
// download prebuilt files; nothing is compiled on their machine.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = dirname(require.resolve('@horang-corp/avr-gcc-wasm/package.json'));
const out = join(here, '../public/toolchain');
const assets = join(pkg, 'assets');
const manifest = JSON.parse(readFileSync(join(assets, 'manifest.json'), 'utf8'));

const TOOLS = ['cc1plus', 'avr-as', 'avr-ld', 'avr-objcopy'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let wasmBytes = 0;
for (const t of TOOLS) {
  cpSync(join(pkg, 'tools', `${t}.mjs`), join(out, `${t}.mjs`));
  const gz = gzipSync(readFileSync(join(pkg, 'tools', `${t}.wasm`)), { level: 9 });
  writeFileSync(join(out, `${t}.wasm.gz`), gz);
  wasmBytes += gz.length;
}

// ---- sysroot ---------------------------------------------------------------
const keepHeader = (p) => {
  const m = /^\/sysroot\/avr\/include\/avr\/(io[^/]*)\.h$/.exec(p);
  if (!m) return true;
  return m[1] === 'io' || m[1] === 'iom328p';
};

const work = mkdtempSync(join(tmpdir(), 'bb-toolchain-'));
const strip = (file) => execFileSync('avr-strip', ['--strip-debug', file]);

const files = new Map(); // virtual path -> bytes
for (const p of manifest.headerFiles.filter(keepHeader)) files.set(p, readFileSync(join(assets, 'fs', p)));
files.set('/ldscripts/avr5.xn', readFileSync(join(assets, 'ldscripts/avr5.xn')));

for (const lib of manifest.libs) {
  const tmp = join(work, lib.split('/').pop());
  cpSync(join(assets, lib), tmp);
  strip(tmp);
  files.set(lib, readFileSync(tmp));
}

const objDir = join(work, 'objects');
mkdirSync(objDir);
const objects = readdirSync(join(assets, 'objects')).filter((f) => f.endsWith('.o'));
for (const o of objects) {
  cpSync(join(assets, 'objects', o), join(objDir, o));
  strip(join(objDir, o));
}
const archive = join(work, 'libarduino.a');
execFileSync('avr-ar', ['rcs', archive, ...objects.map((o) => join(objDir, o))]);
files.set('/libs/libarduino.a', readFileSync(archive));

// Pack format: "BBPK1\n" | u32 LE index length | JSON index [{p,o,n}] | data
const index = [];
let offset = 0;
for (const [p, b] of files) {
  index.push({ p, o: offset, n: b.length });
  offset += b.length;
}
const indexBytes = Buffer.from(JSON.stringify(index));
const header = Buffer.alloc(10);
header.write('BBPK1\n', 0, 'latin1');
header.writeUInt32LE(indexBytes.length, 6);
const raw = Buffer.concat([header, indexBytes, ...files.values()]);
const packed = gzipSync(raw, { level: 9 });
writeFileSync(join(out, 'sysroot.pack.gz'), packed);

const info = {
  version: JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version,
  files: files.size,
  rawBytes: raw.length,
  packBytes: packed.length,
  wasmGzBytes: wasmBytes,
};
writeFileSync(join(out, 'toolchain.json'), JSON.stringify(info, null, 2));
cpSync(join(pkg, 'THIRD_PARTY_NOTICES.md'), join(out, 'THIRD_PARTY_NOTICES.md'));

// Also expose the unpacked Arduino core for the native example build (build-time only).
const native = join(here, '../.toolchain-native');
rmSync(native, { recursive: true, force: true });
mkdirSync(native, { recursive: true });
for (const [p, b] of files) {
  if (p.startsWith('/sysroot/')) continue;
  const dest = join(native, p);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, b);
}
rmSync(work, { recursive: true, force: true });

const mb = (n) => (n / 1e6).toFixed(2) + ' MB';
console.log(`toolchain ready in ${out}`);
console.log(`  wasm (gzip):   ${mb(wasmBytes)}`);
console.log(`  sysroot pack:  ${mb(packed.length)} (from ${mb(raw.length)}, ${files.size} files)`);
console.log(`  total download ${mb(wasmBytes + packed.length)}`);
if (!existsSync(join(out, 'cc1plus.mjs'))) process.exit(1);
