import { Injectable } from '@nestjs/common';
import path from 'node:path';
import { readdir, rm, mkdir, lstat } from 'node:fs/promises';
import type { Location } from '@muxplorer/shared';
import { Files } from './files';
import { Paths, safeName, childLocation } from './paths';
import { Processes } from './process';
import { JobContext } from './jobs';
import { config } from './config';
import { problem } from './errors';
import { diagnostic } from './diagnostics';
export interface ExtractRequest {
  source: Location;
  destination: Location;
  folder?: string;
  password?: string;
}
export class SevenZipProgress {
  private latest = -1;
  constructor(private readonly report: (percent: number) => void) {}
  accept(line: string) {
    const match = /^\s*(\d{1,3})%(?:\s|$)/.exec(line);
    if (!match) return;
    const percent = Number(match[1]);
    // The engine may reset its counter between volumes/files. Keep its current
    // value instead of pinning the UI forever to an earlier high-water mark.
    if (percent > 100 || percent === this.latest || /\bScan\b/.test(line)) return;
    this.latest = percent;
    this.report(percent);
  }
}
export function validateArchiveListing(listing: string) {
  const blocks = listing.split(/\r?\n\r?\n/).filter((block) => /^Path = /m.test(block));
  const seen = new Set<string>();
  for (const block of blocks) {
    const name = /^Path = (.*)$/m.exec(block)?.[1]?.trim();
    if (
      !name ||
      /[\x00-\x1f\x7f\\:]/.test(name) ||
      name.startsWith('/') ||
      name.split('/').some((p) => p === '..' || p === '.')
    )
      problem('El archivo comprimido contiene una ruta no segura.');
    if (seen.has(name))
      problem(
        'El archivo comprimido contiene rutas duplicadas; extracción bloqueada para evitar colisiones.',
      );
    seen.add(name);
    if (
      /^(Symbolic Link|Hard Link) = .+/m.test(block) ||
      /^Attributes = .*\bl[rwx-]{9}/m.test(block)
    )
      problem('El archivo comprimido contiene enlaces; extracción bloqueada.');
  }
}
@Injectable()
export class Archives {
  constructor(
    private readonly paths: Paths,
    private readonly files: Files,
    private readonly processes: Processes,
  ) {}
  async extract(request: ExtractRequest, context: JobContext) {
    const source = await this.paths.file(request.source);
    if (request.folder) safeName(request.folder);
    const staging = await this.files.staging(request.destination, context.id);
    const password = request.password ?? '';
    const options = { signal: context.signal, secrets: [password], jobId: context.id };
    const run = (args: string[], extra: Parameters<Processes['run']>[2] = {}) =>
      this.processes.run(config.SANDBOX_BIN, [staging, config.SEVENZIP_BIN, ...args], {
        ...options,
        ...extra,
      });
    const phases = /\.(tar\.(gz|xz)|tgz)$/i.test(source) ? 2 : 1;
    const extractOne = async (archive: string, output: string, phase: number) => {
      context.update('Inspeccionando las rutas del archivo comprimido');
      const listing = await run(['l', '-slt', '-ba', `-p${password}`, '--', archive], {
        captureLimit: 32 * 1024 * 1024,
      });
      validateArchiveListing(listing.stdout);
      const stage =
        phases === 2 ? `Extrayendo con 7-Zip · Etapa ${phase + 1}/2` : 'Extrayendo con 7-Zip';
      context.update(stage, (phase / phases) * 100);
      const progress = new SevenZipProgress((percent) => {
        if (percent === 100 && phase === phases - 1)
          context.update('Finalizando la extracción con 7-Zip');
        else context.update(stage, ((phase + percent / 100) / phases) * 100);
      });
      let sampledAt = 0;
      await run(
        ['x', '-y', '-aos', '-bsp1', '-bso1', `-p${password}`, `-o${output}`, '--', archive],
        {
          onLine: (line) => {
            if (/^\s*\d{1,3}%/.test(line) && Date.now() - sampledAt >= 5000) {
              diagnostic('archive.engine_progress', {
                jobId: context.id,
                phase,
                line: line.slice(0, 200),
              });
              sampledAt = Date.now();
            }
            progress.accept(line);
          },
        },
      );
      context.update('Validando rutas y archivos extraídos');
      context.signal.throwIfAborted();
      await this.paths.tree(output);
    };
    try {
      const contents = path.join(staging, 'contents');
      await mkdir(contents);
      await extractOne(source, contents, 0);
      // 7-Zip unwraps gzip/xz first; tar must then be unpacked explicitly.
      if (phases === 2) {
        const inner = await readdir(contents);
        if (inner.length !== 1 || !(await lstat(path.join(contents, inner[0]))).isFile())
          problem('Estructura tar comprimida no compatible.');
        const expanded = path.join(staging, 'expanded');
        await mkdir(expanded);
        await extractOne(path.join(contents, inner[0]), expanded, 1);
        await rm(contents, { recursive: true });
        await this.files.renameExclusive(expanded, contents);
      }
      context.signal.throwIfAborted();
      context.update('Esperando para publicar los archivos extraídos');
      const publication = request.folder
        ? [childLocation(request.destination, request.folder)]
        : (await readdir(contents)).map((name) => childLocation(request.destination, name));
      await this.files.exclusive(publication, async () => {
        context.signal.throwIfAborted();
        context.update('Publicando los archivos extraídos');
        if (request.folder) {
          context.result(await this.files.publish(contents, request.destination, request.folder));
          return;
        }
        const names = await readdir(contents);
        for (const name of names)
          await this.files.absent(childLocation(request.destination, safeName(name)));
        // Commit each top-level entry atomically. Already published entries are recorded if a later entry fails.
        for (const name of names)
          context.result(
            await this.files.publish(path.join(contents, name), request.destination, name),
          );
      });
    } finally {
      context.update('Limpiando archivos temporales');
      await rm(staging, { recursive: true, force: true });
    }
  }
}
