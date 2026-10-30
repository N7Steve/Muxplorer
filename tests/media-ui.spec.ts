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
  await expect(page.locator('.panels')).toBeVisible();
});

test('MediaInfo can be minimized, restored and compared with another file', async ({ page }) => {
  const left = page.locator('mx-explorer[panelId="left"]');
  await left.getByRole('row').filter({ hasText: 'Muestra.mkv' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Ver MediaInfo', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.locator('.mediainfo-table')).toBeVisible();
  await expect(modal.locator('.mediainfo-table')).toContainText('PCM');
  await modal.getByRole('button', { name: 'Minimizar a Operaciones' }).click();
  await expect(page.getByRole('button', { name: 'Ver MediaInfo', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar operaciones', exact: true }).click();
  await left.getByRole('row').filter({ hasText: 'Muestra.wav' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Añadir a comparación', exact: true }).click();
  await expect(modal.locator('.mediainfo-table thead th')).toHaveCount(3);
  await expect(modal.locator('.mediainfo-different')).not.toHaveCount(0);
  await modal.getByLabel('Solo diferencias').check();
  await expect(modal.locator('tbody tr:not(.mediainfo-different)')).toHaveCount(0);
  await modal.getByRole('button', { name: 'Minimizar a Operaciones' }).click();
  await page.getByRole('button', { name: 'Ver MediaInfo', exact: true }).click();
  await expect(modal.locator('.mediainfo-table thead th')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/visual/mediainfo-comparison.png', fullPage: true });
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
test('desktop explorer opens MKVToolNix on double click and remuxes selected tracks', async ({
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
  await sample.dblclick();
  const modal = page.getByRole('dialog');
  await expect(modal.locator('.track-row')).toHaveCount(2);
  await expect(modal.getByRole('button', { name: 'Añadir audio o subtítulos' })).toHaveCount(0);
  await expect(modal.getByRole('heading', { name: 'Muestra.mkv' })).toBeVisible();
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

for (const action of ['Editar tags sin remuxear', 'Abrir con MKVToolNix']) {
  test(`${action} waits for all properties before revealing the form`, async ({ page }) => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/media/inspect', async (route) => {
      const response = await route.fetch();
      await ready;
      await route.fulfill({ response });
    });
    const left = page.locator('mx-explorer[panelId="left"]');
    await left.getByRole('row').filter({ hasText: 'Muestra.mkv' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: action, exact: true }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByText('Cargando propiedades…', { exact: true })).toBeVisible();
    await expect(modal.locator('.modal-body, .track-row')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: /Guardar tags|Crear MKV/ })).toHaveCount(0);
    await expect(page.locator('.modal-backdrop')).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: `test-results/visual/loader-${action.startsWith('Editar') ? 'tags' : 'remux'}.png`,
    });
    release();
    await expect(modal.locator('.track-row')).toHaveCount(2);
    await expect(modal.locator('.modal-loader')).toHaveCount(0);
    await expect(modal.locator('.modal-body')).toHaveCSS('animation-name', 'modal-reveal');
    if (action.startsWith('Editar')) {
      await expect(modal.locator('.modal-body')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: 'test-results/visual/properties-ready.png' });
    }
  });
}

test('property loading can be cancelled and errors never reveal a partial form', async ({
  page,
}) => {
  let fail = false;
  await page.route('**/api/media/inspect', async (route) => {
    if (fail)
      await route.fulfill({
        status: 400,
        json: { message: 'Espera a que terminen las operaciones que usan este archivo.' },
      });
    // Leave the first request pending until the user cancels it.
  });
  const row = page
    .locator('mx-explorer[panelId="left"]')
    .getByRole('row')
    .filter({ hasText: 'Muestra.mkv' });
  const open = async () => {
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Editar tags sin remuxear' }).click();
  };
  await open();
  const modal = page.getByRole('dialog');
  await expect(modal.locator('.modal-loader')).toBeVisible();
  await modal.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(modal).toHaveCount(0);
  fail = true;
  await open();
  await expect(modal.getByRole('alert')).toContainText('Espera a que terminen');
  await expect(modal.getByRole('textbox')).toHaveCount(0);
  await expect(modal.getByRole('button', { name: 'Guardar tags' })).toHaveCount(0);
  await modal.getByRole('button', { name: 'Cerrar', exact: true }).click();
});

test('MakeMKV hides the disc form until its analysis finishes', async ({ page }) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/makemkv/inspect', async (route) => {
    await ready;
    await route.fulfill({
      json: {
        location: { root: 'downloads', path: 'Disc fixture/BDMV/index.bdmv' },
        titles: [
          {
            id: 0,
            name: 'Película de prueba',
            duration: '00:02:05',
            size: '10 MB',
            chapters: 1,
            streams: [],
          },
        ],
      },
    });
  });
  const left = page.locator('mx-explorer[panelId="left"]');
  await left.getByRole('row').filter({ hasText: 'Disc fixture' }).dblclick();
  await left.getByRole('row').filter({ hasText: /^BDMV/ }).dblclick();
  await left.getByRole('row').filter({ hasText: 'index.bdmv' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Abrir con MakeMKV', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByText('Analizando el disco…', { exact: true })).toBeVisible();
  await expect(modal.locator('.modal-body, .destination-card')).toHaveCount(0);
  release();
  await expect(modal.getByText('Película de prueba', { exact: true })).toBeVisible();
  await expect(modal.locator('.destination-card')).toBeVisible();
});

test('MKV metadata editor saves track names, languages and flags in place without a remux job', async ({
  page,
}) => {
  const left = page.locator('mx-explorer[panelId="left"]');
  await left.getByRole('row').filter({ hasText: 'Muestra.mkv' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Editar tags sin remuxear' }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('heading', { name: 'Editar tags del MKV' })).toBeVisible();
  await expect(modal.locator('.track-row')).toHaveCount(2);
  await expect(modal.locator('.drag-handle, .track-select')).toHaveCount(0);
  await expect(modal.getByLabel('Archivo de salida')).toHaveCount(0);
  await modal.getByLabel('Título del MKV').fill('Título editado');
  await modal
    .getByRole('textbox', { name: 'Nombre de pista', exact: true })
    .first()
    .fill('Audio renombrado');
  await modal.getByRole('textbox', { name: 'Idioma BCP 47', exact: true }).first().fill('es-MX');
  await modal.getByRole('checkbox', { name: 'Pista predeterminada', exact: true }).first().check();
  const rows = modal.locator('.track-row');
  expect((await rows.first().boundingBox())!.height).toBeLessThanOrEqual(68);
  await page.screenshot({ path: 'test-results/visual/metadata-editor.png', fullPage: true });
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/media/metadata'));
  await modal.getByRole('button', { name: 'Guardar tags', exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(modal).toHaveCount(0);
  const response = await page.request.post('/api/media/inspect', {
    headers: { 'X-Muxplorer': '1' },
    data: { root: 'downloads', path: 'Muestra.mkv' },
  });
  const media = await response.json();
  expect(media.title).toBe('Título editado');
  expect(media.tracks[0].name).toBe('Audio renombrado');
  expect(media.tracks[0].language).toBe('es-MX');
  expect(media.tracks[0].default).toBe(true);
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

test('BDMV context menu offers only MakeMKV and double click uses it', async ({ page }) => {
  const left = page.locator('mx-explorer[panelId="left"]');
  await left.getByRole('row').filter({ hasText: 'Disc fixture' }).dblclick();
  await left.getByRole('row').filter({ hasText: /^BDMV/ }).dblclick();
  await left.getByRole('row').filter({ hasText: 'index.bdmv' }).click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Abrir con MakeMKV', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Abrir con MKVToolNix', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await left.getByRole('row').filter({ hasText: 'index.bdmv' }).dblclick();
  const modal = page.getByRole('dialog');
  await expect(modal.getByText('MAKEMKV', { exact: true })).toBeVisible();
  await expect(modal.getByLabel('Nombre base de salida')).toHaveValue('Disc fixture');
  await expect(modal.getByLabel('Título del MKV')).toHaveValue('Disc fixture');
});

test('MakeMKV ISO flow preserves filename and title, edits tracks and collapses completed operations', async ({
  page,
}) => {
  const left = page.locator('mx-explorer[panelId="left"]');
  await left.getByRole('row').filter({ hasText: 'Disc fixture' }).dblclick();
  await left.getByRole('row').filter({ hasText: 'bluray.iso' }).click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Abrir con MKVToolNix', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await left.getByRole('row').filter({ hasText: 'bluray.iso' }).dblclick();
  const modal = page.getByRole('dialog');
  await modal.locator('.disc-title input[type="checkbox"]').first().check();
  const base = `Plex review ${Date.now()}`;
  await modal.getByLabel('Nombre base de salida').fill(base);
  await modal.getByLabel('Título del MKV').fill('Título del disco');
  const queuedResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/makemkv/convert'),
  );
  await modal.getByRole('button', { name: 'Extraer y revisar pistas', exact: true }).click();
  const queued = await (await queuedResponse).json();
  const drawer = page.getByRole('complementary', { name: 'Panel de operaciones' });
  const card = drawer.locator(`[data-job-id="${queued.id}"]`);
  await page.getByRole('button', { name: 'Operaciones', exact: false }).first().click();
  await card.getByRole('button', { name: 'Revisar pistas', exact: true }).click({ timeout: 15000 });
  await expect(drawer).toHaveCount(0);
  const names = modal.getByRole('textbox', { name: 'Nombre de pista', exact: true });
  await expect(modal.locator('.track-group')).toHaveCount(3);
  await expect(modal.getByLabel('Archivo de salida')).toHaveValue(base);
  await expect(modal.getByLabel('Título del MKV')).toHaveValue('Título del disco');
  await modal.getByLabel('Título del MKV').fill('Título final del MKV');
  await expect(modal.locator('.source-label')).toHaveCount(0);
  await expect(modal.locator('.track-description').first()).not.toContainText('#');
  await expect(modal.locator('.track-codec-logo .codec-flag').first()).toBeVisible();
  await expect(modal.locator('.codec-flag').first()).toHaveCSS('max-width', '80px');
  await expect(
    modal
      .locator('.modal-footer')
      .getByRole('button', { name: 'Limpiar nombres de todas las pistas' }),
  ).toBeVisible();
  await expect(modal.getByText('Sin transferencias por el navegador')).toHaveCount(0);
  const videoGroup = modal
    .locator('.track-group')
    .filter({ has: page.locator('summary', { hasText: 'Vídeo' }) });
  await videoGroup.locator('summary').click();
  await expect(videoGroup.locator('.track-row').first()).toBeHidden();
  await videoGroup.locator('summary').click();
  await names.first().fill('Nombre que también se elimina');
  for (const name of await names.all()) await name.fill('Nombre que se elimina');
  await modal.getByRole('button', { name: 'Limpiar nombres de todas las pistas' }).click();
  for (const name of await names.all()) await expect(name).toHaveValue('');
  await modal.getByRole('textbox', { name: 'Idioma BCP 47', exact: true }).first().fill('es-MX');
  await expect(videoGroup.locator('.language-flag').first()).toHaveAttribute(
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
  await names.first().click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await expect(names.first()).toHaveValue('');
  await names.first().fill('Plex video');
  await page.screenshot({ path: 'test-results/visual/review-editable.png', fullPage: true });
  await modal.getByRole('button', { name: 'Confirmar y crear MKV', exact: true }).click();
  await page.getByRole('button', { name: 'Operaciones', exact: false }).first().click();
  await expect(card.locator('.job-status')).toHaveText('Completado', { timeout: 15000 });
  await expect(card).toHaveClass(/job-compact/);
  await expect(card.locator('.job-stage')).toHaveCount(0);
  await card.getByRole('button', { name: 'Expandir', exact: true }).click();
  await expect(card.locator('.job-stage')).toBeVisible();
  const inspect = await page.request.post('/api/media/inspect', {
    headers: { 'X-Muxplorer': '1' },
    data: { root: 'plex', path: base + '.mkv' },
  });
  const media = await inspect.json();
  expect(media.title).toBe('Título final del MKV');
  expect(media.tracks[0].name).toBe('Plex video');
  expect(media.tracks[0].language).toBe('es-MX');
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

test('context shortcuts copy and move directly into the folder open in the opposite panel', async ({
  page,
}) => {
  const left = page.locator('mx-explorer[panelId="left"]');
  const right = page.locator('mx-explorer[panelId="right"]');
  const calls: unknown[] = [];
  await page.route('**/api/files/operation', async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { ok: true } });
  });
  await right
    .getByRole('row')
    .filter({ hasText: /^Películas/ })
    .dblclick();
  await left.getByRole('row').filter({ hasText: 'Notas.txt' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copiar al panel de al lado', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls[0]).toEqual({
    kind: 'copy',
    sources: [{ root: 'downloads', path: 'Notas.txt' }],
    destination: { root: 'plex', path: 'Películas' },
  });
  // A folder works too, and the destination follows navigation in the other panel.
  await left.getByRole('row').filter({ hasText: 'Colección de prueba' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mover al panel de al lado', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls[1]).toEqual({
    kind: 'move',
    sources: [{ root: 'downloads', path: 'Colección de prueba' }],
    destination: { root: 'plex', path: 'Películas' },
  });
  await right.getByRole('button', { name: 'Carpeta superior' }).click();
  await right
    .getByRole('row')
    .filter({ hasText: /^Series/ })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copiar al panel de al lado', exact: true }).click();
  expect(calls[2]).toEqual({
    kind: 'copy',
    sources: [{ root: 'plex', path: 'Series' }],
    destination: { root: 'downloads', path: '' },
  });
});
