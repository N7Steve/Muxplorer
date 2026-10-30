import { Injectable } from '@nestjs/common';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rm, rmdir, link, unlink, open, utimes } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import path from 'node:path';
import type { Entry, Location } from '@muxplorer/shared';
import { Paths, childLocation, safeName } from './paths';
import { Processes } from './process';
import { JobContext } from './jobs';
import { config } from './config';
import { problem } from './errors';
export interface FileRequest {
  sources: Location[];
  destination?: Location;
  confirmed?: boolean;
}
interface Manifest {
  relative: string;
  size: number;
  mtime: number;
  ino: number;
  dev: number;
  directory: boolean;
}
@Injectable()
export class Files {
  constructor(
    readonly paths: Paths,
    private readonly processes: Processes,
  ) {}
  private readonly locks = new Set<{ paths: string[]; done: Promise<void> }>();
  overlaps(a: Location, b: Location): boolean {
    const absolute = (location: Location) => {
      const value = path.resolve(this.paths.roots[location.root], location.path);
      return process.platform === 'win32' ? value.toLowerCase() : value;
    };
    return this.pathOverlaps(absolute(a), absolute(b));
  }
  private pathOverlaps(a: string, b: string): boolean {
    const contains = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        !relative ||
        (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    };
    return contains(a, b) || contains(b, a);
  }
  exclusive<T>(locations: Location[], action: () => Promise<T>): Promise<T> {
    // Reserve before awaiting: overlapping waiters keep their order, while unrelated
    // films can proceed. Resolve against storage roots so aliases share a lock.
    const paths = locations.map((location) => {
      const value = path.resolve(this.paths.roots[location.root], location.path);
      return process.platform === 'win32' ? value.toLowerCase() : value;
    });
    const previous = [...this.locks].filter((lock) =>
      lock.paths.some((a) => paths.some((b) => this.pathOverlaps(a, b))),
    );
    let release!: () => void;
    const lock = {
      paths,
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    this.locks.add(lock);
    return Promise.all(previous.map((item) => item.done))
      .then(action)
      .finally(() => {
        this.locks.delete(lock);
        release();
      });
  }
  async list(location: Location): Promise<Entry[]> {
    const directory = await this.paths.directory(location);
    const names = (await readdir(directory)).filter((name) => !name.startsWith('.muxplorer-'));
    const entries: Entry[] = [];
    for (const name of names) {
      try {
        let blockedName = false;
        try {
          safeName(name);
        } catch {
          blockedName = true;
        }
        const item = await lstat(path.join(directory, name));
        entries.push({
          name,
          location: { root: location.root, path: [location.path, name].filter(Boolean).join('/') },
          kind:
            blockedName || item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())
              ? 'blocked'
              : item.isDirectory()
                ? 'directory'
                : 'file',
          size: item.size,
          modified: item.mtime.toISOString(),
          extension: path.extname(name).toLowerCase().slice(1),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return entries;
  }
  async create(parent: Location, name: string) {
    return this.exclusive([childLocation(parent, name)], async () => {
      await this.paths.directory(parent);
      const dest = childLocation(parent, name);
      await mkdir(await this.paths.resolve(dest, true));
      return dest;
    });
  }
  async rename(source: Location, name: string) {
    const parent = { ...source, path: source.path.split('/').slice(0, -1).join('/') };
    return this.exclusive([source, childLocation(parent, name)], async () => {
      this.paths.assertMutable(source);
      const from = await this.paths.resolve(source);
      const parent = { ...source, path: source.path.split('/').slice(0, -1).join('/') };
      const dest = childLocation(parent, name);
      const to = await this.paths.resolve(dest, true);
      await this.renameExclusive(from, to);
      return dest;
    });
  }
  async renameExclusive(from: string, to: string) {
    // renameat2(RENAME_NOREPLACE) keeps directory publication atomic and never overwrites.
    if (process.platform === 'linux') {
      await this.processes.run(config.RENAME_BIN, [from, to]);
      return;
    }
    if ((await lstat(from)).isFile()) {
      await link(from, to);
      await unlink(from);
      return;
    }
    // Windows dev fallback: production always uses the Linux no-replace helper.
    await mkdir(to);
    try {
      for (const name of await readdir(from))
        await this.renameExclusive(path.join(from, name), path.join(to, name));
      await rmdir(from);
    } catch (error) {
      throw new Error(`Publicación parcial en ${path.basename(to)}: ${String(error)}`);
    }
  }
  async staging(destination: Location, id: string) {
    const parent = await this.paths.directory(destination);
    const directory = path.join(parent, `.muxplorer-${id}`);
    await mkdir(directory, { mode: 0o700 });
    return directory;
  }
  async absent(location: Location) {
    const absolute = await this.paths.resolve(location, true);
    try {
      await lstat(absolute);
      problem(`Ya existe «${path.basename(absolute)}». Elige otro nombre; no se sobrescribirá.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return absolute;
  }
  private async manifest(absolute: string, relative = ''): Promise<Manifest[]> {
    const item = await lstat(absolute);
    if (
      item.isSymbolicLink() ||
      (!item.isDirectory() && !item.isFile()) ||
      (item.nlink > 1 && item.isFile())
    )
      problem('Se bloquean enlaces y archivos especiales.');
    const result: Manifest[] = [
      {
        relative,
        size: item.isFile() ? item.size : 0,
        mtime: item.mtimeMs,
        ino: item.ino,
        dev: item.dev,
        directory: item.isDirectory(),
      },
    ];
    if (item.isDirectory())
      for (const name of (await readdir(absolute)).sort()) {
        safeName(name);
        result.push(...(await this.manifest(path.join(absolute, name), path.join(relative, name))));
      }
    return result;
  }
  private async digest(absolute: string, signal: AbortSignal) {
    const hash = createHash('sha256');
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    await pipeline(handle.createReadStream(), hash, { signal });
    return hash.digest('hex');
  }
  async operate(kind: 'copy' | 'move' | 'delete', request: FileRequest, context: JobContext) {
    for (const source of request.sources) this.paths.assertMutable(source);
    const destinations = request.destination
      ? request.sources.map((source) =>
          childLocation(request.destination!, path.posix.basename(source.path)),
        )
      : [];
    return this.exclusive([...request.sources, ...destinations], async () => {
      const { sources, destination } = request;
      if (!sources.length) problem('Selecciona al menos un elemento.');
      if (kind === 'delete' && request.confirmed !== true) problem('Confirma la eliminación.');
      const absoluteSources: string[] = [];
      for (const source of sources) {
        this.paths.assertMutable(source);
        absoluteSources.push(await this.paths.resolve(source));
      }
      for (let i = 0; i < absoluteSources.length; i++)
        for (let j = 0; j < absoluteSources.length; j++)
          if (
            i !== j &&
            (absoluteSources[i] === absoluteSources[j] ||
              absoluteSources[j].startsWith(absoluteSources[i] + path.sep))
          )
            problem('No selecciones una carpeta y su contenido en la misma operación.');
      if (kind !== 'delete') {
        if (!destination) problem('Falta el destino.');
        const parent = await this.paths.directory(destination);
        if (
          absoluteSources.some(
            (source) => parent === source || parent.startsWith(source + path.sep),
          )
        )
          problem('No se puede copiar o mover una carpeta dentro de sí misma.');
        const names = absoluteSources.map((source) => path.basename(source));
        if (new Set(names).size !== names.length)
          problem('La selección contiene nombres duplicados.');
        for (const name of names) await this.absent(childLocation(destination, name));
      }
      for (let i = 0; i < sources.length; i++) {
        context.signal.throwIfAborted();
        const absolute = await this.paths.resolve(sources[i]);
        const initial = await this.manifest(absolute);
        if (kind === 'delete') {
          context.update(`Eliminando ${path.basename(absolute)} (${i + 1}/${sources.length})`);
          context.signal.throwIfAborted();
          await rm(absolute, { recursive: true });
          continue;
        }
        const dest = childLocation(destination!, path.basename(absolute));
        const target = await this.absent(dest);
        if (kind === 'move' && (await lstat(path.dirname(target))).dev === initial[0].dev) {
          context.update(`Moviendo ${path.basename(absolute)}`);
          try {
            await this.renameExclusive(absolute, target);
            context.result(dest);
            continue;
          } catch (error) {
            if (!String(error).includes('cross-device') && !String(error).includes('EXDEV'))
              throw error;
          }
        }
        const staging = await this.staging(destination!, `${context.id}-${i}`);
        const temporary = path.join(staging, path.basename(absolute));
        try {
          let done = 0;
          const total = initial.reduce((n, item) => n + item.size, 0);
          let last = 0;
          for (const item of initial) {
            context.signal.throwIfAborted();
            const input = path.join(absolute, item.relative),
              output = path.join(temporary, item.relative);
            if (item.directory) {
              await mkdir(output, { mode: 0o755 });
              continue;
            }
            const checksum = createHash('sha256');
            const counter = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                checksum.update(chunk);
                done += chunk.length;
                if (Date.now() - last > 300) {
                  context.update(
                    `Copiando ${path.basename(absolute)} (${i + 1}/${sources.length})`,
                    total ? (done / total) * 90 : 0,
                  );
                  last = Date.now();
                }
                callback(null, chunk);
              },
            });
            const inputHandle = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
            await pipeline(
              inputHandle.createReadStream(),
              counter,
              createWriteStream(output, { flags: 'wx', mode: 0o644 }),
              { signal: context.signal },
            );
            const handle = await open(output, 'r+');
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
            context.update(`Verificando ${path.basename(input)}`);
            if (checksum.digest('hex') !== (await this.digest(output, context.signal)))
              problem('La verificación SHA-256 de la copia ha fallado. El origen se conserva.');
            await utimes(output, new Date(item.mtime), new Date(item.mtime));
          }
          if (JSON.stringify(initial) !== JSON.stringify(await this.manifest(absolute)))
            problem('El origen cambió durante la copia. Se conserva el original.');
          context.signal.throwIfAborted();
          await this.paths.directory(destination!);
          await this.renameExclusive(temporary, target);
          context.result(dest);
          if (kind === 'move') {
            context.update('Copia verificada. Eliminando el origen');
            await this.paths.resolve(sources[i]);
            if (JSON.stringify(initial) !== JSON.stringify(await this.manifest(absolute)))
              problem(
                'El origen cambió antes de eliminarlo. La copia está publicada y el original se conserva.',
              );
            await rm(absolute, { recursive: true });
          }
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      }
    });
  }
  async publish(staged: string, destination: Location, name: string) {
    await this.paths.tree(staged);
    if ((await lstat(staged)).isFile()) {
      const handle = await open(staged, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await this.paths.directory(destination);
    const result = childLocation(destination, name);
    const target = await this.absent(result);
    await this.renameExclusive(staged, target);
    return result;
  }
  async cleanup(destination: Location, id: string) {
    const parent = await this.paths.directory(destination);
    const names = (await readdir(parent)).filter(
      (name) => name === `.muxplorer-${id}` || name.startsWith(`.muxplorer-${id}-`),
    );
    await this.exclusive(
      names.map((name) => ({
        ...destination,
        path: [destination.path, name].filter(Boolean).join('/'),
      })),
      async () => {
        for (const name of names) {
          const target = path.join(parent, name);
          const item = await lstat(target);
          if (!item.isSymbolicLink() && item.isDirectory())
            await rm(target, { recursive: true, force: true });
        }
      },
    );
  }
}
