import { A11yModule } from '@angular/cdk/a11y';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type {
  Download,
  DownloadAccount,
  DownloadAccountProvider,
  DownloadAccountStatus,
  DownloadAction,
  DownloadBulkResult,
  DownloadGroup,
  DownloadLinkCheck,
  DownloadLinkStatus,
  DownloadSettings,
  DownloadStatus,
  DownloadsPage,
  Location,
} from '@muxplorer/shared';
import { Api, bytes, displayLocation } from './api';
import { Explorer } from './explorer';
import { Icon, type IconName } from './icon';

interface Submission {
  links: { id: string; url: string; name?: string; expectedParts?: number }[];
  destination?: Location;
  accountId?: string;
}

interface CapturedLink {
  id: string;
  url: string;
  host: string;
  check?: DownloadLinkCheck;
  selected: boolean;
}

interface CaptureGroup {
  id: string;
  name?: string;
  host: string;
  links: CapturedLink[];
  expected: number;
  missing: number;
  online: number;
  selected: number;
  total: number;
}

type DownloadsTab = 'queue' | 'capture' | 'settings';
type QueueFilter = 'all' | 'active' | 'paused' | 'issues' | 'completed' | 'cancelled';
type CaptureFilter = 'all' | 'online' | 'issues';

interface ConfirmState {
  title: string;
  eyebrow: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  danger: boolean;
  onConfirm: () => Promise<void> | void;
}

const PROVIDER_META: Record<
  DownloadAccountProvider,
  { name: string; short: string; usesEmail: boolean; secretLabel: string; hint: string }
> = {
  '1fichier': {
    name: '1fichier · Clave API',
    short: '1F',
    usesEmail: false,
    secretLabel: 'Clave API',
    hint: 'Recomendado para cuentas prémium de 1fichier. Genera la clave API en tu panel de 1fichier; puedes usar el correo como nombre para identificarla.',
  },
  '1fichier-web': {
    name: '1fichier · Inicio de sesión web',
    short: '1F',
    usesEmail: true,
    secretLabel: 'Contraseña',
    hint: 'Inicia sesión mediante la web de 1fichier usando correo y contraseña. Útil si tu cuenta no tiene acceso a la clave API (no compatible con 2FA).',
  },
  mega: {
    name: 'MEGA',
    short: 'MG',
    usesEmail: true,
    secretLabel: 'Contraseña',
    hint: 'Cuenta de MEGA para mejorar cuota y estabilidad al descargar enlaces públicos con clave de descifrado.',
  },
  'real-debrid': {
    name: 'Real-Debrid',
    short: 'RD',
    usesEmail: false,
    secretLabel: 'Clave API',
    hint: 'Desbloquea automáticamente enlaces de decenas de alojamientos compatibles usando tu token privado de Real-Debrid.',
  },
  terabox: {
    name: 'TeraBox',
    short: 'TB',
    usesEmail: false,
    secretLabel: 'Token de acceso de Open Platform',
    hint: 'Introduce el token de acceso de TeraBox Open Platform para resolver enlaces compartidos de archivo único.',
  },
  nitroflare: {
    name: 'Nitroflare',
    short: 'NF',
    usesEmail: true,
    secretLabel: 'Clave prémium',
    hint: 'Usa el correo de tu cuenta de Nitroflare junto con tu clave prémium.',
  },
  rapidgator: {
    name: 'Rapidgator',
    short: 'RG',
    usesEmail: true,
    secretLabel: 'Contraseña',
    hint: 'Usa el correo y la contraseña de tu cuenta prémium de Rapidgator.',
  },
  katfile: {
    name: 'KatFile',
    short: 'KF',
    usesEmail: false,
    secretLabel: 'Clave API',
    hint: 'Introduce tu clave API de KatFile para generar enlaces directos.',
  },
};

const QUEUE_FILTERS: { id: QueueFilter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'active', label: 'En curso' },
  { id: 'paused', label: 'En pausa' },
  { id: 'issues', label: 'Con errores' },
  { id: 'completed', label: 'Completadas' },
  { id: 'cancelled', label: 'Canceladas' },
];

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

function cleanTrailingPunctuation(raw: string): string {
  let result = raw.trim();
  while (result.length) {
    const last = result.at(-1)!;
    if (/[.,;'"<>]/.test(last)) {
      result = result.slice(0, -1);
      continue;
    }
    if (last === ')' && (result.match(/\(/g)?.length ?? 0) < (result.match(/\)/g)?.length ?? 0)) {
      result = result.slice(0, -1);
      continue;
    }
    if (last === ']' && (result.match(/\[/g)?.length ?? 0) < (result.match(/\]/g)?.length ?? 0)) {
      result = result.slice(0, -1);
      continue;
    }
    break;
  }
  return result;
}

function extractUrls(text: string): string[] {
  const matches = text.match(/(?:https?:\/\/[^\s<>"'`]+|magnet:\?[^\s<>"'`]+)/gi) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of matches) {
    const cleaned = cleanTrailingPunctuation(raw);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return urls;
}

function detectHost(url: string): string {
  if (/^magnet:\?/i.test(url)) return 'Magnet';
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (host === '1fichier.com' || host.endsWith('.1fichier.com')) return '1fichier';
    if (host === 'mega.nz' || host === 'mega.co.nz') return 'MEGA';
    if (host === 'rapidgator.net' || host === 'rapidgator.asia' || host === 'rg.to')
      return 'Rapidgator';
    if (host === 'nitroflare.com' || host === 'nitroflare.net' || host === 'nitro.download')
      return 'Nitroflare';
    if (host === 'katfile.com') return 'KatFile';
    if (
      host === 'terabox.com' ||
      host === 'terabox.app' ||
      host === 'teraboxlink.com' ||
      host === '1024terabox.com' ||
      host === '1024tera.com'
    )
      return 'TeraBox';
    return host;
  } catch {
    return 'Enlace';
  }
}

@Component({
  selector: 'mx-downloads',
  imports: [A11yModule, DatePipe, Explorer, FormsModule, Icon, NgTemplateOutlet],
  templateUrl: './downloads.html',
  styleUrl: './downloads.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DownloadsView implements OnInit, OnDestroy {
  readonly api = inject(Api);
  readonly reveal = output<Location>();

  // Navigation & View State
  readonly tab = signal<DownloadsTab>('queue');
  readonly snapshot = signal<DownloadsPage | null>(null);
  readonly page = signal(0);
  readonly filter = signal<QueueFilter>('all');
  readonly query = signal('');
  readonly captureFilter = signal<CaptureFilter>('all');
  readonly expandedPackages = signal<ReadonlySet<string>>(new Set());

  // Feedback & Errors
  readonly error = signal('');
  readonly loadingError = signal('');
  readonly captureNotice = signal('');
  readonly settingsError = signal('');
  readonly settingsMessage = signal('');

  // Settings & Accounts
  readonly settings = signal<DownloadSettings | null>(null);
  readonly saving = signal(false);
  readonly checkingAccounts = signal<ReadonlySet<string>>(new Set());
  readonly picker = signal<'default' | 'batch' | null>(null);
  readonly override = signal<Location | undefined>(undefined);
  readonly batchAccountId = signal<string>('');
  readonly accountDraft = signal<DownloadAccount | null>(null);
  readonly accountOriginalEmail = signal<string | undefined>(undefined);
  readonly showSecret = signal(false);

  // Confirm Dialog
  readonly confirmDialog = signal<ConfirmState | null>(null);
  readonly confirmBusy = signal(false);

  // Link Capture & Input
  readonly inputText = signal('');
  readonly dragActive = signal(false);
  readonly adding = signal(false);
  readonly checking = signal(false);
  readonly captured = signal<CapturedLink[]>([]);

  // Busy Flags
  readonly busy = signal<ReadonlySet<string>>(new Set());
  readonly bulkBusy = signal(false);

  readonly providerMeta = PROVIDER_META;
  readonly providerOptions = (Object.keys(PROVIDER_META) as DownloadAccountProvider[]).map(
    (key) => [key, PROVIDER_META[key].name] as const,
  );
  readonly queueFilters = QUEUE_FILTERS;

  readonly accountStates: Record<DownloadAccountStatus, string> = {
    unchecked: 'Sin comprobar',
    connected: 'Conectada',
    invalid: 'Credenciales rechazadas',
    unavailable: 'Proveedor sin confirmar',
    captcha: 'CAPTCHA requerido',
    'two-factor': 'Requiere verificación en dos pasos',
    restricted: 'El proveedor denegó el acceso a la API',
    'rate-limited': 'Límite de comprobaciones alcanzado',
  };

  readonly linkStates: Record<DownloadLinkStatus, string> = {
    online: 'En línea',
    offline: 'Fuera de línea',
    captcha: 'CAPTCHA requerido',
    'account-required': 'Requiere cuenta',
    unknown: 'Sin confirmar',
  };

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

  readonly display = displayLocation;
  readonly bytes = bytes;
  readonly pageSize = 30;
  secret = '';

  // Derived Signals
  readonly destination = computed(() => this.override() ?? this.settings()?.destination);

  readonly defaultRootFree = computed(() => {
    const dest = this.settings()?.destination;
    if (!dest) return null;
    const root = this.api.roots().find((item) => item.id === dest.root);
    return root?.available ? (root.free ?? null) : null;
  });

  readonly statusMessage = computed(() => this.loadingError() || this.snapshot()?.engine.message);

  readonly available = computed(
    () => this.snapshot()?.engine.status === 'connected' && !this.loadingError(),
  );

  readonly hasAccountIssues = computed(() =>
    (this.settings()?.accounts ?? []).some(
      (account) =>
        account.status &&
        ['invalid', 'captcha', 'restricted', 'two-factor', 'rate-limited'].includes(account.status),
    ),
  );

  readonly detectedInputCount = computed(() => extractUrls(this.inputText()).length);

  readonly selectionCount = computed(() => this.captured().filter((item) => item.selected).length);

  readonly selectedBytes = computed(() =>
    this.captured().reduce(
      (sum, item) => sum + (item.selected && item.check?.total ? item.check.total : 0),
      0,
    ),
  );

  readonly onlineCount = computed(
    () => this.captured().filter((item) => item.check?.status === 'online').length,
  );

  readonly issueCaptureCount = computed(
    () => this.captured().filter((item) => item.check && item.check.status !== 'online').length,
  );

  readonly checkedCount = computed(() => this.captured().filter((item) => item.check).length);

  readonly captureProgress = computed(() => {
    const total = this.captured().length;
    return total ? Math.round((this.checkedCount() * 100) / total) : 0;
  });

  readonly captureGroups = computed<CaptureGroup[]>(() => {
    const groups = new Map<string, CaptureGroup>();
    for (const link of this.captured()) {
      const part = link.check?.multipart;
      const id = part?.key ?? link.id;
      let group = groups.get(id);
      if (!group) {
        group = {
          id,
          name: part?.name,
          host: link.host,
          links: [],
          expected: 0,
          missing: 0,
          online: 0,
          selected: 0,
          total: 0,
        };
        groups.set(id, group);
      }
      group.links.push(link);
      if (part) group.expected = Math.max(group.expected, part.part);
      if (link.check?.status === 'online') group.online++;
      if (link.selected) group.selected++;
      if (link.check?.total) group.total += link.check.total;
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

  readonly filteredCaptureGroups = computed(() => {
    const activeFilter = this.captureFilter();
    if (activeFilter === 'all') return this.captureGroups();
    return this.captureGroups().filter((group) =>
      activeFilter === 'online'
        ? group.online > 0
        : group.links.some((link) => link.check && link.check.status !== 'online'),
    );
  });

  readonly downloadGroups = computed(() => this.snapshot()?.groups ?? []);

  readonly counts = computed(() => {
    const c = this.snapshot()?.counts;
    if (c) return c;
    const total = this.snapshot()?.total ?? 0;
    return {
      all: total,
      active: this.snapshot()?.active ?? 0,
      paused: 0,
      issues: 0,
      completed: 0,
      cancelled: 0,
      pausable: 0,
      resumable: 0,
      clearable: 0,
    };
  });

  readonly pages = computed(() =>
    Math.max(1, Math.ceil((this.snapshot()?.total ?? 0) / this.pageSize)),
  );

  readonly accountSecretRequired = computed(() => {
    const draft = this.accountDraft();
    if (!draft) return false;
    if (!draft.id) return true;
    return (
      this.usesEmail(draft.provider) &&
      (draft.email?.trim() ?? '') !== (this.accountOriginalEmail() ?? '')
    );
  });

  private captureRequest?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private destroyed = false;

  ngOnInit() {
    void this.refresh();
    void this.loadSettings();
  }

  ngOnDestroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    clearTimeout(this.searchTimer);
    this.request?.abort();
    this.captureRequest?.abort();
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: Event) {
    if (this.confirmDialog()) {
      if (!this.confirmBusy()) this.confirmDialog.set(null);
      event.stopPropagation();
      return;
    }
    if (this.picker()) {
      if (!this.saving()) this.picker.set(null);
      event.stopPropagation();
      return;
    }
    if (this.accountDraft()) {
      if (!this.saving()) this.editAccount(null);
      event.stopPropagation();
    }
  }

  openTab(next: DownloadsTab) {
    this.tab.set(next);
    if (next === 'settings' && !this.settings()) void this.loadSettings();
    if (next === 'queue') void this.refresh();
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
        query: this.query().trim(),
        filter: this.filter(),
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

  setFilter(next: QueueFilter) {
    this.filter.set(next);
    this.showPage(0);
  }

  onSearchInput(value: string) {
    this.query.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      if (!this.destroyed) this.showPage(0);
    }, 200);
  }

  clearSearch() {
    clearTimeout(this.searchTimer);
    this.query.set('');
    this.showPage(0);
  }

  resetQueueFilters() {
    clearTimeout(this.searchTimer);
    this.query.set('');
    this.filter.set('all');
    this.showPage(0);
  }

  // --- Link Capture ---

  async pasteClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        this.captureNotice.set('El portapapeles está vacío.');
        return;
      }
      const current = this.inputText().trim();
      this.inputText.set(current ? `${current}\n${text}` : text);
      this.captureNotice.set('');
    } catch {
      this.captureNotice.set('Usa Ctrl+V para pegar directamente en el cuadro de enlaces.');
    }
  }

  onImportFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void this.readTextFile(file);
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    this.dragActive.set(true);
  }

  onDragLeave() {
    this.dragActive.set(false);
  }

  onDropFile(event: DragEvent) {
    event.preventDefault();
    this.dragActive.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      void this.readTextFile(file);
      return;
    }
    const text = event.dataTransfer?.getData('text/plain');
    if (text?.trim()) {
      const current = this.inputText().trim();
      this.inputText.set(current ? `${current}\n${text}` : text);
    }
  }

  private async readTextFile(file: File) {
    if (file.size > 1_500_000) {
      this.captureNotice.set('El archivo supera el límite de 1,5 MB.');
      return;
    }
    const text = await file.text();
    const extracted = extractUrls(text);
    if (!extracted.length) {
      this.captureNotice.set(`No se encontraron enlaces válidos en «${file.name}».`);
      return;
    }
    const current = this.inputText().trim();
    this.inputText.set(current ? `${current}\n${extracted.join('\n')}` : extracted.join('\n'));
    this.captureNotice.set(`Importados ${extracted.length} enlaces desde «${file.name}».`);
  }

  capture() {
    const raw = this.inputText().trim();
    if (!raw) return;
    const extracted = extractUrls(raw);
    const candidates = extracted.length ? extracted : raw.split(/\s+/).filter(Boolean);
    const existing = new Set(this.captured().map((item) => item.url));
    const unique: string[] = [];
    let skippedDuplicates = 0;
    for (const url of new Set(candidates)) {
      if (existing.has(url)) skippedDuplicates++;
      else unique.push(url);
    }
    if (!unique.length) {
      this.captureNotice.set(
        skippedDuplicates
          ? 'Todos esos enlaces ya estaban en la lista de captura.'
          : 'No se detectó ningún enlace válido.',
      );
      return;
    }
    const links: CapturedLink[] = unique.map((url) => ({
      id: requestId(),
      url,
      host: detectHost(url),
      selected: false,
    }));
    this.inputText.set('');
    this.captureFilter.set('all');
    this.captureNotice.set(
      skippedDuplicates
        ? `${links.length} enlaces añadidos (${skippedDuplicates} duplicados omitidos).`
        : '',
    );
    this.captured.update((current) => [...current, ...links]);
    return this.checkLinks(links);
  }

  cancelCheck() {
    this.captureRequest?.abort();
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
    const accountId = this.batchAccountId() || undefined;
    try {
      for (let offset = 0; offset < items.length && !request.signal.aborted; offset += 6) {
        const results = new Map(
          await Promise.all(
            items.slice(offset, offset + 6).map(async (item) => {
              const check = await this.api
                .request<DownloadLinkCheck>(
                  'downloads/check',
                  accountId ? { url: item.url, accountId } : { url: item.url },
                  request.signal,
                )
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
      if (this.captureRequest === request) this.captureRequest = undefined;
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

  selectGroup(group: CaptureGroup, selected: boolean) {
    const ids = new Set(group.links.map((item) => item.id));
    this.captured.update((items) =>
      items.map((item) =>
        ids.has(item.id) && item.check?.status === 'online' ? { ...item, selected } : item,
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

  removeUnavailableCaptured() {
    this.captured.update((items) =>
      items.filter((item) => !item.check || item.check.status === 'online'),
    );
    if (this.captureFilter() === 'issues') this.captureFilter.set('all');
  }

  clearCaptured() {
    this.captureRequest?.abort();
    this.captured.set([]);
    this.captureFilter.set('all');
    this.captureNotice.set('');
  }

  add() {
    if (this.adding() || this.checking()) return;
    const links: Submission['links'] = [];
    const incompleteNames: string[] = [];
    for (const group of this.captureGroups()) {
      const selected = group.links.filter(
        (item) => item.selected && item.check?.status === 'online',
      );
      if (!selected.length) continue;
      const parts = new Set(selected.map((item) => item.check?.multipart?.part));
      if (group.expected > parts.size) incompleteNames.push(group.name ?? 'Paquete multiparte');
      for (const item of selected)
        links.push({
          id: item.id,
          url: item.url,
          name: item.check?.name,
          expectedParts: group.expected || undefined,
        });
    }
    if (!links.length) return;
    if (incompleteNames.length) {
      this.confirmDialog.set({
        eyebrow: 'PAQUETE INCOMPLETO',
        title: 'Faltan partes en la selección',
        message: 'Hay paquetes incompletos en la selección. ¿Añadir las partes disponibles?',
        detail: incompleteNames.join(', '),
        confirmLabel: 'Añadir partes disponibles',
        danger: false,
        onConfirm: () => this.submitLinks(links),
      });
      return;
    }
    void this.submitLinks(links);
  }

  private async submitLinks(links: Submission['links']) {
    this.adding.set(true);
    this.error.set('');
    const destination = this.destination();
    const accountId = this.batchAccountId() || undefined;
    let added = 0;
    try {
      for (let offset = 0; offset < links.length && !this.destroyed; offset += 8) {
        const batch = links.slice(offset, offset + 8);
        await this.api.request('downloads', {
          links: batch,
          destination,
          ...(accountId ? { accountId } : {}),
        } satisfies Submission);
        added += batch.length;
        const submitted = new Set(batch.map((item) => item.id));
        this.captured.update((items) => items.filter((item) => !submitted.has(item.id)));
      }
      if (!this.destroyed) {
        this.api.toast(
          added === 1 ? 'Descarga añadida a la cola.' : `${added} descargas añadidas a la cola.`,
        );
        this.tab.set('queue');
        this.filter.set('all');
        this.showPage(0);
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'No se pudieron añadir los enlaces.');
    } finally {
      this.adding.set(false);
    }
  }

  // --- Settings & Accounts ---

  loadSettings() {
    return this.changeSettings(async () => {
      const next = await this.api.request<DownloadSettings>('downloads/settings');
      this.settings.set(next);
      if (this.batchAccountId() && !next.accounts.some((a) => a.id === this.batchAccountId()))
        this.batchAccountId.set('');
    });
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
      this.api.toast('Carpeta predeterminada guardada.');
    });
  }

  editAccount(account: DownloadAccount | null) {
    this.secret = '';
    this.showSecret.set(false);
    this.accountOriginalEmail.set(account?.id ? account.email : undefined);
    this.accountDraft.set(account && { ...account });
    this.settingsError.set('');
    this.settingsMessage.set('');
  }

  async saveAccount(account: DownloadAccount) {
    if (!account.label.trim() || (this.accountSecretRequired() && !this.secret)) return;
    await this.changeSettings(async () => {
      const accounts = await this.api.request<DownloadAccount[]>('downloads/accounts', {
        label: account.label.trim(),
        provider: account.provider,
        id: account.id || undefined,
        email: this.usesEmail(account.provider) ? account.email?.trim() : undefined,
        secret: this.secret || undefined,
      });
      this.settings.update((current) => current && { ...current, accounts });
      const wasNew = !account.id;
      this.editAccount(null);
      const message = wasNew ? 'Cuenta guardada y comprobada.' : 'Cambios de la cuenta guardados.';
      this.settingsMessage.set(message);
      this.api.toast(message);
    });
  }

  removeAccount(account: DownloadAccount) {
    this.confirmDialog.set({
      eyebrow: 'ELIMINAR CUENTA',
      title: '¿Eliminar esta cuenta?',
      message: `Se eliminará la cuenta «${account.label}» y sus credenciales cifradas del servidor.`,
      confirmLabel: 'Eliminar cuenta',
      danger: true,
      onConfirm: async () => {
        await this.changeSettings(async () => {
          const accounts = await this.api.request<DownloadAccount[]>('downloads/accounts/remove', {
            id: account.id,
          });
          this.settings.update((current) => current && { ...current, accounts });
          if (this.accountDraft()?.id === account.id) this.editAccount(null);
          if (this.batchAccountId() === account.id) this.batchAccountId.set('');
          this.settingsMessage.set('Cuenta eliminada.');
          this.api.toast('Cuenta eliminada.');
        });
      },
    });
  }

  async checkAccount(account: DownloadAccount) {
    if (this.checkingAccounts().has(account.id)) return;
    this.checkingAccounts.update((set) => new Set(set).add(account.id));
    this.settingsError.set('');
    this.settingsMessage.set('');
    try {
      const accounts = await this.api.request<DownloadAccount[]>('downloads/accounts/check', {
        id: account.id,
      });
      this.settings.update((current) => current && { ...current, accounts });
    } catch (error) {
      this.settingsError.set(
        error instanceof Error ? error.message : 'No se pudo comprobar la cuenta.',
      );
    } finally {
      this.checkingAccounts.update((set) => {
        const next = new Set(set);
        next.delete(account.id);
        return next;
      });
    }
  }

  async checkAllAccounts() {
    const list = this.settings()?.accounts ?? [];
    for (const account of list) {
      if (this.destroyed) break;
      await this.checkAccount(account);
    }
    if (!this.destroyed && list.length) this.api.toast('Estado de las cuentas actualizado.');
  }

  usesEmail(provider: DownloadAccountProvider) {
    return PROVIDER_META[provider].usesEmail;
  }

  secretLabel(provider: DownloadAccountProvider) {
    return PROVIDER_META[provider].secretLabel;
  }

  providerHint(provider: DownloadAccountProvider) {
    return PROVIDER_META[provider].hint;
  }

  providerName(provider: DownloadAccountProvider) {
    return PROVIDER_META[provider].name;
  }

  providerShort(provider: DownloadAccountProvider) {
    return PROVIDER_META[provider].short;
  }

  accountStatusTone(status?: DownloadAccountStatus): 'ok' | 'warn' | 'err' | 'muted' {
    if (status === 'connected') return 'ok';
    if (status === 'invalid' || status === 'restricted') return 'err';
    if (
      status === 'captcha' ||
      status === 'two-factor' ||
      status === 'rate-limited' ||
      status === 'unavailable'
    )
      return 'warn';
    return 'muted';
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

  // --- Queue & Package Commands ---

  command(task: Download, action: DownloadAction) {
    if (action === 'cancel') {
      this.confirmDialog.set({
        eyebrow: 'CANCELAR DESCARGA',
        title: '¿Cancelar esta descarga?',
        message: 'Se detendrá la descarga y se eliminarán sus archivos parciales temporales.',
        detail: task.name,
        confirmLabel: 'Cancelar descarga',
        danger: true,
        onConfirm: () => this.executeCommand(task.id, action),
      });
      return;
    }
    if (action === 'remove') {
      this.confirmDialog.set({
        eyebrow: 'RETIRAR DEL HISTORIAL',
        title: '¿Retirar esta descarga del gestor?',
        message: 'Se conservarán los archivos ya publicados en tu almacenamiento.',
        detail: task.name,
        confirmLabel: 'Retirar',
        danger: false,
        onConfirm: () => this.executeCommand(task.id, action),
      });
      return;
    }
    void this.executeCommand(task.id, action);
  }

  private executeCommand(id: string, action: DownloadAction) {
    return this.run(id, async () => {
      await this.api.request('downloads/' + id + '/' + action, {});
      await this.refresh();
    });
  }

  bulkAll(action: 'pause' | 'resume' | 'clear-finished') {
    if (this.bulkBusy()) return;
    if (action === 'clear-finished') {
      const count = this.counts().clearable;
      this.confirmDialog.set({
        eyebrow: 'LIMPIAR HISTORIAL',
        title: '¿Limpiar descargas finalizadas?',
        message: `Se retirarán ${count} entradas completadas o canceladas de la lista. Los archivos publicados en tu disco no se eliminan.`,
        confirmLabel: 'Limpiar finalizadas',
        danger: false,
        onConfirm: () => this.executeBulk({ scope: 'all', action }),
      });
      return;
    }
    void this.executeBulk({ scope: 'all', action });
  }

  groupAction(group: DownloadGroup, action: DownloadAction) {
    if (this.bulkBusy()) return;
    const ids = group.tasks.filter((task) => task.actions.includes(action)).map((task) => task.id);
    if (!ids.length) return;
    if (action === 'cancel') {
      this.confirmDialog.set({
        eyebrow: 'CANCELAR PAQUETE',
        title: `¿Cancelar ${ids.length} partes de «${group.name}»?`,
        message:
          'Se detendrán las partes activas o pausadas y se eliminarán sus archivos parciales.',
        confirmLabel: 'Cancelar paquete',
        danger: true,
        onConfirm: () => this.executeBulk({ scope: 'ids', ids, action }),
      });
      return;
    }
    if (action === 'remove') {
      this.confirmDialog.set({
        eyebrow: 'RETIRAR PAQUETE',
        title: `¿Retirar ${ids.length} partes de «${group.name}»?`,
        message: 'Se conservarán todos los archivos ya publicados en tu carpeta de destino.',
        confirmLabel: 'Retirar paquete',
        danger: false,
        onConfirm: () => this.executeBulk({ scope: 'ids', ids, action }),
      });
      return;
    }
    void this.executeBulk({ scope: 'ids', ids, action });
  }

  private async executeBulk(
    payload:
      | { scope: 'all'; action: 'pause' | 'resume' | 'clear-finished' }
      | { scope: 'ids'; ids: string[]; action: DownloadAction },
  ) {
    if (this.bulkBusy()) return;
    this.bulkBusy.set(true);
    this.error.set('');
    try {
      const result = await this.api.request<DownloadBulkResult>('downloads/bulk', payload);
      await this.refresh();
      if (result.failed) {
        this.api.toast(
          new Error(
            `Completadas ${result.ok}, con fallo en ${result.failed}. Revisa el estado del motor.`,
          ),
        );
      } else if (result.ok) {
        const message =
          payload.action === 'pause'
            ? `Pausadas ${result.ok} descargas.`
            : payload.action === 'resume'
              ? `Reanudadas ${result.ok} descargas.`
              : payload.action === 'clear-finished' || payload.action === 'remove'
                ? `Retiradas ${result.ok} entradas de la lista.`
                : payload.action === 'cancel'
                  ? `Canceladas ${result.ok} descargas.`
                  : `Publicación reintentada en ${result.ok} descargas.`;
        this.api.toast(message);
      }
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'No se pudo completar la acción en lote.',
      );
    } finally {
      this.bulkBusy.set(false);
    }
  }

  async runConfirm() {
    const dialog = this.confirmDialog();
    if (!dialog || this.confirmBusy()) return;
    this.confirmBusy.set(true);
    try {
      await dialog.onConfirm();
      this.confirmDialog.set(null);
    } finally {
      this.confirmBusy.set(false);
    }
  }

  async open(task: Download) {
    await this.run(task.id, async () => {
      const location = await this.api.request<Location>('downloads/' + task.id + '/location');
      if (!this.destroyed) this.reveal.emit(location);
    });
  }

  togglePackage(id: string) {
    this.expandedPackages.update((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
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

  // --- Formatting & Display Helpers ---

  fileIcon(name: string): IconName {
    if (/\.(mkv|mp4|m4v|avi|mov|webm|m2ts|ts)$/i.test(name)) return 'FileVideo';
    if (/\.(rar|zip|7z|tar|gz|xz|tgz|\d{3})$/i.test(name)) return 'FileArchive';
    if (/\.(iso|bdmv)$/i.test(name)) return 'Disc3';
    if (/\.(flac|ac3|eac3|aac|dts|mp3|wav|ogg|opus|m4a)$/i.test(name)) return 'FileAudio';
    return 'File';
  }

  fileIconKind(name: string): string {
    if (/\.(mkv|mp4|m4v|avi|mov|webm|m2ts|ts)$/i.test(name)) return 'video';
    if (/\.(rar|zip|7z|tar|gz|xz|tgz|\d{3})$/i.test(name)) return 'archive';
    if (/\.(iso|bdmv)$/i.test(name)) return 'disc';
    return 'generic';
  }

  statusTone(status: DownloadStatus): 'active' | 'ok' | 'warn' | 'err' | 'muted' {
    if (status === 'running' || status === 'publishing') return 'active';
    if (status === 'completed') return 'ok';
    if (status === 'paused' || status === 'pending') return 'warn';
    if (status === 'failed' || status === 'publication-failed' || status === 'missing')
      return 'err';
    return 'muted';
  }

  linkStatusTone(status?: DownloadLinkStatus): 'ok' | 'warn' | 'err' | 'muted' {
    if (status === 'online') return 'ok';
    if (status === 'offline') return 'err';
    if (status === 'captcha' || status === 'account-required') return 'warn';
    return 'muted';
  }

  actionIcon(action: DownloadAction): IconName {
    switch (action) {
      case 'pause':
        return 'Pause';
      case 'resume':
        return 'Play';
      case 'cancel':
        return 'X';
      case 'remove':
        return 'Trash2';
      case 'publish':
        return 'RefreshCw';
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
        (sum, task) =>
          sum + (task.status === 'completed' ? task.total : Math.min(task.downloaded, task.total)),
        0,
      );
      return Math.floor((100 * downloaded) / total);
    }
    return null;
  }

  groupDownloaded(tasks: Download[]) {
    return tasks.reduce(
      (sum, task) =>
        sum +
        (task.status === 'completed'
          ? task.total
          : Math.min(task.downloaded, task.total || task.downloaded)),
      0,
    );
  }

  groupTotal(tasks: Download[]) {
    return tasks.reduce((sum, task) => sum + task.total, 0);
  }

  groupSpeed(tasks: Download[]) {
    return tasks.reduce((sum, task) => sum + task.speed, 0);
  }

  groupEta(tasks: Download[]) {
    const speed = this.groupSpeed(tasks);
    const total = this.groupTotal(tasks);
    const downloaded = this.groupDownloaded(tasks);
    if (!speed || downloaded >= total) return '';
    return this.formatDuration(Math.ceil((total - downloaded) / speed));
  }

  groupStatus(group: DownloadGroup): DownloadStatus {
    const statuses = group.tasks.map((task) => task.status);
    if (statuses.some((s) => s === 'running')) return 'running';
    if (statuses.some((s) => s === 'publishing')) return 'publishing';
    if (statuses.some((s) => s === 'failed' || s === 'publication-failed' || s === 'missing'))
      return 'failed';
    if (statuses.some((s) => s === 'pending')) return 'pending';
    if (statuses.some((s) => s === 'paused')) return 'paused';
    if (statuses.every((s) => s === 'completed')) return 'completed';
    if (statuses.every((s) => s === 'cancelled')) return 'cancelled';
    return statuses[0] ?? 'pending';
  }

  groupCompletedCount(group: DownloadGroup) {
    return group.tasks.filter((task) => task.status === 'completed').length;
  }

  groupActions(group: DownloadGroup): DownloadAction[] {
    const order: DownloadAction[] = ['pause', 'resume', 'publish', 'cancel', 'remove'];
    return order.filter((action) => group.tasks.some((task) => task.actions.includes(action)));
  }

  groupFirstCompleted(group: DownloadGroup): Download | undefined {
    return group.tasks.find((task) => task.result);
  }

  filterCount(id: QueueFilter): number {
    return this.counts()[id];
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
    return this.formatDuration(Math.ceil((task.total - task.downloaded) / task.speed));
  }

  private formatDuration(seconds: number) {
    return seconds < 60
      ? seconds + ' s'
      : seconds < 3600
        ? Math.ceil(seconds / 60) + ' min'
        : Math.floor(seconds / 3600) + ' h ' + (Math.floor(seconds / 60) % 60) + ' min';
  }
}
