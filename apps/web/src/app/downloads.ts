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
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import type {
  Download,
  DownloadAccount,
  DownloadAccountProvider,
  DownloadAccountStatus,
  DownloadAction,
  DownloadSettings,
  DownloadLinkCheck,
  DownloadLinkStatus,
  DownloadStatus,
  DownloadsPage,
  Location,
} from '@muxplorer/shared';
import { Api, bytes, displayLocation } from './api';
import { Explorer } from './explorer';
import { Icon } from './icon';

interface Submission {
  links: { id: string; url: string; name?: string; expectedParts?: number }[];
  destination?: Location;
}

interface CapturedLink {
  id: string;
  url: string;
  check?: DownloadLinkCheck;
  selected: boolean;
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
  imports: [DatePipe, Explorer, FormsModule, Icon, NgTemplateOutlet],
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
    '1fichier': '1fichier · Clave API',
    '1fichier-web': '1fichier · Inicio de sesión web',
    mega: 'MEGA',
    'real-debrid': 'Real-Debrid',
    terabox: 'TeraBox',
    nitroflare: 'Nitroflare',
    rapidgator: 'Rapidgator',
    katfile: 'KatFile',
  };
  readonly providerOptions = Object.entries(this.providers);
  readonly accountStates: Record<DownloadAccountStatus, string> = {
    unchecked: 'Sin comprobar',
    connected: 'Conectada',
    invalid: 'Credenciales rechazadas',
    unavailable: 'Proveedor sin confirmar',
    captcha: 'CAPTCHA requerido',
    'two-factor': 'Requiere verificación en dos pasos',
    restricted: 'El proveedor denegó el acceso a la API',
    'rate-limited': 'Demasiadas comprobaciones. Espera antes de volver a comprobar.',
  };
  readonly linkStates: Record<DownloadLinkStatus, string> = {
    online: 'En línea',
    offline: 'Fuera de línea',
    captcha: 'CAPTCHA requerido',
    'account-required': 'Requiere cuenta',
    unknown: 'Sin confirmar',
  };
  readonly display = displayLocation;
  readonly loadingError = signal('');
  readonly statusMessage = computed(() => this.loadingError() || this.snapshot()?.engine.message);
  readonly adding = signal(false);
  readonly checking = signal(false);
  readonly captured = signal<CapturedLink[]>([]);
  readonly selectionCount = computed(() => this.captured().filter((item) => item.selected).length);
  readonly onlineCount = computed(
    () => this.captured().filter((item) => item.check?.status === 'online').length,
  );
  readonly checkedCount = computed(() => this.captured().filter((item) => item.check).length);
  readonly captureGroups = computed(() => {
    const groups = new Map<
      string,
      { id: string; name?: string; links: CapturedLink[]; expected: number; missing: number }
    >();
    for (const link of this.captured()) {
      const part = link.check?.multipart;
      const id = part?.key ?? link.id;
      let group = groups.get(id);
      if (!group) {
        group = { id, name: part?.name, links: [], expected: 0, missing: 0 };
        groups.set(id, group);
      }
      group.links.push(link);
      if (part) group.expected = Math.max(group.expected, part.part);
    }
    for (const group of groups.values()) {
      if (!group.expected) continue;
      group.links.sort((a, b) => a.check!.multipart!.part - b.check!.multipart!.part);
      group.missing =
        group.expected -
        new Set(
          group.links
            .filter((link) => link.check?.status === 'online')
            .map((link) => link.check!.multipart!.part),
        ).size;
    }
    return [...groups.values()];
  });
  readonly downloadGroups = computed(() => this.snapshot()?.groups ?? []);
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
  secret = '';
  filter = 'all';
  query = '';
  private captureRequest?: AbortController;
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
    this.captureRequest?.abort();
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

  capture() {
    const urls = new Set(this.input.trim().split(/\s+/).filter(Boolean));
    for (const item of this.captured()) urls.delete(item.url);
    const links = [...urls].map((url) => ({ id: requestId(), url, selected: false }));
    this.input = '';
    this.captured.update((current) => [...current, ...links]);
    return this.checkLinks(links);
  }

  recheck() {
    return this.checkLinks(this.captured().filter((item) => item.check?.status !== 'online'));
  }

  private async checkLinks(items: CapturedLink[]) {
    if (this.checking() || !items.length) return;
    const request = new AbortController();
    this.captureRequest = request;
    this.checking.set(true);
    this.error.set('');
    try {
      for (let offset = 0; offset < items.length && !request.signal.aborted; offset += 6) {
        const results = new Map(
          await Promise.all(
            items.slice(offset, offset + 6).map(async (item) => {
              const check = await this.api
                .request<DownloadLinkCheck>('downloads/check', { url: item.url }, request.signal)
                .catch((error: unknown): DownloadLinkCheck => ({
                  status: 'unknown',
                  message:
                    error instanceof Error ? error.message : 'No se pudo comprobar el enlace.',
                }));
              return [item.id, { ...item, check, selected: check.status === 'online' }] as const;
            }),
          ),
        );
        if (!request.signal.aborted)
          this.captured.update((current) => current.map((item) => results.get(item.id) ?? item));
      }
    } finally {
      this.checking.set(false);
    }
  }

  selectLink(id: string, selected: boolean) {
    this.captured.update((items) =>
      items.map((item) =>
        item.id === id && item.check?.status === 'online' ? { ...item, selected } : item,
      ),
    );
  }

  selectOnline(selected: boolean) {
    this.captured.update((items) =>
      items.map((item) => (item.check?.status === 'online' ? { ...item, selected } : item)),
    );
  }

  removeCaptured(id: string) {
    this.captured.update((items) => items.filter((item) => item.id !== id));
  }

  async add() {
    if (this.adding() || this.checking()) return;
    const links: Submission['links'] = [];
    let incomplete = 0;
    for (const group of this.captureGroups()) {
      const selected = group.links.filter(
        (item) => item.selected && item.check?.status === 'online',
      );
      if (!selected.length) continue;
      const parts = new Set(selected.map((item) => item.check?.multipart?.part));
      if (group.expected > parts.size) incomplete++;
      for (const item of selected)
        links.push({
          id: item.id,
          url: item.url,
          name: item.check?.name,
          expectedParts: group.expected || undefined,
        });
    }
    if (
      !links.length ||
      (incomplete &&
        !window.confirm(
          'Hay paquetes incompletos en la selección. ¿Añadir las partes disponibles?',
        ))
    )
      return;
    this.adding.set(true);
    this.error.set('');
    const destination = this.destination();
    try {
      for (let offset = 0; offset < links.length && !this.destroyed; offset += 8) {
        const batch = links.slice(offset, offset + 8);
        await this.api.request('downloads', { links: batch, destination } satisfies Submission);
        const submitted = new Set(batch.map((item) => item.id));
        this.captured.update((items) => items.filter((item) => !submitted.has(item.id)));
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'No se pudieron añadir los enlaces.');
    } finally {
      this.adding.set(false);
      if (!this.destroyed) this.showPage(0);
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
        label: account.label,
        provider: account.provider,
        id: account.id || undefined,
        email: this.usesEmail(account.provider) ? account.email?.trim() : undefined,
        secret: this.secret || undefined,
      });
      this.settings.update((current) => current && { ...current, accounts });
      this.editAccount(null);
      if (!account.id) this.settingsMessage.set('Cuenta guardada. Revisa su estado de conexión.');
    });
  }

  async removeAccount(account: DownloadAccount) {
    if (!window.confirm('¿Eliminar la cuenta «' + account.label + '»?')) return;
    await this.changeSettings(async () => {
      const accounts = await this.api.request<DownloadAccount[]>('downloads/accounts/remove', {
        id: account.id,
      });
      this.settings.update((current) => current && { ...current, accounts });
      if (this.accountDraft()?.id === account.id) this.editAccount(null);
      this.settingsMessage.set('Cuenta eliminada.');
    });
  }

  checkAccount(account: DownloadAccount) {
    return this.changeSettings(async () => {
      const accounts = await this.api.request<DownloadAccount[]>('downloads/accounts/check', {
        id: account.id,
      });
      this.settings.update((current) => current && { ...current, accounts });
    });
  }

  usesEmail(provider: DownloadAccountProvider) {
    return ['mega', 'rapidgator', 'nitroflare', '1fichier-web'].includes(provider);
  }

  secretLabel(provider: DownloadAccountProvider) {
    if (provider === 'mega' || provider === 'rapidgator' || provider === '1fichier-web')
      return 'Contraseña';
    if (provider === 'nitroflare') return 'Clave prémium';
    if (provider === 'terabox') return 'Token de acceso de Open Platform';
    return 'Clave API';
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

  groupProgress(tasks: Download[]) {
    const total = tasks.reduce((sum, task) => sum + task.total, 0);
    if (total && tasks.every((task) => task.total || task.status === 'completed')) {
      const downloaded = tasks.reduce(
        (sum, task) => sum + Math.min(task.downloaded, task.total),
        0,
      );
      return Math.floor((100 * downloaded) / total);
    }
    return null;
  }

  linkState(status: DownloadLinkStatus | undefined) {
    return status ? this.linkStates[status] : 'Pendiente de comprobar';
  }

  downloadState(status: DownloadStatus) {
    return this.states[status];
  }

  actionLabel(action: DownloadAction) {
    return this.labels[action];
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
