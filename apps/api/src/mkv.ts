import { Injectable } from '@nestjs/common';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { rm, lstat } from 'node:fs/promises';
import { z } from 'zod';
import type { Media, MetadataRequest, RemuxRequest, Track } from '@muxplorer/shared';
import { Paths, safeName, childLocation } from './paths';
import { Files } from './files';
import { Processes } from './process';
import { config } from './config';
import { JobContext } from './jobs';
import { problem } from './errors';
const identification = z.object({
  container: z.object({
    recognized: z.boolean().optional(),
    supported: z.boolean().optional(),
    properties: z.object({ title: z.string().optional() }).passthrough().optional(),
  }),
  tracks: z.array(
    z.object({
      id: z.number().int().nonnegative(),
      type: z.string(),
      codec: z.string(),
      properties: z
        .object({
          language: z.string().optional(),
          language_ietf: z.string().optional(),
          track_name: z.string().optional(),
          audio_channels: z.number().optional(),
          pixel_dimensions: z.string().optional(),
          default_track: z.boolean().optional(),
          forced_track: z.boolean().optional(),
        })
        .passthrough(),
    }),
  ),
  errors: z.array(z.string()).optional(),
});
export function parseMkv(json: string): Omit<Media, 'location'> {
  const data = identification.parse(JSON.parse(json));
  if (
    data.container.recognized === false ||
    data.container.supported === false ||
    data.errors?.length
  )
    problem(data.errors?.join('\n') || 'Contenedor no compatible con MKVToolNix.');
  const tracks: Track[] = data.tracks
    .filter((t) => ['video', 'audio', 'subtitles'].includes(t.type))
    .map((t) => ({
      id: t.id,
      type: t.type as Track['type'],
      codec: t.codec,
      language: t.properties.language_ietf ?? t.properties.language ?? 'und',
      name: t.properties.track_name ?? '',
      channels: t.properties.audio_channels,
      resolution: t.properties.pixel_dimensions,
      default: t.properties.default_track ?? false,
      forced: t.properties.forced_track ?? false,
    }));
  if (!tracks.length) problem('No se encontraron pistas compatibles.');
  return { title: data.container.properties?.title ?? '', tracks };
}
export function mkvArguments(
  request: RemuxRequest,
  sources: { absolute: string; tracks: Track[] }[],
  output: string,
): string[] {
  const enabled = request.tracks.filter((t) => t.enabled);
  if (!enabled.length) problem('Selecciona al menos una pista.');
  if (new Set(request.tracks.map((t) => `${t.source}:${t.id}`)).size !== request.tracks.length)
    problem('Hay pistas duplicadas.');
  for (const choice of request.tracks)
    if (!sources[choice.source]?.tracks.some((t) => t.id === choice.id))
      problem('La selección contiene una pista desconocida.');
  const args = [
    '--gui-mode',
    '--output',
    output,
    '--title',
    request.title,
    '--track-order',
    enabled.map((t) => `${t.source}:${t.id}`).join(','),
  ];
  sources.forEach((source, index) => {
    const selected = enabled.filter((t) => t.source === index);
    for (const type of ['video', 'audio', 'subtitles'] as const) {
      const ids = selected
        .filter((t) => source.tracks.find((track) => track.id === t.id)?.type === type)
        .map((t) => t.id);
      args.push(
        ids.length
          ? type === 'subtitles'
            ? '--subtitle-tracks'
            : `--${type}-tracks`
          : `--no-${type}`,
        ...(ids.length ? [ids.join(',')] : []),
      );
    }
    args.push('--no-buttons');
    if (index > 0) args.push('--no-chapters', '--no-global-tags');
    for (const track of selected)
      args.push(
        '--track-name',
        `${track.id}:${track.name}`,
        '--language',
        `${track.id}:${track.language || 'und'}`,
        '--default-track-flag',
        `${track.id}:${track.default ? 1 : 0}`,
        '--forced-display-flag',
        `${track.id}:${track.forced ? 1 : 0}`,
      );
    // Each source is a separate input; no '+' (append) or parenthesized concatenation.
    args.push(source.absolute);
  });
  return args;
}
export function metadataArguments(
  request: MetadataRequest,
  media: Omit<Media, 'location'>,
): string[] {
  if (
    new Set(request.tracks.map((t) => t.id)).size !== request.tracks.length ||
    request.tracks.some((t) => !media.tracks.some((original) => original.id === t.id))
  )
    problem('La selección contiene pistas desconocidas o duplicadas.');
  const args: string[] = [];
  if (request.title !== media.title) args.push('--edit', 'info', '--set', `title=${request.title}`);
  const positions = { video: 0, audio: 0, subtitles: 0 };
  for (const original of media.tracks) {
    const ordinal = ++positions[original.type];
    const track = request.tracks.find((t) => t.id === original.id);
    if (!track) continue;
    const changes: string[] = [];
    for (const [field, property] of [
      ['name', 'name'],
      ['language', 'language'],
      ['default', 'flag-default'],
      ['forced', 'flag-forced'],
    ] as const) {
      if (track[field] !== original[field])
        changes.push(
          '--set',
          `${property}=${typeof track[field] === 'boolean' ? Number(track[field]) : track[field]}`,
        );
    }
    if (changes.length)
      args.push(
        '--edit',
        `track:${original.type === 'subtitles' ? 's' : original.type[0]}${ordinal}`,
        ...changes,
      );
  }
  return args;
}
async function fileRevision(absolute: string) {
  const stat = await lstat(absolute, { bigint: true });
  return createHash('sha256')
    .update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'))
    .digest('hex');
}
@Injectable()
export class Mkv {
  constructor(
    private readonly paths: Paths,
    private readonly files: Files,
    private readonly processes: Processes,
  ) {}
  async inspectAbsolute(absolute: string) {
    const result = await this.processes.run(config.MKVMERGE_BIN, ['-J', absolute], {
      timeout: 120_000,
    });
    return parseMkv(result.stdout);
  }
  async inspect(location: Media['location']): Promise<Media> {
    return this.files.exclusive([location], async () => {
      const absolute = await this.paths.file(location);
      const revision = await fileRevision(absolute);
      const media = await this.inspectAbsolute(absolute);
      if (revision !== (await fileRevision(absolute)))
        problem('El archivo ha cambiado. Vuelve a abrirlo.');
      return { location, revision, ...media };
    });
  }
  async editMetadata(request: MetadataRequest) {
    return this.files.exclusive([request.source], async () => {
      if (!/\.mkv$/i.test(request.source.path)) problem('Selecciona un archivo MKV.');
      const absolute = await this.paths.file(request.source);
      await this.paths.tree(absolute);
      if (request.revision !== (await fileRevision(absolute)))
        problem('El archivo ha cambiado. Vuelve a abrir el editor.');
      const media = await this.inspectAbsolute(absolute);
      const args = metadataArguments(request, media);
      if (request.revision !== (await fileRevision(absolute)))
        problem('El archivo ha cambiado. Vuelve a abrir el editor.');
      if (!args.length) return { ok: true };
      try {
        const result = await this.processes.run(config.MKVPROPEDIT_BIN, [absolute, ...args], {
          allowedCodes: [0, 1],
          timeout: 120_000,
        });
        const updated = await this.inspectAbsolute(absolute);
        if (
          updated.tracks.length !== media.tracks.length ||
          updated.title !== request.title ||
          request.tracks.some((t) => {
            const actual = updated.tracks.find((a) => a.id === t.id);
            return (
              !actual ||
              actual.name !== t.name ||
              actual.default !== t.default ||
              actual.forced !== t.forced
            );
          })
        )
          problem('No se han podido verificar todos los metadatos guardados.');
        return { ok: true, warning: result.code === 1 ? result.stdout : undefined };
      } catch (error) {
        problem(
          `No se completó la edición. Vuelve a abrir el archivo para comprobar sus metadatos. ${error instanceof Error ? error.message : ''}`,
        );
      }
    });
  }
  async runAbsolute(
    request: RemuxRequest,
    sourcePaths: string[],
    output: string,
    context: JobContext,
  ) {
    const sources = await Promise.all(
      sourcePaths.map(async (absolute) => ({
        absolute,
        ...(await this.inspectAbsolute(absolute)),
      })),
    );
    const result = await this.processes.run(
      config.MKVMERGE_BIN,
      mkvArguments(request, sources, output),
      {
        signal: context.signal,
        jobId: context.id,
        allowedCodes: [0, 1],
        onLine: (line) => {
          const progress = /#GUI#progress\s+(\d+)%/.exec(line);
          if (progress) context.update('Remultiplexando sin recodificar', Number(progress[1]));
          else if (line.startsWith('#GUI#warning')) context.message(line);
        },
      },
    );
    if (result.code === 1)
      context.message('MKVToolNix terminó con advertencias. Consulta los mensajes del trabajo.');
    if (!(await lstat(output)).size) problem('MKVToolNix no generó un archivo válido.');
    const final = await this.inspectAbsolute(output);
    if (final.tracks.length !== request.tracks.filter((t) => t.enabled).length)
      problem('El número de pistas del resultado no coincide con la selección.');
  }
  async remux(request: RemuxRequest, context: JobContext) {
    safeName(request.name);
    if (!request.name.toLowerCase().endsWith('.mkv'))
      problem('La salida debe tener extensión .mkv.');
    await this.files.absent({
      root: request.destination.root,
      path: [request.destination.path, request.name].filter(Boolean).join('/'),
    });
    const sourcePaths = await Promise.all(request.sources.map((source) => this.paths.file(source)));
    const staging = await this.files.staging(request.destination, context.id);
    try {
      const output = path.join(staging, 'result.mkv');
      await this.runAbsolute(request, sourcePaths, output, context);
      context.signal.throwIfAborted();
      context.result(
        await this.files.exclusive([childLocation(request.destination, request.name)], () =>
          this.files.publish(output, request.destination, request.name),
        ),
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
