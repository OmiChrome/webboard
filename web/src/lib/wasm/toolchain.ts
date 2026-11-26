/**
 * In-browser AVR toolchain: GCC's cc1plus + GNU binutils compiled to
 * WebAssembly (from @horang-corp/avr-gcc-wasm), driven directly because the
 * gcc driver needs process APIs (vfork) that the web does not have:
 *
 *   sketch.ino --preprocess--> sketch.cpp --cc1plus--> .s --avr-as--> .o
 *              --avr-ld (+ libarduino.a, avr-libc, libgcc)--> .elf --avr-objcopy--> .hex
 *
 * Runs inside a Web Worker. Compiled WebAssembly modules and the unpacked
 * sysroot are kept in memory so only the first build pays the start-up cost.
 */
import { parseDiagnostics, preprocessSketch, type ParsedDiagnostic } from '../arduino/preprocess';
import { avrUsage } from './elf';

type ToolName = 'cc1plus' | 'avr-as' | 'avr-ld' | 'avr-objcopy';

interface EmscriptenFS {
  mkdir(p: string): void;
  writeFile(p: string, d: Uint8Array | string): void;
  readFile(p: string): Uint8Array;
}
interface EmscriptenModule {
  FS: EmscriptenFS;
  callMain(args: string[]): number;
}
type Factory = (opts: Record<string, unknown>) => Promise<EmscriptenModule>;

export interface ToolchainResult {
  ok: boolean;
  hex?: string;
  log: string;
  diagnostics: ParsedDiagnostic[];
  flash_used?: number;
  flash_max: number;
  ram_used?: number;
  ram_max: number;
  timings: Record<string, number>;
}

export interface Progress {
  stage: 'download' | 'compile' | 'assemble' | 'link' | 'hex';
  loaded?: number;
  total?: number;
}

const FLASH_MAX = 32256;
const RAM_MAX = 2048;

const INCLUDE_DIRS = [
  '/arduino/core',
  '/arduino/variant',
  '/arduino/libraries/Wire/src',
  '/arduino/libraries/Wire/src/utility',
  '/arduino/libraries/SPI/src',
  '/libraries/Servo/src',
  '/libraries/Firmata',
  '/libraries/Adafruit_BMP085_Library',
  '/libraries/DHT_sensor_library',
  '/libraries/Adafruit_GFX_Library',
  '/libraries/Adafruit_SSD1306',
  '/libraries/VL53L0X',
  '/libraries/Adafruit_BusIO',
  '/libraries/Adafruit_Unified_Sensor',
];

export interface BoardTarget {
  /** -D define identifying the board, e.g. ARDUINO_AVR_UNO */
  define: string;
}

/**
 * Decompress if (still) gzipped. Some static hosts serve `.gz` files with
 * `Content-Encoding: gzip`, in which case the browser has already inflated
 * them; others serve the raw gzip bytes. Sniff the magic number.
 */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fetchWithProgress(url: string, onProgress?: (loaded: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to download ${url} (${res.status})`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export class WasmToolchain {
  private modules = new Map<ToolName, WebAssembly.Module>();
  private factories = new Map<ToolName, Factory>();
  private sysroot: Map<string, Uint8Array> | null = null;
  private ready: Promise<void> | null = null;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /** Download (or read from the HTTP / service-worker cache) everything once. */
  init(onProgress?: (p: Progress) => void): Promise<void> {
    this.ready ??= this.load(onProgress).catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  private async load(onProgress?: (p: Progress) => void) {
    const info = await fetch(this.baseUrl + 'toolchain.json').then((r) => r.json() as Promise<{ packBytes: number; wasmGzBytes: number }>);
    const total = info.packBytes + info.wasmGzBytes;
    const loadedBy = new Map<string, number>();
    const report = (key: string, n: number) => {
      loadedBy.set(key, n);
      onProgress?.({ stage: 'download', loaded: [...loadedBy.values()].reduce((a, b) => a + b, 0), total });
    };
    const tools: ToolName[] = ['cc1plus', 'avr-as', 'avr-ld', 'avr-objcopy'];
    await Promise.all([
      ...tools.map(async (t) => {
        const [factory, gz] = await Promise.all([
          import(/* @vite-ignore */ this.baseUrl + `${t}.mjs`).then((m) => m.default as Factory),
          fetchWithProgress(this.baseUrl + `${t}.wasm.gz`, (n) => report(t, n)),
        ]);
        this.factories.set(t, factory);
        this.modules.set(t, await WebAssembly.compile((await gunzip(gz)) as BufferSource));
      }),
      (async () => {
        const gz = await fetchWithProgress(this.baseUrl + 'sysroot.pack.gz', (n) => report('pack', n));
        this.sysroot = unpack(await gunzip(gz));
      })(),
    ]);
  }

  private async run(tool: ToolName, args: string[], inputs: [string, Uint8Array | string][], output: string, log: string[]) {
    const module = this.modules.get(tool)!;
    const factory = this.factories.get(tool)!;
    const mod = await factory({
      noInitialRun: true,
      print: (l: string) => l && log.push(l),
      printErr: (l: string) => l && log.push(l),
      instantiateWasm(imports: WebAssembly.Imports, receive: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
        WebAssembly.instantiate(module, imports).then((inst) => receive(inst, module));
        return {};
      },
    });
    for (const [p, data] of inputs) writeFile(mod.FS, p, data);
    let status = 0;
    try {
      status = mod.callMain(args) ?? 0;
    } catch (e) {
      const s = (e as { status?: number }).status;
      status = typeof s === 'number' ? s : 1;
      if (typeof s !== 'number') log.push(`${tool}: ${(e as Error).message ?? e}`);
    }
    if (status !== 0) return null;
    try {
      return mod.FS.readFile(output);
    } catch {
      return null;
    }
  }

  async compile(source: string, board: BoardTarget, onProgress?: (p: Progress) => void): Promise<ToolchainResult> {
    await this.init(onProgress);
    const sys = this.sysroot!;
    const timings: Record<string, number> = {};
    const log: string[] = [];
    const t = (k: string, t0: number) => (timings[k] = Math.round(performance.now() - t0));
    const result: ToolchainResult = { ok: false, log: '', diagnostics: [], flash_max: FLASH_MAX, ram_max: RAM_MAX, timings };
    const headers = [...sys].filter(([p]) => p.startsWith('/sysroot/') || p.startsWith('/arduino/') || p.startsWith('/libraries/'));
    const finish = () => {
      result.log = log.map((l) => l.replaceAll('/build/', '')).join('\n') + (log.length ? '\n' : '');
      result.diagnostics = parseDiagnostics(result.log);
      return result;
    };

    // 1. C++ -> assembly
    onProgress?.({ stage: 'compile' });
    let t0 = performance.now();
    const cpp = preprocessSketch(source, 'sketch.ino');
    const asm = await this.run(
      'cc1plus',
      [
        '-quiet', '-imultilib', 'avr5',
        '-D__AVR_ATmega328P__', '-D__AVR_DEVICE_NAME__=atmega328p', '-DF_CPU=16000000L',
        '-DARDUINO=10819', `-D${board.define}`, '-DARDUINO_ARCH_AVR',
        '-isystem', '/sysroot/gcc/include', '-isystem', '/sysroot/avr/include',
        ...INCLUDE_DIRS.flatMap((d) => ['-I', d]),
        '/build/sketch.ino.cpp',
        '-mn-flash=1', '-mno-skip-bug', '-mmcu=avr5', '-dumpbase', 'sketch.ino.cpp',
        '-Os', '-Wall', '-std=gnu++11', '-fpermissive', '-fno-exceptions', '-fno-threadsafe-statics',
        '-fno-rtti', '-fno-enforce-eh-specs', '-ffunction-sections', '-fdata-sections',
        '-o', '/build/sketch.s',
      ],
      [...headers, ['/build/sketch.ino.cpp', cpp]],
      '/build/sketch.s',
      log,
    );
    t('compileMs', t0);
    if (!asm) return finish();

    // 2. assemble
    onProgress?.({ stage: 'assemble' });
    t0 = performance.now();
    const obj = await this.run('avr-as', ['-mmcu=atmega328p', '-o', '/build/sketch.o', '/build/sketch.s'], [['/build/sketch.s', asm]], '/build/sketch.o', log);
    t('assembleMs', t0);
    if (!obj) return finish();

    // 3. link against the Arduino core archive + avr-libc + libgcc
    onProgress?.({ stage: 'link' });
    t0 = performance.now();
    const libs = [...sys].filter(([p]) => p.startsWith('/libs/') || p.startsWith('/ldscripts/'));
    const elf = await this.run(
      'avr-ld',
      [
        '-m', 'avr5', '-Tdata=0x800100', '--gc-sections', '-o', '/build/sketch.elf',
        '/libs/crtatmega328p.o', '/build/sketch.o', '-L/libs',
        '--start-group', '-larduino', '-lm', '-lc', '-lgcc', '--end-group',
      ],
      [...libs, ['/build/sketch.o', obj]],
      '/build/sketch.elf',
      log,
    );
    t('linkMs', t0);
    if (!elf) {
      for (const sym of ['setup', 'loop']) {
        if (log.some((l) => l.includes(`undefined reference to \`${sym}'`))) {
          log.push(`hint: Every sketch needs a \`void ${sym}()\` function.`);
        }
      }
      return finish();
    }

    // 4. Intel HEX
    onProgress?.({ stage: 'hex' });
    t0 = performance.now();
    const hex = await this.run('avr-objcopy', ['-O', 'ihex', '-R', '.eeprom', '/build/sketch.elf', '/build/sketch.hex'], [['/build/sketch.elf', elf]], '/build/sketch.hex', log);
    t('hexMs', t0);
    if (!hex) return finish();

    const { flash, ram } = avrUsage(elf);
    result.flash_used = flash;
    result.ram_used = ram;
    log.push(
      `Sketch uses ${flash} bytes (${Math.round((flash * 100) / FLASH_MAX)}%) of program storage space. Maximum is ${FLASH_MAX} bytes.`,
      `Global variables use ${ram} bytes (${Math.round((ram * 100) / RAM_MAX)}%) of dynamic memory, leaving ${RAM_MAX - ram} bytes for local variables. Maximum is ${RAM_MAX} bytes.`,
    );
    if (flash > FLASH_MAX) {
      log.push('error: Sketch too big; see https://support.arduino.cc/hc/en-us/articles/360013825179 for tips on reducing it.');
      return finish();
    }
    result.hex = new TextDecoder().decode(hex);
    result.ok = true;
    return finish();
  }
}

function writeFile(fs: EmscriptenFS, path: string, data: Uint8Array | string) {
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts.slice(0, -1)) {
    cur += '/' + part;
    try {
      fs.mkdir(cur);
    } catch {
      /* exists */
    }
  }
  fs.writeFile(path, data);
}

export function unpack(raw: Uint8Array): Map<string, Uint8Array> {
  const magic = new TextDecoder().decode(raw.subarray(0, 6));
  if (magic !== 'BBPK1\n') throw new Error('bad sysroot pack');
  const len = new DataView(raw.buffer, raw.byteOffset + 6, 4).getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(raw.subarray(10, 10 + len))) as { p: string; o: number; n: number }[];
  const base = 10 + len;
  const files = new Map<string, Uint8Array>();
  for (const e of index) files.set(e.p, raw.subarray(base + e.o, base + e.o + e.n));
  return files;
}
