import { expect, test, type Page } from '@playwright/test';

test.skip(({ isMobile }) => isMobile, 'desktop suite');

async function fresh(page: Page) {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId('board-state')).toBeVisible();
}

test.use({ serviceWorkers: 'block' });

async function openExample(page: Page, id: string) {
  await page.getByTestId(`example-${id}`).click();
  await expect(page.locator('.filename')).toContainText('.ino');
}

async function setEditor(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  // insertText bypasses per-key handlers such as bracket auto-closing.
  await page.keyboard.insertText(text);
}

test('compiles Blink in the browser, uploads over STK500 and the LED blinks', async ({ page }) => {
  await fresh(page);
  await page.getByTestId('upload').click();
  const log = page.getByTestId('log');
  await expect(log).toContainText('Sketch uses', { timeout: 60_000 });
  await expect(log).toContainText('Done compiling in your browser');
  await expect(log).toContainText('In sync with bootloader');
  await expect(log).toContainText('Device signature: 0x1e 0x95 0x0f');
  await expect(log).toContainText('Verified OK');
  await expect(log).toContainText('Upload complete');
  await expect(page.getByTestId('board-state')).toHaveText('Running');
  const led = page.getByTestId('led-13');
  await expect(led).toHaveAttribute('data-on', '1');
  await expect(led).toHaveAttribute('data-on', '0');
  await expect(page.locator('.usage')).toContainText('% flash');
});

test('HelloSerial prints to the Serial Monitor', async ({ page }) => {
  await fresh(page);
  await openExample(page, 'HelloSerial');
  await page.getByTestId('upload').click();
  await expect(page.getByTestId('log')).toContainText('Upload complete');
  await page.getByRole('tab', { name: 'Serial Monitor' }).click();
  await expect(page.getByTestId('monitor')).toContainText('Hello from Bitbench!');
  await expect(page.getByTestId('monitor')).toContainText('tick 1');
});

test('EchoUppercase round-trips input from the monitor', async ({ page }) => {
  await fresh(page);
  await openExample(page, 'EchoUppercase');
  await page.getByTestId('upload').click();
  await expect(page.getByTestId('log')).toContainText('Upload complete');
  await page.getByRole('tab', { name: 'Serial Monitor' }).click();
  await expect(page.getByTestId('monitor')).toContainText('Type something');
  await page.getByLabel('Message to send').fill('hello android');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('monitor')).toContainText('HELLO ANDROID');
});

test('SinePlotter feeds the plotter', async ({ page }) => {
  await fresh(page);
  await openExample(page, 'SinePlotter');
  await page.getByTestId('upload').click();
  await expect(page.getByTestId('log')).toContainText('Upload complete');
  await page.getByRole('tab', { name: 'Plotter' }).click();
  await expect(page.locator('.legend')).toContainText('sin');
  await expect(page.locator('.legend')).toContainText('cos');
});

test('compile errors are shown inline with the right line', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: 'New sketch' }).click();
  await setEditor(page, 'void setup() {\n  pinMode(13, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrit(13, HIGH);\n}\n');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByTestId('log')).toContainText("sketch.ino:6:3: error: 'digitalWrit' was not declared", { timeout: 60_000 });
  await expect(page.locator('.badge.error')).toHaveText('1 error');
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(1);
});

test('compiles an edited sketch entirely in the browser (WebAssembly) and runs it', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: 'New sketch' }).click();
  await setEditor(
    page,
    'String name = "wasm";\n\nvoid setup() {\n  Serial.begin(115200);\n  pinMode(LED_BUILTIN, OUTPUT);\n}\n\nvoid loop() {\n  Serial.println("compiled by " + name + ", 6*7=" + String(answer()));\n  digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));\n  delay(200);\n}\n\nint answer() { return 6 * 7; }\n',
  );
  await page.getByTestId('upload').click();
  const log = page.getByTestId('log');
  await expect(log).toContainText('Done compiling in your browser', { timeout: 60_000 });
  await expect(log).toContainText('Upload complete');
  await page.getByRole('tab', { name: 'Serial Monitor' }).click();
  await expect(page.getByTestId('monitor')).toContainText('compiled by wasm, 6*7=42');
  await expect(page.getByTestId('led-13')).toHaveAttribute('data-on', '1');
  await expect(page.getByTestId('led-13')).toHaveAttribute('data-on', '0');
});

test('falls back to the precompiled example when the compiler cannot load', async ({ page }) => {
  await page.route('**/toolchain/**', (r) => r.abort());
  await fresh(page);
  await openExample(page, 'TrafficLight');
  await page.getByTestId('upload').click();
  await expect(page.getByTestId('log')).toContainText('using the precompiled build of "Traffic Light"');
  await expect(page.getByTestId('log')).toContainText('Upload complete');
  await expect(page.getByTestId('led-10')).toHaveAttribute('data-on', '1');
});

test('sketches persist on the device', async ({ page }) => {
  await fresh(page);
  await openExample(page, 'Fade');
  await page.reload();
  await expect(page.locator('.list li.active')).toContainText('Fade.ino');
  await expect(page.locator('.cm-content')).toContainText('analogWrite(9, brightness)');
});
