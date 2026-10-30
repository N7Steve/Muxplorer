import type { Track } from '@muxplorer/shared';

function quality(codec: string): number | undefined {
  const value = codec.toUpperCase().replace(/[._-]/g, ' ');
  if (/DTS.*(MASTER AUDIO|HD MA|XLL)/.test(value)) return 7;
  if (/TRUEHD|TRUE HD|MLP FBA/.test(value)) return 6;
  if (/DTS.*(HIGH RESOLUTION|HD HR|HD HRA)/.test(value)) return 5;
  if (/\bDTS\b/.test(value) && !/HD|EXPRESS/.test(value)) return 4;
  if (/E AC 3|EAC3|DOLBY DIGITAL PLUS/.test(value)) return 3;
  if (/AC 3|AC3|DOLBY DIGITAL/.test(value)) return 2;
  return undefined;
}

// Use engine metadata only. Ambiguous codecs or languages keep the original order.
export function orderAudio<T extends { metadata: Track }>(tracks: T[]): T[] {
  const audio = tracks.filter((track) => track.metadata.type === 'audio');
  const language = (track: T) => {
    const code = track.metadata.language.toLowerCase().split(/[-_]/)[0];
    return code === 'eng' ? 'en' : ['spa', 'esp'].includes(code) ? 'es' : code;
  };
  if (
    audio.some(
      (track) =>
        quality(track.metadata.codec) === undefined ||
        !/^[a-z]{2,3}$/.test(language(track)) ||
        ['und', 'mul', 'zxx'].includes(language(track)),
    )
  )
    return tracks;
  const others = [...new Set(audio.map(language).filter((code) => !['en', 'es'].includes(code)))];
  const rank = (track: T) =>
    language(track) === 'en'
      ? 0
      : language(track) === 'es'
        ? 1
        : 2 + others.indexOf(language(track));
  audio.sort(
    (a, b) => rank(a) - rank(b) || quality(b.metadata.codec)! - quality(a.metadata.codec)!,
  );
  let index = 0;
  return tracks.map((track) => (track.metadata.type === 'audio' ? audio[index++] : track));
}
