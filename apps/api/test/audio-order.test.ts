import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Track } from '@muxplorer/shared';
import { orderAudio } from '../../web/src/app/audio-order';

function audio(id: number, codec: string, language: string) {
  return {
    metadata: {
      id,
      codec,
      language,
      type: 'audio',
      name: '',
      default: false,
      forced: false,
    } as Track,
  };
}

test('audio order groups English then Spanish by known codec quality and preserves other tracks', () => {
  const video = { metadata: { ...audio(0, 'AVC', 'und').metadata, type: 'video' } as Track };
  const subtitle = { metadata: { ...audio(8, 'PGS', 'eng').metadata, type: 'subtitles' } as Track };
  const tracks = [
    video,
    audio(1, 'DTS-HD Master Audio', 'it'),
    audio(2, 'DTS', 'es-ES'),
    audio(3, 'AC-3', 'eng'),
    subtitle,
    audio(4, 'Dolby TrueHD', 'en-US'),
    audio(5, 'DTS-HD MA', 'spa'),
    audio(6, 'DTS-HD Master Audio', 'eng'),
  ];
  const result = orderAudio(tracks);
  assert.deepEqual(
    result.map((track) => track.metadata.id),
    [0, 6, 4, 3, 8, 5, 2, 1],
  );
  assert.equal(result[0], video);
  assert.equal(result[4], subtitle);
  assert.equal(tracks[1].metadata.id, 1);
});

test('ambiguous audio metadata and equal quality preserve original order', () => {
  for (const unknown of [audio(3, 'AAC', 'en'), audio(3, 'DTS', 'und'), audio(3, 'DTS-HD', 'en')]) {
    const tracks = [audio(1, 'DTS', 'es'), unknown, audio(2, 'DTS', 'en')];
    assert.deepEqual(orderAudio(tracks), tracks);
  }
  const tied = [audio(1, 'DTS', 'en'), audio(2, 'DTS', 'eng')];
  assert.deepEqual(orderAudio(tied), tied);
});
