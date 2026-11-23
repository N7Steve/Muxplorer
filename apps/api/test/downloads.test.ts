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
