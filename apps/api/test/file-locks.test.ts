import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Files } from '../src/files';
import { Paths } from '../src/paths';
import { Processes } from '../src/process';
import { Mkv } from '../src/mkv';
import type { JobContext } from '../src/jobs';
import { ApiController } from '../src/controller';
import type { Location } from '@muxplorer/shared';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('pending and running jobs reject properties only for overlapping films, including parent folders', async () => {
  const files = new Files(
    new Paths({ downloads: path.resolve('storage'), plex: path.resolve('storage') }),
    new Processes(),
  );
  let status = 'pending';
  const controller = Object.assign(Object.create(ApiController.prototype) as ApiController, {
    files,
    jobs: {
      list: () => [{ status, sources: [{ root: 'downloads', path: 'Busy film' }], results: [] }],
    },
    mkv: { inspect: async () => 'inspected', editMetadata: async () => 'saved' },
  });
  const edit = (source: Location) => ({
    source,
    revision: 'revision',
    title: 'Film',
    tracks: [{ id: 0, name: '', language: 'und', default: true, forced: false }],
  });
  const busy: Location = { root: 'plex', path: 'Busy film/movie.mkv' };
  const other: Location = { root: 'downloads', path: 'Other film/movie.mkv' };
  for (status of ['pending', 'running']) {
    assert.throws(() => controller.inspect(busy), /Espera a que terminen/);
    assert.throws(() => controller.metadata(edit(busy)), /Espera a que terminen/);
    assert.equal(await controller.inspect(other), 'inspected');
    assert.equal(await controller.metadata(edit(other)), 'saved');
  }
  status = 'completed';
  assert.equal(await controller.inspect(busy), 'inspected');
  assert.equal(await controller.metadata(edit(busy)), 'saved');
});

test('copying a film allows inspection of a sibling while protecting source, destination and ancestors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mux-lock-'));
  const copying = gate(),
    finish = gate();
  try {
    const downloads = path.join(root, 'downloads'),
      plex = path.join(root, 'plex');
    await mkdir(downloads);
    await mkdir(plex);
    await writeFile(path.join(downloads, 'busy.mkv'), 'film');
    await writeFile(path.join(downloads, 'other.mkv'), 'other');
    class PausedFiles extends Files {
      override async renameExclusive(from: string, to: string) {
        copying.resolve();
        await finish.promise;
        await super.renameExclusive(from, to);
      }
    }
    class FakeMkv extends Mkv {
      override async inspectAbsolute() {
        return { title: 'Other', tracks: [] };
      }
    }
    const paths = new Paths({ downloads, plex }),
      processes = new Processes();
    const files = new PausedFiles(paths, processes);
    const context: JobContext = {
      id: 'copy-test',
      signal: new AbortController().signal,
      update() {},
      message() {},
      result() {},
      checkpoint() {},
    };
    const copy = files.operate(
      'copy',
      {
        sources: [{ root: 'downloads', path: 'busy.mkv' }],
        destination: { root: 'plex', path: '' },
      },
      context,
    );
    await copying.promise;
    const entered: string[] = [];
    const waits = [
      files.exclusive([{ root: 'downloads', path: 'busy.mkv' }], async () => {
        entered.push('source');
      }),
      files.exclusive([{ root: 'plex', path: 'busy.mkv' }], async () => {
        entered.push('destination');
      }),
    ];
    const inspected = await new FakeMkv(paths, files, processes).inspect({
      root: 'downloads',
      path: 'other.mkv',
    });
    assert.equal(inspected.title, 'Other');
    assert.deepEqual(entered, []);
    waits.push(
      files.exclusive([{ root: 'downloads', path: '' }], async () => {
        entered.push('parent');
      }),
    );
    finish.resolve();
    await copy;
    await Promise.all(waits);
    assert.deepEqual(new Set(entered), new Set(['source', 'destination', 'parent']));
  } finally {
    finish.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test('overlapping waiters keep order and release after failure, including aliased storage roots', async () => {
  const roots = new Paths({ downloads: path.resolve('storage'), plex: path.resolve('storage') });
  const files = new Files(roots, new Processes());
  const hold = gate();
  const order: number[] = [];
  const first = files.exclusive([{ root: 'downloads', path: 'Movie' }], async () => {
    await hold.promise;
    order.push(1);
    throw new Error('failed');
  });
  const failed = assert.rejects(first, /failed/);
  const second = files.exclusive([{ root: 'plex', path: 'Movie/film.mkv' }], async () => {
    order.push(2);
  });
  const third = files.exclusive([{ root: 'downloads', path: 'Movie' }], async () => {
    order.push(3);
  });
  await files.exclusive([{ root: 'downloads', path: 'Movie 2/film.mkv' }], async () => {
    order.push(0);
  });
  assert.deepEqual(order, [0]);
  hold.resolve();
  await Promise.all([failed, second, third]);
  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.equal(
    files.overlaps({ root: 'downloads', path: 'Movie' }, { root: 'plex', path: 'Movie/film.mkv' }),
    true,
  );
  assert.equal(
    files.overlaps(
      { root: 'downloads', path: 'Movie' },
      { root: 'plex', path: 'Movie 2/film.mkv' },
    ),
    false,
  );
});
