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
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('button', { name: 'Añadir cuenta' }).click();
  await page.getByLabel('Nombre de la cuenta').fill('Cuenta de prueba');
  await page.getByLabel('Clave API').fill('fixture-secret-account');
  await page.getByRole('button', { name: 'Guardar cuenta' }).click();
  await expect(page.getByRole('list', { name: 'Cuentas guardadas' })).toContainText(
    'Cuenta de prueba',
  );
  await page.getByRole('button', { name: 'Editar Cuenta de prueba' }).click();
  await expect(page.getByLabel('Clave API')).toHaveValue('');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Eliminar cuenta Cuenta de prueba' }).click();
  await expect(page.getByRole('list', { name: 'Cuentas guardadas' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cambiar carpeta' }).click();
  const folder = page.getByRole('region', { name: 'Elegir carpeta predeterminada' });
  await folder.getByRole('row').filter({ hasText: 'FixturePack' }).dblclick();
  await page.getByRole('button', { name: 'Guardar como predeterminada' }).click();
  await expect(page.getByText('Carpeta predeterminada guardada.')).toBeVisible();
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('button', { name: 'Elegir carpeta del lote' }).click();
  await page
    .getByRole('region', { name: 'Elegir carpeta del lote' })
    .getByRole('button', { name: 'Carpeta superior' })
    .click();
  await page.getByRole('button', { name: 'Usar esta carpeta' }).click();
  const links = page.getByLabel('Enlaces de descarga');
  await links.fill(
    [
      'http://fixture:8080/browser.txt',
      'http://fixture:8080/slow.bin',
      'http://fixture:8080/browser.part01.rar',
      'http://fixture:8080/browser.part03.rar',
      ...Array.from({ length: 21 }, (_, index) => 'http://fixture:8080/missing-' + index + '.bin'),
    ].join('\n'),
  );
  await page.getByRole('button', { name: 'Comprobar enlaces' }).click();
  const captured = page.getByRole('region', { name: 'Enlaces capturados' });
  await expect(captured.getByText('25 de 25 comprobados · 4 en línea')).toBeVisible();
  await expect(captured.getByText('Fuera de línea')).toHaveCount(21);
  await expect(captured.getByText('Paquete incompleto')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Añadir seleccionados a descargas' }).click();
  const queue = page.getByRole('list', { name: 'Descargas', exact: true });
  await expect(queue.getByText('Paquete incompleto · 1 pendientes')).toBeVisible();
  await queue.getByText('browser.rar', { exact: true }).click();
  await expect(queue.getByText('browser.part03.rar', { exact: true })).toBeVisible();
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
