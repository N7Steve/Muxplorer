import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const container = process.env.MUXPLORER_TEST_CONTAINER;
const safe = !!container && /^muxplorer-smoke-\d+$/.test(container);
test.skip(
  !safe,
  'Requires an isolated muxplorer-smoke-* container; never seed production datasets.',
);
test.beforeAll(() => {
  if (!safe) return;
  const exec = (...args: string[]) =>
    execFileSync('docker', ['exec', container!, ...args], { stdio: 'pipe' });
  exec(
    'node',
    '-e',
    String.raw`const f=require('fs'), p='/data/downloads/';
    for(const n of ['Colección de prueba','Subtítulos','Pendientes']) f.mkdirSync(p+n,{recursive:true});
    const b=Buffer.alloc(16044);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(16000,40);f.writeFileSync(p+'Muestra.wav',b);
    f.writeFileSync(p+'Original.srt','1\n00:00:00,000 --> 00:00:00,800\nHello\n');
    f.writeFileSync(p+'Subtítulos/Castellano.srt','1\n00:00:00,000 --> 00:00:00,800\nHola\n');
    f.writeFileSync(p+'Notas.txt','Fixtures pequeñas para validar Muxplorer.');
    f.mkdirSync('/data/plex/Películas',{recursive:true});f.mkdirSync('/data/plex/Series',{recursive:true});f.mkdirSync('/data/plex/Documentales',{recursive:true});`,
  );
  exec(
    'mkvmerge',
    '-o',
    '/data/downloads/Muestra.mkv',
    '/data/downloads/Muestra.wav',
    '/data/downloads/Original.srt',
  );
  exec('7zz', 'a', '-tzip', '/data/downloads/Archivo de prueba.zip', '/data/downloads/Notas.txt');
  mkdirSync('test-results/visual', { recursive: true });
});
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Nombre de usuario').fill('mux-admin');
  await page.getByLabel('Contraseña de administrador').fill('Muxplorer-test-password-2026');
  await page.getByRole('button', { name: 'Entrar en Muxplorer' }).click();
  await expect(page.getByRole('heading', { name: 'Explorador de archivos.' })).toBeVisible();
});
test('desktop explorer, multimedia context menus and exact external-track selection work', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const left = page.locator('mx-explorer[panelId="left"]');
  const sample = left.getByRole('row').filter({ hasText: 'Muestra.mkv' });
  await expect(sample).toBeVisible();
  await expect(page.locator('.panels')).toHaveCSS('display', 'flex');
  await sample.click();
  await page.screenshot({ path: 'test-results/visual/explorer.png', fullPage: true });
  await sample.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Abrir con MKVToolNix' }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.locator('.track-row')).toHaveCount(2);
  await modal.getByRole('button', { name: 'Añadir audio o subtítulos' }).click();
  const picker = page.locator('mx-explorer[panelId="picker"]');
  await picker.getByLabel('Raíz de almacenamiento').selectOption('downloads');
  await picker.getByRole('row').filter({ hasText: 'Subtítulos' }).dblclick();
  await picker.getByRole('row').filter({ hasText: 'Castellano.srt' }).dblclick();
  await expect(modal.locator('.track-row')).toHaveCount(3);
  await modal.getByLabel('Título del MKV').fill('Prueba desde el navegador');
  const resultName = `Resultado UI ${Date.now()}.mkv`;
  await modal.getByLabel('Archivo de salida').fill(resultName);
  await modal.locator('.track-row').nth(1).getByRole('checkbox').first().uncheck();
  await page.screenshot({ path: 'test-results/visual/remux.png', fullPage: true });
  await modal.getByRole('button', { name: 'Crear MKV', exact: true }).click();
  await expect(
    page.locator('mx-explorer[panelId="right"]').getByRole('row').filter({ hasText: resultName }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test('archive extraction uses visual destination picker and updates the other panel', async ({
  page,
}) => {
  const left = page.locator('mx-explorer[panelId="left"]');
  await left
    .getByRole('row')
    .filter({ hasText: 'Archivo de prueba.zip' })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Extraer…', exact: true }).click();
  const modal = page.getByRole('dialog');
  const folderName = `Extraído desde UI ${Date.now()}`;
  await modal.getByLabel('Nombre de subcarpeta').fill(folderName);
  await modal.getByRole('button', { name: /PlexMedia.*Cambiar/ }).click();
  await page.locator('.picker-footer').getByRole('button', { name: 'Usar esta carpeta' }).click();
  await page.screenshot({ path: 'test-results/visual/extract.png', fullPage: true });
  await modal.getByRole('button', { name: 'Extraer', exact: true }).click();
  await expect(
    page.locator('mx-explorer[panelId="right"]').getByRole('row').filter({ hasText: folderName }),
  ).toBeVisible();
});
test('multiple selection, drag and drop confirmation and mobile layout', async ({ page }) => {
  const left = page.locator('mx-explorer[panelId="left"]');
  await left.getByRole('row').filter({ hasText: 'Colección de prueba' }).click();
  await left
    .getByRole('row')
    .filter({ hasText: 'Pendientes' })
    .click({ modifiers: ['Control'] });
  await expect(left.getByRole('row', { selected: true })).toHaveCount(2);
  const from = await left.getByRole('row').filter({ hasText: 'Pendientes' }).boundingBox();
  const to = await page.locator('mx-explorer[panelId="right"] .file-list').boundingBox();
  if (!from || !to) throw new Error('Missing explorer bounds');
  await page.mouse.move(from.x + 60, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + 80, from.y + 20, { steps: 5 });
  await page.mouse.move(to.x + 100, to.y + 180, { steps: 25 });
  await page.mouse.up();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('heading', { name: 'Transferir archivos' })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Copiar aquí' })).toBeVisible();
  await modal.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/visual/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
