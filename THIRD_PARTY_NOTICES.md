# Third-party notices

Bitbench's own source code is MIT licensed (see `LICENSE`). The deployed site
also distributes, unmodified, the following third-party components, fetched at
build time from the npm package `@horang-corp/avr-gcc-wasm@0.2.0` and served
under `toolchain/`.

| Component | Where | License | Source |
|---|---|---|---|
| GCC 7.3 `cc1plus` (AVR target) built to WebAssembly | `toolchain/cc1plus.*` | GPL-3.0-or-later | https://gcc.gnu.org/ — build: https://github.com/horang-corp/avr-gcc-wasm |
| GNU binutils `as`, `ld`, `objcopy` (AVR) built to WebAssembly | `toolchain/avr-*.*` | GPL-3.0-or-later | https://www.gnu.org/software/binutils/ — build: https://github.com/horang-corp/avr-gcc-wasm |
| libgcc | `toolchain/sysroot.pack.gz` | GPL-3.0 with GCC Runtime Library Exception | https://gcc.gnu.org/ |
| avr-libc headers and libraries | `toolchain/sysroot.pack.gz` | Modified BSD | https://github.com/avrdudes/avr-libc |
| Arduino AVR core (headers + objects) | `toolchain/sysroot.pack.gz` | LGPL-2.1-or-later | https://github.com/arduino/ArduinoCore-avr |
| Wire, SPI, Servo, Firmata | `toolchain/sysroot.pack.gz` | LGPL-2.1-or-later | Arduino libraries |
| Adafruit GFX, SSD1306, BusIO, BMP085, Unified Sensor; DHT sensor library; VL53L0X | `toolchain/sysroot.pack.gz` | BSD / MIT (see upstream) | https://github.com/adafruit, https://github.com/pololu/vl53l0x-arduino |
| avr8js | JS bundle | MIT | https://github.com/wokwi/avr8js |
| CodeMirror, React | JS bundle | MIT | upstream |

The GPL-licensed compiler binaries are separate programs that the web app
invokes; they are aggregated with, not linked into, Bitbench. Corresponding
source for them is available from the upstream projects listed above, and the
build scripts and patches used to produce the WebAssembly artifacts are at
https://github.com/horang-corp/avr-gcc-wasm. The pruning/packing step in
`web/scripts/prepare-toolchain.mjs` only selects files, strips debug sections
(`avr-strip --strip-debug`) and archives objects (`avr-ar`).

The upstream notice shipped with the package is reproduced at
`toolchain/THIRD_PARTY_NOTICES.md` on the deployed site.
