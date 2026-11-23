import { expect, test } from '@playwright/test';

test('Descargas recibe progreso, conserva el explorador y selecciona el resultado en móvil', async ({
  page,
}) => {
  test.skip(
    process.env.MUX_DOWNLOAD_TEST !== '1',
    'Requiere el fixture local de Gopeed en Docker.',
  );
  await page.goto('/');
  test.setTimeout(60_000);
  await page.getByLabel('Nombre de usuario').fill(process.env.MUX_DOWNLOAD_USER!);
  await page.getByLabel('Contraseña de administrador').fill(process.env.MUX_DOWNLOAD_PASSWORD!);
  await page.getByRole('button', { name: 'Entrar en Muxplorer' }).click();
  await page.getByRole('button', { name: 'Descargas', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Descargas' })).toBeVisible();
  await expect(page.getByText(/Gopeed v?1\.9\.3/)).toBeVisible();
  const links = page.getByLabel('Enlaces de descarga');
  await links.fill('http://fixture:8080/browser.txt\nhttp://fixture:8080/slow.bin');
  await page.getByRole('button', { name: 'Añadir descargas' }).click();
  const slow = page.getByRole('listitem').filter({ hasText: 'slow.bin' }).first();
  await expect(slow.getByText('Descargando')).toBeVisible({ timeout: 15_000 });
  await expect(slow.getByText(/Restan/)).toBeVisible({ timeout: 15_000 });
  await slow.getByRole('button', { name: 'Pausar', exact: true }).click();
  await expect(slow.getByText('En pausa')).toBeVisible({ timeout: 15_000 });
  const result = page.getByRole('listitem').filter({ hasText: 'browser.txt' });
  await expect(result.getByText('Completada')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Explorador', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Descargas', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Descargas' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await result.getByRole('button', { name: 'Abrir en el explorador' }).click();
  const selected = page
    .locator('mx-explorer')
    .first()
    .getByRole('row')
    .filter({ hasText: 'browser.txt' });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
