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
  execFileSync('docker', ['cp', 'tests/fixtures/disc.zip', `${container}:/tmp/disc.zip`]);
  exec('7zz', 'x', '-y', '-o/data/downloads/Disc fixture', '/tmp/disc.zip');
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
test('all media engines are available automatically without an extra MakeMKV setup screen', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Configuración y herramientas' }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByText('Muxplorer 0.1.5', { exact: false })).toBeVisible();
  await expect(modal.locator('.tool-item').filter({ hasText: 'MakeMKV' })).toContainText(
    'Disponible',
  );
  await expect(modal.locator('.tool-item').filter({ hasText: 'MakeMKV' })).toContainText(
    'MakeMKV v1.18.4',
  );
  await expect(modal.getByRole('button', { name: 'Habilitar MakeMKV' })).toHaveCount(0);
  await expect(modal.getByText('MakeMKV requiere instalación', { exact: false })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/visual/tools.png', fullPage: true });
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
  await modal.getByLabel('Archivo de salida').fill(resultName.replace(/\.mkv$/, ''));
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

test('progress follows HTTP snapshots even when the SSE connection stays open without updates', async ({
  page,
}) => {
  await page.addInitScript(() => {
    class SilentEvents {
      onopen?: () => void;
      onmessage?: () => void;
      onerror?: () => void;
      constructor() {
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', { value: SilentEvents });
  });
  let requests = 0;
  let progress = 98;
  await page.route('**/api/jobs', async (route) => {
    requests++;
    await route.fulfill({
      json: [
        {
          id: 'progress-poll-fixture',
          kind: 'extract',
          status: 'running',
          revision: requests,
          createdAt: '2026-10-29T08:00:00Z',
          updatedAt: new Date().toISOString(),
          sources: [{ root: 'downloads', path: 'progress-fixture.rar' }],
          destination: { root: 'plex', path: '' },
          progress,
          stage: 'Extrayendo con 7-Zip',
          messages: [],
          results: [],
        },
      ],
    });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Operaciones', exact: false }).first().click();
  const job = page
    .getByRole('complementary', { name: 'Panel de operaciones' })
    .locator('article')
    .filter({ hasText: 'progress-fixture.rar' });
  await expect(job.getByText('98%', { exact: true })).toBeVisible();
  progress = 17;
  await expect(job.getByText('17%', { exact: true })).toBeVisible({ timeout: 7000 });
  progress = 46;
  await expect(job.getByText('46%', { exact: true })).toBeVisible({ timeout: 7000 });
});

test('disc context menu offers both MKVToolNix and MakeMKV', async ({ page }) => {
  const left = page.locator('mx-explorer[panelId="left"]');
  await left.getByRole('row').filter({ hasText: 'Disc fixture' }).dblclick();
  await left.getByRole('row').filter({ hasText: /^BDMV/ }).dblclick();
  await left.getByRole('row').filter({ hasText: 'index.bdmv' }).click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Abrir con MakeMKV', exact: true }),
  ).toBeVisible();
  await page.getByRole('menuitem', { name: 'Abrir con MKVToolNix', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByText('Lista 00000.mpls', { exact: true })).toBeVisible();
  await expect(modal.getByText('00:02:05', { exact: true })).toBeVisible();
  await expect(modal.getByText('MKVTOOLNIX', { exact: true })).toBeVisible();
});

test('ISO preparation runs in background, reopens, edits track names and dismisses the completed operation', async ({
  page,
}) => {
  const left = page.locator('mx-explorer[panelId="left"]');
  await left.getByRole('row').filter({ hasText: 'Disc fixture' }).dblclick();
  await left.getByRole('row').filter({ hasText: 'bluray.iso' }).click({ button: 'right' });
  const queuedResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/disc/prepare'),
  );
  await page.getByRole('menuitem', { name: 'Abrir con MKVToolNix', exact: true }).click();
  const queued = await (await queuedResponse).json();
  await page.getByRole('button', { name: 'Continuar en segundo plano', exact: true }).click();
  const drawer = page.getByRole('complementary', { name: 'Panel de operaciones' });
  const card = drawer.locator(`[data-job-id="${queued.id}"]`);
  await card.getByRole('button', { name: 'Elegir títulos', exact: true }).click({ timeout: 10000 });
  const modal = page.getByRole('dialog');
  await expect(drawer).toHaveCount(0);
  await modal.locator('.disc-title input[type="checkbox"]').first().check();
  const base = `Plex review ${Date.now()}`;
  await modal.getByLabel('Nombre base de salida').fill(base);
  await modal.getByRole('button', { name: 'Extraer y revisar pistas', exact: true }).click();
  await page.getByRole('button', { name: 'Operaciones', exact: false }).first().click();
  await card.getByRole('button', { name: 'Revisar pistas', exact: true }).click({ timeout: 15000 });
  await expect(drawer).toHaveCount(0);
  const names = modal.getByRole('textbox', { name: 'Nombre de pista', exact: true });
  await expect(modal.locator('.track-group')).toHaveCount(3);
  await expect(modal.getByLabel('Archivo de salida')).toHaveValue(base);
  await expect(modal.locator('.source-label')).toHaveCount(0);
  await expect(modal.getByText('Sin transferencias por el navegador')).toHaveCount(0);
  const audioGroup = modal
    .locator('.track-group')
    .filter({ has: page.locator('summary', { hasText: 'Audio' }) });
  await audioGroup.locator('summary').click();
  await expect(audioGroup.locator('.track-row').first()).toBeHidden();
  await audioGroup.locator('summary').click();
  await names.first().fill('Nombre que también se elimina');
  await names.nth(1).fill('Otro nombre');
  await modal.getByRole('button', { name: 'Limpiar nombres de todas las pistas' }).click();
  for (const name of await names.all()) await expect(name).toHaveValue('');
  await modal.getByRole('textbox', { name: 'Idioma BCP 47', exact: true }).nth(1).fill('es-MX');
  await expect(audioGroup.locator('.language-flag').first()).toHaveAttribute(
    'src',
    '/language-flags/mx.svg',
  );
  for (const img of await modal.locator('.codec-flag, .language-flag').all())
    await expect
      .poll(() => img.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
  await names.first().click();
  await expect(names.first()).toBeFocused();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Plex video');
  await expect(names.first()).toHaveValue('Plex video');
  await names.nth(1).fill('Nombre que se elimina');
  await names.nth(1).click();
  await expect(names.nth(1)).toBeFocused();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await expect(names.nth(1)).toHaveValue('');
  await page.screenshot({ path: 'test-results/visual/review-editable.png', fullPage: true });
  await modal.getByRole('button', { name: 'Confirmar y crear MKV', exact: true }).click();
  await page.getByRole('button', { name: 'Operaciones', exact: false }).first().click();
  await expect(card.locator('.job-status')).toHaveText('Completado', { timeout: 15000 });
  const inspect = await page.request.post('/api/media/inspect', {
    headers: { 'X-Muxplorer': '1' },
    data: { root: 'plex', path: base + '.mkv' },
  });
  const media = await inspect.json();
  expect(media.tracks[0].name).toBe('Plex video');
  expect(media.tracks[1].name).toBe('');
  await card.getByRole('button', { name: 'Quitar de operaciones', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Operaciones', exact: false }).first().click();
  await expect(card).toHaveCount(0);
  const retained = await page.request.post('/api/media/inspect', {
    headers: { 'X-Muxplorer': '1' },
    data: { root: 'plex', path: base + '.mkv' },
  });
  expect(retained.ok()).toBeTruthy();
});

test('queued operations expose Empezar with two jobs already running', async ({ page }) => {
  let started = false;
  const stamp = '2026-10-29T10:00:00.000Z';
  const makeJob = (id: string, status: string) => ({
    id,
    kind: 'extract',
    status,
    revision: started ? 2 : 1,
    createdAt: stamp,
    updatedAt: stamp,
    progress: status === 'running' ? 15 : null,
    stage: status === 'running' ? 'Extrayendo' : 'En cola',
    sources: [{ root: 'downloads', path: id + '.rar' }],
    results: [],
    messages: [],
  });
  await page.route('**/api/jobs', (route) =>
    route.fulfill({
      json: [
        makeJob('active', 'running'),
        makeJob('requested', started ? 'running' : 'pending'),
        makeJob('waiting', 'pending'),
      ],
    }),
  );
  await page.route('**/api/jobs/requested/start', async (route) => {
    started = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Operaciones', exact: false }).first().click();
  const drawer = page.getByRole('complementary', { name: 'Panel de operaciones' });
  const requested = drawer.locator('[data-job-id="requested"]');
  await expect(requested.getByRole('button', { name: 'Empezar', exact: true })).toBeEnabled();
  await requested.getByRole('button', { name: 'Empezar', exact: true }).click();
  await expect(requested.getByText('En ejecución', { exact: true })).toBeVisible();
  await expect(
    drawer.locator('[data-job-id="waiting"]').getByRole('button', { name: 'Empezar', exact: true }),
  ).toBeEnabled();
});
