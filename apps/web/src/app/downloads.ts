import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import type {
  Download,
  DownloadAccount,
  DownloadAccountProvider,
  DownloadAction,
  DownloadSettings,
  DownloadStatus,
  DownloadsPage,
  Location,
} from '@muxplorer/shared';
import { Api, bytes, displayLocation } from './api';
import { Explorer } from './explorer';
import { Icon } from './icon';

interface Submission {
  links: { id: string; url: string }[];
  accountId?: string;
  destination?: Location;
}

function requestId() {
  // The NAS also supports plain HTTP, where crypto.randomUUID is unavailable.
  const value = crypto.getRandomValues(new Uint8Array(16));
  value[6] = (value[6] & 15) | 64;
  value[8] = (value[8] & 63) | 128;
  const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

@Component({
  selector: 'mx-downloads',
  imports: [DatePipe, Explorer, FormsModule, Icon],
  templateUrl: './downloads.html',
  styleUrl: './downloads.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DownloadsView implements OnInit, OnDestroy {
  private readonly api = inject(Api);
  readonly reveal = output<Location>();
  readonly snapshot = signal<DownloadsPage | null>(null);
  readonly page = signal(0);
  readonly error = signal('');
  readonly settingsError = signal('');
  readonly settingsMessage = signal('');
  readonly settings = signal<DownloadSettings | null>(null);
  readonly showSettings = signal(false);
  readonly saving = signal(false);
  readonly picker = signal<'default' | 'batch' | null>(null);
  readonly override = signal<Location | undefined>(undefined);
  readonly destination = computed(() => this.override() ?? this.settings()?.destination);
  readonly accountDraft = signal<DownloadAccount | null>(null);
  readonly providers: Record<DownloadAccountProvider, string> = {
    '1fichier': '1fichier',
    mega: 'MEGA',
    'real-debrid': 'Real-Debrid',
  };
  readonly display = displayLocation;
  readonly loadingError = signal('');
  readonly statusMessage = computed(() => this.loadingError() || this.snapshot()?.engine.message);
  readonly adding = signal(false);
  readonly busy = signal<ReadonlySet<string>>(new Set());
  readonly pageSize = 30;
  readonly pages = computed(() =>
    Math.max(1, Math.ceil((this.snapshot()?.total ?? 0) / this.pageSize)),
  );
  readonly available = computed(
    () => this.snapshot()?.engine.status === 'connected' && !this.loadingError(),
  );
  readonly bytes = bytes;
  readonly states: Record<DownloadStatus, string> = {
    pending: 'Pendiente',
    running: 'Descargando',
    paused: 'En pausa',
    failed: 'Fallida',
    publishing: 'Publicando',
    'publication-failed': 'Publicación bloqueada',
    completed: 'Completada',
    cancelled: 'Cancelada',
    missing: 'Retirada de Gopeed',
  };
  readonly labels: Record<DownloadAction, string> = {
    pause: 'Pausar',
    resume: 'Reanudar',
    cancel: 'Cancelar',
    remove: 'Eliminar',
    publish: 'Reintentar publicación',
  };
  input = '';
  accountId = '';
  secret = '';
  filter = 'all';
  query = '';
  private submission?: { key: string; body: Submission };
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private destroyed = false;

  ngOnInit() {
    void this.refresh();
    void this.loadSettings();
  }

  ngOnDestroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.request?.abort();
  }

  async refresh() {
    if (this.destroyed) return;
    clearTimeout(this.timer);
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    try {
      const query = new URLSearchParams({
        page: String(this.page()),
        limit: String(this.pageSize),
        query: this.query.trim(),
        filter: this.filter,
      });
      const next = await this.api.request<DownloadsPage>(
        'downloads?' + query,
        undefined,
        request.signal,
      );
      if (request.signal.aborted) return;
      this.loadingError.set('');
      const old = this.snapshot();
      const previous = new Map(old?.tasks.map((task) => [task.id, task]));
      next.tasks = next.tasks.map((task) => {
        const before = previous.get(task.id);
        return before && JSON.stringify(before) === JSON.stringify(task) ? before : task;
      });
      this.snapshot.set(next);
      if (this.page() >= this.pages()) this.showPage(this.pages() - 1);
    } catch {
      if (!request.signal.aborted)
        this.loadingError.set('No se pudo actualizar la lista de descargas.');
    } finally {
      if (!request.signal.aborted)
        this.timer = setTimeout(() => void this.refresh(), this.available() ? 3000 : 6500);
    }
  }

  showPage(page: number) {
    this.page.set(page);
    void this.refresh();
  }

  async add() {
    if (this.adding()) return;
    const input = this.input.trim();
    if (!input) return;
    const urls = [...new Set(input.split(/\s+/))];
    if (urls.length > 20) {
      this.error.set('Añade un máximo de 20 enlaces por lote.');
      return;
    }
    const destination = this.destination();
    const accountId = this.accountId || undefined;
    const key = JSON.stringify([input, destination, accountId]);
    if (this.submission?.key !== key) {
      this.submission = {
        key,
        body: { links: urls.map((url) => ({ id: requestId(), url })), destination, accountId },
      };
    }
    this.adding.set(true);
    this.error.set('');
    try {
      await this.api.request('downloads', this.submission.body);
      this.submission = undefined;
      if (this.input.trim() === input) this.input = '';
      this.showPage(0);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'No se pudieron añadir los enlaces.');
    } finally {
      this.adding.set(false);
    }
  }

  loadSettings() {
    return this.changeSettings(async () => {
      this.settings.set(await this.api.request<DownloadSettings>('downloads/settings'));
    });
  }

  toggleSettings() {
    this.showSettings.update((open) => !open);
    this.picker.set(null);
    if (!this.showSettings()) this.editAccount(null);
    else if (!this.settings()) void this.loadSettings();
  }

  selectDestination(destination: Location) {
    if (this.picker() === 'batch') {
      this.override.set(destination);
      this.picker.set(null);
      return;
    }
    void this.changeSettings(async () => {
      this.settings.set(
        await this.api.request<DownloadSettings>('downloads/settings', { destination }),
      );
      this.picker.set(null);
      this.settingsMessage.set('Carpeta predeterminada guardada.');
    });
  }

  editAccount(account: DownloadAccount | null) {
    this.secret = '';
    this.accountDraft.set(account && { ...account });
    this.settingsError.set('');
    this.settingsMessage.set('');
  }

  async saveAccount(account: DownloadAccount) {
    if (!account.label.trim() || (!account.id && !this.secret)) return;
    await this.changeSettings(async () => {
      const accounts = await this.api.request<DownloadAccount[]>('downloads/accounts', {
        ...account,
        id: account.id || undefined,
        email: account.provider === 'mega' ? account.email?.trim() : undefined,
        secret: this.secret || undefined,
      });
      this.settings.update((current) => current && { ...current, accounts });
      this.editAccount(null);
      this.settingsMessage.set('Cuenta guardada.');
    });
  }

  async removeAccount(account: DownloadAccount) {
    if (!window.confirm('¿Eliminar la cuenta «' + account.label + '»?')) return;
    await this.changeSettings(async () => {
      const accounts = await this.api.request<DownloadAccount[]>('downloads/accounts/remove', {
        id: account.id,
      });
      this.settings.update((current) => current && { ...current, accounts });
      if (this.accountId === account.id) this.accountId = '';
      if (this.accountDraft()?.id === account.id) this.editAccount(null);
      this.settingsMessage.set('Cuenta eliminada.');
    });
  }

  private async changeSettings(update: () => Promise<void>) {
    if (this.saving()) return;
    this.saving.set(true);
    this.settingsError.set('');
    this.settingsMessage.set('');
    try {
      await update();
    } catch (error) {
      this.settingsError.set(
        error instanceof Error ? error.message : 'No se pudieron actualizar los ajustes.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  async command(task: Download, action: DownloadAction) {
    if (
      action === 'cancel' &&
      !window.confirm('¿Cancelar la descarga y eliminar sus archivos parciales?')
    )
      return;
    if (
      action === 'remove' &&
      !window.confirm('¿Retirar esta descarga del gestor? Se conservarán los archivos publicados.')
    )
      return;
    await this.run(task.id, async () => {
      await this.api.request('downloads/' + task.id + '/' + action, {});
      await this.refresh();
    });
  }

  async open(task: Download) {
    await this.run(task.id, async () => {
      const location = await this.api.request<Location>('downloads/' + task.id + '/location');
      if (!this.destroyed) this.reveal.emit(location);
    });
  }

  private async run(id: string, work: () => Promise<void>) {
    if (this.busy().has(id)) return;
    this.busy.update((previous) => new Set(previous).add(id));
    this.error.set('');
    try {
      await work();
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'La operación de descarga ha fallado.',
      );
    } finally {
      this.busy.update((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  }

  percent(task: Download) {
    if (task.status === 'completed' || task.status === 'publishing') return 100;
    return task.total ? Math.min(100, Math.floor((task.downloaded * 100) / task.total)) : null;
  }

  eta(task: Download) {
    if (!task.speed || task.downloaded >= task.total) return '';
    const seconds = Math.ceil((task.total - task.downloaded) / task.speed);
    return seconds < 60
      ? seconds + ' s'
      : seconds < 3600
        ? Math.ceil(seconds / 60) + ' min'
        : Math.floor(seconds / 3600) + ' h ' + (Math.floor(seconds / 60) % 60) + ' min';
  }
}
