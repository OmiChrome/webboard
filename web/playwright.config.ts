import { defineConfig, devices } from '@playwright/test';

const PORT = 8799;
const chromium = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}/webboard/`, trace: 'off', launchOptions: chromium },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 860 }, launchOptions: chromium }, testIgnore: /mobile\.spec/ },
    { name: 'android', use: { ...devices['Pixel 7'], launchOptions: chromium }, testMatch: /mobile\.spec/ },
  ],
  // The static production build, served under /webboard/ exactly like GitHub Pages.
  // Compilation happens in the browser (WebAssembly) — no backend.
  webServer: {
    command: `pnpm exec vite preview --port ${PORT} --strictPort`,
    env: { BASE_PATH: '/webboard/' },
    url: `http://localhost:${PORT}/webboard/`,
    timeout: 60_000,
    reuseExistingServer: true,
  },
});
