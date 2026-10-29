import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metadataArguments, mkvArguments, parseMkv } from '../src/mkv';
import { parseDisc, robotFields, makeSource } from '../src/makemkv';
import type { MetadataRequest, RemuxRequest, Track } from '@muxplorer/shared';
import { metadata, parse } from '../src/contracts';
const video: Track = {
  id: 0,
  type: 'video',
  codec: 'HEVC',
  language: 'und',
  name: '',
  default: true,
  forced: false,
  resolution: '3840x2160',
};
const audio: Track = {
  id: 1,
  type: 'audio',
  codec: 'DTS',
  language: 'eng',
  name: 'Original',
  default: false,
  forced: false,
  channels: 6,
};
const subtitles: Track = { ...audio, id: 0, type: 'subtitles', codec: 'SRT', language: 'spa' };
const request: RemuxRequest = {
  sources: [
    { root: 'downloads', path: 'movie.mkv' },
    { root: 'plex', path: 'subs.srt' },
  ],
  tracks: [
    {
      source: 1,
      id: 0,
      enabled: true,
      name: 'Español',
      language: 'es',
      default: true,
      forced: true,
    },
    { source: 0, id: 0, enabled: true, name: '', language: 'und', default: true, forced: false },
    {
      source: 0,
      id: 1,
      enabled: false,
      name: 'Omitir',
      language: 'eng',
      default: false,
      forced: false,
    },
  ],
  title: 'Movie "Name"; $(never)',
  destination: { root: 'plex', path: '' },
  name: 'out.mkv',
};

test('metadata editor selects tracks by type ordinal, not sparse identification IDs, and changes only requested fields', () => {
  const tracks = [video, { ...audio, id: 7 }, { ...audio, id: 12 }];
  const edit: MetadataRequest = {
    source: request.sources[0],
    revision: 'revision',
    title: 'Movie',
    tracks: [{ id: 12, name: '', language: 'es-MX', default: true, forced: true }],
  };
  const args = metadataArguments(edit, { title: 'Movie', tracks });
  assert.deepEqual(args, [
    '--edit',
    'track:a2',
    '--set',
    'name=',
    '--set',
    'language=es-MX',
    '--set',
    'flag-default=1',
    '--set',
    'flag-forced=1',
  ]);
  assert.deepEqual(
    metadataArguments({ ...edit, tracks: [], title: '' }, { title: 'Movie', tracks }),
    ['--edit', 'info', '--set', 'title='],
  );
  assert.deepEqual(
    metadataArguments({ ...edit, tracks: [{ ...audio, id: 7 }] }, { title: 'Movie', tracks }),
    [],
  );
  assert.throws(() =>
    metadataArguments(
      { ...edit, tracks: [edit.tracks[0], edit.tracks[0]] },
      { title: 'Movie', tracks },
    ),
  );
  assert.throws(() =>
    metadataArguments(
      { ...edit, tracks: [{ ...edit.tracks[0], id: 999 }] },
      { title: 'Movie', tracks },
    ),
  );
  assert.throws(() =>
    parse(metadata, { ...edit, tracks: [{ ...edit.tracks[0], enabled: false }] }),
  );
  assert.throws(() => parse(metadata, { ...edit, revision: undefined }));
});
test('mkvmerge JSON preserves metadata and refuses unsupported containers', () => {
  const result = parseMkv(
    JSON.stringify({
      container: { recognized: true, supported: true, properties: { title: 'Movie' } },
      tracks: [
        {
          id: 7,
          type: 'audio',
          codec: 'DTS-HD',
          properties: {
            language_ietf: 'es-ES',
            track_name: 'Castellano',
            audio_channels: 8,
            default_track: true,
            forced_track: false,
          },
        },
      ],
    }),
  );
  assert.equal(result.title, 'Movie');
  assert.equal(result.tracks[0].language, 'es-ES');
  assert.equal(result.tracks[0].channels, 8);
  assert.equal(result.tracks[0].id, 7);
  assert.throws(() => parseMkv('{"container":{"supported":false},"tracks":[]}'));
  assert.throws(() => parseMkv('not json'));
});
test('multiple input IDs stay distinct; tracks ordered globally with per-input switches', () => {
  const args = mkvArguments(
    request,
    [
      { absolute: '/data/downloads/movie.mkv', tracks: [video, audio] },
      { absolute: '/data/plex/subs.srt', tracks: [subtitles] },
    ],
    '/data/plex/.temporary/out.mkv',
  );
  assert.equal(args[args.indexOf('--track-order') + 1], '1:0,0:0');
  assert.ok(args.includes('--no-audio'));
  assert.ok(args.includes('--no-subtitles'));
  assert.ok(args.indexOf('/data/downloads/movie.mkv') < args.indexOf('/data/plex/subs.srt'));
  assert.ok(!args.includes('+'));
  assert.ok(!args.includes('('));
  assert.equal(args[args.indexOf('--title') + 1], request.title);
  const second = args.slice(args.indexOf('/data/downloads/movie.mkv') + 1);
  assert.ok(second.includes('--subtitle-tracks'));
  assert.ok(second.includes('0:Español'));
  assert.ok(second.includes('0:1'));
});
test('unknown and duplicate tracks are rejected', () => {
  assert.throws(() =>
    mkvArguments({ ...request, tracks: [...request.tracks, request.tracks[0]] }, [], 'out'),
  );
  assert.throws(() =>
    mkvArguments({ ...request, tracks: [{ ...request.tracks[0], source: 5 }] }, [], 'out'),
  );
  assert.throws(() => mkvArguments({ ...request, tracks: [] }, [], 'out'));
});
test('MakeMKV robot parser handles quotes, commas, language-independent attributes', () => {
  const result = parseDisc(
    'MSG:1005,0,1,"MakeMKV started","%1"\nTINFO:0,2,0,"Movie, \\"edition\\""\nTINFO:0,9,0,"1:40:05"\nTINFO:0,10,0,"22.4 GB"\nTINFO:0,8,0,"18"\nSINFO:0,7,1,6202,"Audio"\nSINFO:0,7,3,0,"spa"\nSINFO:0,7,7,0,"DTS-HD Master Audio"\nTINFO:1,2,0,"Extras"',
  );
  assert.equal(result.titles.length, 2);
  assert.equal(result.titles[0].name, 'Movie, "edition"');
  assert.equal(result.titles[0].duration, '1:40:05');
  assert.equal(result.titles[0].chapters, '18');
  assert.equal(result.titles[0].streams[0].id, 7);
  assert.equal(result.titles[0].streams[0].language, 'spa');
  assert.equal(result.messages[0], 'MakeMKV started');
  assert.deepEqual(robotFields('1,"a,b","x\\nline"'), ['1', 'a,b', 'x\nline']);
  assert.throws(() => robotFields('"broken'));
});
test('MakeMKV ISO and BDMV use different real source specifications', () => {
  assert.equal(makeSource('/data/downloads/movie.iso'), 'iso:/data/downloads/movie.iso');
  assert.equal(makeSource('/data/downloads/Movie/BDMV/index.bdmv'), 'file:/data/downloads/Movie');
  assert.throws(() => makeSource('/data/downloads/index.bdmv'));
});
