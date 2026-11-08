import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { RemuxRequest, Track } from '@muxplorer/shared';
import { MakeMkv, MakeRequest } from '../src/makemkv';
import { Mkv } from '../src/mkv';
import { Paths } from '../src/paths';
import { Files } from '../src/files';
import { Processes, ProcessOptions } from '../src/process';
import { config } from '../src/config';
import { JobContext, NeedsReview } from '../src/jobs';

test('MakeMKV validates robot save failures independently of exit code and partial files', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mux-make-failure-'));
  const previousHome = config.MAKEMKV_HOME;
  config.MAKEMKV_HOME = path.join(temporary, 'home');
  try {
    const downloads = path.join(temporary, 'downloads'),
      plex = path.join(temporary, 'plex');
    await mkdir(downloads);
    await mkdir(plex);
    await writeFile(path.join(downloads, 'disc.iso'), 'unchanged ISO');
    const corruption =
      'MSG:4004,0,2,"The source file /BDMV/STREAM/00000.m2ts is corrupt or invalid at offset 9081458688, attempting to work around"';
    const exception =
      'MSG:1002,0,1,"LIBMKV_TRACE: Exception: MKV_ASSERT: TimecodeDelay >= int16(0x8000) && TimecodeDelay <= int16(0x7FFF)"';
    const cases = [
      {
        name: 'reported corruption and timecode failure without output',
        lines: [
          corruption,
          exception,
          ...Array<string>(50).fill('MSG:2008,0,0,"Slow disk warning"'),
          'MSG:5003,0,2,"Failed to save title 0 to file title.mkv"',
          'MSG:5004,0,2,"0 titles saved, 1 failed","%1 titles saved, %2 failed","0","1"',
        ],
        files: [],
        error: /datos corruptos o inválidos.*00000\.m2ts.*9081458688.*TimecodeDelay/,
      },
      {
        name: 'localized failed save with a nonempty partial MKV',
        lines: ['MSG:5003,0,2,"No se pudo guardar el título"'],
        files: ['partial.mkv'],
        error: /fallo al guardar.*No se pudo guardar/,
      },
      {
        name: 'failed title summary with a partial MKV',
        lines: [
          'MSG:5004,0,2,"0 títulos guardados, 1 fallido","%1 títulos guardados, %2 fallidos","0","1"',
        ],
        files: ['partial.mkv'],
        error: /fallo al guardar/,
      },
      {
        name: 'failed copy summary with a partial MKV',
        lines: ['MSG:5037,0,2,"Copy complete. 0 titles saved, 1 failed."'],
        files: ['partial.mkv'],
        error: /fallo al guardar/,
      },
      {
        name: 'disc open failure',
        lines: ['MSG:5010,0,0,"Failed to open disc"'],
        files: [],
        error: /Failed to open disc/,
      },
      {
        name: 'internal engine exception without output',
        lines: [exception],
        files: [],
        error: /error interno.*TimecodeDelay/,
      },
      {
        name: 'missing output without reported failure',
        lines: ['MSG:1005,0,1,"MakeMKV started"'],
        files: [],
        error: /Se esperaba un MKV y se encontraron 0/,
      },
      {
        name: 'ambiguous output',
        lines: [],
        files: ['one.mkv', 'two.mkv'],
        error: /Se esperaba un MKV y se encontraron 2/,
      },
      {
        name: 'successful recovery from a corruption warning',
        lines: [
          corruption,
          'MSG:5005,0,1,"1 titles saved"',
          'MSG:5036,0,1,"Copy complete. 1 titles saved."',
        ],
        files: ['complete.mkv'],
        error: undefined,
      },
    ];
    for (const fixture of cases) {
      await t.test(fixture.name, async () => {
        class FakeProcess extends Processes {
          override async run(_binary: string, args: string[], options?: ProcessOptions) {
            if (args.includes('info')) return { stdout: 'TINFO:0,2,0,"Movie"', code: 0 };
            for (const line of fixture.lines) options?.onLine?.(line);
            options?.onLine?.('PRGV:100,100,100');
            for (const name of fixture.files)
              await writeFile(path.join(args.at(-1)!, name), 'MKV data');
            // Simulate stdout having reached its capture limit before the failure.
            return { stdout: 'MSG:1005,0,1,"MakeMKV started"', code: 0 };
          }
        }
        const paths = new Paths({ downloads, plex }),
          processes = new FakeProcess();
        const files = new Files(paths, processes);
        let inspected = false,
          checkpointed = false;
        class FakeMkv extends Mkv {
          override async inspectAbsolute() {
            inspected = true;
            return { title: '', tracks: [] };
          }
        }
        const engine = new MakeMkv(paths, files, processes, new FakeMkv(paths, files, processes));
        await engine.onModuleInit();
        const context: JobContext = {
          id: 'failure-test',
          signal: new AbortController().signal,
          update: () => undefined,
          message: () => undefined,
          checkpoint: () => {
            checkpointed = true;
          },
          result: () => assert.fail('Extraction must not publish files'),
        };
        const request: MakeRequest = {
          source: { root: 'downloads', path: 'disc.iso' },
          destination: { root: 'plex', path: '' },
          titles: [0],
          name: 'Movie',
        };
        if (fixture.error) {
          await assert.rejects(engine.convert(request, context), (error: Error) => {
            assert.match(error.message, fixture.error!);
            assert.doesNotMatch(error.message, /licencia/);
            return true;
          });
          assert.equal(inspected, false);
          assert.equal(checkpointed, false);
          assert.equal(request.checkpoint, undefined);
          assert.deepEqual(await readdir(plex), []);
        } else {
          await assert.rejects(engine.convert(request, context), NeedsReview);
          assert.equal(inspected, true);
          assert.equal(checkpointed, true);
          await rm(path.join(plex, '.muxplorer-failure-test'), { recursive: true });
        }
        assert.equal(await readFile(path.join(downloads, 'disc.iso'), 'utf8'), 'unchanged ISO');
      });
    }
  } finally {
    config.MAKEMKV_HOME = previousHome;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('MakeMKV keeps a checkpoint, reviews generated track IDs and only publishes after exact remux', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mux-make-'));
  const previousHome = config.MAKEMKV_HOME;
  config.MAKEMKV_HOME = path.join(temporary, 'home');
  try {
    const downloads = path.join(temporary, 'downloads'),
      plex = path.join(temporary, 'plex');
    await mkdir(downloads);
    await mkdir(plex);
    await writeFile(path.join(downloads, 'disc.iso'), 'ISO fixture');
    const generated: Track[] = [
      {
        id: 37,
        type: 'audio',
        codec: 'DTS',
        language: 'spa',
        name: 'Generated track',
        default: true,
        forced: false,
      },
      {
        id: 12,
        type: 'subtitles',
        codec: 'PGS',
        language: 'eng',
        name: '',
        default: false,
        forced: false,
      },
    ];
    const calls: string[][] = [];
    class FakeMakeProcess extends Processes {
      override async run(binary: string, args: string[], options?: ProcessOptions) {
        if (binary !== config.MAKEMKV_BIN) return super.run(binary, args, options);
        calls.push(args);
        if (args.includes('info'))
          return {
            stdout: 'TINFO:3,2,0,"Title"\nTINFO:3,9,0,"01:30:00"\nSINFO:3,8,1,0,"Audio"',
            code: 0,
          };
        options?.onLine?.('PRGV:10,50,100');
        await writeFile(path.join(args.at(-1)!, 'title.mkv'), 'temporary MKV');
        return { stdout: '', code: 0 };
      }
    }
    const paths = new Paths({ downloads, plex }),
      processes = new FakeMakeProcess(),
      files = new Files(paths, processes);
    let finalChoices: RemuxRequest['tracks'] = [];
    let finalTitle = '';
    class FakeMkv extends Mkv {
      override async inspectAbsolute() {
        return { title: '', tracks: generated };
      }
      override async runAbsolute(request: RemuxRequest, _paths: string[], output: string) {
        finalChoices = request.tracks;
        finalTitle = request.title;
        await writeFile(output, 'verified remux result');
      }
    }
    const engine = new MakeMkv(paths, files, processes, new FakeMkv(paths, files, processes));
    await engine.onModuleInit();
    let checkpoint: MakeRequest | undefined;
    const results: string[] = [];
    const context: JobContext = {
      id: 'fixture-job',
      signal: new AbortController().signal,
      update: () => undefined,
      message: () => undefined,
      result: (result) => results.push(result.path),
      checkpoint: (payload) => {
        checkpoint = JSON.parse(JSON.stringify(payload)) as MakeRequest;
      },
    };
    const request: MakeRequest = {
      source: { root: 'downloads', path: 'disc.iso' },
      destination: { root: 'plex', path: '' },
      titles: [3],
      name: 'Movie',
      title: 'Disc title',
    };
    await assert.rejects(engine.convert(request, context), (error) => {
      assert.ok(error instanceof NeedsReview);
      assert.equal(error.files[0].name, 'Movie.mkv');
      assert.equal(error.files[0].title, 'Disc title');
      assert.deepEqual(
        error.files[0].tracks.map((t) => t.id),
        [37, 12],
      );
      return true;
    });
    assert.equal((await readdir(plex)).filter((n) => !n.startsWith('.muxplorer-')).length, 0);
    assert.ok(checkpoint?.checkpoint);
    assert.ok(calls.some((a) => a.includes('iso:' + path.join(downloads, 'disc.iso'))));
    await engine.convert(
      {
        ...checkpoint!,
        review: [
          {
            index: 0,
            name: 'Renamed Movie.mkv',
            title: 'Final MKV title',
            tracks: [
              {
                source: 0,
                id: 37,
                enabled: true,
                name: 'Castellano',
                language: 'es',
                default: true,
                forced: false,
              },
            ],
          },
        ],
      },
      context,
    );
    assert.equal(finalChoices[0].id, 37);
    assert.equal(finalTitle, 'Final MKV title');
    assert.deepEqual(results, ['Renamed Movie.mkv']);
    assert.equal(
      await readFile(path.join(plex, 'Renamed Movie.mkv'), 'utf8'),
      'verified remux result',
    );
    assert.equal(await readFile(path.join(downloads, 'disc.iso'), 'utf8'), 'ISO fixture');
    assert.deepEqual(await readdir(plex), ['Renamed Movie.mkv']);
  } finally {
    config.MAKEMKV_HOME = previousHome;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('MakeMKV activates a fresh beta from the official page, retries and preserves personal licenses', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mux-beta-'));
  const previousHome = config.MAKEMKV_HOME;
  config.MAKEMKV_HOME = path.join(temporary, 'home');
  try {
    const downloads = path.join(temporary, 'downloads'),
      plex = path.join(temporary, 'plex');
    await mkdir(downloads);
    await mkdir(plex);
    await writeFile(path.join(downloads, 'disc.iso'), 'fixture');
    const key = 'T-' + 'a'.repeat(66);
    const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      assert.equal(String(url), 'https://forum.makemkv.com/forum/viewtopic.php?f=5&t=1053');
      return new Response(`<code>${key}</code>`);
    });
    let calls = 0;
    let expiredVersion = false;
    class TrialProcess extends Processes {
      override async run() {
        calls++;
        return calls === 1
          ? await super.run(process.execPath, [
              '-e',
              expiredVersion
                ? `console.log('MSG:5021,0,1,"Version too old; enter a registration key"');process.exit(253)`
                : `console.log('MSG:5053,1544,1,"Start evaluation period now?"');process.exit(139)`,
            ])
          : { code: 0, stdout: 'TINFO:0,2,0,"Movie"' };
      }
    }
    const paths = new Paths({ downloads, plex }),
      processes = new TrialProcess();
    const files = new Files(paths, processes);
    const engine = new MakeMkv(paths, files, processes, new Mkv(paths, files, processes));
    await engine.onModuleInit();
    assert.equal((await engine.inspect({ root: 'downloads', path: 'disc.iso' })).titles.length, 1);
    assert.equal(calls, 2);
    const filename = path.join(config.MAKEMKV_HOME, '.MakeMKV', 'settings.conf');
    const settings = await readFile(filename, 'utf8');
    assert.ok(settings.includes(`app_Key = "${key}"`));
    assert.ok(settings.includes('app_DefaultSelectionString = "+sel:all"'));
    calls = 0;
    expiredVersion = true;
    assert.equal((await engine.inspect({ root: 'downloads', path: 'disc.iso' })).titles.length, 1);
    assert.equal(calls, 2);
    await writeFile(filename, settings.replace(key, 'personal-license'));
    calls = 0;
    await assert.rejects(
      engine.inspect({ root: 'downloads', path: 'disc.iso' }),
      /Revisa tu licencia/,
    );
    assert.equal(fetchMock.mock.callCount(), 2);
    assert.ok((await readFile(filename, 'utf8')).includes('personal-license'));
    // A failed or changed official page leaves the existing configuration intact.
    await writeFile(filename, settings);
    calls = 0;
    fetchMock.mock.mockImplementation(async () => new Response('unavailable', { status: 503 }));
    await assert.rejects(
      engine.inspect({ root: 'downloads', path: 'disc.iso' }),
      /no se pudo obtener/,
    );
    assert.equal(await readFile(filename, 'utf8'), settings);
  } finally {
    config.MAKEMKV_HOME = previousHome;
    await rm(temporary, { recursive: true, force: true });
  }
});
