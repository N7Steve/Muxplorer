import { Injectable, Optional } from '@nestjs/common';
import { constants, createReadStream, createWriteStream, type BigIntStats } from 'node:fs';
import { access, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Location } from '@muxplorer/shared';
import { config } from './config';
import { Files } from './files';
import type { EngineTask } from './download-provider';
import { relativePath, safeName } from './paths';

const destination: Location = { root: 'downloads', path: '' };
const noFollow = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const directoryFlags = noFollow | constants.O_DIRECTORY;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const fdPath = (fd: number) => '/proc/self/fd/' + fd;

interface Identity {
  inode: string;
  birth: string;
}
export interface Publication {
  name: string;
  target: string;
  identity: Identity;
}

function identityOf(stat: BigIntStats): Identity {
  return { inode: String(stat.ino), birth: String(stat.birthtimeNs) };
}
function matches(stat: BigIntStats | undefined, identity: Identity) {
  return (
    stat &&
    (stat.isFile() || stat.isDirectory()) &&
    String(stat.ino) === identity.inode &&
    String(stat.birthtimeNs) === identity.birth
  );
}
async function statIfPresent(absolute: string) {
  try {
    return await lstat(absolute, { bigint: true });
  } catch (error) {
    if (!missing(error)) throw error;
    return undefined;
  }
}
async function syncDirectory(absolute: string) {
  const directory = await open(absolute, directoryFlags);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function suffixed(name: string, index: number, directory: boolean) {
  if (!index) return name;
  const extension = directory ? '' : path.extname(name);
  const tail = ' (' + (index + 1) + ')' + extension;
  if (Buffer.byteLength(tail) >= 240) return suffixed(name, index, true);
  const characters = Array.from(name.slice(0, name.length - extension.length));
  while (Buffer.byteLength(characters.join('') + tail) > 240) characters.pop();
  return safeName(characters.join('') + tail);
}

export class PublicationError extends Error {}

@Injectable()
export class DownloadPublication {
  constructor(
    private readonly files: Files,
    @Optional() private readonly stagingRoot = config.GOPEED_STAGING_DIR,
  ) {}

  async staging() {
    const absolute = path.resolve(this.stagingRoot);
    if (
      process.platform !== 'linux' ||
      (await realpath(absolute)) !== absolute ||
      !(await lstat(absolute)).isDirectory() ||
      (['downloads', 'plex'] as const).some((root) =>
        this.files.overlaps({ root, path: '' }, { root, path: absolute }),
      )
    )
      throw new Error('Staging must be a separate Linux directory.');
    await access(absolute, constants.R_OK | constants.W_OK | constants.X_OK);
    return absolute;
  }

  async createStage(id: string) {
    await mkdir(path.join(await this.staging(), id), { mode: 0o750 });
  }

  async cleanStage(id: string) {
    await rm(path.join(await this.staging(), id), { recursive: true, force: true });
  }

  cleanPrepared(id: string) {
    return this.files.cleanup(destination, 'download-' + id);
  }

  async prepare(id: string, task: EngineTask): Promise<Publication> {
    const resource = task.resource;
    if (task.status !== 'done' || !resource?.files.length)
      throw new PublicationError('Gopeed todavía no tiene un resultado verificable.');
    const directory = !!resource.name;
    const { outputName: override, selectedFiles: selectFiles } = task;
    const name = safeName(override || resource.name || resource.files[0].name);
    const manifest = new Map<string, number>();
    const indexes = selectFiles?.length ? selectFiles : resource.files.map((_, index) => index);
    for (const index of indexes) {
      const file = resource.files[index];
      if (!file) throw new PublicationError('Gopeed indicó una selección de archivos inválida.');
      const parent = relativePath(file.path);
      const leaf = safeName(directory ? file.name : name);
      const relative = [parent, leaf].filter(Boolean).join('/');
      if (manifest.has(relative) || (!directory && indexes.length !== 1))
        throw new PublicationError('El resultado contiene rutas duplicadas o incompatibles.');
      manifest.set(relative, !directory && file.size === 0 ? resource.size : file.size);
    }

    await this.cleanPrepared(id);
    const work = await this.files.staging(destination, 'download-' + id);
    const prepared = path.join(work, 'payload');
    const source = await open(await this.staging(), directoryFlags);
    try {
      const taskDirectory = await open(path.join(fdPath(source.fd), id), directoryFlags);
      try {
        const taskPath = fdPath(taskDirectory.fd);
        if (directory) {
          const packageDirectory = await open(path.join(taskPath, name), directoryFlags);
          try {
            await mkdir(prepared);
            const created = new Set([prepared]);
            for (const [relative, size] of manifest)
              await this.copyExpected(
                fdPath(packageDirectory.fd),
                relative,
                prepared,
                size,
                created,
              );
            for (const item of [...created].reverse()) await syncDirectory(item);
          } finally {
            await packageDirectory.close();
          }
        } else {
          const [relative, size] = [...manifest][0];
          await this.copyExpected(taskPath, relative, work, size, new Set(), 'payload');
        }
      } finally {
        await taskDirectory.close();
      }
    } finally {
      await source.close();
    }
    await syncDirectory(work);
    await syncDirectory(path.dirname(work));
    return { name, target: name, identity: identityOf(await lstat(prepared, { bigint: true })) };
  }

  private async copyExpected(
    source: string,
    relative: string,
    target: string,
    size: number,
    created: Set<string>,
    outputName?: string,
  ): Promise<void> {
    const [part, ...rest] = relative.split('/');
    if (rest.length) {
      const parent = await open(path.join(source, part), directoryFlags);
      try {
        const sub = outputName ? target : path.join(target, part);
        if (!outputName && !created.has(sub)) {
          await mkdir(sub);
          created.add(sub);
        }
        await this.copyExpected(fdPath(parent.fd), rest.join('/'), sub, size, created, outputName);
      } finally {
        await parent.close();
      }
      return;
    }
    // Pin the open file and each ancestor. Never copy through links, even if the
    // engine replaces a directory or file while publication is in progress.
    const input = await open(path.join(source, part), noFollow);
    try {
      const before = await input.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(size))
        throw new PublicationError('El archivo de Gopeed no coincide con el resultado esperado.');
      const output = path.join(target, outputName ?? part);
      await pipeline(
        createReadStream(fdPath(input.fd)),
        createWriteStream(output, { flags: 'wx', mode: 0o640 }),
      );
      const file = await open(output, noFollow);
      try {
        const after = await input.stat({ bigint: true });
        if (
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          before.size !== after.size ||
          (await file.stat({ bigint: true })).size !== before.size
        )
          throw new PublicationError('El archivo cambió durante la publicación.');
        await file.sync();
      } finally {
        await file.close();
      }
    } finally {
      await input.close();
    }
  }

  async commit(
    id: string,
    publication: Publication,
    journal: (record: Publication) => void,
    complete: (name: string) => void,
  ) {
    const root = await this.files.paths.directory(destination);
    const prepared = path.join(root, '.muxplorer-download-' + id, 'payload');
    const source = await statIfPresent(prepared);
    if (!source) {
      // The rename may have succeeded before SQLite committed. Only recognize
      // the journaled inode; an unrelated file or a user move is ambiguous.
      const target = safeName(publication.target);
      await this.files.exclusive([{ ...destination, path: target }], async () => {
        if (!matches(await statIfPresent(path.join(root, target)), publication.identity))
          throw new PublicationError(
            'No se pudo confirmar el destino de una publicación interrumpida.',
          );
        await syncDirectory(root);
        complete(target);
      });
      return;
    }
    if (!matches(source, publication.identity))
      throw new PublicationError('La copia preparada ha cambiado; publicación bloqueada.');

    for (let index = 0; index < 1000; index++) {
      const name = suffixed(publication.name, index, source.isDirectory());
      const done = await this.files.exclusive([{ ...destination, path: name }], async () => {
        const target = path.join(root, name);
        if (await statIfPresent(target)) return false;
        journal({ ...publication, target: name });
        try {
          await this.files.publish(prepared, destination, name);
        } catch (error) {
          if (
            (await statIfPresent(target)) &&
            matches(await statIfPresent(prepared), publication.identity)
          )
            return false;
          throw error;
        }
        await syncDirectory(root);
        if (!matches(await statIfPresent(target), publication.identity))
          throw new PublicationError('El destino cambió durante la publicación.');
        complete(name);
        return true;
      });
      if (done) return;
    }
    throw new PublicationError('No se encontró un nombre libre en Downloads.');
  }

  async result(name: string, identity: Identity) {
    const result = { ...destination, path: safeName(name) };
    try {
      if (matches(await statIfPresent(await this.files.paths.resolve(result)), identity))
        return result;
    } catch {
      // A result may have been moved, removed or replaced by the explorer.
    }
    return null;
  }
}
