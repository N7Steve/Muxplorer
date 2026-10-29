import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Files } from '../src/files';
import { Paths } from '../src/paths';
import { Processes } from '../src/process';
import { Jobs, NeedsReview, JobContext } from '../src/jobs';
import { Store } from '../src/store';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const context = (): JobContext => ({
  id: 'unit-test',
  signal: new AbortController().signal,
  update: () => undefined,
  message: () => undefined,
  result: () => undefined,
  checkpoint: () => undefined,
});
test('real processes report missing binaries, exit failures, cancellation and redact secrets', async () => {
  const processes = new Processes();
  await assert.rejects(processes.run('mux-no-such-executable', []), /ENOENT/);
  await assert.rejects(
    processes.run(
      process.execPath,
      ['-e', 'console.error("bad password TOPSECRET"); process.exit(2)'],
      { secrets: ['TOPSECRET'] },
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('[oculto]'));
      assert.ok(!error.message.includes('TOPSECRET'));
      return true;
    },
  );
  const result = await processes.run(process.execPath, [
    '-e',
    'console.log(process.argv[1])',
    'a;$(echo unsafe)',
  ]);
  assert.equal(result.stdout.trim(), 'a;$(echo unsafe)');
  const unicode = await processes.run(process.execPath, [
    '-e',
    'process.stdout.write(Buffer.from([0xc3]));setTimeout(()=>process.stdout.write(Buffer.from([0xa1,10])),20)',
  ]);
  assert.equal(unicode.stdout, 'á\n');
  const controller = new AbortController();
  const running = processes.run(process.execPath, ['-e', 'setInterval(()=>{},100)'], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, /cancelada/);
});
test('file operations create, rename, copy with hash validation, reject conflicts and delete fixtures', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mux-files-'));
  try {
    const downloads = path.join(temporary, 'downloads'),
      plex = path.join(temporary, 'plex');
    await mkdir(downloads);
    await mkdir(plex);
    const files = new Files(new Paths({ downloads, plex }), new Processes());
    const src = { root: 'downloads', path: 'first.txt' } as const,
      dest = { root: 'plex', path: '' } as const;
    await writeFile(path.join(downloads, 'first.txt'), 'streamed fixture\n'.repeat(4096));
    await files.operate('copy', { sources: [src], destination: dest }, context());
    assert.equal(
      await readFile(path.join(plex, 'first.txt'), 'utf8'),
      await readFile(path.join(downloads, 'first.txt'), 'utf8'),
    );
    await assert.rejects(
      files.operate('copy', { sources: [src], destination: dest }, context()),
      /Ya existe/,
    );
    const renamed = await files.rename({ root: 'plex', path: 'first.txt' }, 'second.txt');
    assert.equal(renamed.path, 'second.txt');
    await files.create(dest, 'folder');
    await assert.rejects(files.create(dest, 'folder'));
    await assert.rejects(files.operate('delete', { sources: [renamed] }, context()), /Confirma/);
    await files.operate('delete', { sources: [renamed], confirmed: true }, context());
    assert.ok(!(await readdir(plex)).includes('second.txt'));
    await assert.rejects(
      files.operate(
        'move',
        { sources: [{ root: 'downloads', path: '' }], destination: dest },
        context(),
      ),
      /raíz/,
    );
    await assert.rejects(
      files.operate(
        'copy',
        { sources: [src], destination: { root: 'downloads', path: '' } },
        context(),
      ),
      /Ya existe/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
test('failed and cancelled transfers preserve the source and do not publish partial files', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mux-cancel-'));
  try {
    const downloads = path.join(temporary, 'downloads'),
      plex = path.join(temporary, 'plex');
    await mkdir(downloads);
    await mkdir(plex);
    await writeFile(path.join(downloads, 'source'), 'safe');
    const files = new Files(new Paths({ downloads, plex }), new Processes());
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      files.operate(
        'move',
        {
          sources: [{ root: 'downloads', path: 'source' }],
          destination: { root: 'plex', path: '' },
        },
        { ...context(), signal: controller.signal },
      ),
    );
    assert.equal(await readFile(path.join(downloads, 'source'), 'utf8'), 'safe');
    assert.deepEqual(await readdir(plex), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
test('jobs persist errors, safe review checkpoints and mark unfinished work interrupted on restart', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mux-jobs-'));
  const store = new Store(temporary);
  try {
    const jobs = new Jobs(store);
    jobs.register('copy', async (_payload, ctx) => {
      ctx.update('Copying', 50);
      throw new Error('Permission denied');
    });
    const first = jobs.enqueue('copy', { fixture: true }, [{ root: 'downloads', path: 'a' }]);
    for (let i = 0; i < 100 && !['failed'].includes(jobs.get(first.id).status); i++)
      await sleep(10);
    assert.equal(jobs.get(first.id).status, 'failed');
    assert.equal(jobs.get(first.id).error, 'Permission denied');
    jobs.register('makemkv', async (_payload, ctx) => {
      ctx.checkpoint({ generated: true });
      throw new NeedsReview([{ index: 0, name: 'a.mkv', tracks: [] }]);
    });
    const review = jobs.enqueue('makemkv', {}, []);
    for (let i = 0; i < 100 && !jobs.get(review.id).awaitingReview; i++) await sleep(10);
    assert.ok(jobs.get(review.id).awaitingReview);
    assert.deepEqual(jobs.payload(review.id), { generated: true });
    await jobs.onModuleDestroy();
    const restarted = new Jobs(store);
    assert.equal(restarted.get(review.id).status, 'interrupted');
    assert.equal(restarted.get(first.id).status, 'failed');
    restarted.cancel(review.id);
    assert.equal(restarted.get(review.id).status, 'cancelled');
    await restarted.onModuleDestroy();
  } finally {
    store.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('process diagnostics correlate exits and redact passwords and beta keys', async (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'log', (line: string) => {
    logs.push(line);
  });
  const beta = 'T-' + 'a'.repeat(66);
  await assert.rejects(
    new Processes().run(
      process.execPath,
      ['-e', `console.error('TOPSECRET ${beta}');process.exit(2)`],
      { jobId: 'log-fixture', secrets: ['TOPSECRET'] },
    ),
  );
  const records = logs.map((line) => JSON.parse(line));
  const start = records.find((record) => record.event === 'process.start');
  const end = records.find((record) => record.event === 'process.exit');
  assert.equal(start.jobId, 'log-fixture');
  assert.equal(end.processId, start.processId);
  assert.equal(end.code, 2);
  assert.ok(!logs.join('').includes('TOPSECRET'));
  assert.ok(!logs.join('').includes(beta));
  assert.ok(end.detail.includes('[oculto]'));
});
