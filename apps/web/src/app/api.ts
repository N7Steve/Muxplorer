import { Injectable, signal } from '@angular/core';
import type { Entry, Job, Location, Root, SystemStatus } from '@muxplorer/shared';
import { mergeJobs } from './job-state';
@Injectable({ providedIn: 'root' })
export class Api {
  readonly jobs = signal<Job[]>([]);
  readonly roots = signal<Root[]>([]);
  readonly system = signal<SystemStatus | null>(null);
  readonly revision = signal(0);
  readonly connection = signal<'connected' | 'reconnecting'>('connected');
  readonly notice = signal<{ message: string; error: boolean } | null>(null);
  private stream?: EventSource;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private connectionGeneration = 0;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  async request<T>(url: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Muxplorer': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: unknown = await response.json();
    if (!response.ok)
      throw new Error(
        typeof data === 'object' && data && 'message' in data
          ? String(data.message)
          : `Error ${response.status}`,
      );
    return data as T;
  }
  list(location: Location) {
    return this.request<Entry[]>(
      `files?root=${location.root}&path=${encodeURIComponent(location.path)}`,
    );
  }
  async syncJobs() {
    const jobs = await this.request<Job[]>('jobs');
    this.applyJobs(jobs);
  }
  private applyJobs(jobs: Job[]) {
    const previous = this.jobs();
    this.jobs.update((current) => mergeJobs(current, jobs));
    for (const job of jobs) {
      const before = previous.find((item) => item.id === job.id);
      if (this.jobs().find((item) => item.id === job.id) !== job) continue;
      if (before && job.status === 'completed' && before.status !== 'completed') {
        this.revision.update((r) => r + 1);
        this.toast('Operación completada. El resultado está disponible.');
      }
      if (before && job.status === 'failed' && before.status !== 'failed') {
        this.revision.update((r) => r + 1);
        this.toast(new Error(job.error ?? 'La operación ha fallado.'));
      }
      if (job.results.length !== before?.results.length) this.revision.update((r) => r + 1);
    }
  }
  async connect() {
    this.disconnect();
    const generation = this.connectionGeneration;
    this.roots.set(await this.request<Root[]>('roots'));
    await this.syncJobs();
    void this.request<SystemStatus>('system')
      .then((system) => this.system.set(system))
      .catch((error) => this.toast(error));
    this.stream?.close();
    this.stream = new EventSource('/api/jobs/events');
    // Some proxies hold SSE data while keeping the connection open. HTTP snapshots
    // keep progress and completion current even when no stream error is reported.
    const poll = async () => {
      if (generation !== this.connectionGeneration) return;
      try {
        const jobs = await this.request<Job[]>('jobs');
        if (generation === this.connectionGeneration) this.applyJobs(jobs);
      } catch {
        // The stream and the next snapshot can recover without repeated toasts.
      } finally {
        if (generation === this.connectionGeneration)
          this.pollTimer = setTimeout(() => void poll(), 2000);
      }
    };
    this.pollTimer = setTimeout(() => void poll(), 2000);
    this.stream.onopen = () => {
      this.connection.set('connected');
      void this.syncJobs().then(() => {
        this.revision.update((r) => r + 1);
      });
    };
    this.stream.onerror = () => this.connection.set('reconnecting');
    this.stream.onmessage = (event) => {
      const job = JSON.parse(event.data) as Job;
      if (!job.id) return;
      this.applyJobs([job]);
    };
  }
  disconnect() {
    this.connectionGeneration++;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.stream?.close();
  }
  toast(value: unknown) {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.notice.set({
      message: value instanceof Error ? value.message : String(value),
      error: value instanceof Error,
    });
    this.noticeTimer = setTimeout(
      () => this.notice.set(null),
      value instanceof Error ? 12_000 : 4500,
    );
  }
}
export function bytes(value: number): string {
  if (!value) return '0 B';
  const index = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toLocaleString('es-ES', { maximumFractionDigits: index ? 1 : 0 })} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
}
export function rootName(location: Location) {
  return location.root === 'downloads' ? 'Downloads' : 'PlexMedia';
}
export function displayLocation(location: Location) {
  return `${rootName(location)}${location.path ? ` / ${location.path}` : ''}`;
}
