import { safeName } from './paths';

export function downloadPart(name: string) {
  const rar = /^(.*?)[. _-]part(\d{1,5})\.rar$/i.exec(name);
  const split = /^(.*?)\.(\d{3,5})$/i.exec(name);
  const match = rar ?? split;
  if (!match?.[1]) return undefined;
  const part = Number(match[2]);
  if (!part) return undefined;
  const title = match[1] + (rar ? '.rar' : '');
  return {
    key: (rar ? 'rar:' : 'split:') + title.normalize('NFC').toLowerCase(),
    name: title,
    part,
  };
}

export function nameFromLink(url: string) {
  // Only take a filename from the path. Queries and fragments may carry credentials.
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    const candidate = name.replace(/(\.rar|\.\d{3,5})\.html$/i, '$1');
    return downloadPart(candidate) ? safeName(candidate) : undefined;
  } catch {
    return undefined;
  }
}
