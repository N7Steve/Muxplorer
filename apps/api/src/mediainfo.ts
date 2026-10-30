import { Injectable } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import type { Location, MediaSummary, SummaryTrack } from '@muxplorer/shared';
import { Paths } from './paths';
import { Processes } from './process';
import { config } from './config';
import { problem } from './errors';
import { Files } from './files';

type RawTrack = Record<string, unknown>;
const text = (track: RawTrack, key: string) =>
  typeof track[key] === 'string' || typeof track[key] === 'number' ? String(track[key]) : '';
const number = (track: RawTrack, key: string) => {
  const value = Number(text(track, key));
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

export function hdrSummary(track: RawTrack): string {
  const format = text(track, 'HDR_Format');
  const compatibility = text(track, 'HDR_Format_Compatibility');
  const profile = text(track, 'HDR_Format_Profile');
  const result: string[] = [];
  if (/Dolby Vision/i.test(format)) {
    const match =
      profile.match(/dv(?:he|av|h1|a1)\.(\d+)/i) ??
      profile.match(/(?:Profile\s*)?(\d+(?:\.\d+)?)/i);
    result.push(`Dolby Vision${match ? ` Profile ${Number(match[1])}` : ''}`);
  }
  if (/HDR10\+|ST\s*2094[ -](?:40|App\s*4)/i.test(`${format} ${compatibility}`))
    result.push('HDR10+');
  if (/HDR10(?!\+)/i.test(compatibility)) result.push('HDR10');
  const transfer = text(track, 'transfer_characteristics');
  if (/HLG|ARIB STD-B67/i.test(`${compatibility} ${transfer}`)) result.push('HLG');
  if (result.length) return result.join(' + ');
  if (format) return format;
  if (/PQ|2084/i.test(transfer)) return 'PQ (HDR sin formato identificado)';
  if (/BT\.709|BT\.601|sRGB/i.test(transfer)) return 'SDR';
  return 'No informado';
}

export function parseMediaSummary(raw: unknown, location: Location, size: number): MediaSummary {
  const tracks = (raw as { media?: { track?: unknown } })?.media?.track;
  if (!Array.isArray(tracks) || tracks.some((t) => !t || typeof t !== 'object'))
    problem('MediaInfo no ha devuelto información válida.');
  const all = tracks as RawTrack[];
  const general = all.find((t) => t['@type'] === 'General') ?? {};
  const convert = (t: RawTrack): SummaryTrack => ({
    codec:
      [
        text(t, 'Format_Commercial_IfAny') || text(t, 'Format_Commercial') || text(t, 'Format'),
        text(t, 'Format_Profile'),
        text(t, 'Format_AdditionalFeatures'),
      ]
        .filter(Boolean)
        .join(' · ') || 'No informado',
    bitrate: number(t, 'BitRate'),
    bitrateMode: text(t, 'BitRate_Mode'),
    language: text(t, 'Language') || 'No informado',
    title: text(t, 'Title'),
    channels: number(t, 'Channels'),
    layout: text(t, 'ChannelLayout'),
    sampleRate: number(t, 'SamplingRate'),
    width: number(t, 'Width'),
    height: number(t, 'Height'),
    frameRate: number(t, 'FrameRate'),
    bitDepth: number(t, 'BitDepth'),
    hdr: hdrSummary(t),
    color: [text(t, 'colour_primaries'), text(t, 'ChromaSubsampling')].filter(Boolean).join(' · '),
  });
  const videos = all.filter((t) => t['@type'] === 'Video').map(convert);
  const audios = all.filter((t) => t['@type'] === 'Audio').map(convert);
  if (!videos.length && !audios.length)
    problem('El archivo no contiene pistas de vídeo o audio reconocidas.');
  return {
    location,
    size,
    container: text(general, 'Format') || 'No informado',
    duration: number(general, 'Duration'),
    bitrate: number(general, 'OverallBitRate'),
    videos,
    audios,
  };
}

@Injectable()
export class MediaInfo {
  constructor(
    private readonly paths: Paths,
    private readonly processes: Processes,
    private readonly files: Files,
  ) {}
  async inspect(location: Location): Promise<MediaSummary> {
    return this.files.exclusive([location], () => this.inspectFile(location));
  }
  private async inspectFile(location: Location): Promise<MediaSummary> {
    const absolute = await this.paths.file(location);
    const before = await stat(absolute);
    const result = await this.processes.run(
      config.MEDIAINFO_BIN,
      ['--Output=JSON', '--', absolute],
      { timeout: 60_000 },
    );
    const after = await stat(absolute);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== after.ino ||
      before.dev !== after.dev
    )
      problem('El archivo ha cambiado durante el análisis. Vuelve a abrirlo.');
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      problem('MediaInfo no ha devuelto JSON válido.');
    }
    return parseMediaSummary(raw, location, after.size);
  }
}
