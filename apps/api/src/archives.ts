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
export interface ExtractRequest {
  source: Location;
  destination: Location;
  folder?: string;
  password?: string;
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
    const options = { signal: context.signal, secrets: [password] };
    const run = (args: string[], extra: Parameters<Processes['run']>[2] = {}) =>
      this.processes.run(config.SANDBOX_BIN, [staging, config.SEVENZIP_BIN, ...args], {
        ...options,
        ...extra,
      });
    const extractOne = async (archive: string, output: string) => {
      context.update('Inspeccionando las rutas del archivo comprimido');
      const listing = await run(['l', '-slt', '-ba', `-p${password}`, '--', archive], {
        captureLimit: 32 * 1024 * 1024,
      });
      validateArchiveListing(listing.stdout);
      await run(
        ['x', '-y', '-aos', '-bsp1', '-bso1', `-p${password}`, `-o${output}`, '--', archive],
        {
          onLine: (line) => {
            const match = /(?:^|\s)(\d+)%/.exec(line);
            if (match) context.update('Extrayendo con 7-Zip', Number(match[1]));
          },
        },
      );
      await this.paths.tree(output);
    };
    try {
      const contents = path.join(staging, 'contents');
      await mkdir(contents);
      await extractOne(source, contents);
      // 7-Zip unwraps gzip/xz first; tar must then be unpacked explicitly.
      if (/\.(tar\.(gz|xz)|tgz)$/i.test(source)) {
        const inner = await readdir(contents);
        if (inner.length !== 1 || !(await lstat(path.join(contents, inner[0]))).isFile())
          problem('Estructura tar comprimida no compatible.');
        const expanded = path.join(staging, 'expanded');
        await mkdir(expanded);
        await extractOne(path.join(contents, inner[0]), expanded);
        await rm(contents, { recursive: true });
        await this.files.renameExclusive(expanded, contents);
      }
      context.signal.throwIfAborted();
      await this.files.exclusive(async () => {
        if (request.folder) {
          context.result(await this.files.publish(contents, request.destination, request.folder));
          return;
        }
        const names = await readdir(contents);
        for (const name of names)
          await this.files.absent(childLocation(request.destination, safeName(name)));
        context.update('Publicando los elementos extraídos');
        // Commit each top-level entry atomically. Already published entries are recorded if a later entry fails.
        for (const name of names)
          context.result(
            await this.files.publish(path.join(contents, name), request.destination, name),
          );
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
