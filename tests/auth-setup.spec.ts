import { test, expect } from '@playwright/test';

test('first launch creates the only administrator without a token and requires both credentials later', async ({
  page,
}) => {
  test.skip(
    process.env.MUXPLORER_EXPECT_SETUP !== 'true',
    'Only run against a fresh isolated container.',
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Crear administrador' })).toBeVisible();
  await expect(page.getByText('Token de configuración', { exact: true })).toHaveCount(0);
  await page.getByLabel('Nombre de usuario').fill('mux-admin');
  await page.getByLabel('Contraseña de administrador').fill('Muxplorer-test-password-2026');
  await page.getByRole('button', { name: 'Crear administrador' }).click();
  await expect(page.locator('.panels')).toBeVisible();
  await page.reload();
  await expect(page.locator('.panels')).toBeVisible();
  await page.getByRole('button', { name: 'Perfil', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Cerrar sesión', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Crear administrador' })).toHaveCount(0);
  await page.getByLabel('Nombre de usuario').fill('another-user');
  await page.getByLabel('Contraseña de administrador').fill('Muxplorer-test-password-2026');
  await page.getByRole('button', { name: 'Entrar en Muxplorer' }).click();
  await expect(page.getByRole('alert')).toContainText('Usuario o contraseña incorrectos');
  await page.getByLabel('Nombre de usuario').fill('mux-admin');
  await page.getByRole('button', { name: 'Entrar en Muxplorer' }).click();
  await expect(page.locator('.panels')).toBeVisible();
});
