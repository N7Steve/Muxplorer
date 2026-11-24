import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { API, File, Storage } from 'megajs';
import { DownloadAccounts } from './download-accounts';
import { DownloadPublication } from './download-publication';
import { type DownloadResource, type EngineTask, ProviderError } from './download-provider';
import { safeName } from './paths';
import { Store } from './store';

type MegaTask = EngineTask & { source?: string; accountId?: string };
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fdPath = (fd: number) => '/proc/self/fd/' + fd;
const prefix = 'mega-';

export const megaHost = (host: string) => /^(www\.)?mega\.(nz|co\.nz)$/.test(host);

function megaFetch(signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !/(^|\.)mega\.(nz|co\.nz)$/.test(url.hostname)
    )
      throw new Error('Servidor de MEGA no válido.');
    return fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(30_000),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
  };
}

@Injectable()
export class MegaDownloads implements OnModuleDestroy {
  private readonly tasks = new Map<string, MegaTask>();
  private readonly workers = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private stopping = false;

  constructor(
    private readonly store: Store,
    private readonly accounts: DownloadAccounts,
    private readonly files: DownloadPublication,
  ) {
    for (const { data } of store.db
      .prepare('SELECT data FROM mega_downloads ORDER BY rowid')
      .all()) {
      const task = JSON.parse(String(data)) as MegaTask;
      if (task.status === 'running') task.status = 'pending';
      this.tasks.set(task.id, task);
    }
  }

  private save(task: MegaTask) {
    this.store.db
      .prepare('INSERT OR REPLACE INTO mega_downloads VALUES (?, ?)')
      .run(task.id, JSON.stringify({ ...task, speed: 0 }));
    this.tasks.set(task.id, task);
  }

  async onModuleDestroy() {
    this.stopping = true;
    for (const worker of this.workers.values()) worker.controller.abort();
    await Promise.allSettled([...this.workers.values()].map((worker) => worker.done));
  }

  list(): EngineTask[] {
    this.schedule();
    return [...this.tasks.values()];
  }

  get(id: string): EngineTask | null {
    return this.tasks.get(id) ?? null;
  }

  add(url: string, requestId: string, accountId?: string) {
    const id = prefix + requestId;
    if (this.tasks.has(id)) return id;
    this.save({
      id,
      requestId,
      status: 'pending',
      downloaded: 0,
      speed: 0,
      accountId,
      source: this.accounts.seal(url, id),
    });
    this.schedule();
    return id;
  }

  async pause(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new ProviderError('missing');
    if (task.status !== 'pending' && task.status !== 'running') throw new ProviderError('rejected');
    this.save({ ...task, status: 'paused', downloaded: 0, speed: 0 });
    await this.stop(id);
  }

  async resume(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new ProviderError('missing');
    if (task.status !== 'failed' && task.status !== 'paused') throw new ProviderError('rejected');
    this.save({ ...task, status: 'pending', downloaded: 0, speed: 0, error: undefined });
    this.schedule();
  }

  async remove(id: string) {
    this.store.db.prepare('DELETE FROM mega_downloads WHERE id=?').run(id);
    this.tasks.delete(id);
    await this.stop(id);
  }

  private async stop(id: string) {
    const worker = this.workers.get(id);
    worker?.controller.abort();
    await worker?.done;
  }

  private schedule() {
    if (this.stopping) return;
    for (const task of this.tasks.values()) {
      if (this.workers.size >= 2) break;
      if (task.status !== 'pending' || this.workers.has(task.id)) continue;
      const controller = new AbortController();
      const done = this.transfer(task, controller.signal).finally(() => {
        this.workers.delete(task.id);
        this.schedule();
      });
      this.workers.set(task.id, { controller, done });
      // A database write failure leaves the persisted task recoverable on restart.
      void done.catch(() => undefined);
    }
  }

  private async withResource<T>(
    url: string,
    accountId: string | undefined,
    controller: AbortController,
    use: (resource: DownloadResource, files: File[]) => Promise<T>,
  ) {
    const { signal } = controller;
    const fetch = megaFetch(signal);
    let storage: Storage | undefined;
    let api: API | undefined;
    try {
      if (accountId) {
        const account = this.accounts.get(accountId);
        storage = new Storage({
          email: account.email!,
          password: account.secret,
          keepalive: false,
          autoload: false,
          fetch,
        });
        await storage.ready;
      }
      api = storage?.api ?? new API(false, { fetch });
      const root = await File.fromURL(url, { api }).loadAttributes();
      const files: File[] = [];
      const entries: DownloadResource['files'] = [];
      const names = new Set<string>();
      const visit = (file: File, parents: string[]) => {
        if (parents.length > 64 || names.size >= 2000)
          throw new Error('Carpeta de MEGA demasiado grande.');
        const name = safeName(file.name ?? '');
        const relative = [...parents, name].join('/');
        if (names.has(relative)) throw new Error('El enlace de MEGA contiene nombres duplicados.');
        names.add(relative);
        if (file.directory) {
          for (const child of file.children ?? []) visit(child, [...parents, name]);
        } else {
          if (!file.key || !Number.isSafeInteger(file.size) || file.size! < 0)
            throw new Error('Archivo de MEGA no válido.');
          file.api = api!;
          files.push(file);
          entries.push({ name, path: parents.join('/'), size: file.size! });
        }
      };
      if (root.directory) {
        for (const child of root.children ?? []) visit(child, []);
      } else {
        visit(root, []);
      }
      const size = entries.reduce((total, file) => total + file.size, 0);
      if (!entries.length || !Number.isSafeInteger(size))
        throw new Error('El enlace de MEGA no contiene archivos descargables.');
      return await use(
        { name: root.directory ? safeName(root.name ?? '') : '', files: entries, size },
        files,
      );
    } finally {
      if (storage && !signal.aborted) await storage.close().catch(() => undefined);
      api?.close();
    }
  }

  resolve(url: string, accountId?: string) {
    return this.withResource(url, accountId, new AbortController(), async (resource) => resource);
  }

  private async transfer(initial: MegaTask, signal: AbortSignal) {
    const task: MegaTask = { ...initial, status: 'running', downloaded: 0, speed: 0 };
    this.save(task);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const url = this.accounts.unseal(task.source!, task.id);
      await this.withResource(url, task.accountId, controller, async (resource, files) => {
        signal.throwIfAborted();
        this.save({ ...task, resource });
        const root = await open(await this.files.staging(), flags);
        try {
          const stage = await open(path.join(fdPath(root.fd), task.requestId!), flags);
          try {
            await this.write(stage.fd, task, resource, files, controller.signal);
            await stage.sync();
          } finally {
            await stage.close();
          }
        } finally {
          await root.close();
        }
        if (!signal.aborted)
          this.save({
            ...task,
            resource,
            status: 'done',
            downloaded: resource.size,
            source: undefined,
          });
      });
    } catch {
      if (!signal.aborted)
        this.save({
          ...(this.tasks.get(task.id) ?? task),
          status: 'failed',
          speed: 0,
          error:
            'MEGA no pudo completar la descarga. Comprueba el enlace, la cuenta y la cuota de transferencia.',
        });
    } finally {
      controller.abort();
      signal.removeEventListener('abort', abort);
    }
  }

  private async write(
    stageFd: number,
    task: MegaTask,
    resource: DownloadResource,
    files: File[],
    signal: AbortSignal,
  ) {
    const stage = fdPath(stageFd);
    const work = path.join(stage, '.muxplorer-mega');
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { mode: 0o700 });
    const base = path.join(work, resource.name);
    const directories = new Set<string>();
    let total = 0;
    let sample = { time: Date.now(), bytes: 0 };
    try {
      for (const [index, file] of resource.files.entries()) {
        signal.throwIfAborted();
        const directory = path.join(base, file.path);
        const output = path.join(directory, file.name);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        for (let parent = directory; parent !== work; parent = path.dirname(parent))
          directories.add(parent);
        const stream = files[index].download({
          forceHttps: true,
          maxConnections: 2,
          handleRetries: (_tries, error, callback) => callback(error),
        });
        stream.on('progress', ({ bytesLoaded }: { bytesLoaded: number }) => {
          const now = Date.now();
          const current = this.tasks.get(task.id);
          if (!current || current.status !== 'running') return;
          current.downloaded = total + bytesLoaded;
          if (now - sample.time >= 1000) {
            current.speed = Math.max(
              0,
              (1000 * (current.downloaded - sample.bytes)) / (now - sample.time),
            );
            sample = { time: now, bytes: current.downloaded };
          }
        });
        await pipeline(
          stream,
          createWriteStream(output, { flags: 'wx', mode: 0o640, flush: true }),
          { signal },
        );
        if ((await lstat(output)).size !== file.size) throw new Error('Tamaño inesperado en MEGA.');
        total += file.size;
      }
      for (const directory of directories) {
        const handle = await open(directory, flags);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      signal.throwIfAborted();
      const name = resource.name || resource.files[0].name;
      const target = path.join(stage, name);
      await rm(target, { recursive: true, force: true });
      await rename(path.join(work, name), target);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
