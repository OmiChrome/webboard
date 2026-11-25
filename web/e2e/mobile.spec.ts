import { expect, test } from '@playwright/test';

test('phone layout: upload Knight Rider from the drawer', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Sketches' }).click();
  await page.getByTestId('example-KnightRider').click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
  await page.getByTestId('upload').click();
  await expect(page.getByTestId('log')).toContainText('Upload complete');
  await expect(page.locator('[data-testid^="led-"][data-on="1"]').first()).toBeVisible();
  // No horizontal scrolling on a phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
