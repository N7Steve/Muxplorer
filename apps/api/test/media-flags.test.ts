import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { Track } from '@muxplorer/shared';
import { codecFlag, languageFlag } from '../../web/src/app/media-flags';

test('codec badges distinguish profiles and resolve to bundled Kodi artwork', () => {
  const examples = [
    ['DTS', 'dts'],
    ['DTS-HD Master Audio', 'dtshd_ma'],
    ['DTS-HD High Resolution', 'dtshd_hra'],
    ['DTS:X', 'dtsx'],
    ['TrueHD', 'truehd'],
    ['TrueHD Atmos', 'atmos'],
    ['E-AC-3', 'eac3'],
    ['AC-3 Dolby Surround EX', 'ac3'],
    ['HEVC/H.265/MPEG-H', 'hevc'],
    ['AVC/H.264/MPEG-4p10', 'h264'],
  ];
  for (const [codec, expected] of examples) {
    const flag = codecFlag({ codec, type: /HEVC|AVC/.test(codec) ? 'video' : 'audio' } as Track);
    assert.equal(flag, `/media-flags/${expected}.png`);
    assert.ok(existsSync(`../web/public${flag}`));
  }
  assert.equal(codecFlag({ codec: 'Unknown', type: 'audio', name: 'Atmos' } as Track), null);
  assert.equal(codecFlag({ codec: 'SubRip/SRT', type: 'subtitles' } as Track), null);
});

test('language flags support ISO aliases and explicit BCP 47 regions', () => {
  for (const [language, country] of [
    ['eng', 'gb'],
    ['spa', 'es'],
    ['fre', 'fr'],
    ['ger', 'de'],
    ['deu', 'de'],
    ['es-MX', 'mx'],
    ['en_US', 'us'],
    ['zh-Hant-TW', 'tw'],
  ])
    assert.equal(languageFlag(language), `/language-flags/${country}.svg`);
  assert.equal(languageFlag('und'), null);
  assert.equal(languageFlag('mul'), null);
});
