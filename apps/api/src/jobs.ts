import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Subject } from 'rxjs';
import type { Job, JobKind, Location, ReviewFile } from '@muxplorer/shared';
import { Store } from './store';
import { config } from './config';
import { errorText, problem } from './errors';
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
type Handler = (payload: unknown, context: JobContext) => Promise<void>;
@Injectable()
export class Jobs implements OnModuleDestroy {
  readonly events = new Subject<{ data: Job }>();
  readonly shutdown = new Subject<void>();
  private readonly handlers = new Map<JobKind, Handler>();
  private readonly running = new Map<string, AbortController>();
  private readonly secrets = new Map<string, unknown>();
  private stopped = false;
  constructor(private readonly store: Store) {
    for (const job of this.list())
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
    job.updatedAt = new Date().toISOString();
    if (payload !== undefined)
      this.store.db
        .prepare('INSERT OR REPLACE INTO jobs VALUES (?, ?, ?)')
        .run(job.id, JSON.stringify(job), JSON.stringify(payload));
    else
      this.store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id);
    this.events.next({ data: job });
  }
  list(): Job[] {
    return (
      this.store.db.prepare('SELECT data FROM jobs ORDER BY rowid DESC LIMIT 500').all() as {
        data: string;
      }[]
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
    if (this.list().filter((j) => j.status === 'pending' || j.status === 'running').length >= 100)
      problem('La cola tiene demasiados trabajos pendientes.');
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
    if (ephemeral) this.secrets.set(job.id, ephemeral);
    queueMicrotask(() => this.drain());
    return job;
  }
  cancel(id: string) {
    const job = this.get(id);
    if (job.status === 'running') {
      this.running.get(id)?.abort();
      return;
    }
    if (job.status === 'pending' || job.status === 'interrupted') {
      job.status = 'cancelled';
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
  markCleaned(id: string) {
    const job = this.get(id);
    if (job.status === 'running' || job.status === 'pending')
      problem('Cancela el trabajo antes de limpiar.');
    delete job.awaitingReview;
    job.messages.push('Temporales limpiados por el administrador.');
    this.save(job);
  }
  private drain() {
    if (this.stopped) return;
    for (const job of this.list().reverse()) {
      if (this.running.size >= config.JOB_CONCURRENCY) break;
      if (job.status !== 'pending' || job.awaitingReview || this.running.has(job.id)) continue;
      const handler = this.handlers.get(job.kind);
      if (!handler) continue;
      const controller = new AbortController();
      this.running.set(job.id, controller);
      job.status = 'running';
      job.stage = 'Preparando';
      this.save(job);
      const context: JobContext = {
        id: job.id,
        signal: controller.signal,
        update: (stage, progress = null) => {
          job.stage = stage;
          job.progress = progress === null ? null : Math.max(0, Math.min(100, progress));
          this.save(job);
        },
        message: (message) => {
          job.messages.push(message.slice(0, 8000));
          job.messages = job.messages.slice(-40);
          this.save(job);
        },
        result: (location) => {
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
          if (error instanceof NeedsReview) {
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
            job.error = errorText(error);
            job.stage =
              job.status === 'cancelled'
                ? 'Cancelado'
                : job.status === 'interrupted'
                  ? 'Interrumpido'
                  : 'Error';
          }
        })
        .finally(() => {
          this.save(job);
          this.secrets.delete(job.id);
          this.running.delete(job.id);
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
