import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store';
import { Downloads } from '../src/downloads';
import { DownloadPublication } from '../src/download-publication';
import { Files } from '../src/files';
import { Paths, relativePath } from '../src/paths';
import { Processes } from '../src/process';
import { GopeedDownloadProvider, engineDirectory } from '../src/gopeed';
import { ProviderError, type EngineTask } from '../src/download-provider';
import { DownloadAccounts } from '../src/download-accounts';
import { DownloadHosts } from '../src/download-hosts';
import { FichierWebsite } from '../src/fichier-website';
import { DownloadRouting } from '../src/download-routing';
import { MegaDownloads } from '../src/mega-downloads';

test('Gopeed v1.9.3 REST contract, credentials, failures and missing tasks', async (t) => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let fail = 0;
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : null;
    const endpoint = req.url ?? '';
    calls.push({ method: req.method ?? '', path: endpoint, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-api-token'] !== 'secret' || fail === 401) {
      res.writeHead(401).end(JSON.stringify({ code: 1001, msg: 'secret' }));
      return;
    }
    if (fail === 1) {
      res.end(JSON.stringify({ code: 0, data: {} }));
      return;
    }
    const data = endpoint.endsWith('/info')
      ? { version: 'v1.9.3' }
      : endpoint.endsWith('/resolve')
        ? { res: fixture('mock').resource }
        : endpoint.endsWith('/tasks') && req.method === 'POST'
          ? 'gopeed-task'
          : endpoint.endsWith('/tasks')
            ? []
            : null;
    res.end(JSON.stringify({ code: endpoint.endsWith('/missing') ? 2001 : 0, data }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const provider = new GopeedDownloadProvider('http://127.0.0.1:' + address.port, 'secret');
  assert.deepEqual(await provider.info(), { version: 'v1.9.3' });
  const id = randomUUID();
  const url = 'https://fixture.invalid/file?private=token';
  assert.equal(await provider.add(url, id), 'gopeed-task');
  assert.deepEqual(calls[1].body, {
    req: { url, labels: { muxplorer: id } },
    opts: { path: engineDirectory(id), extra: { autoExtract: false, autoTorrent: false } },
  });
  assert.deepEqual(await provider.list(), []);
  assert.equal((await provider.resolve(url)).files[0].name, 'fixture.bin');
  assert.equal(await provider.get('missing'), null);
  await provider.pause('gopeed-task');
  await provider.resume('gopeed-task');
  await provider.cancel('gopeed-task');
  assert.deepEqual(
    calls.slice(-3).map((call) => [call.method, call.path]),
    [
      ['PUT', '/api/v1/tasks/gopeed-task/pause'],
      ['PUT', '/api/v1/tasks/gopeed-task/continue'],
      ['DELETE', '/api/v1/tasks/gopeed-task?force=false'],
    ],
  );
  fail = 1;
  await assert.rejects(provider.list(), { kind: 'response' });
  fail = 401;
  await assert.rejects(
    provider.info(),
    (error: ProviderError) => error.kind === 'auth' && !error.message.includes('secret'),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await assert.rejects(provider.info(), { kind: 'connection' });
});

function fixture(id: string, status: EngineTask['status'] = 'done'): EngineTask {
  return {
    id: 'engine-' + id,
    status,
    requestId: id,
    resource: { name: '', size: 4, files: [{ name: 'fixture.bin', path: '', size: 4 }] },
    downloaded: 4,
    speed: 0,
  };
}

test('download accounts protect credentials and resolve premium links at the corresponding host', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mux-download-accounts-'));
  const store = new Store(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const accounts = new DownloadAccounts(store);
  const [fichier] = accounts.save({
    provider: '1fichier',
    label: 'Premium',
    secret: 'private-key',
  });
  assert.deepEqual(Object.keys(fichier).sort(), ['email', 'id', 'label', 'provider']);
  assert.doesNotMatch(store.get('downloadAccounts')!, /private-key/);
  accounts.save({ ...fichier, label: 'Cuenta principal' });
  assert.equal(new DownloadAccounts(store).get(fichier.id).secret, 'private-key');
  const debrid = accounts.save({
    provider: 'real-debrid',
    label: 'Debrid',
    secret: 'private-token',
  })[1];
  const engine = new GopeedDownloadProvider('http://gopeed:9999', 'engine-secret');
  const mega = new MegaDownloads(
    store,
    accounts,
    new DownloadPublication(new Files(new Paths(), new Processes())),
  );
  const routing = new DownloadRouting(engine, mega, accounts);
  t.mock.method(globalThis, 'fetch', async (input: URL | string, init: RequestInit) => {
    switch (new URL(input).hostname) {
      case 'api.1fichier.com':
        assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer private-key');
        assert.equal(JSON.parse(String(init.body)).url, 'https://1fichier.com/?test');
        return Response.json({ status: 'OK', url: 'https://files.example.org/one' });
      case 'api.real-debrid.com':
        assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer private-token');
        assert.equal(String(init.body), 'link=https%3A%2F%2Fhost.example.org%2Ftwo');
        return Response.json({ download: 'https://files.example.org/two' });
      default: {
        assert.equal(new URL(input).host, 'gopeed:9999');
        const { req } = JSON.parse(String(init.body));
        assert.match(req.url, /^https:\/\/files\.example\.org\/(one|two)$/);
        assert.equal(req.extra, undefined);
        return Response.json({ code: 0, data: 'gopeed-task' });
      }
    }
  });
  assert.throws(
    () => routing.validate('https://mega.nz/file/example#key', fichier.id),
    /no admite/,
  );
  assert.equal(
    await routing.add('https://1fichier.com/?test', randomUUID(), fichier.id),
    'gopeed-task',
  );
  assert.equal(
    await routing.add('https://host.example.org/two', randomUUID(), debrid.id),
    'gopeed-task',
  );
  accounts.remove(fichier.id);
  assert.throws(() => routing.validate('https://1fichier.com/?test', fichier.id), /ya no existe/);
});

test('1fichier distinguishes authentication errors, access restrictions and rate limits', async (t) => {
  const hosts = new DownloadHosts();
  const account = {
    id: randomUUID(),
    label: '1fichier fixture',
    provider: '1fichier' as const,
    secret: 'fixture-api-key',
  };
  let response = Response.json({ status: 'OK' });
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (input: URL | string, init: RequestInit) => {
      assert.equal(new URL(input).hostname, 'api.1fichier.com');
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-api-key');
      return response.clone();
    },
  );
  assert.equal(await hosts.verify(account), 'connected');
  response = Response.json({ status: 'KO', message: 'Not authenticated #247' }, { status: 401 });
  assert.equal(await hosts.verify(account), 'invalid');
  response = new Response('Forbidden', { status: 403 });
  assert.equal(await hosts.verify(account), 'restricted');
  response = Response.json({ status: 'KO', message: 'Too many requests' }, { status: 429 });
  assert.equal(await hosts.verify(account), 'rate-limited');
  await assert.rejects(
    hosts.direct(new URL('https://1fichier.com/?fixture'), account, true),
    /limitó las solicitudes/,
  );
  assert.equal(fetch.mock.callCount(), 5);
});

test('1fichier web login uses a scoped session to resolve a download form', async (t) => {
  const website = new FichierWebsite();
  const account = {
    id: randomUUID(),
    label: 'Web',
    provider: '1fichier-web' as const,
    email: 'test@example.org',
    secret: 'web password',
  };
  const source = new URL('https://1fichier.com/?abcde');
  const direct = 'https://cdn.1fichier.com/ticket/file.bin';
  const fetch = t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    const headers = new Headers(init.headers);
    assert.equal(input.hostname, '1fichier.com');
    assert.equal(init.redirect, 'manual');
    assert.equal(headers.has('Authorization'), false);
    if (input.pathname === '/login.pl' && init.method === 'GET')
      return new Response('<form></form>');
    if (input.pathname === '/login.pl') {
      const form = init.body as URLSearchParams;
      assert.equal(form.get('mail'), account.email);
      assert.equal(form.get('pass'), account.secret);
      assert.equal(form.has('purge'), false);
      assert.equal(form.has('lt'), false);
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/console/index.pl',
          'Set-Cookie': 'SID=test-session; Path=/; Secure; HttpOnly',
        },
      });
    }
    assert.equal(headers.get('Cookie'), 'SID=test-session');
    if (input.pathname === '/console/index.pl')
      return new Response('<a href="/logout.pl">Logout</a>');
    if (init.method === 'GET')
      return new Response(
        '<form method="post" action="/?abcde"><input type="hidden" name="token" value="A&amp;B" /><input type="submit" value="Download"></form>',
      );
    assert.equal(input.href, source.href);
    assert.equal((init.body as URLSearchParams).get('did'), '1');
    assert.equal((init.body as URLSearchParams).get('token'), 'A&B');
    return new Response(null, { status: 302, headers: { Location: direct } });
  });
  assert.equal(await website.verify(account), 'connected');
  assert.deepEqual(await website.direct(source, account), { link: direct });
  assert.equal(fetch.mock.callCount(), 5);
  await assert.rejects(
    website.direct(new URL('https://1fichier.com.evil.test/?abcde'), account),
    /enlace/,
  );
  assert.equal(fetch.mock.callCount(), 5);
});

test('1fichier web login recognizes a two-factor prompt', async (t) => {
  const website = new FichierWebsite();
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: URL, init: RequestInit) =>
      new Response(init.method === 'POST' ? '<form><input name="tfa"></form>' : '<form></form>'),
  );
  assert.equal(
    await website.verify({
      id: randomUUID(),
      label: 'Web',
      provider: '1fichier-web',
      email: 'test@example.org',
      secret: 'fixture',
    }),
    'two-factor',
  );
});

test('checks new accounts and routes a mixed set of links independently', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mux-download-hosts-'));
  const store = new Store(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const accounts = new DownloadAccounts(store);
  const engine = new GopeedDownloadProvider('http://gopeed:9999', 'engine-secret');
  const routing = new DownloadRouting(
    engine,
    new MegaDownloads(
      store,
      accounts,
      new DownloadPublication(new Files(new Paths(), new Processes())),
    ),
    accounts,
  );
  const links = [
    'https://rapidgator.net/file/123/Movie.part1.rar.html',
    'https://nitroflare.com/view/1AB/Movie.part2.rar',
    'https://www.terabox.com/s/1share',
    'https://katfile.com/abcdefghijkl',
    'https://supported.example.org/share',
    'https://standalone.example.org/local',
  ];
  const transfers: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL | string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(init.redirect, 'error');
    switch (url.hostname) {
      case 'rapidgator.net':
        if (url.pathname.endsWith('/login')) {
          assert.equal(url.searchParams.get('password'), 'premium-password');
          return Response.json({ status: 200, response: { token: 'session-test' } });
        }
        assert.equal(url.searchParams.get('token'), 'session-test');
        return Response.json({
          status: 200,
          response: url.pathname.endsWith('/file/info')
            ? { file: { name: 'Movie.part1.rar', size: 12 } }
            : { download_url: 'https://cdn.example.org/rapid' },
        });
      case 'nitroflare.com':
        if (url.pathname.endsWith('/getFileInfo'))
          return Response.json({
            result: {
              files: {
                [url.searchParams.get('files')!]: {
                  status: 'online',
                  name: 'Movie.part2.rar',
                  size: 12,
                },
              },
            },
          });
        if (url.pathname.endsWith('/getKeyInfo')) {
          assert.equal(url.searchParams.get('premiumKey'), 'nitro-key');
          return Response.json({ result: { status: 'active' } });
        }
        if (url.searchParams.get('file') === 'CHALLENGE')
          return Response.json({ type: 'error', code: 12 });
        return Response.json({ result: { url: 'https://cdn.example.org/nitro' } });
      case 'www.terabox.com':
        assert.equal(url.searchParams.get('access_tokens'), 'open-token');
        if (url.pathname.endsWith('/uinfo')) return Response.json({ errno: 0, uk: '1' });
        if (url.pathname.endsWith('/share/list'))
          return Response.json({
            errno: 0,
            uk: '1',
            shareid: '2',
            list: [{ fs_id: 3, server_filename: 'tera.bin', isdir: 0, size: 8 }],
          });
        assert.equal(url.searchParams.get('fid_list'), '[3]');
        return Response.json({ errno: 0, list: [{ dlink: 'https://cdn.example.org/tera' }] });
      case 'katfile.com':
        if (url.searchParams.get('key') === 'bad-key')
          return Response.json({
            status: 400,
            msg: 'Invalid key',
          });
        if (url.pathname.endsWith('/account/info'))
          return Response.json({ status: 200, result: {} });
        return Response.json({
          msg: 'OK',
          result: { url: 'https://cdn.example.org/kat', size: 12 },
        });
      case 'api.real-debrid.com':
        if (url.pathname.endsWith('/user')) return Response.json({ username: 'test' });
        if (url.pathname.endsWith('/hosts/domains'))
          return Response.json(['supported.example.org']);
        assert.equal(new URLSearchParams(String(init.body)).get('link'), links[4]);
        return Response.json({ download: 'https://cdn.example.org/debrid' });
      case 'gopeed': {
        const link = JSON.parse(String(init.body)).req.url;
        if (url.pathname.endsWith('/resolve')) {
          if (link.endsWith('/missing'))
            return Response.json({
              code: 1000,
              msg: 'http request fail, code:404',
              data: null,
            });
          return Response.json({ code: 0, data: { res: fixture('fixture').resource } });
        }
        transfers.push(link);
        return Response.json({ code: 0, data: 'gopeed-task' });
      }
      default:
        throw new Error('Unexpected request: ' + url.hostname);
    }
  });
  const email = 'fixture@example.org';
  const providers = [
    { provider: 'rapidgator', email, secret: 'premium-password' },
    { provider: 'nitroflare', email, secret: 'nitro-key' },
    { provider: 'terabox', secret: 'open-token' },
    { provider: 'katfile', secret: 'kat-key' },
    { provider: 'real-debrid', secret: 'rd-token' },
  ] as const;
  for (const provider of providers) {
    const list = await routing.saveAccount({ ...provider, label: provider.provider });
    assert.equal(list.at(-1)?.status, 'connected');
    assert.ok(list.at(-1)?.checkedAt);
    assert.equal('secret' in list.at(-1)!, false);
  }
  const invalid = await routing.saveAccount({
    provider: 'katfile',
    label: 'Invalid',
    secret: 'bad-key',
  });
  assert.equal(invalid.at(-1)?.status, 'invalid');
  assert.equal((await routing.check(links[0])).name, 'Movie.part1.rar');
  assert.equal((await routing.check(links[1])).name, 'Movie.part2.rar');
  assert.equal((await routing.check('https://nitroflare.com/view/CHALLENGE')).status, 'captcha');
  assert.equal((await routing.check('https://standalone.example.org/missing')).status, 'offline');
  for (const link of links) await routing.add(link, randomUUID());
  assert.deepEqual(transfers, [
    'https://cdn.example.org/rapid',
    'https://cdn.example.org/nitro',
    'https://cdn.example.org/tera',
    'https://cdn.example.org/kat',
    'https://cdn.example.org/debrid',
    links[5],
  ]);
});

test('deduplicates concurrent submissions and reconciles an uncertain POST after restart', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mux-downloads-'));
  class IsolatedVolume extends DownloadPublication {
    override async staging() {
      return root;
    }
    override async cleanPrepared() {}
  }
  const files = new IsolatedVolume(new Files(new Paths(), new Processes()));
  const tasks = new Map<string, EngineTask>();
  let requests = 0;
  let offline = false;
  const provider = {
    async info() {
      return { version: '1.9.3' };
    },
    async list() {
      if (offline) throw new ProviderError('connection');
      return [...tasks.values()];
    },
    async get(id: string) {
      return tasks.get(id) ?? null;
    },
    async add(_url: string, id: string) {
      requests++;
      const task = fixture(id, 'running');
      tasks.set(task.id, task);
      throw new ProviderError('connection');
    },
    async pause(id: string) {
      tasks.get(id)!.status = 'paused';
    },
    async resume(id: string) {
      tasks.get(id)!.status = 'running';
    },
    async cancel(id: string) {
      tasks.delete(id);
    },
    async remove(id: string) {
      tasks.delete(id);
    },
  };
  let store = new Store(root);
  let service = new Downloads(store, files, provider, 'http://engine', 'token');
  await service.refresh();
  const link = { id: randomUUID(), url: 'https://fixture.invalid/asset?secret=omitted' };
  const other = { ...link, id: randomUUID() };
  const submitted = await Promise.all([service.add([link]), service.add([other])]);
  assert.deepEqual(submitted, [{ ids: [link.id] }, { ids: [link.id] }]);
  assert.equal(requests, 1);
  await service.onModuleDestroy();
  store.close();
  store = new Store(root);
  service = new Downloads(store, files, provider, 'http://engine', 'token');
  t.after(async () => {
    await service.onModuleDestroy();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.refresh();
  assert.equal(service.get(link.id).status, 'running');
  assert.doesNotMatch(
    JSON.stringify(store.db.prepare('SELECT data FROM downloads').all()),
    /omitted/,
  );
  offline = true;
  await service.refresh();
  assert.equal(service.status().status, 'unavailable');
  assert.equal(service.get(link.id).status, 'running');
  await assert.rejects(service.command(link.id, 'pause'), /conectar/);
  offline = false;
  await service.refresh();
  await service.command(link.id, 'pause');
  await service.refresh();
  assert.equal(service.get(link.id).status, 'paused');
  await service.command(link.id, 'resume');
  await service.refresh();
  await service.command(link.id, 'cancel');
  await service.refresh();
  assert.equal(service.get(link.id).status, 'cancelled');
  assert.equal(tasks.size, 0);
  assert.ok(!(await readdir(root)).includes(link.id));
  await service.command(link.id, 'remove');
  await service.refresh();
  assert.equal(service.list(0, 30).total, 0);
});

test('publication rejects traversal and reserved paths', () => {
  for (const name of ['../../plex', '/etc', 'sub\\escape', 'sub/.muxplorer-work'])
    assert.throws(() => relativePath(name));
});

test(
  'Linux publication verifies a tree, handles collisions and recovers an interrupted commit',
  {
    skip: process.platform !== 'linux',
  },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mux-download-publish-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const downloads = path.join(root, 'downloads');
    const plex = path.join(root, 'plex');
    const staging = path.join(root, 'staging');
    await Promise.all([downloads, plex, staging].map((item) => mkdir(item)));
    class TestFiles extends Files {
      override async renameExclusive(from: string, to: string) {
        await rename(from, to);
      }
    }
    const files = new TestFiles(new Paths({ downloads, plex }), new Processes());
    const publication = new DownloadPublication(files, staging);
    await assert.rejects(new DownloadPublication(files, downloads).staging());
    const id = randomUUID();
    await publication.createStage(id);
    const task = fixture(id);
    const dir = path.join(staging, id, 'Package');
    await mkdir(path.join(dir, 'nested'), { recursive: true });
    await writeFile(path.join(dir, 'nested', 'first.txt'), 'one');
    await writeFile(path.join(dir, 'second.txt'), 'two');
    await mkdir(path.join(downloads, 'Package'));
    await writeFile(path.join(downloads, 'Package', 'original.txt'), 'original');
    task.resource = {
      name: 'Package',
      size: 6,
      files: [
        { name: 'first.txt', path: 'nested', size: 3 },
        { name: 'second.txt', path: '', size: 3 },
      ],
    };
    assert.deepEqual(
      (await files.list({ root: 'downloads', path: '' })).map((item) => item.name),
      ['Package'],
    );
    const prepared = await publication.prepare(id, task);
    let saved = prepared;
    await assert.rejects(
      publication.commit(
        id,
        prepared,
        (plan) => {
          saved = plan;
        },
        () => {
          throw new Error('crash after rename');
        },
      ),
      /crash after rename/,
    );
    assert.equal(saved.target, 'Package (2)');
    const restarted = new DownloadPublication(files, staging);
    await restarted.commit(
      id,
      saved,
      () => assert.fail('must not rename twice'),
      (name) => assert.equal(name, saved.target),
    );
    assert.equal(
      await readFile(path.join(downloads, 'Package', 'original.txt'), 'utf8'),
      'original',
    );
    assert.equal(
      await readFile(path.join(downloads, saved.target, 'nested', 'first.txt'), 'utf8'),
      'one',
    );
    assert.equal(await readFile(path.join(downloads, saved.target, 'second.txt'), 'utf8'), 'two');
    assert.ok(await restarted.result(saved.target, saved.identity));
    await rename(path.join(downloads, saved.target), path.join(downloads, 'Moved'));
    assert.equal(await restarted.result(saved.target, saved.identity), null);
    await assert.rejects(
      restarted.commit(
        id,
        saved,
        () => {},
        () => assert.fail(),
      ),
      /interrumpida/,
    );

    task.resource.files[0].path = '../nested';
    await assert.rejects(publication.prepare(id, task), /Ruta no válida/);
    task.resource.files[0].path = 'nested';
    const second = path.join(dir, 'second.txt');
    await rm(second);
    await assert.rejects(publication.prepare(id, task), { code: 'ENOENT' });
    await symlink(path.join(downloads, 'Moved', 'second.txt'), second);
    await assert.rejects(publication.prepare(id, task), { code: 'ELOOP' });
    assert.deepEqual(
      await readdir(downloads).then((names) =>
        names.filter((name) => !name.startsWith('.muxplorer-')).sort(),
      ),
      ['Moved', 'Package'],
    );
  },
);
