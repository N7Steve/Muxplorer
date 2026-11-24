import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  Download,
  DownloadAction,
  DownloadEngine,
  DownloadGroup,
  DownloadLinkCheck,
  DownloadsPage,
  DownloadStatus,
  Location,
} from '@muxplorer/shared';
import { config } from './config';
import { diagnostic } from './diagnostics';
import {
  defaultDownloadDestination,
  DownloadPublication,
  PublicationError,
  type Publication,
} from './download-publication';
import {
  DOWNLOAD_PROVIDER,
  HostDownloadError,
  ProviderError,
  type DownloadProvider,
  type EngineTask,
} from './download-provider';
import { childLocation, safeName } from './paths';
import { Store } from './store';
import { downloadPart, nameFromLink } from './download-parts';

interface RecordData {
  id: string;
  createdAt: string;
  digest: string;
  engineId?: string;
  phase: 'creating' | 'active' | 'cancelled' | 'completed' | 'rejected';
  intent?: 'cancel' | 'remove';
  cleaned?: boolean;
  publication?: Publication;
  publicationError?: string;
  name?: string;
  total?: number;
  destination?: Location;
  downloadError?: string;
  expectedParts?: number;
}

const creationGrace = 30_000;
const digest = (url: string, accountId?: string) =>
  createHash('sha256')
    .update(accountId ? JSON.stringify([url, accountId]) : url)
    .digest('hex');
const sameLocation = (a: Location, b: Location) => a.root === b.root && a.path === b.path;
const activeStates: DownloadStatus[] = ['pending', 'running', 'publishing'];
const issueStates: DownloadStatus[] = ['failed', 'missing', 'publication-failed'];
export type DownloadFilter = 'all' | 'active' | 'paused' | 'issues' | 'completed' | 'cancelled';

function resolvedName(task?: EngineTask) {
  const resource = task?.resource;
  const candidate = task?.outputName || resource?.name || resource?.files[0]?.name;
  try {
    if (candidate) return safeName(candidate);
  } catch {
    // The raw URL and malformed names stay outside the public metadata.
  }
  return undefined;
}

@Injectable()
export class Downloads implements OnModuleInit, OnModuleDestroy {
  private readonly records = new Map<string, RecordData>();
  private tasks = new Map<string, EngineTask>();
  private readonly publicationRetry = new Map<string, number>();
  private engine: DownloadEngine;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private publication?: Promise<void>;
  private publishingId?: string;

  constructor(
    private readonly store: Store,
    private readonly files: DownloadPublication,
    @Inject(DOWNLOAD_PROVIDER) private readonly provider: DownloadProvider,
    @Optional() private readonly engineUrl = config.GOPEED_URL,
    @Optional() private readonly token = config.GOPEED_API_TOKEN,
  ) {
    for (const { data } of store.db.prepare('SELECT data FROM downloads ORDER BY rowid').all()) {
      const record = JSON.parse(String(data)) as RecordData;
      this.records.set(record.id, record);
    }
    this.engine = { status: engineUrl ? 'connecting' : 'disabled' };
  }

  onModuleInit() {
    if (this.engineUrl) this.schedule(0);
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.queue;
    await this.publication;
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => {
        const active =
          this.engine.status === 'connected' &&
          [...this.tasks.values()].some((task) => ['pending', 'running'].includes(task.status));
        this.schedule(active ? 2500 : 6000);
      });
    }, delay);
    this.timer.unref();
  }

  private serial<T>(action: () => Promise<T>) {
    const work = this.queue.then(action);
    this.queue = work.catch(() => undefined);
    return work;
  }

  private save(record: RecordData) {
    this.store.db
      .prepare(
        'INSERT INTO downloads VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(record.id, JSON.stringify(record));
    this.records.set(record.id, record);
  }

  private forget(id: string) {
    this.store.db.prepare('DELETE FROM downloads WHERE id=?').run(id);
    this.records.delete(id);
    this.tasks.delete(id);
    this.publicationRetry.delete(id);
  }

  private setEngine(engine: DownloadEngine) {
    if (this.engine.status !== engine.status)
      diagnostic('downloads.engine', { status: engine.status });
    this.engine = engine;
  }

  private owns(task: EngineTask, record: RecordData) {
    return task.requestId === record.id && (!record.engineId || task.id === record.engineId);
  }

  async refresh() {
    if (!this.engineUrl || this.stopped) return;
    return this.serial(async () => {
      try {
        const url = URL.parse(this.engineUrl);
        if (
          !url ||
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          !this.token
        ) {
          this.setEngine({
            status: 'misconfigured',
            message: 'Configura la URL privada y el token de Gopeed.',
          });
          return;
        }
        try {
          await this.files.staging();
        } catch {
          this.setEngine({
            status: 'misconfigured',
            message: 'El volumen privado de descargas no está disponible en Muxplorer.',
          });
          return;
        }
        const info = this.engine.status === 'connected' ? this.engine : await this.provider.info();
        const next = new Map<string, EngineTask>();
        const duplicates = new Set<string>();
        for (const task of await this.provider.list()) {
          const id = task.requestId;
          const record = id && this.records.get(id);
          if (record && this.owns(task, record)) {
            if (next.has(record.id)) duplicates.add(record.id);
            next.set(record.id, task);
          }
        }
        for (const id of duplicates) next.delete(id);
        this.tasks = next;
        this.setEngine({ status: 'connected', version: info.version });

        for (const record of this.records.values()) {
          const task = next.get(record.id);
          if (task && ['creating', 'active'].includes(record.phase)) {
            const name = record.name ?? resolvedName(task);
            if (record.phase === 'creating' || name !== record.name)
              this.save({ ...record, engineId: task.id, phase: 'active', name });
          }
        }

        // Release the engine snapshot before copying potentially large media.
        this.startPublication();
        for (const record of this.records.values()) {
          if (record.id === this.publishingId || duplicates.has(record.id) || record.cleaned)
            continue;
          if (record.intent || ['completed', 'cancelled', 'rejected'].includes(record.phase)) {
            try {
              await this.cleanup(record, next.get(record.id));
            } catch {
              diagnostic('downloads.cleanup_retry', { id: record.id });
            }
          }
        }
      } catch (error) {
        this.setEngine({
          status: 'unavailable',
          message:
            error instanceof ProviderError ? error.message : 'No se pudo sincronizar con Gopeed.',
        });
      }
    });
  }

  private startPublication() {
    if (this.stopped || this.publication || this.engine.status !== 'connected') return;
    const record = [...this.records.values()].find(
      (item) =>
        item.phase === 'active' &&
        !item.intent &&
        !item.publicationError &&
        (this.publicationRetry.get(item.id) ?? 0) <= Date.now() &&
        (item.publication || this.tasks.get(item.id)?.status === 'done'),
    );
    if (!record) return;
    this.publishingId = record.id;
    this.publication = this.publish(record)
      .catch(() => {
        this.publicationRetry.set(record.id, Date.now() + 10_000);
        diagnostic('downloads.publication_retry', { id: record.id });
      })
      .finally(() => {
        this.publishingId = undefined;
        this.publication = undefined;
        this.startPublication();
      });
  }

  private async publish(initial: RecordData) {
    let record = initial;
    try {
      let publication = record.publication;
      if (!publication) {
        const fresh = record.engineId && (await this.provider.get(record.engineId));
        if (!fresh || !this.owns(fresh, record) || fresh.status !== 'done')
          throw new PublicationError('El motor no confirma que la descarga esté completa.');
        publication = await this.files.prepare(record.id, fresh, record.destination);
        record = { ...record, publication, total: fresh.resource?.size ?? 0 };
        this.save(record);
      }
      await this.files.commit(
        record.id,
        publication,
        (next) => {
          record = { ...record, publication: next };
          this.save(record);
        },
        (name) => {
          this.publicationRetry.delete(record.id);
          this.save({
            ...record,
            phase: 'completed',
            publication: { ...publication, target: name },
          });
        },
        record.destination,
      );
    } catch (error) {
      if (
        error instanceof ProviderError &&
        ['connection', 'response', 'auth'].includes(error.kind)
      ) {
        this.publicationRetry.set(record.id, Date.now() + 10_000);
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      const message =
        error instanceof PublicationError
          ? error.message
          : error instanceof ProviderError
            ? error.message
            : code === 'ENOSPC'
              ? 'No hay espacio suficiente en la carpeta de destino.'
              : 'No se pudo publicar el contenido. Comprueba que la carpeta de destino sigue disponible.';
      if (!record.publication)
        await this.files.cleanPrepared(record.id, record.destination).catch(() => undefined);
      this.save({ ...record, publicationError: message });
      diagnostic('downloads.publication_failed', { id: record.id });
    }
  }

  private async cleanup(record: RecordData, task?: EngineTask) {
    // An ambiguous POST can still appear in a later snapshot. Leave its UUID
    // reserved while waiting for either the task or an explicit dismissal.
    if (
      record.phase === 'creating' &&
      !task &&
      Date.now() - Date.parse(record.createdAt) < creationGrace
    )
      return;
    if (task) {
      const action = record.intent === 'cancel' ? 'cancel' : 'remove';
      await this.provider[action](task.id);
      this.tasks.delete(record.id);
    }
    await this.files.cleanStage(record.id);
    await this.files.cleanPrepared(record.id, record.destination);
    if (record.intent === 'remove') this.forget(record.id);
    else
      this.save({
        ...record,
        phase: record.intent === 'cancel' ? 'cancelled' : record.phase,
        intent: undefined,
        cleaned: true,
      });
  }

  status() {
    return this.engine;
  }

  destination(): Location {
    const saved = this.store.get('downloadDestination');
    return saved ? (JSON.parse(saved) as Location) : defaultDownloadDestination;
  }

  async setDestination(destination: Location) {
    await this.checkDestination(destination);
    this.store.set('downloadDestination', JSON.stringify(destination));
    return destination;
  }

  private async checkDestination(destination: Location) {
    try {
      await this.files.checkDestination(destination);
    } catch {
      throw new BadRequestException('Elige una carpeta existente con permisos de escritura.');
    }
  }

  private requireEngine() {
    if (this.engine.status !== 'connected')
      throw new ServiceUnavailableException(this.engine.message ?? 'Gopeed no está conectado.');
  }

  private row(id: string) {
    const record = this.records.get(id);
    if (!record || record.intent === 'remove')
      throw new NotFoundException('Descarga no encontrada.');
    return record;
  }

  private view(record: RecordData): Download {
    const task = this.tasks.get(record.id);
    const res = task?.resource;
    const result: Download = {
      id: record.id,
      createdAt: record.createdAt,
      name: record.publication?.name ?? resolvedName(task) ?? record.name ?? 'Descarga',
      status: task?.status === 'done' ? 'publishing' : (task?.status ?? 'pending'),
      downloaded: task?.downloaded ?? 0,
      total: res?.size ?? record.total ?? 0,
      speed: task?.status === 'running' && this.engine.status === 'connected' ? task.speed : 0,
      actions: [],
      destination: record.destination,
    };
    const part = downloadPart(record.name ?? '') ?? downloadPart(result.name);
    if (part)
      result.multipart = { ...part, expected: Math.max(part.part, record.expectedParts ?? 0) };
    if (record.phase === 'completed' && record.publication) {
      result.status = 'completed';
      result.name = record.publication.target;
      result.downloaded = result.total;
      result.result = childLocation(
        record.destination ?? defaultDownloadDestination,
        record.publication.target,
      );
    } else if (record.phase === 'cancelled' || record.intent === 'cancel') {
      result.status = 'cancelled';
      if (record.intent)
        result.error = 'La cancelación se confirmará con Gopeed cuando esté disponible.';
    } else if (record.publicationError) {
      result.status = 'publication-failed';
      result.error = record.publicationError;
    } else if (record.phase === 'rejected' || task?.status === 'failed') {
      result.status = 'failed';
      result.error =
        record.downloadError ??
        task?.error ??
        (record.phase === 'rejected'
          ? 'Gopeed rechazó el enlace.'
          : 'Gopeed informó de un error de descarga. Comprueba el enlace o vuelve a intentarlo.');
    } else if (record.publication || record.id === this.publishingId) {
      result.status = 'publishing';
    } else if (!task && this.engine.status === 'connected') {
      if (record.phase === 'active') {
        result.status = 'missing';
        result.error = 'La tarea ya no existe en Gopeed.';
      } else if (Date.now() - Date.parse(record.createdAt) >= creationGrace) {
        result.status = 'failed';
        result.error =
          'Gopeed no confirmó el alta. Puedes retirar esta entrada y volver a añadir el enlace.';
      }
    }
    if (record.id !== this.publishingId && result.status !== 'publishing') {
      if (this.engine.status === 'connected' && !record.intent) {
        if (task && ['running', 'pending'].includes(task.status)) result.actions.push('pause');
        if (task && ['paused', 'failed'].includes(task.status)) result.actions.push('resume');
        if (record.publicationError) result.actions.push('publish');
      }
      if (
        !record.publication &&
        ['pending', 'running', 'paused'].includes(result.status) &&
        (record.phase !== 'creating' || Date.now() - Date.parse(record.createdAt) >= creationGrace)
      )
        result.actions.push('cancel');
      if (
        ['failed', 'missing', 'cancelled', 'publication-failed', 'completed'].includes(
          result.status,
        )
      )
        result.actions.push('remove');
    }
    return result;
  }

  list(page: number, limit: number, filter: DownloadFilter = 'all', query = ''): DownloadsPage {
    const tasks = [...this.records.values()]
      .filter((record) => record.intent !== 'remove')
      .reverse()
      .map((record) => this.view(record));
    const active = tasks.filter((task) => activeStates.includes(task.status));
    const search = query.toLocaleLowerCase('es');
    const matches = (task: Download) =>
      (task.name.toLocaleLowerCase('es').includes(search) ||
        task.multipart?.name.toLocaleLowerCase('es').includes(search)) &&
      (filter === 'all' ||
        (filter === 'active'
          ? activeStates.includes(task.status)
          : filter === 'issues'
            ? issueStates.includes(task.status)
            : task.status === filter));
    const groups = new Map<string, DownloadGroup>();
    for (const task of tasks) {
      const part = task.multipart;
      const id = part
        ? JSON.stringify([task.destination ?? defaultDownloadDestination, part.key])
        : task.id;
      let group = groups.get(id);
      if (!group) {
        group = { id, name: part?.name ?? task.name, tasks: [] };
        groups.set(id, group);
      }
      group.tasks.push(task);
      if (part) group.expected = Math.max(group.expected ?? 0, part.expected);
    }
    const filtered = [...groups.values()].filter((group) => group.tasks.some(matches));
    const pageGroups = filtered.slice(page * limit, (page + 1) * limit);
    for (const group of pageGroups) {
      if (!group.expected) continue;
      group.tasks.sort((a, b) => a.multipart!.part - b.multipart!.part);
      const parts = new Set(
        group.tasks
          .filter((task) => task.status !== 'cancelled' && !issueStates.includes(task.status))
          .map((task) => task.multipart!.part),
      );
      group.missing = group.expected - parts.size;
    }
    return {
      engine: this.engine,
      tasks: pageGroups.flatMap((group) => group.tasks),
      groups: pageGroups,
      total: filtered.length,
      active: active.length,
      speed: active.reduce((sum, task) => sum + task.speed, 0),
    };
  }

  get(id: string) {
    return this.view(this.row(id));
  }

  async result(id: string) {
    const record = this.row(id);
    const publication = record.publication;
    const location =
      record.phase === 'completed' &&
      publication &&
      (await this.files.result(publication.target, publication.identity, record.destination));
    if (!location) throw new NotFoundException('El resultado ya no está en su ubicación original.');
    return location;
  }

  async analyze(url: string, accountId?: string) {
    this.requireEngine();
    if (!this.provider.resolve)
      throw new ConflictException('El motor no admite el análisis de enlaces.');
    try {
      const resource = await this.provider.resolve(url, accountId);
      return {
        name: safeName(resource.name || resource.files[0]?.name),
        total: resource.size,
        files: resource.files.length,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ConflictException(
        error instanceof HostDownloadError
          ? error.message
          : 'No se pudo analizar el recurso solicitado.',
      );
    }
  }

  async check(url: string): Promise<DownloadLinkCheck> {
    this.requireEngine();
    const result: DownloadLinkCheck = (await this.provider.check?.(url)) ?? { status: 'unknown' };
    const name = result.name ?? nameFromLink(url);
    try {
      return {
        ...result,
        name: name && safeName(name),
        multipart: name ? downloadPart(name) : undefined,
      };
    } catch {
      return { ...result, name: undefined };
    }
  }

  add(
    links: { id: string; url: string; name?: string; expectedParts?: number }[],
    override?: Location,
    accountId?: string,
  ) {
    return this.serial(async () => {
      this.requireEngine();
      const destination = override ?? this.destination();
      for (const { id, url } of links) {
        const direct = this.records.get(id);
        if (!direct) this.provider.validate?.(url, accountId);
        else if (
          direct.digest !== digest(url, accountId) ||
          (override && !sameLocation(direct.destination ?? defaultDownloadDestination, override))
        )
          throw new ConflictException('El identificador ya se usó con otra descarga.');
      }
      if (
        links.some(({ id }) => !this.records.has(id)) &&
        !sameLocation(destination, defaultDownloadDestination)
      )
        await this.checkDestination(destination);
      const ids: string[] = [];
      const canReuse = (record: RecordData) =>
        !record.intent &&
        (record.phase === 'creating' ||
          (record.phase === 'active' && !issueStates.includes(this.view(record).status)));
      const candidates = new Map<string, string>();
      for (const record of this.records.values()) {
        if (
          sameLocation(record.destination ?? defaultDownloadDestination, destination) &&
          canReuse(record) &&
          !candidates.has(record.digest)
        )
          candidates.set(record.digest, record.id);
      }
      for (const { id, url, name, expectedParts } of links) {
        const key = digest(url, accountId);
        const candidate = this.records.get(candidates.get(key) ?? '');
        const existing =
          this.records.get(id) ?? (candidate && canReuse(candidate) ? candidate : undefined);
        if (existing) {
          ids.push(existing.id);
          if (
            existing.id !== this.publishingId &&
            expectedParts &&
            expectedParts > (existing.expectedParts ?? 0) &&
            name &&
            downloadPart(name)
          )
            this.save({ ...existing, name, expectedParts });
          continue;
        }
        let record: RecordData = {
          id,
          digest: key,
          phase: 'creating',
          createdAt: new Date().toISOString(),
          destination,
          name: name ?? nameFromLink(url),
          expectedParts,
        };
        try {
          await this.files.createStage(id);
        } catch {
          throw new ServiceUnavailableException(
            'No se pudo preparar el volumen privado de Gopeed.',
          );
        }
        this.save(record);
        ids.push(id);
        try {
          const engineId = await this.provider.add(url, id, accountId);
          record = { ...record, engineId, phase: 'active' };
          this.save(record);
          candidates.set(key, id);
        } catch (error) {
          if (
            error instanceof HostDownloadError ||
            error instanceof BadRequestException ||
            (error instanceof ProviderError && ['rejected', 'auth'].includes(error.kind))
          )
            this.save({ ...record, phase: 'rejected', downloadError: error.message });
          else candidates.set(key, id);
        }
      }
      return { ids };
    }).finally(() => {
      if (!this.stopped) void this.refresh();
    });
  }

  command(id: string, action: DownloadAction) {
    return this.serial(async () => {
      const record = this.row(id);
      if (this.publishingId === id) throw new ConflictException('La publicación está en curso.');
      if (action === 'publish') {
        this.requireEngine();
        if (!record.publicationError)
          throw new ConflictException('No hay una publicación pendiente de reintento.');
        this.save({ ...record, publicationError: undefined });
        this.startPublication();
      } else if (action === 'cancel' || action === 'remove') {
        if (
          action === 'cancel' &&
          (record.phase === 'completed' || this.tasks.get(id)?.status === 'done')
        )
          throw new ConflictException('La descarga ya está completa.');
        if (record.cleaned) {
          if (action === 'remove') this.forget(id);
        } else {
          if (
            record.phase === 'creating' &&
            Date.now() - Date.parse(record.createdAt) < creationGrace
          )
            throw new ConflictException('Espera a que Gopeed confirme el alta.');
          if (record.publication && record.phase !== 'completed' && !record.publicationError)
            throw new ConflictException(
              'Confirma primero el resultado de la publicación pendiente.',
            );
          this.save({ ...record, intent: action });
        }
      } else {
        this.requireEngine();
        const task = this.tasks.get(id);
        const allowed = action === 'pause' ? ['running', 'pending'] : ['paused', 'failed'];
        if (!task || !allowed.includes(task.status) || record.intent || record.phase !== 'active')
          throw new ConflictException('La tarea no admite esta acción en su estado actual.');
        try {
          await this.provider[action](task.id);
        } catch (error) {
          throw new ServiceUnavailableException(
            error instanceof ProviderError ? error.message : 'Gopeed no confirmó la acción.',
          );
        }
      }
      return { ok: true };
    }).finally(() => {
      if (!this.stopped) void this.refresh();
    });
  }
}
