import { defineConfig, devices } from '@playwright/test';

const PORT = 8799;
const chromium = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'off', launchOptions: chromium },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 860 }, launchOptions: chromium }, testIgnore: /mobile\.spec/ },
    { name: 'android', use: { ...devices['Pixel 7'], launchOptions: chromium }, testMatch: /mobile\.spec/ },
  ],
  // The real Rust compile server, serving the production build of the PWA.
  webServer: {
    command: `cargo run --release --manifest-path ../server/Cargo.toml`,
    env: { PORT: String(PORT), BITBENCH_STATIC_DIR: 'dist', RUST_LOG: 'warn' },
    url: `http://localhost:${PORT}/api/health`,
    timeout: 180_000,
    reuseExistingServer: true,
  },
});
