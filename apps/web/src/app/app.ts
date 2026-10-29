import { Component, computed, inject, signal, viewChild, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { A11yModule } from '@angular/cdk/a11y';
import type {
  Disc,
  Entry,
  Job,
  Location,
  Media,
  RemuxRequest,
  Track,
  TrackChoice,
} from '@muxplorer/shared';
import { Api, bytes, displayLocation } from './api';
import { Explorer, Action } from './explorer';
import { Icon } from './icon';
import { Tracks, EditableTrack } from './tracks';
type Dialog =
  | 'mkdir'
  | 'rename'
  | 'delete'
  | 'transfer'
  | 'extract'
  | 'remux'
  | 'disc'
  | 'properties'
  | 'settings'
  | 'review'
  | 'shortcuts'
  | null;
function editable(track: Track, source: number, sourceName: string): EditableTrack {
  return {
    source,
    id: track.id,
    enabled: true,
    name: track.name,
    language: track.language,
    default: track.default,
    forced: track.forced,
    metadata: track,
    sourceName,
  };
}
@Component({
  selector: 'mux-app',
  standalone: true,
  imports: [FormsModule, DatePipe, A11yModule, Explorer, Icon, Tracks],
  templateUrl: './app.html',
})
export class AppComponent {
  readonly api = inject(Api);
  readonly authenticated = signal(false);
  readonly configured = signal(true);
  readonly starting = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  password = '';
  username = '';
  readonly adminName = signal('');
  readonly active = signal<'left' | 'right'>('left');
  readonly jobsOpen = signal(false);
  readonly dialog = signal<Dialog>(null);
  readonly context = signal<Action | null>(null);
  readonly currentAction = signal<Action | null>(null);
  readonly destination = signal<Location>({ root: 'plex', path: '' });
  readonly picking = signal<'destination' | 'external' | null>(null);
  readonly left = viewChild<Explorer>('left');
  readonly right = viewChild<Explorer>('right');
  readonly sources = signal<Media[]>([]);
  readonly tracks = signal<EditableTrack[]>([]);
  readonly disc = signal<Disc | null>(null);
  readonly discEngine = signal<'makemkv' | 'disc'>('makemkv');
  readonly discPreparationId = signal<string | null>(null);
  readonly preparation = computed(() =>
    this.api.jobs().find((job) => job.id === this.discPreparationId()),
  );
  readonly discContent = computed(() =>
    this.discEngine() === 'disc' && this.discPreparationId()
      ? (this.preparation()?.awaitingDisc ?? null)
      : this.disc(),
  );
  readonly visibleJobs = computed(() => this.api.jobs().filter((job) => !job.dismissed));
  readonly selectedTitles = signal<Set<number>>(new Set());
  readonly reviewJob = signal<Job | null>(null);
  readonly reviewFiles = signal<{ index: number; name: string; tracks: EditableTrack[] }[]>([]);
  readonly selectedJob = signal<string | null>(null);
  private clipboard: { entries: Entry[]; kind: 'copy' | 'move' } | null = null;
  name = '';
  title = '';
  archivePassword = '';
  createSubfolder = true;
  transfer: 'copy' | 'move' = 'copy';
  readonly bytes = bytes;
  readonly display = displayLocation;
  readonly toolKeys = ['sevenZip', 'mkvmerge', 'makemkv'] as const;
  readonly activeCount = computed(
    () => this.api.jobs().filter((j) => j.status === 'pending' || j.status === 'running').length,
  );
  readonly activeJobs = computed(() =>
    this.api
      .jobs()
      .filter(
        (j) => j.status === 'pending' || j.status === 'running' || j.status === 'interrupted',
      ),
  );
  readonly currentSelection = computed(
    () => (this.active() === 'left' ? this.left() : this.right())?.selection() ?? [],
  );
  readonly jobLabels: Record<string, string> = {
    copy: 'Copia',
    move: 'Movimiento',
    delete: 'Eliminación',
    extract: 'Extracción',
    remux: 'Remux MKV',
    makemkv: 'MakeMKV',
    disc: 'Disco · MKVToolNix',
  };
  readonly statusLabels: Record<string, string> = {
    pending: 'Pendiente',
    running: 'En ejecución',
    completed: 'Completado',
    failed: 'Fallido',
    cancelled: 'Cancelado',
    interrupted: 'Interrumpido',
  };
  constructor() {
    void this.session();
  }
  private async session() {
    try {
      const session = await this.api.request<{
        configured: boolean;
        authenticated: boolean;
        username?: string;
      }>('auth/session');
      this.configured.set(session.configured);
      this.authenticated.set(session.authenticated);
      this.adminName.set(session.username ?? '');
      if (session.authenticated) await this.api.connect();
    } catch (error) {
      this.error.set(this.message(error));
    } finally {
      this.starting.set(false);
    }
  }
  private message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  async login() {
    this.busy.set(true);
    this.error.set('');
    try {
      const session = await this.api.request<{ username: string }>(
        this.configured() ? 'auth/login' : 'auth/setup',
        { username: this.username, password: this.password },
      );
      this.password = '';
      this.adminName.set(session.username);
      this.username = '';
      this.configured.set(true);
      this.authenticated.set(true);
      await this.api.connect();
    } catch (error) {
      this.error.set(this.message(error));
    } finally {
      this.busy.set(false);
    }
  }
  async logout() {
    await this.api.request('auth/logout', {});
    this.api.disconnect();
    this.authenticated.set(false);
  }
  panel() {
    return this.active() === 'left' ? this.left() : this.right();
  }
  otherPanel() {
    return this.active() === 'left' ? this.right() : this.left();
  }
  root(root: 'downloads' | 'plex') {
    this.panel()?.navigate({ root, path: '' });
  }
  toolbar(action: string) {
    this.onAction({
      action,
      entries: this.currentSelection(),
      location: this.panel()?.location() ?? { root: 'downloads', path: '' },
    });
  }
  isArchive(entry?: Entry) {
    return (
      !!entry &&
      entry.kind === 'file' &&
      /\.(rar|zip|7z|tar|tar\.gz|tgz|tar\.xz|001)$/i.test(entry.name)
    );
  }
  isMedia(entry?: Entry) {
    return (
      !!entry &&
      entry.kind === 'file' &&
      /\.(mkv|mp4|avi|mov|webm|m2ts|ts|flac|ac3|aac|dts|mp3|wav|srt|ass|ssa|sup|m4a)$/i.test(
        entry.name,
      )
    );
  }
  isDisc(entry?: Entry) {
    return (
      !!entry &&
      entry.kind === 'file' &&
      (/\.iso$/i.test(entry.name) || entry.name.toLowerCase() === 'index.bdmv')
    );
  }
  async onAction(action: Action) {
    if (action.action === 'context') {
      this.context.set({
        ...action,
        x: Math.min(action.x ?? 0, window.innerWidth - 250),
        y: Math.min(action.y ?? 0, window.innerHeight - 390),
      });
      return;
    }
    this.context.set(null);
    if (action.action.startsWith('clipboard-')) {
      this.clipboard = {
        entries: action.entries,
        kind: action.action === 'clipboard-copy' ? 'copy' : 'move',
      };
      this.api.toast(
        `${action.entries.length} elementos preparados. Ctrl+V para elegir el destino.`,
      );
      return;
    }
    if (action.action === 'paste') {
      if (!this.clipboard?.entries.length) return;
      action = {
        ...action,
        action: this.clipboard.kind,
        entries: this.clipboard.entries,
        destination: action.location,
      };
    }
    this.currentAction.set(action);
    this.error.set('');
    this.name = '';
    this.title = '';
    this.archivePassword = '';
    this.picking.set(null);
    this.destination.set(
      action.destination ?? this.otherPanel()?.location() ?? { root: 'plex', path: '' },
    );
    if (action.action === 'mkdir') this.dialog.set('mkdir');
    else if (action.action === 'rename' && action.entries.length === 1) {
      this.name = action.entries[0].name;
      this.dialog.set('rename');
    } else if (action.action === 'delete' && action.entries.length) this.dialog.set('delete');
    else if (['copy', 'move', 'drop'].includes(action.action) && action.entries.length) {
      this.transfer = action.action === 'move' ? 'move' : 'copy';
      this.dialog.set('transfer');
    } else if (action.action === 'properties' && action.entries.length)
      this.dialog.set('properties');
    else if (action.action.startsWith('extract') && action.entries.length === 1) {
      this.name = action.entries[0].name.replace(
        /(\.part\d+)?\.(tar\.(gz|xz)|rar|zip|7z|tar|tgz|001)$/i,
        '',
      );
      this.createSubfolder = action.action !== 'extract-here';
      if (action.action === 'extract-here' || action.action === 'extract-new')
        this.destination.set(action.location);
      this.dialog.set('extract');
    } else if (action.action === 'remux' && action.entries.length === 1) {
      this.sources.set([]);
      this.tracks.set([]);
      this.name = action.entries[0].name.replace(/\.[^.]+$/, '') + '.remux';
      this.dialog.set('remux');
      await this.addSource(action.entries[0].location);
    } else if (['disc', 'disc-mkvtoolnix'].includes(action.action) && action.entries.length === 1) {
      this.discEngine.set(action.action === 'disc' ? 'makemkv' : 'disc');
      this.disc.set(null);
      this.selectedTitles.set(new Set());
      this.name = action.entries[0].name.replace(/\.[^.]+$/, '') || 'pelicula';
      this.dialog.set('disc');
      this.discPreparationId.set(null);
      if (this.discEngine() === 'disc') {
        try {
          const job = await this.api.request<Job>('disc/prepare', action.entries[0].location);
          this.discPreparationId.set(job.id);
          await this.api.syncJobs();
        } catch (error) {
          this.error.set(this.message(error));
        }
        return;
      }
      this.busy.set(true);
      try {
        this.disc.set(
          await this.api.request<Disc>(`${this.discEngine()}/inspect`, action.entries[0].location),
        );
      } catch (error) {
        this.error.set(this.message(error));
      } finally {
        this.busy.set(false);
      }
    }
  }
  contextAction(action: string) {
    const current = this.context();
    if (current) void this.onAction({ ...current, action });
  }
  async addSource(location: Location) {
    if (
      this.sources().some(
        (s) => s.location.root === location.root && s.location.path === location.path,
      )
    ) {
      this.error.set('Este archivo ya está añadido.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const media = await this.api.request<Media>('media/inspect', location);
      const index = this.sources().length;
      this.sources.update((s) => [...s, media]);
      this.tracks.update((t) => [
        ...t,
        ...media.tracks
          .filter((track) => index === 0 || track.type !== 'video')
          .map((track) => editable(track, index, location.path.split('/').at(-1) ?? 'Origen')),
      ]);
      if (index === 0) this.title = media.title;
      this.picking.set(null);
    } catch (error) {
      this.error.set(this.message(error));
    } finally {
      this.busy.set(false);
    }
  }
  choose(action: Action) {
    if (action.action === 'choose' && action.entries[0])
      void this.addSource(action.entries[0].location);
  }
  close() {
    if (this.busy()) return;
    this.dialog.set(null);
    this.picking.set(null);
    this.error.set('');
    this.archivePassword = '';
  }
  backdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) this.close();
  }
  private choices(tracks: EditableTrack[]): TrackChoice[] {
    return tracks.map((track) => ({
      source: track.source,
      id: track.id,
      enabled: track.enabled,
      name: track.name,
      language: track.language,
      default: track.default,
      forced: track.forced,
    }));
  }
  async submit() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const action = this.currentAction();
    try {
      const sources = action?.entries.map((e) => e.location) ?? [];
      let message = 'Operación añadida';
      switch (this.dialog()) {
        case 'mkdir':
          await this.api.request('files/mkdir', { parent: action!.location, name: this.name });
          this.api.revision.update((r) => r + 1);
          message = 'Carpeta creada';
          break;
        case 'rename':
          await this.api.request('files/rename', { source: sources[0], name: this.name });
          this.api.revision.update((r) => r + 1);
          message = 'Nombre actualizado';
          break;
        case 'delete':
          await this.api.request('files/operation', { kind: 'delete', sources, confirmed: true });
          message = 'Eliminación añadida a operaciones';
          break;
        case 'transfer':
          await this.api.request('files/operation', {
            kind: this.transfer,
            sources,
            destination: this.destination(),
          });
          message = 'Transferencia añadida a operaciones';
          break;
        case 'extract':
          await this.api.request('archives/extract', {
            source: sources[0],
            destination: this.destination(),
            ...(this.createSubfolder ? { folder: this.name } : {}),
            ...(this.archivePassword ? { password: this.archivePassword } : {}),
          });
          message = 'Extracción añadida a operaciones';
          break;
        case 'remux': {
          const request: RemuxRequest = {
            sources: this.sources().map((s) => s.location),
            tracks: this.choices(this.tracks()),
            title: this.title,
            name: mkvName(this.name),
            destination: this.destination(),
          };
          await this.api.request('media/remux', request);
          message = 'Remux añadido a operaciones';
          break;
        }
        case 'disc':
          if (this.discEngine() === 'disc' && this.discPreparationId()) {
            await this.api.request(`jobs/${this.discPreparationId()}/disc-selection`, {
              destination: this.destination(),
              titles: [...this.selectedTitles()],
              name: this.name,
            });
          } else
            await this.api.request(`${this.discEngine()}/convert`, {
              source: sources[0],
              destination: this.destination(),
              titles: [...this.selectedTitles()],
              name: this.name,
            });
          message = 'Disco añadido. Podrás revisar las pistas tras la extracción.';
          break;
        case 'review':
          await this.api.request(`jobs/${this.reviewJob()!.id}/review`, {
            files: this.reviewFiles().map((f) => ({
              index: f.index,
              name: mkvName(f.name),
              tracks: this.choices(f.tracks),
            })),
          });
          message = 'Selección confirmada. Preparando los MKV finales.';
          break;
        default:
          return;
      }
      this.dialog.set(null);
      this.archivePassword = '';
      this.api.toast(message);
      await this.api.syncJobs();
    } catch (error) {
      this.error.set(this.message(error));
    } finally {
      this.busy.set(false);
    }
  }
  toggleTitle(id: number) {
    this.selectedTitles.update((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  review(job: Job) {
    this.jobsOpen.set(false);
    this.reviewJob.set(job);
    this.reviewFiles.set(
      (job.awaitingReview ?? []).map((f) => ({
        ...f,
        name: f.name.replace(/\.mkv$/i, ''),
        tracks: f.tracks.map((t) => editable(t, 0, f.name)),
      })),
    );
    this.error.set('');
    this.dialog.set('review');
  }
  clearTrackNames() {
    const tracks =
      this.dialog() === 'review'
        ? this.reviewFiles().flatMap((file) => file.tracks)
        : this.tracks();
    for (const track of tracks) track.name = '';
  }
  openDisc(job: Job) {
    this.jobsOpen.set(false);
    this.discEngine.set('disc');
    this.discPreparationId.set(job.id);
    this.disc.set(null);
    this.currentAction.set({ action: 'disc-mkvtoolnix', entries: [], location: job.sources[0] });
    this.selectedTitles.set(new Set());
    this.name = job.sources[0].path
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, '');
    this.destination.set(this.otherPanel()?.location() ?? { root: 'plex', path: '' });
    this.error.set('');
    this.dialog.set('disc');
  }
  async start(job: Job) {
    try {
      await this.api.request(`jobs/${job.id}/start`, {});
      await this.api.syncJobs();
    } catch (error) {
      this.api.toast(error);
    }
  }
  async dismiss(job: Job) {
    try {
      await this.api.request(`jobs/${job.id}/dismiss`, {});
      await this.api.syncJobs();
    } catch (error) {
      this.api.toast(error);
    }
  }
  async cancelPreparation() {
    const job = this.preparation();
    if (job && ['pending', 'running', 'interrupted'].includes(job.status)) await this.cancel(job);
    this.close();
  }
  async cancel(job: Job) {
    try {
      await this.api.request(`jobs/${job.id}/cancel`, {});
      await this.api.syncJobs();
    } catch (error) {
      this.api.toast(error);
    }
  }
  async cleanup(job: Job) {
    try {
      await this.api.request(`jobs/${job.id}/cleanup`, {});
      await this.api.syncJobs();
      this.api.toast('Temporales del trabajo eliminados.');
    } catch (error) {
      this.api.toast(error);
    }
  }
  openResult(job: Job) {
    const result = job.destination;
    if (result) {
      this.panel()?.navigate(result);
      this.jobsOpen.set(false);
    }
  }
  @HostListener('document:keydown', ['$event']) keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      this.context.set(null);
      if (this.picking()) this.picking.set(null);
      else if (this.dialog()) this.close();
      else this.jobsOpen.set(false);
    }
  }
}

function mkvName(name: string): string {
  const trimmed = name.trim();
  return trimmed && !/\.mkv$/i.test(trimmed) ? trimmed + '.mkv' : trimmed;
}
