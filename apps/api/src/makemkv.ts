import { Injectable, OnModuleInit } from '@nestjs/common';
import path from 'node:path';
import { mkdir, readdir, rm, lstat, readFile, writeFile } from 'node:fs/promises';
import type { Disc, DiscTitle, Location, RemuxRequest, TrackChoice } from '@muxplorer/shared';
import { Paths, safeName } from './paths';
import { Files } from './files';
import { Processes } from './process';
import { Mkv } from './mkv';
import { JobContext, NeedsReview } from './jobs';
import { config } from './config';
import { problem } from './errors';
export interface MakeRequest {
  source: Location;
  destination: Location;
  titles: number[];
  name: string;
  checkpoint?: { files: { title: number; relative: string; name: string }[] };
  review?: { index: number; tracks: TrackChoice[]; name: string }[];
}
// Robot fields use C-style backslash escaping, not RFC CSV quoting.
export function robotFields(line: string): string[] {
  const fields: string[] = [];
  let field = '',
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && quoted) {
      const next = line[++i];
      field += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : (next ?? '');
    } else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else field += ch;
  }
  if (quoted) problem('Salida robot incompleta de MakeMKV.');
  fields.push(field);
  return fields;
}
export function parseDisc(output: string): Omit<Disc, 'location'> {
  const titles = new Map<
    number,
    { attrs: Record<string, string>; streams: Map<number, Record<string, string>> }
  >();
  const messages: string[] = [];
  const title = (id: number) => {
    if (!titles.has(id)) titles.set(id, { attrs: {}, streams: new Map() });
    return titles.get(id)!;
  };
  for (const line of output.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const kind = line.slice(0, colon),
      f = robotFields(line.slice(colon + 1));
    if (kind === 'MSG') messages.push(f[3] ?? '');
    if (kind === 'TINFO' && f.length >= 4) title(Number(f[0])).attrs[f[1]] = f[3];
    if (kind === 'SINFO' && f.length >= 5) {
      const t = title(Number(f[0]));
      const id = Number(f[1]);
      if (!t.streams.has(id)) t.streams.set(id, {});
      t.streams.get(id)![f[2]] = f[4];
    }
  }
  const result: DiscTitle[] = [...titles].map(([id, t]) => ({
    id,
    name: t.attrs['2'] ?? `Título ${id}`,
    duration: t.attrs['9'] ?? '—',
    size: t.attrs['10'] ?? t.attrs['11'] ?? '—',
    chapters: t.attrs['8'] ?? '—',
    streams: [...t.streams].map(([stream, a]) => ({
      id: stream,
      type: a['1'] ?? 'Desconocido',
      codec: a['7'] ?? a['6'] ?? a['5'] ?? '',
      language: a['3'] ?? 'und',
      description: a['30'] ?? a['2'] ?? '',
    })),
  }));
  return { titles: result, messages: messages.slice(-30) };
}
export function makeSource(absolute: string) {
  if (/\.iso$/i.test(absolute)) return `iso:${absolute}`;
  if (
    path.basename(absolute).toLowerCase() === 'index.bdmv' &&
    path.basename(path.dirname(absolute)).toLowerCase() === 'bdmv'
  )
    return `file:${path.dirname(path.dirname(absolute))}`;
  return problem('MakeMKV requiere una ISO o un index.bdmv dentro de una carpeta BDMV válida.');
}
@Injectable()
export class MakeMkv implements OnModuleInit {
  constructor(
    private readonly paths: Paths,
    private readonly files: Files,
    private readonly processes: Processes,
    private readonly mkv: Mkv,
  ) {}
  async onModuleInit() {
    const folder = path.join(this.env().HOME, '.MakeMKV');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        path.join(folder, 'settings.conf'),
        'app_DefaultSelectionString = "+sel:all"\napp_UpdateEnable = "0"\n',
        { mode: 0o600, flag: 'wx' },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  env() {
    return { ...process.env, HOME: config.MAKEMKV_HOME ?? path.join(config.CONFIG_DIR, 'makemkv') };
  }
  async source(location: Location) {
    const absolute = await this.paths.file(location);
    const source = makeSource(absolute);
    if (source.startsWith('file:')) {
      await this.paths.tree(path.dirname(path.dirname(absolute)));
      const names = (await readdir(path.dirname(absolute))).map((n) => n.toLowerCase());
      if (!names.includes('stream') || !names.includes('playlist'))
        problem('La estructura Blu-ray no contiene STREAM y PLAYLIST.');
    }
    return source;
  }
  async inspect(location: Location): Promise<Disc> {
    const source = await this.source(location);
    const result = await this.processes.run(
      config.MAKEMKV_BIN,
      ['-r', '--noscan', '--cache=128', 'info', source],
      { env: this.env(), timeout: 10 * 60_000, captureLimit: 16 * 1024 * 1024 },
    );
    const disc = parseDisc(result.stdout);
    if (!disc.titles.length)
      problem(
        `MakeMKV no encontró títulos. Comprueba instalación, licencia y origen. ${disc.messages.slice(-3).join(' ')}`,
      );
    return { location, ...disc };
  }
  async convert(request: MakeRequest, context: JobContext) {
    safeName(request.name);
    const parent = await this.paths.directory(request.destination);
    let staging = path.join(parent, `.muxplorer-${context.id}`);
    if (!request.checkpoint) {
      const source = await this.source(request.source);
      const disc = await this.inspect(request.source);
      for (const id of request.titles)
        if (!disc.titles.some((t) => t.id === id))
          problem('El título elegido ya no está disponible.');
      // Do not inherit a user's language-filtered defaults: every generated track is reviewed.
      const settings = await readFile(
        path.join(this.env().HOME, '.MakeMKV', 'settings.conf'),
        'utf8',
      ).catch(() => '');
      if (!/^app_DefaultSelectionString\s*=\s*"\+sel:all"\s*$/m.test(settings))
        problem(
          'Configura app_DefaultSelectionString = "+sel:all" en /config/makemkv/.MakeMKV/settings.conf. Es necesario conservar las pistas antes de revisarlas.',
        );
      staging = await this.files.staging(request.destination, context.id);
      const generated: NonNullable<MakeRequest['checkpoint']>['files'] = [];
      try {
        for (const id of request.titles) {
          const relative = `title-${id}`;
          const directory = path.join(staging, relative);
          await mkdir(directory);
          context.update(`MakeMKV · Extrayendo título ${id}`);
          await this.processes.run(
            config.MAKEMKV_BIN,
            [
              '-r',
              '--noscan',
              '--cache=512',
              '--progress=-same',
              'mkv',
              source,
              String(id),
              directory,
            ],
            {
              env: this.env(),
              signal: context.signal,
              onLine: (line) => {
                if (line.startsWith('PRGV:')) {
                  const f = robotFields(line.slice(5));
                  const maximum = Number(f[2]);
                  if (maximum > 0)
                    context.update(`MakeMKV · Título ${id}`, (Number(f[1]) / maximum) * 100);
                }
                if (line.startsWith('MSG:')) {
                  const fields = robotFields(line.slice(4));
                  context.message(fields[3] ?? '');
                }
              },
            },
          );
          const output = (await readdir(directory)).filter((name) =>
            name.toLowerCase().endsWith('.mkv'),
          );
          if (output.length !== 1)
            problem(
              'MakeMKV no produjo exactamente un MKV para el título. Consulta los mensajes y la licencia.',
            );
          const file = path.join(relative, output[0]);
          if (!(await lstat(path.join(staging, file))).size) problem('El MKV generado está vacío.');
          generated.push({
            title: id,
            relative: file,
            name:
              request.titles.length === 1
                ? `${request.name.replace(/\.mkv$/i, '')}.mkv`
                : `${request.name.replace(/\.mkv$/i, '')}-t${id}.mkv`,
          });
        }
        request.checkpoint = { files: generated };
        context.checkpoint(request);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    }
    // The manifest is server-created; no client-supplied paths or track correspondences are trusted.
    await this.paths.tree(staging);
    const checkpoint = request.checkpoint!;
    if (!request.review) {
      const review = await Promise.all(
        checkpoint.files.map(async (file, index) => ({
          index,
          name: file.name,
          tracks: (await this.mkv.inspectAbsolute(path.join(staging, file.relative))).tracks,
        })),
      );
      throw new NeedsReview(review);
    }
    if (
      request.review.length !== checkpoint.files.length ||
      new Set(request.review.map((f) => f.index)).size !== checkpoint.files.length
    )
      problem('Revisa todos los títulos generados.');
    for (const selected of request.review)
      if (!checkpoint.files[selected.index]) problem('Índice de título desconocido.');
    if (new Set(request.review.map((f) => f.name)).size !== request.review.length)
      problem('Cada título debe tener un nombre de salida diferente.');
    for (const selected of request.review)
      await this.files.absent({
        ...request.destination,
        path: [request.destination.path, safeName(selected.name)].filter(Boolean).join('/'),
      });
    try {
      for (const selected of request.review) {
        context.signal.throwIfAborted();
        const file = checkpoint.files[selected.index];
        const input = path.join(staging, file.relative);
        const output = path.join(staging, `result-${selected.index}.mkv`);
        const remux: RemuxRequest = {
          sources: [request.source],
          tracks: selected.tracks,
          title: request.name,
          destination: request.destination,
          name: selected.name,
        };
        await this.mkv.runAbsolute(remux, [input], output, context);
        context.result(
          await this.files.exclusive(() =>
            this.files.publish(output, request.destination, selected.name),
          ),
        );
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
