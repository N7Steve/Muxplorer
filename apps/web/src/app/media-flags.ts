import type { Track } from '@muxplorer/shared';

// Aeon Nox SiLVO artwork, ordered from specific profiles to their codec families.
export function codecFlag(track: Track): string | null {
  const codec = track.codec.toLowerCase();
  const audio: [RegExp, string][] = [
    [/atmos/, 'atmos'],
    [/dts[\s:_-]*x|dtshd_ma_x/, 'dtsx'],
    [/dts.*(master|ma)|dtshd_ma/, 'dtshd_ma'],
    [/dts.*(high resolution|hra)|dtshd_hra/, 'dtshd_hra'],
    [/dts/, 'dts'],
    [/true[\s-]*hd|mlp/, 'truehd'],
    [/e[\s-]*ac[\s-]*3|digital plus/, 'eac3'],
    [/ac[\s-]*3|dolby/, 'ac3'],
    [/aac/, 'aac'],
    [/flac/, 'flac'],
    [/pcm/, 'pcm'],
    [/opus/, 'opus'],
    [/vorbis/, 'vorbis'],
    [/mp3|layer 3/, 'mp3'],
    [/mp2|layer 2/, 'mp2'],
  ];
  const video: [RegExp, string][] = [
    [/hevc|h[\s./-]*265|mpeg-h/, 'hevc'],
    [/avc|h[\s./-]*264/, 'h264'],
    [/av1/, 'av1'],
    [/mpeg[\s-]*2/, 'mpeg2'],
    [/vc[\s-]*1/, 'vc1'],
  ];
  const match = (track.type === 'audio' ? audio : track.type === 'video' ? video : []).find(
    ([pattern]) => pattern.test(codec),
  );
  return match ? `/media-flags/${match[1]}.png` : null;
}

// A language has no unique country; use a representative flag unless a region is explicit.
const languageCountries: Record<string, string> = {
  es: 'es',
  spa: 'es',
  en: 'gb',
  eng: 'gb',
  fr: 'fr',
  fre: 'fr',
  fra: 'fr',
  de: 'de',
  ger: 'de',
  deu: 'de',
  it: 'it',
  ita: 'it',
  pt: 'pt',
  por: 'pt',
  ja: 'jp',
  jpn: 'jp',
  zh: 'cn',
  chi: 'cn',
  zho: 'cn',
  ko: 'kr',
  kor: 'kr',
  ru: 'ru',
  rus: 'ru',
  ca: 'es-ct',
  cat: 'es-ct',
  eu: 'es-pv',
  baq: 'es-pv',
  eus: 'es-pv',
  gl: 'es-ga',
  glg: 'es-ga',
  ar: 'sa',
  ara: 'sa',
  nl: 'nl',
  dut: 'nl',
  nld: 'nl',
  pl: 'pl',
  pol: 'pl',
  sv: 'se',
  swe: 'se',
  no: 'no',
  nor: 'no',
  da: 'dk',
  dan: 'dk',
  fi: 'fi',
  fin: 'fi',
  cs: 'cz',
  cze: 'cz',
  ces: 'cz',
  el: 'gr',
  gre: 'gr',
  ell: 'gr',
  tr: 'tr',
  tur: 'tr',
  hi: 'in',
  hin: 'in',
  he: 'il',
  heb: 'il',
  uk: 'ua',
  ukr: 'ua',
  ro: 'ro',
  rum: 'ro',
  ron: 'ro',
  hu: 'hu',
  hun: 'hu',
  th: 'th',
  tha: 'th',
};
export function languageFlag(language: string): string | null {
  const parts = language.trim().toLowerCase().replaceAll('_', '-').split('-');
  const region = parts.slice(1).find((part) => /^[a-z]{2}$/.test(part));
  const country = region || languageCountries[parts[0]];
  return country ? `/language-flags/${country}.svg` : null;
}
