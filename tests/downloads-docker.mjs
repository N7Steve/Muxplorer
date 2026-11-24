import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'mux-dl-'));
const project = 'mux-dl-' + Date.now();
const fixture = project + '-fixture';
const image = process.env.MUXPLORER_IMAGE ?? 'muxplorer:0.4.1';
const token = randomBytes(32).toString('hex');
const username = 'download-admin';
const password = 'Muxplorer-download-test-2026';
const env = {
  ...process.env,
  PUID: '1000',
  PGID: '1000',
  WEB_PORT: '127.0.0.1:',
  MUX_GOPEED_URL: 'http://gopeed:9999',
  MUX_GOPEED_TOKEN: token,
};
const docker = (...args) =>
  execFileSync('docker', args, {
    env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const override = path.join(temporary, 'compose.yml');
const envFile = path.join(temporary, '.env');
const compose = (...args) =>
  docker(
    'compose',
    '--env-file',
    envFile,
    '-p',
    project,
    '-f',
    'docker-compose.yml',
    '-f',
    override,
    '--profile',
    'downloads',
    ...args,
  );
// One torrent piece, served entirely by the isolated HTTP fixture through BEP 19.
const pack = 'FixturePack';
const piece = createHash('sha1').update(Buffer.alloc(24, 65)).digest();
const info = Buffer.concat([
  Buffer.from(
    'd5:filesld6:lengthi12e4:pathl9:first.txteed6:lengthi12e4:pathl6:nested10:second.txteee4:name11:FixturePack12:piece lengthi16384e6:pieces20:',
  ),
  piece,
  Buffer.from('e'),
]);
const metadata = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
const magnet = new URL('magnet:');
magnet.searchParams.set('xt', 'urn:btih:' + createHash('sha1').update(info).digest('hex'));
magnet.searchParams.set('xs', 'http://fixture:8080/local.torrent');
magnet.searchParams.set('ws', 'http://fixture:8080/seed/');
const fixtureCode = String.raw`
  const http = require('node:http');
  http.createServer((req, res) => {
    const name = new URL(req.url, 'http://fixture').pathname.slice(1);
    if (name.startsWith('missing')) {
      res.writeHead(404).end();
      return;
    }
    if (name === 'local.torrent') {
      const data = Buffer.from(process.argv[1], 'base64');
      res.writeHead(200, { 'Content-Type': 'application/x-bittorrent', 'Content-Length': data.length });
      res.end(data);
      return;
    }
    const slow = name === 'slow.bin' || name === 'cancel.bin';
    const size = slow ? 1024 * 1024 : 12;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + size }).end();
      return;
    }
    res.writeHead(range ? 206 : 200, {
      'Content-Length': end - start + 1,
      'Content-Disposition': 'attachment; filename="' + name + '"',
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + size } : {}),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    if (!slow) { res.end(Buffer.alloc(size, 65)); return; }
    let remaining = end - start + 1;
    const timer = setInterval(() => {
      const length = Math.min(16 * 1024, remaining);
      remaining -= length;
      res.write(Buffer.alloc(length, 66));
      if (!remaining) res.end();
    }, 450);
    res.on('close', () => clearInterval(timer));
  }).listen(8080, '0.0.0.0');
`;

// Exercise the real MEGA decryption library without contacting remote services.
const megaFixture = String.raw`
  const assert = require('node:assert/strict');
  const { randomUUID, createCipheriv } = require('node:crypto');
  const { mkdir, mkdtemp, readFile, rm } = require('node:fs/promises');
  const { setTimeout: delay } = require('node:timers/promises');
  const { encrypt } = require('megajs');
  require('reflect-metadata');
  const { Store } = require('./dist/store');
  const { DownloadAccounts } = require('./dist/download-accounts');
  const { MegaDownloads } = require('./dist/mega-downloads');
  const { DownloadPublication } = require('./dist/download-publication');
  const { Files } = require('./dist/files');
  const { Processes } = require('./dist/process');
  const { Paths } = require('./dist/paths');

  async function main() {
    const content = Buffer.from('Test payload for MEGA');
    const key = Buffer.alloc(24, 42);
    const encoder = encrypt(key);
    encoder.end(Buffer.from(content));
    const chunks = [];
    for await (const chunk of encoder) chunks.push(chunk);
    const ciphertext = Buffer.concat(chunks);
    const attributes = Buffer.alloc(32);
    attributes.write('MEGA{"n":"mega-fixture.txt"}');
    const cipher = createCipheriv('aes-128-cbc', key.subarray(0, 16), Buffer.alloc(16));
    cipher.setAutoPadding(false);
    const at = Buffer.concat([cipher.update(attributes), cipher.final()]).toString('base64url');
    const source = 'https://mega.nz/file/AbCd1234#' + encoder.key.toString('base64url');
    let corrupt = false;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      if (url.hostname === 'g.api.mega.co.nz') {
        const [request] = JSON.parse(init.body);
        assert.equal(request.p, 'AbCd1234');
        return Response.json([{ at, s: content.length, g: 'https://fixture.userstorage.mega.co.nz/file' }]);
      }
      assert.equal(url.hostname, 'fixture.userstorage.mega.co.nz');
      return new Response(corrupt ? Buffer.alloc(ciphertext.length) : ciphertext);
    };
    const root = await mkdtemp('/tmp/mux-mega-');
    const store = new Store(root + '/config');
    const volumes = { downloads: root + '/downloads', plex: root + '/plex' };
    const stage = root + '/stage';
    const publication = new DownloadPublication(new Files(new Paths(volumes), new Processes()), stage);
    const accounts = new DownloadAccounts(store);
    const mega = new MegaDownloads(store, accounts, publication);
    try {
      await Promise.all([...Object.values(volumes), stage].map((name) => mkdir(name)));
      for (const expected of ['done', 'failed']) {
        const requestId = randomUUID();
        await publication.createStage(requestId);
        const id = mega.add(source, requestId);
        const deadline = Date.now() + 5000;
        while (mega.get(id).status === 'running' && Date.now() < deadline) await delay(20);
        const task = mega.get(id);
        assert.equal(task.status, expected, task.error);
        if (!corrupt) {
          await assert.rejects(mega.pause(id), { kind: 'rejected' });
          const prepared = await publication.prepare(requestId, task);
          await publication.commit(requestId, prepared, () => {}, () => {});
          assert.deepEqual(await readFile(volumes.downloads + '/mega-fixture.txt'), content);
        }
        await mega.remove(id);
        corrupt = true;
      }
    } finally {
      await mega.onModuleDestroy();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  }
  main().catch((error) => { console.error(error); process.exitCode = 1; });
`;

let base,
  cookie = '';
async function request(
  endpoint,
  { body, status = 200, auth = true, headers = {}, prefix = '/api/' } = {},
) {
  const response = await fetch(base + prefix + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Muxplorer': '1',
      Connection: 'close',
      ...(auth ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const data = await response.json();
  assert.equal(response.status, status, endpoint + ': ' + JSON.stringify(data));
  assert.ok(!JSON.stringify(data).includes(token));
  assert.ok(!JSON.stringify(data).includes('fixture-secret'));
  return data;
}
async function until(label, action, accept) {
  const deadline = Date.now() + 65_000;
  let latest;
  while (Date.now() < deadline) {
    let current;
    try {
      current = await action();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    if (accept(current)) return current;
    if (current !== undefined) latest = current;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(
    'Tiempo agotado: ' +
      label +
      '\nÚltimo estado: ' +
      JSON.stringify(latest) +
      (base ? '\n' + compose('logs', 'muxplorer').slice(-2500) : ''),
  );
}
const status = () => request('downloads/status');
const task = (id) => request('downloads/' + id);
const fixtureUrl = (name) => 'http://fixture:8080/' + name + '?key=fixture-secret';
async function create(name, url = fixtureUrl(name), destination) {
  const id = randomUUID();
  const result = await request('downloads', {
    status: 201,
    body: { links: [{ id, url }], destination },
  });
  assert.deepEqual(result.ids, [id]);
  return id;
}
const command = (id, action) =>
  request('downloads/' + id + '/' + action, { body: {}, status: 201 });
const frontFile = (name) => '/data/downloads/' + name;
const file = (name) =>
  Buffer.from(
    compose(
      'exec',
      '-T',
      'muxplorer',
      'node',
      '-e',
      "process.stdout.write(require('node:fs').readFileSync(process.argv[1]).toString('base64'))",
      frontFile(name),
    ),
    'base64',
  );

try {
  writeFileSync(envFile, '');
  writeFileSync(
    override,
    JSON.stringify({
      services: {
        muxplorer: {
          image,
          volumes: ['fixture_downloads:/data/downloads', 'fixture_plex:/data/plex'],
        },
      },
      volumes: { fixture_downloads: {}, fixture_plex: {} },
      networks: { 'download-egress': { internal: true } },
    }),
  );
  compose('config', '--quiet');
  compose('create', '--no-build');
  docker(
    'run',
    '--rm',
    '--user',
    '0:0',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CHOWN',
    '-v',
    project + '_fixture_downloads:/mnt/downloads',
    '-v',
    project + '_fixture_plex:/mnt/plex',
    '--entrypoint',
    'chown',
    image,
    '1000:1000',
    '/mnt/downloads',
    '/mnt/plex',
  );
  compose('up', '-d', '--no-build');
  docker(
    'run',
    '-d',
    '--name',
    fixture,
    '--network',
    project + '_download-egress',
    '--network-alias',
    'fixture',
    '--cap-drop',
    'ALL',
    '--read-only',
    '--no-healthcheck',
    '--entrypoint',
    'node',
    image,
    '-e',
    fixtureCode,
    metadata.toString('base64'),
  );
  const mapping = compose('port', 'muxplorer', '8098').split(/\r?\n/)[0];
  base = 'http://' + mapping;
  await until(
    'Muxplorer',
    () => request('health'),
    (data) => data?.status === 'ok',
  );
  await request('downloads/status', { auth: false, status: 401 });
  await request('downloads', { auth: false, body: {}, status: 401 });
  await request('auth/setup', { status: 201, body: { username, password } });
  await request('downloads', { body: {}, headers: { 'X-Muxplorer': '' }, status: 403 });
  await request('downloads', {
    body: {},
    headers: { 'X-Muxplorer': '' },
    prefix: '/API/',
    status: 403,
  });
  await request('downloads', {
    body: {},
    headers: { Origin: 'https://other.invalid' },
    status: 403,
  });
  await request('downloads', {
    body: { links: [{ id: randomUUID(), url: 'file:///etc/passwd' }] },
    status: 400,
  });
  const engine = await until('Gopeed conectado', status, (data) => data?.status === 'connected');
  assert.match(engine.version, /^v?1\.9\.3$/);
  const engineContainer = compose('ps', '-q', 'gopeed');
  assert.ok(engineContainer);
  assert.ok(
    !Object.keys(
      JSON.parse(
        docker('inspect', '--format', '{{json .HostConfig.PortBindings}}', engineContainer),
      ) ?? {},
    ).length,
  );
  assert.match(
    docker('exec', engineContainer, 'sh', '-c', 'grep "^Uid:" /proc/1/status'),
    /^Uid:\s+1000\s+1000/,
  );
  const unauthenticated = docker(
    'exec',
    engineContainer,
    'sh',
    '-c',
    'wget -S -O /dev/null http://127.0.0.1:9999/api/v1/info 2>&1 || true',
  );
  assert.match(unauthenticated, /401 Unauthorized/);
  const preview = await request('downloads/resolve', {
    body: { url: fixtureUrl('preview.txt') },
    status: 201,
  });
  assert.deepEqual(preview, { name: 'preview.txt', total: 12, files: 1 });
  compose('exec', '-T', '-w', '/app/api', 'muxplorer', 'node', '-e', megaFixture);

  compose(
    'exec',
    '-T',
    'muxplorer',
    'node',
    '-e',
    "require('node:fs').writeFileSync(process.argv[1], 'original')",
    frontFile('collision.txt'),
  );
  const done = await create('collision.txt');
  await until(
    'archivo publicado',
    () => task(done),
    (data) => data?.status === 'completed',
  );
  const location = await request('downloads/' + done + '/location');
  assert.deepEqual(location, { root: 'downloads', path: 'collision (2).txt' });
  assert.equal(file('collision.txt').toString(), 'original');
  assert.equal(file(location.path).toString(), 'A'.repeat(12));
  const packageId = await create(pack, magnet.href);
  await until(
    'paquete BitTorrent publicado',
    () => task(packageId),
    (data) => data?.status === 'completed',
  );
  assert.deepEqual(await request('downloads/' + packageId + '/location'), {
    root: 'downloads',
    path: pack,
  });
  assert.equal(file(pack + '/first.txt').toString(), 'A'.repeat(12));
  assert.equal(file(pack + '/nested/second.txt').toString(), 'A'.repeat(12));

  await request('downloads/settings', { auth: false, status: 401 });
  await request('downloads/settings', {
    body: { destination: { root: 'downloads', path: '../config' } },
    status: 400,
  });
  const destination = { root: 'downloads', path: 'FixturePack/nested' };
  const settings = await request('downloads/settings', { body: { destination }, status: 201 });
  assert.deepEqual(settings.destination, destination);
  const routed = await create('routed.txt');
  const root = { root: 'downloads', path: '' };
  await request('downloads/settings', { body: { destination: root }, status: 201 });
  const alternate = await create('alternate.txt', undefined, destination);
  const expected = { root: 'downloads', path: destination.path + '/routed.txt' };
  await until(
    'destinos de descarga',
    () => request('downloads?filter=completed'),
    ({ tasks }) =>
      tasks.some((item) => item.id === routed) && tasks.some((item) => item.id === alternate),
  );
  assert.deepEqual(await request('downloads/' + routed + '/location'), expected);
  assert.equal(file(destination.path + '/alternate.txt').toString(), 'A'.repeat(12));
  const filtered = await request('downloads?filter=completed&query=ROUTED');
  assert.deepEqual(
    filtered.tasks.map((item) => item.id),
    [routed],
  );

  const slow = await create('slow.bin');
  await until(
    'progreso',
    () => task(slow),
    (data) => data?.status === 'running' && data.downloaded > 0,
  );
  const during = await request('files?root=downloads&path=');
  assert.ok(
    !during.some((entry) => entry.name === 'slow.bin' || entry.name.startsWith('.muxplorer-')),
  );
  await command(slow, 'pause');
  await until(
    'pausada',
    () => task(slow),
    (data) => data?.status === 'paused',
  );
  compose('stop', 'gopeed');
  await until('motor desconectado', status, (data) => data?.status === 'unavailable');
  await request('files?root=downloads&path=');
  await request('downloads', {
    body: { links: [{ id: randomUUID(), url: fixtureUrl('offline.txt') }] },
    status: 503,
  });
  compose('restart', 'muxplorer');
  base = 'http://' + compose('port', 'muxplorer', '8098').split(/\r?\n/)[0];
  await until(
    'Muxplorer reiniciado',
    () => request('health'),
    (data) => data?.status === 'ok',
  );
  assert.deepEqual(await request('downloads/' + done + '/location'), location);
  compose('start', 'gopeed');
  await until('Gopeed reiniciado', status, (data) => data?.status === 'connected');
  await until(
    'pausa conservada',
    () => task(slow),
    (data) => data?.status === 'paused',
  );
  await command(slow, 'resume');
  await until(
    'descarga reanudada',
    () => task(slow),
    (data) => data?.status === 'running',
  );
  await until(
    'archivo reanudado publicado',
    () => task(slow),
    (data) => data?.status === 'completed',
  );
  assert.deepEqual(file('slow.bin'), Buffer.alloc(1024 * 1024, 66));

  const cancelled = await create('cancel.bin');
  await until(
    'inicio antes de cancelar',
    () => task(cancelled),
    (data) => data?.status === 'running',
  );
  await command(cancelled, 'cancel');
  await until(
    'cancelación confirmada',
    () => task(cancelled),
    (data) => data?.status === 'cancelled' && !data.error,
  );
  await command(cancelled, 'remove');
  await request('downloads/' + cancelled, { status: 404 });
  const results = await request('files?root=downloads&path=');
  assert.ok(!results.some((entry) => entry.name === 'cancel.bin'));

  if (process.argv.includes('--browser')) {
    execFileSync(
      process.execPath,
      ['node_modules/@playwright/test/cli.js', 'test', 'tests/downloads.spec.ts'],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          MUXPLORER_URL: base,
          MUX_DOWNLOAD_TEST: '1',
          MUX_DOWNLOAD_USER: username,
          MUX_DOWNLOAD_PASSWORD: password,
        },
      },
    );
  }
  await command(done, 'remove');
  await request('downloads/' + done, { status: 404 });
  assert.equal(file(location.path).toString(), 'A'.repeat(12));
  assert.ok(!compose('logs', 'muxplorer').includes('fixture-secret'));
  console.log(
    'Descargas: Gopeed real, controles, colisiones, autenticación, reinicio y publicación verificados.',
  );
} finally {
  try {
    docker('rm', '-f', fixture);
  } catch {
    /* The fixture may have failed to start. */
  }
  try {
    compose('down', '-v');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
