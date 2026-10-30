import assert from 'node:assert/strict';
import test from 'node:test';
import { hdrSummary, parseMediaSummary } from '../src/mediainfo';

test('MediaInfo preserves simultaneous Dolby Vision, HDR10+ and HDR10 with the real DV profile', () => {
  assert.equal(
    hdrSummary({
      HDR_Format: 'Dolby Vision / SMPTE ST 2094 App 4',
      HDR_Format_Profile: 'dvhe.08.06 / ',
      HDR_Format_Compatibility: 'HDR10 / HDR10+ Profile B',
    }),
    'Dolby Vision Profile 8 + HDR10+ + HDR10',
  );
  assert.equal(
    hdrSummary({ HDR_Format: 'Dolby Vision', HDR_Format_Profile: 'dvhe.05.06' }),
    'Dolby Vision Profile 5',
  );
  assert.equal(
    hdrSummary({
      HDR_Format: 'Dolby Vision',
      HDR_Format_Profile: 'Profile 8.4',
      HDR_Format_Compatibility: 'HLG',
    }),
    'Dolby Vision Profile 8.4 + HLG',
  );
  assert.equal(
    hdrSummary({ HDR_Format: 'SMPTE ST 2086', HDR_Format_Compatibility: 'HDR10' }),
    'HDR10',
  );
  assert.equal(hdrSummary({ HDR_Format: 'SMPTE ST 2094 App 4' }), 'HDR10+');
});

test('MediaInfo never infers HDR from the filename, bit depth or BT.2020 alone', () => {
  assert.equal(hdrSummary({ BitDepth: '10', colour_primaries: 'BT.2020' }), 'No informado');
  assert.equal(hdrSummary({ transfer_characteristics: 'PQ' }), 'PQ (HDR sin formato identificado)');
  assert.equal(hdrSummary({ transfer_characteristics: 'BT.709' }), 'SDR');
});

test('MediaInfo separates total and video bitrate and retains every audio track and missing values', () => {
  const summary = parseMediaSummary(
    {
      media: {
        track: [
          {
            '@type': 'General',
            Format: 'Matroska',
            Duration: '7200.125',
            OverallBitRate: '65000000',
          },
          {
            '@type': 'Video',
            Format: 'HEVC',
            Format_Profile: 'Main 10@L5.1@High',
            Width: '3840',
            Height: '2160',
            FrameRate: '23.976',
            BitDepth: '10',
            BitRate: '60000000',
          },
          {
            '@type': 'Audio',
            Format: 'MLP FBA',
            Format_AdditionalFeatures: '16-ch',
            Language: 'en',
            Channels: '8',
            BitRate: '4000000',
          },
          {
            '@type': 'Audio',
            Format: 'AC-3',
            Language: 'es',
            Channels: '6',
            SamplingRate: '48000',
          },
        ],
      },
    },
    { root: 'downloads', path: 'Movie.DV.HDR10+.mkv' },
    12345,
  );
  assert.equal(summary.duration, 7200.125);
  assert.equal(summary.bitrate, 65000000);
  assert.equal(summary.videos[0].bitrate, 60000000);
  assert.equal(summary.videos[0].hdr, 'No informado');
  assert.equal(summary.audios.length, 2);
  assert.equal(summary.audios[0].language, 'en');
  assert.equal(summary.audios[1].language, 'es');
  assert.equal(summary.audios[1].sampleRate, 48000);
  assert.equal(summary.audios[1].bitrate, undefined);
});

test('MediaInfo rejects invalid and non-media output rather than displaying an empty report', () => {
  for (const raw of [
    null,
    {},
    { media: { track: {} } },
    { media: { track: [null] } },
    { media: { track: [{ '@type': 'General' }] } },
  ]) {
    assert.throws(() => parseMediaSummary(raw, { root: 'downloads', path: 'file.txt' }, 1));
  }
});
