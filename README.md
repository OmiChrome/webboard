# Bitbench (webboard)

**An Arduino IDE that runs entirely in the browser, on desktop or Android.** Write a sketch, compile it to AVR machine code *in the browser* with WebAssembly, flash it over USB and talk to the board. There's no install and no backend: it's a static site on GitHub Pages.

**Live:** https://omichrome.github.io/webboard/

![Bitbench on desktop](docs/screenshots/desktop-traffic-output.png)

| Serial Plotter (dark) | Android phone |
|---|---|
| ![](docs/screenshots/desktop-plotter-dark.png) | ![](docs/screenshots/android-knightrider.png) |

## How it works

```
 sketch.ino ─► preprocess (prototypes, #line)            ┐
            ─► cc1plus.wasm   (GCC 7.3, C++ → AVR asm)    │  Web Worker,
            ─► avr-as.wasm    (→ .o)                      │  all in the
            ─► avr-ld.wasm    (+ Arduino core, libc)      │  browser
            ─► avr-objcopy.wasm (→ Intel HEX)             ┘
            ─► STK500v1 uploader ─► Web Serial | WebUSB driver | Virtual Uno
```

- **Compiling in the browser.** GCC and binutils are compiled to WebAssembly (taken from [`@horang-corp/avr-gcc-wasm`](https://github.com/horang-corp/avr-gcc-wasm)) and driven directly from a Web Worker. Sketches link against the **official Arduino AVR core**, so `String`, `Serial`, `Wire`, `SPI` and `Servo` work, plus a few Adafruit libraries.
- **Optimised for the web.** At build time the toolchain is cut from **55 MB to a one-time 6.2 MB download**:
  - the sysroot is pruned to the ATmega328P;
  - debug info is stripped;
  - the Arduino core is packed into an archive so the linker only pulls in what a sketch uses;
  - headers and libraries ship as one gzipped pack;
  - the WebAssembly is gzipped.

  It loads in the background once the page is idle, and the service worker caches it, so compiling also works **offline**. A typical build takes under a second.
- **Nothing to compile on your machine.** Visitors only download prebuilt files. The AVR toolchain is needed on the CI build machine only.
- **Flashing:** a TypeScript STK500v1 uploader (the protocol `avrdude -c arduino` uses). It handles auto-reset, signature check, page writes and read-back verification.
- **Three ways to connect:**
  - **Web Serial:** desktop Chrome and Edge, ChromeOS.
  - **WebUSB with userland drivers:** Android Chrome. Covers CDC-ACM, CH340/CH341, CP210x and FTDI.
  - **Virtual Uno:** runs the compiled machine code on [avr8js](https://github.com/wokwi/avr8js) and emulates the Optiboot bootloader. Shows LEDs, PWM and an analog input.
- **Serial Monitor and Plotter**, with the same line formats as the Arduino IDE 2 plotter.
- **Local-first:** sketches stay on the device. Installable as a PWA.
- **Android app:** a Trusted Web Activity config in [`android/`](android/README.md). It runs in real Chrome, so WebUSB keeps working.
- **8 examples**, including `SerialCommands`, which uses `String` parsing.

## Repository layout

```
web/        React 19 + TypeScript + Vite PWA  (the product; deployed to GitHub Pages)
  src/lib/wasm/        in-browser toolchain driver, worker, ELF size reader
  src/lib/arduino/     sketch preprocessing (prototype generation)
  src/lib/serial/      Transport interface, Web Serial, WebUSB drivers, Virtual Uno
  src/lib/upload/      STK500v1 uploader
  scripts/             prepare-toolchain (web-optimised WASM bundle), build-examples, icons, screenshots
  e2e/                 Playwright tests against the static build (desktop + Pixel 7)
examples/   Demo sketches + index.json
server/     Optional self-hosted Rust compile server (axum) for slow devices
core/       Small MIT Arduino-compatible core used by the optional server
android/    Trusted Web Activity (Bubblewrap) config
.github/    Pages deploy + CI workflows
```

## Develop

Build-machine requirements: Node 22+, pnpm, and `binutils-avr gcc-avr avr-libc`. These are used only to pack the toolchain and precompile the examples.

```bash
cd web && pnpm install && pnpm setup
```

```bash
cd web && pnpm dev
```

`pnpm setup` writes `public/toolchain/` and `public/examples.json`. Then open http://localhost:5173.

## Tests

```bash
cd web && pnpm test
```

```bash
cd web && pnpm build && pnpm e2e
```

```bash
cd server && cargo test
```

- `pnpm test`: 28 unit tests. Intel HEX, sketch preprocessing, the toolchain pack, the USB-serial drivers against a fake USB device, and STK500 upload into the virtual Uno with the firmware then running.
- `pnpm e2e`: 9 Playwright tests against the **static** build served under `/webboard/`, like Pages. They cover:
  - in-browser compiling of edited sketches;
  - inline compiler errors;
  - upload, serial I/O and the plotter;
  - falling back to precompiled examples;
  - saving sketches on the device;
  - the phone layout.
- `cargo test`: tests for the optional compile server.

## Deploying

Pushing to `main` runs `.github/workflows/pages.yml`, which installs, packs the toolchain, builds the examples, runs unit and e2e tests, builds the site and deploys it to GitHub Pages. In the repo settings, *Pages → Source* must be **GitHub Actions**.

## Using real hardware

- **Desktop:** choose *USB serial port (Web Serial)*, press Upload and pick the board.
- **Android:** use an OTG adapter. Choose *USB device (WebUSB driver)* and press Upload.

The USB drivers follow the Linux kernel and usb-serial-for-android protocols and are unit-tested, but **they have not yet been verified on physical boards**.

## Roadmap

- **Boards:** Mega (STK500v2), Leonardo (AVR109 with the 1200-baud touch), ESP32 (esptool-js), RP2040 (PICOBOOT over WebUSB).
- **Libraries:** a library manager that compiles libraries in the browser.
- **Download size:** run `wasm-opt` over the toolchain and lazy-load the C++ standard headers.

## License

The app code is MIT. The in-browser toolchain ships GCC and binutils WebAssembly builds (GPL-3.0), avr-libc (BSD), and Arduino core and library objects (LGPL and others). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
