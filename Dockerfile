# Single container: Rust compile server + AVR toolchain + the built PWA.
FROM node:22-bookworm AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM rust:1-bookworm AS server
WORKDIR /src/server
COPY server/ ./
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gcc-avr avr-libc binutils-avr \
    && rm -rf /var/lib/apt/lists/* && useradd -m bitbench
COPY --from=server /src/server/target/release/bitbench-server /usr/local/bin/
COPY core /opt/bitbench/core
COPY --from=web /src/web/dist /opt/bitbench/web
ENV BITBENCH_CORE_DIR=/opt/bitbench/core BITBENCH_STATIC_DIR=/opt/bitbench/web PORT=8787
USER bitbench
EXPOSE 8787
CMD ["bitbench-server"]
