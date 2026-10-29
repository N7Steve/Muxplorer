import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readdir, mkdir, rm, stat } from 'node:fs/promises';
import type { Disc, DiscTitle, Location, Track } from '@muxplorer/shared';
import { MakeMkv, MakeRequest } from './makemkv';
import { Paths } from './paths';
import { Files } from './files';
import { Processes } from './process';
import { Mkv, parseMkv } from './mkv';
import { JobContext, NeedsDiscSelection } from './jobs';
import { config } from './config';
import { validateArchiveListing, SevenZipProgress } from './archives';
import { problem } from './errors';
import { diagnostic } from './diagnostics';

interface TitleSource {
  title: DiscTitle;
  input: string;
  tracks: Track[];
}
export interface DiscRequest extends MakeRequest {
  prepare?: boolean;
  prepared?: { location: Location; stamp: string };
}

@Injectable()
export class Discs extends MakeMkv {
  constructor(paths: Paths, files: Files, processes: Processes, mkv: Mkv) {
    super(paths, files, processes, mkv);
  }
  override async onModuleInit() {
    /* No activation or configuration required. */
  }

  private async withSource<T>(
    location: Location,
    run: (root: string) => Promise<T>,
    context?: JobContext,
    retainForSelection = false,
  ): Promise<T> {
    const absolute = await this.paths.file(location);
    if (!/\.iso$/i.test(absolute)) {
      if (
        path.basename(absolute).toLowerCase() !== 'index.bdmv' ||
        path.basename(path.dirname(absolute)).toLowerCase() !== 'bdmv'
      )
        problem('Selecciona una ISO o BDMV/index.bdmv.');
      const root = path.dirname(path.dirname(absolute));
      await this.paths.tree(root);
      return run(root);
    }
    const parent: Location = { ...location, path: location.path.split('/').slice(0, -1).join('/') };
    const staging = await this.files.staging(
      parent,
      retainForSelection && context ? `${context.id}-iso` : randomUUID(),
    );
    let retained = false;
    try {
      const options = { signal: context?.signal, jobId: context?.id };
      const list = await this.processes.run(
        config.SANDBOX_BIN,
        [staging, config.SEVENZIP_BIN, 'l', '-slt', '-ba', '--', absolute],
        { ...options, captureLimit: 32 * 1024 * 1024 },
      );
      validateArchiveListing(list.stdout);
      context?.update('Abriendo la estructura de la ISO con 7-Zip', 0);
      diagnostic('disc.iso_extract', { jobId: context?.id, source: location });
      const progress = new SevenZipProgress((percent) =>
        context?.update('Abriendo la estructura de la ISO con 7-Zip', percent),
      );
      await this.processes.run(
        config.SANDBOX_BIN,
        [staging, config.SEVENZIP_BIN, 'x', '-y', '-bsp1', `-o${staging}`, '--', absolute],
        { ...options, onLine: (line) => progress.accept(line) },
      );
      await this.paths.tree(staging);
      return await run(staging);
    } catch (error) {
      retained =
        retainForSelection && error instanceof NeedsDiscSelection && !context?.signal.aborted;
      throw error;
    } finally {
      if (!retained) await rm(staging, { recursive: true, force: true });
    }
  }

  private async titles(root: string, context?: JobContext): Promise<TitleSource[]> {
    const entries = await readdir(root);
    // Decrypted backups can retain AACS metadata; its presence alone does not
    // prove that the streams are still encrypted.
    if (entries.some((name) => /^(AACS|BDSVM)$/i.test(name)))
      diagnostic('disc.protection_metadata_present');
    const bdmv = entries.find((name) => /^BDMV$/i.test(name));
    let inputs: { id: number; input: string; name: string }[] = [];
    if (bdmv) {
      const folder = path.join(root, bdmv);
      const playlist = (await readdir(folder)).find((name) => /^PLAYLIST$/i.test(name));
      if (!playlist) problem('La estructura BDMV no contiene PLAYLIST.');
      inputs = (await readdir(path.join(folder, playlist)))
        .filter((name) => /^\d{5}\.mpls$/i.test(name))
        .sort()
        .map((name) => ({
          id: Number(name.slice(0, 5)),
          name: `Lista ${name}`,
          input: path.join(folder, playlist, name),
        }));
    } else {
      const dvd = entries.find((name) => /^VIDEO_TS$/i.test(name));
      if (!dvd)
        problem('La ISO no contiene una estructura Blu-ray BDMV o DVD VIDEO_TS compatible.');
      inputs = (await readdir(path.join(root, dvd)))
        .filter((name) => /^VTS_\d{2}_1\.VOB$/i.test(name))
        .sort()
        .map((name) => ({
          id: Number(name.slice(4, 6)),
          name: `DVD ${name.slice(0, 6)}`,
          input: path.join(root, dvd, name),
        }));
    }
    const result: TitleSource[] = [];
    for (const { id, input, name } of inputs) {
      context?.signal.throwIfAborted();
      context?.update(`Analizando títulos con MKVToolNix · ${result.length + 1}/${inputs.length}`);
      const { stdout } = await this.processes.run(config.MKVMERGE_BIN, ['-J', input], {
        timeout: 120_000,
        signal: context?.signal,
        jobId: context?.id,
      });
      const media = parseMkv(stdout);
      const data = JSON.parse(stdout) as {
        container: {
          properties?: { playlist_duration?: number; playlist_size?: number; duration?: number };
        };
        chapters?: { num_entries: number }[];
      };
      const props = data.container.properties;
      const seconds = Math.round((props?.playlist_duration ?? props?.duration ?? 0) / 1e9);
      const chapters = data.chapters?.reduce((n, c) => n + c.num_entries, 0) ?? 0;
      result.push({
        input,
        tracks: media.tracks,
        title: {
          id,
          name: media.title || name,
          duration: seconds ? new Date(seconds * 1000).toISOString().slice(11, 19) : '—',
          size: props?.playlist_size ? `${(props.playlist_size / 1024 ** 3).toFixed(2)} GB` : '—',
          chapters: String(chapters),
          streams: media.tracks.map((t) => ({
            id: t.id,
            type: t.type,
            codec: t.codec,
            language: t.language,
            description: t.name,
          })),
        },
      });
    }
    if (!result.length)
      problem('No se encontraron listas MPLS o títulos DVD compatibles. Prueba Abrir con MakeMKV.');
    diagnostic('disc.titles', { count: result.length });
    return result;
  }

  override async inspect(location: Location): Promise<Disc> {
    return this.withSource(location, async (root) => ({
      location,
      titles: (await this.titles(root)).map((t) => t.title),
      messages: ['MKVToolNix · fuentes descifradas · sin recodificar'],
    }));
  }

  private async stamp(source: Location) {
    const file = await stat(await this.paths.file(source));
    return `${file.size}:${file.mtimeMs}`;
  }
  async cleanupPreparation(source: Location, id: string) {
    if (/\.iso$/i.test(source.path))
      await this.files.cleanup(
        { ...source, path: source.path.split('/').slice(0, -1).join('/') },
        `${id}-iso`,
      );
  }

  override async convert(request: DiscRequest, context: JobContext) {
    if (request.prepare) {
      const stamp = await this.stamp(request.source);
      return this.withSource(
        request.source,
        async (root) => {
          const titles = await this.titles(root, context);
          context.signal.throwIfAborted();
          request.prepared = {
            stamp,
            location: {
              ...request.source,
              path: /\.iso$/i.test(request.source.path)
                ? [
                    ...request.source.path.split('/').slice(0, -1),
                    `.muxplorer-${context.id}-iso`,
                  ].join('/')
                : request.source.path.split('/').slice(0, -2).join('/'),
            },
          };
          context.checkpoint(request);
          throw new NeedsDiscSelection({
            location: request.source,
            titles: titles.map((t) => t.title),
            messages: ['Preparación completada. Se reutilizará para crear los MKV.'],
          });
        },
        context,
        true,
      );
    }
    if (!request.checkpoint) {
      const staging = await this.files.staging(request.destination, context.id);
      try {
        const generated: NonNullable<MakeRequest['checkpoint']>['files'] = [];
        const generate = async (root: string) => {
          const titles = await this.titles(root, context);
          for (const id of request.titles) {
            context.signal.throwIfAborted();
            const source = titles.find((t) => t.title.id === id);
            if (!source) problem('El título elegido ya no está disponible.');
            const relative = `title-${id}/title.mkv`;
            await mkdir(path.dirname(path.join(staging, relative)));
            await this.mkv.runAbsolute(
              {
                sources: [request.source],
                destination: request.destination,
                name: 'title.mkv',
                title: request.name,
                tracks: source.tracks.map((t) => ({
                  source: 0,
                  id: t.id,
                  enabled: true,
                  name: t.name,
                  language: t.language,
                  default: t.default,
                  forced: t.forced,
                })),
              },
              [source.input],
              path.join(staging, relative),
              context,
            );
            generated.push({
              title: id,
              relative,
              name: `${request.name.replace(/\.mkv$/i, '')}${request.titles.length > 1 ? `-t${id}` : ''}.mkv`,
            });
          }
        };
        if (request.prepared) {
          if ((await this.stamp(request.source)) !== request.prepared.stamp)
            problem('El origen cambió después del análisis. Abre el disco de nuevo.');
          const root = /\.iso$/i.test(request.source.path)
            ? path.join(
                await this.paths.directory({
                  ...request.source,
                  path: request.source.path.split('/').slice(0, -1).join('/'),
                }),
                `.muxplorer-${context.id}-iso`,
              )
            : await this.paths.directory(request.prepared.location);
          await this.paths.tree(root);
          try {
            await generate(root);
          } finally {
            await this.cleanupPreparation(request.source, context.id);
          }
          delete request.prepared;
        } else await this.withSource(request.source, generate, context);
        request.checkpoint = { files: generated };
        context.checkpoint(request);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    }
    // Both engines review the actual generated MKV and use the same verified publication path.
    return super.convert(request, context);
  }
}
