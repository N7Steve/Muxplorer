import { test, expect } from '@playwright/test';
test('authenticated explorer performs real folder operations and displays custom confirmations', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page
    .getByLabel('Nombre de usuario')
    .fill(process.env.MUXPLORER_TEST_USERNAME ?? 'mux-admin');
  await page
    .getByLabel('Contraseña de administrador')
    .fill(process.env.MUXPLORER_TEST_PASSWORD ?? 'Muxplorer-test-password-2026');
  await page.getByRole('button', { name: 'Entrar en Muxplorer' }).click();
  await expect(page.getByRole('heading', { name: 'Explorador de archivos.' })).toBeVisible();
  const left = page.locator('mx-explorer[panelId="left"]');
  await expect(left.getByRole('grid', { name: 'Archivos' })).toBeVisible();
  await page.getByRole('button', { name: 'Nueva carpeta', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const name = `UI fixture ${Date.now()}`;
  await dialog.getByLabel('Nombre', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Crear carpeta' }).click();
  const row = left.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Renombrar/ }).click();
  await dialog.getByLabel('Nombre', { exact: true }).fill(`${name} renamed`);
  await dialog.getByRole('button', { name: 'Guardar nombre' }).click();
  const renamed = left.getByRole('row').filter({ hasText: `${name} renamed` });
  await expect(renamed).toBeVisible();
  await renamed.click();
  await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
  await expect(dialog.getByText('Esta eliminación es permanente')).toBeVisible();
  await dialog.getByRole('button', { name: 'Eliminar definitivamente' }).click();
  await expect(renamed).toHaveCount(0);
  await page.getByRole('button', { name: 'Operaciones', exact: false }).first().click();
  await expect(page.getByRole('complementary', { name: 'Panel de operaciones' })).toBeVisible();
  expect(errors).toEqual([]);
});
