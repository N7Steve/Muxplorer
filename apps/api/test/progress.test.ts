import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Job, Location } from '@muxplorer/shared';
import { Processes, ProcessOptions } from '../src/process';
import { Archives, SevenZipProgress } from '../src/archives';
import { Jobs, JobContext } from '../src/jobs';
import { Store } from '../src/store';
import { Paths } from '../src/paths';
import { Files } from '../src/files';
import { config } from '../src/config';
import { mergeJobs } from '../../web/src/app/job-state';

test('7-Zip reports the latest live counter, including resets, and ignores filename percentages', async () => {
  const percentages: number[] = [];
  const progress = new SevenZipProgress((percent) => percentages.push(percent));
  const controller = new AbortController();
  const processes = new Processes();
  await assert.rejects(
    processes.run(
      process.execPath,
      [
        '-e',
        String.raw`process.stdout.write(' 6');setTimeout(()=>process.stdout.write('5%'),15);setTimeout(()=>process.stdout.write('\b\b\b\b 98%'),40);setInterval(()=>{},1000);`,
      ],
      {
        signal: controller.signal,
        onLine: (line) => {
          progress.accept(line);
          if (percentages.includes(98)) controller.abort();
        },
      },
    ),
    /cancelada/,
  );
  progress.accept(' 65%');
  progress.accept(' 98%');
  progress.accept('Extracting movie 20%.mkv');
  progress.accept('1000% invalid');
  progress.accept('100%');
  assert.deepEqual(percentages, [65, 98, 65, 98, 100]);
});

test('a late HTTP snapshot never replaces newer SSE progress or a cancelled state', () => {
  const job: Job = {
    id: 'test',
    kind: 'extract',
    status: 'running',
    revision: 8,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:01:00.000Z',
    progress: 98,
    stage: 'Extrayendo',
    sources: [],
    results: [],
    messages: [],
  };
  const stale = { ...job, revision: 7, progress: 65 };
  assert.equal(mergeJobs([job], [stale])[0].progress, 98);
  const cancelled: Job = {
    ...job,
    revision: 9,
    status: 'cancelled',
    progress: null,
    stage: 'Cancelado',
  };
  assert.equal(mergeJobs([job], [cancelled])[0].status, 'cancelled');
  assert.equal(mergeJobs([cancelled], [job, stale])[0].status, 'cancelled');
});

test('cancelling freezes further CLI updates and clears the unfinished percentage', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mux-job-progress-'));
  const store = new Store(temporary),
    jobs = new Jobs(store);
  const events: Job[] = [];
  const subscription = jobs.events.subscribe(({ data }) => events.push(data));
  try {
    jobs.register('extract', async (_payload, context) => {
      context.update('Extrayendo con 7-Zip', 98);
      await new Promise<void>((_resolve, reject) =>
        context.signal.addEventListener(
          'abort',
          () => {
            context.update('Stale final buffer', 65);
            reject(new DOMException('Cancelada', 'AbortError'));
          },
          { once: true },
        ),
      );
    });
    const job = jobs.enqueue('extract', {}, []);
    for (let n = 0; n < 100 && jobs.get(job.id).progress !== 98; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    jobs.cancel(job.id);
    assert.equal(jobs.get(job.id).progress, null);
    assert.ok(events.some((event) => event.progress === 98));
    assert.equal(events.find((event) => event.stage === 'En cola')?.status, 'pending');
    for (let n = 0; n < 100 && jobs.get(job.id).status !== 'cancelled'; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const final = jobs.get(job.id);
    assert.equal(final.status, 'cancelled');
    assert.equal(final.progress, null);
    assert.equal(final.error, undefined);
  } finally {
    subscription.unsubscribe();
    await jobs.onModuleDestroy();
    store.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('archive completion reports validation, publication and cleanup instead of leaving the last engine percentage', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mux-archive-progress-'));
  try {
    const downloads = path.join(temporary, 'downloads'),
      plex = path.join(temporary, 'plex');
    await mkdir(downloads);
    await mkdir(plex);
    await writeFile(path.join(downloads, 'fixture.zip'), 'fixture');
    const paths = new Paths({ downloads, plex });
    class Fake7Zip extends Processes {
      override async run(binary: string, args: string[], options?: ProcessOptions) {
        if (binary !== config.SANDBOX_BIN) return super.run(binary, args, options);
        if (args.includes('l')) return { code: 0, stdout: 'Path = sample.txt\nSize = 7\n' };
        const target = args.find((arg) => arg.startsWith('-o'))!.slice(2);
        await writeFile(path.join(target, 'sample.txt'), 'fixture');
        for (const line of [' 65%', ' 98%', ' 65%', ' 99%']) options?.onLine?.(line);
        return { code: 0, stdout: '' };
      }
    }
    const processes = new Fake7Zip(),
      files = new Files(paths, processes),
      archives = new Archives(paths, files, processes);
    const stages: { stage: string; percent: number | null }[] = [],
      results: Location[] = [];
    const context: JobContext = {
      id: 'archive-fixture',
      signal: new AbortController().signal,
      update: (stage, percent = null) => {
        stages.push({ stage, percent });
      },
      message: () => undefined,
      result: (result) => results.push(result),
      checkpoint: () => undefined,
    };
    await archives.extract(
      {
        source: { root: 'downloads', path: 'fixture.zip' },
        destination: { root: 'plex', path: '' },
        folder: 'out',
      },
      context,
    );
    assert.deepEqual(
      stages.filter((s) => s.stage === 'Extrayendo con 7-Zip').map((s) => s.percent),
      [0, 65, 98, 65, 99],
    );
    assert.ok(
      stages.some((s) => s.stage === 'Validando rutas y archivos extraídos' && s.percent === null),
    );
    assert.ok(
      stages.some((s) => s.stage === 'Publicando los archivos extraídos' && s.percent === null),
    );
    assert.equal(stages.at(-1)?.stage, 'Limpiando archivos temporales');
    assert.equal(results[0].path, 'out');
    assert.deepEqual(await readdir(plex), ['out']);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
