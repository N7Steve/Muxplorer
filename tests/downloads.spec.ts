import { expect, test } from '@playwright/test';

test('Descargas recibe progreso, separa ajustes, conserva el explorador y selecciona el resultado en móvil', async ({
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
  await expect(page.getByRole('heading', { name: /Descargas/ })).toBeVisible();
  await expect(page.getByText(/Gopeed v?1\.9\.3/)).toBeVisible();

  // Ajustes separados
  await page.getByRole('tab', { name: /Ajustes/ }).click();
  await page.getByRole('button', { name: 'Añadir cuenta' }).click();
  const accountDialog = page.getByRole('dialog');
  const provider = accountDialog.getByRole('combobox', { name: 'Proveedor' });
  await provider.selectOption('1fichier-web');
  await expect(accountDialog.getByLabel(/Correo de 1fichier/)).toBeVisible();
  await expect(accountDialog.getByLabel('Contraseña', { exact: true })).toBeVisible();
  await provider.selectOption('1fichier');
  await accountDialog.getByLabel('Nombre de la cuenta').fill('Cuenta de prueba');
  await accountDialog.getByLabel('Clave API', { exact: true }).fill('fixture-secret-account');
  await accountDialog.getByRole('button', { name: 'Guardar cuenta' }).click();
  await expect(page.getByRole('list', { name: 'Cuentas guardadas' })).toContainText(
    'Cuenta de prueba',
  );
  await page.getByRole('button', { name: 'Editar Cuenta de prueba' }).click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: /Clave API/ })).toHaveValue(
    '',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click();
  await page.getByRole('button', { name: 'Eliminar cuenta Cuenta de prueba' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Eliminar cuenta' }).click();
  await expect(page.getByRole('list', { name: 'Cuentas guardadas' })).toHaveCount(0);

  // Carpeta predeterminada desde modal
  await page.getByRole('button', { name: 'Cambiar carpeta' }).click();
  const folder = page.getByRole('dialog', { name: 'Elegir carpeta predeterminada' });
  await folder.getByRole('row').filter({ hasText: 'FixturePack' }).dblclick();
  await folder.getByRole('button', { name: 'Guardar como predeterminada' }).click();
  await expect(page.getByText('Carpeta predeterminada guardada.').first()).toBeVisible();

  // Capturador de enlaces
  await page.getByRole('tab', { name: /Capturador/ }).click();
  await page.getByRole('button', { name: /Elegir carpeta del lote/ }).click();
  const batchFolder = page.getByRole('dialog', { name: 'Elegir carpeta del lote' });
  await batchFolder.getByRole('button', { name: 'Carpeta superior' }).click();
  await batchFolder.getByRole('button', { name: 'Usar esta carpeta' }).click();

  const links = page.getByLabel('Enlaces de descarga');
  await links.fill(
    [
      'http://fixture:8080/browser.txt',
      'http://fixture:8080/slow.bin',
      'http://fixture:8080/browser.part01.rar',
      'http://fixture:8080/browser.part03.rar',
      'http://fixture:8080/4RMGU',
      'http://fixture:8080/unknown-size.bin',
      'http://fixture:8080/unavailable.html',
      ...Array.from({ length: 21 }, (_, index) => 'http://fixture:8080/missing-' + index + '.bin'),
    ].join('\n'),
  );
  await page.getByRole('button', { name: 'Comprobar enlaces' }).click();
  const captured = page.getByRole('region', { name: 'Enlaces capturados' });
  await expect(captured.getByText('28 de 28 comprobados')).toBeVisible();
  await expect(captured.getByText('Fuera de línea', { exact: true })).toHaveCount(21);
  await expect(captured.getByText('Paquete incompleto')).toBeVisible();

  const allOnline = captured.getByRole('checkbox', { name: 'Seleccionar todos en línea' });
  const add = captured.getByRole('button', { name: 'Añadir seleccionados a descargas' });
  const selection = captured.getByRole('status').filter({ hasText: 'seleccionado' });
  await expect(allOnline).toBeChecked();
  await captured.getByRole('button', { name: 'Dudosos 3' }).click();
  await expect(captured.getByText('Dudoso', { exact: true })).toHaveCount(3);
  await expect(captured.getByText('Archivo sin extensión.')).toBeVisible();
  await expect(captured.getByText('Tamaño sin confirmar.')).toBeVisible();
  await expect(captured.getByText('El enlace puede apuntar a una página web.')).toBeVisible();
  await expect(captured.getByText('browser.txt', { exact: true })).toHaveCount(0);
  const warningLink = captured.getByRole('checkbox', { name: /4RMGU/ });
  await expect(warningLink).not.toBeChecked();
  await warningLink.check();
  await expect(selection).toContainText('5 seleccionados');
  await captured.getByRole('button', { name: 'Deseleccionar todo' }).click();
  await expect(warningLink).not.toBeChecked();
  await expect(allOnline).not.toBeChecked();
  await expect(add).toBeDisabled();
  await captured.getByRole('button', { name: 'Volver a comprobar' }).click();
  await expect(allOnline).toBeEnabled();
  await expect(add).toBeDisabled();
  await captured.getByRole('button', { name: 'En línea 4' }).click();
  const singleLink = captured.getByRole('checkbox', { name: 'browser.txt', exact: true });
  await singleLink.check();
  await expect(selection).toContainText('1 seleccionado ·');
  await expect(add).toBeEnabled();
  await allOnline.check();
  await expect(selection).toContainText('4 seleccionados');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1512, height: 982 });

  await add.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Añadir partes disponibles' }).click();

  // Cola de descargas (se abre automáticamente al añadir)
  const queue = page.getByRole('list', { name: 'Descargas', exact: true });
  await expect(queue.getByText('Paquete incompleto · 1 pendientes')).toBeVisible();
  await queue.getByRole('button', { name: /browser\.rar/ }).click();
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
  await expect(page.getByRole('heading', { name: /Descargas/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('tab', { name: /Ajustes/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('tab', { name: /Cola/ }).click();
  await result.getByRole('button', { name: 'Abrir en el explorador' }).click();
  const selected = page
    .locator('mx-explorer')
    .first()
    .getByRole('row')
    .filter({ hasText: 'browser.txt' });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
