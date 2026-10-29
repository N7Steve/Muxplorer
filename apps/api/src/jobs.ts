import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Subject } from 'rxjs';
import type { Disc, Job, JobKind, Location, ReviewFile } from '@muxplorer/shared';
import { Store } from './store';
import { config } from './config';
import { errorText, problem } from './errors';
import { diagnostic } from './diagnostics';
export interface JobContext {
  id: string;
  signal: AbortSignal;
  update: (stage: string, progress?: number | null) => void;
  message: (message: string) => void;
  result: (location: Location) => void;
  checkpoint: (payload: unknown) => void;
}
export class NeedsReview extends Error {
  constructor(readonly files: ReviewFile[]) {
    super('Revisa las pistas reales extraídas antes de publicar.');
  }
}
export class NeedsDiscSelection extends Error {
  constructor(readonly disc: Disc) {
    super('Análisis listo. Elige los títulos para crear el MKV.');
  }
}
type Handler = (payload: unknown, context: JobContext) => Promise<void>;
@Injectable()
export class Jobs implements OnModuleDestroy {
  readonly events = new Subject<{ data: Job }>();
  readonly shutdown = new Subject<void>();
  private readonly handlers = new Map<JobKind, Handler>();
  private readonly running = new Map<string, AbortController>();
  private readonly active = new Map<string, Job>();
  private readonly secrets = new Map<string, unknown>();
  private stopped = false;
  constructor(private readonly store: Store) {
    for (const job of this.scheduled())
      if (job.status === 'running' || job.status === 'pending') {
        job.status = 'interrupted';
        job.stage = 'Interrumpido por reinicio. Revisa el destino y los temporales.';
        this.save(job);
      }
  }
  register(kind: JobKind, handler: Handler) {
    this.handlers.set(kind, handler);
  }
  private save(job: Job, payload?: unknown) {
    job.revision = (job.revision ?? 0) + 1;
    job.updatedAt = new Date().toISOString();
    if (payload !== undefined)
      this.store.db
        .prepare('INSERT OR REPLACE INTO jobs VALUES (?, ?, ?)')
        .run(job.id, JSON.stringify(job), JSON.stringify(payload));
    else
      this.store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id);
    // SSE serialization may be deferred until after the next CLI update.
    this.events.next({ data: structuredClone(job) });
  }
  list(): Job[] {
    return (
      this.store.db.prepare('SELECT data FROM jobs ORDER BY rowid DESC LIMIT 500').all() as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data) as Job);
  }
  private scheduled(): Job[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM jobs WHERE json_extract(data, '$.status') IN ('pending', 'running') ORDER BY rowid",
        )
        .all() as { data: string }[]
    ).map((row) => JSON.parse(row.data) as Job);
  }
  get(id: string): Job {
    const row = this.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(id) as
      { data: string } | undefined;
    if (!row) problem('Trabajo no encontrado.');
    return JSON.parse(row.data) as Job;
  }
  payload(id: string): unknown {
    const row = this.store.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id) as {
      payload: string;
    };
    return this.secrets.get(id) ?? JSON.parse(row.payload);
  }
  enqueue(
    kind: JobKind,
    payload: unknown,
    sources: Location[],
    destination?: Location,
    ephemeral?: unknown,
  ) {
    const job: Job = {
      id: randomUUID(),
      kind,
      sources,
      destination,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      progress: null,
      stage: 'En cola',
      messages: [],
      results: [],
    };
    this.save(job, payload);
    diagnostic('job.queued', { jobId: job.id, kind, sources, destination });
    if (ephemeral) this.secrets.set(job.id, ephemeral);
    queueMicrotask(() => this.drain());
    return job;
  }
  cancel(id: string) {
    diagnostic('job.cancel_requested', { jobId: id });
    const job = this.get(id);
    if (job.status === 'running') {
      const current = this.active.get(id);
      if (current) {
        current.stage = 'Cancelando la operación y limpiando temporales';
        current.progress = null;
        this.save(current);
      }
      this.running.get(id)?.abort();
      return;
    }
    if (job.status === 'pending' || job.status === 'interrupted') {
      delete job.awaitingDisc;
      delete job.awaitingReview;
      job.status = 'cancelled';
      job.progress = null;
      delete job.error;
      job.stage = 'Cancelado. Los temporales retenidos pueden limpiarse desde el panel.';
      this.secrets.delete(id);
      this.save(job);
    }
  }
  resumeReview(id: string, payload: unknown) {
    const job = this.get(id);
    if (!job.awaitingReview || !['pending', 'interrupted'].includes(job.status))
      problem('Este trabajo no está pendiente de revisión.');
    job.status = 'pending';
    delete job.awaitingReview;
    job.stage = 'Revisión confirmada';
    this.save(job, payload);
    queueMicrotask(() => this.drain());
    return job;
  }
  resumeDisc(id: string, payload: unknown, destination: Location) {
    const job = this.get(id);
    if (!job.awaitingDisc || !['pending', 'interrupted'].includes(job.status))
      problem('Este análisis no está pendiente de elegir títulos.');
    delete job.awaitingDisc;
    job.status = 'pending';
    job.destination = destination;
    job.stage = 'Títulos confirmados';
    job.progress = null;
    this.save(job, payload);
    queueMicrotask(() => this.drain());
    return job;
  }
  start(id: string) {
    const job = this.get(id);
    if (job.status !== 'pending' || job.awaitingReview || job.awaitingDisc)
      problem('Solo se pueden empezar trabajos que esperan en la cola.');
    diagnostic('job.start_requested', { jobId: id });
    this.drain(id);
    return this.get(id);
  }
  dismiss(id: string) {
    const job = this.get(id);
    if (!['completed', 'failed', 'cancelled'].includes(job.status))
      problem('Termina o cancela el trabajo antes de retirarlo de la lista.');
    job.dismissed = true;
    this.save(job);
    diagnostic('job.dismissed', { jobId: id });
    return job;
  }
  markCleaned(id: string) {
    const job = this.get(id);
    if (job.status === 'running' || job.status === 'pending')
      problem('Cancela el trabajo antes de limpiar.');
    delete job.awaitingReview;
    delete job.awaitingDisc;
    job.messages.push('Temporales limpiados por el administrador.');
    this.save(job);
  }
  private drain(forcedId?: string) {
    if (this.stopped) return;
    const queued = this.scheduled();
    if (forcedId) queued.sort((a, b) => Number(b.id === forcedId) - Number(a.id === forcedId));
    for (const job of queued) {
      if (job.id !== forcedId && this.running.size >= config.JOB_CONCURRENCY) continue;
      if (
        job.status !== 'pending' ||
        job.awaitingReview ||
        job.awaitingDisc ||
        this.running.has(job.id)
      )
        continue;
      const handler = this.handlers.get(job.kind);
      if (!handler) continue;
      const controller = new AbortController();
      this.running.set(job.id, controller);
      this.active.set(job.id, job);
      job.status = 'running';
      job.stage = 'Preparando';
      this.save(job);
      diagnostic('job.started', { jobId: job.id, kind: job.kind });
      let loggedStage = '',
        loggedProgress = -1,
        loggedAt = 0;
      const context: JobContext = {
        id: job.id,
        signal: controller.signal,
        update: (stage, progress = null) => {
          if (controller.signal.aborted) return;
          job.stage = stage;
          job.progress = progress === null ? null : Math.max(0, Math.min(100, progress));
          if (
            stage !== loggedStage ||
            Math.abs((job.progress ?? -1) - loggedProgress) >= 5 ||
            Date.now() - loggedAt >= 15_000
          ) {
            diagnostic('job.progress', { jobId: job.id, stage, progress: job.progress });
            loggedStage = stage;
            loggedProgress = job.progress ?? -1;
            loggedAt = Date.now();
          }
          this.save(job);
        },
        message: (message) => {
          diagnostic('job.message', { jobId: job.id, message: message.slice(0, 2000) });
          job.messages.push(message.slice(0, 8000));
          job.messages = job.messages.slice(-40);
          this.save(job);
        },
        result: (location) => {
          diagnostic('job.result', { jobId: job.id, location });
          job.results.push(location);
          this.save(job);
        },
        checkpoint: (payload) => this.save(job, payload),
      };
      void handler(this.payload(job.id), context)
        .then(() => {
          job.status = 'completed';
          job.stage = 'Completado';
          job.progress = 100;
        })
        .catch((error: unknown) => {
          if (error instanceof NeedsDiscSelection && !controller.signal.aborted) {
            job.status = 'pending';
            job.awaitingDisc = error.disc;
            job.stage = error.message;
            job.progress = 100;
          } else if (error instanceof NeedsReview) {
            job.status = 'pending';
            job.awaitingReview = error.files;
            job.stage = error.message;
            job.progress = null;
          } else {
            job.status = this.stopped
              ? 'interrupted'
              : controller.signal.aborted
                ? 'cancelled'
                : 'failed';
            if (job.status === 'cancelled') {
              delete job.error;
              job.progress = null;
            } else {
              job.error = errorText(error);
              if (job.status === 'interrupted') job.progress = null;
            }
            job.stage =
              job.status === 'cancelled'
                ? 'Cancelado'
                : job.status === 'interrupted'
                  ? 'Interrumpido'
                  : 'Error';
          }
        })
        .finally(() => {
          diagnostic('job.finished', {
            jobId: job.id,
            status: job.status,
            stage: job.stage,
            progress: job.progress,
            error: job.error,
            results: job.results,
          });
          this.save(job);
          this.secrets.delete(job.id);
          this.running.delete(job.id);
          this.active.delete(job.id);
          this.drain();
        });
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    this.shutdown.next();
    this.shutdown.complete();
    for (const controller of this.running.values()) controller.abort();
    const until = Date.now() + 10_000;
    while (this.running.size && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
