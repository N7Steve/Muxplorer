import { Component, Injectable, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Location, MediaSummary } from '@muxplorer/shared';
import { Api, bytes, displayLocation } from './api';

@Injectable({ providedIn: 'root' })
export class MediaInfoState {
  private readonly api = inject(Api);
  readonly files = signal<MediaSummary[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  private generation = 0;
  async inspect(locations: Location[], append: boolean) {
    if (this.loading()) return;
    const existing = append ? this.files() : [];
    const unique = locations.filter(
      (location, i) =>
        !existing.some(
          (f) => f.location.root === location.root && f.location.path === location.path,
        ) && locations.findIndex((l) => l.root === location.root && l.path === location.path) === i,
    );
    if (existing.length + unique.length > 2) {
      this.error.set('La comparación admite dos archivos. Quita uno antes de añadir otro.');
      return;
    }
    const generation = ++this.generation;
    this.files.set(existing);
    this.loading.set(true);
    this.error.set('');
    try {
      // Retain successful results even when the other file cannot be inspected.
      for (const location of unique) {
        const file = await this.api.request<MediaSummary>('media/summary', location);
        if (generation !== this.generation) return;
        this.files.update((files) => [...files, file]);
      }
    } catch (error) {
      if (generation === this.generation)
        this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
  clear() {
    this.generation++;
    this.files.set([]);
    this.error.set('');
    this.loading.set(false);
  }
}

export function summaryRows(files: MediaSummary[]) {
  const missing = 'No informado';
  const numeric = (value?: number, unit = '') =>
    value === undefined
      ? missing
      : `${value.toLocaleString('es-ES', { maximumFractionDigits: 3 })}${unit}`;
  const bitrate = (value?: number) =>
    value === undefined
      ? missing
      : value >= 1_000_000
        ? numeric(value / 1_000_000, ' Mb/s')
        : numeric(value / 1000, ' kb/s');
  const duration = (value?: number) => {
    if (value === undefined) return missing;
    const seconds = Math.round(value);
    return `${Math.floor(seconds / 3600)
      .toString()
      .padStart(2, '0')}:${Math.floor((seconds / 60) % 60)
      .toString()
      .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  };
  const rows: { label: string; values: string[]; different: boolean }[] = [];
  const add = (label: string, get: (file: MediaSummary) => string) => {
    const values = files.map(get);
    rows.push({ label, values, different: values.length === 2 && values[0] !== values[1] });
  };
  add('Contenedor', (f) => f.container);
  add('Tamaño', (f) => bytes(f.size));
  add('Duración', (f) => duration(f.duration));
  add('Bitrate total', (f) => bitrate(f.bitrate));
  for (const kind of ['videos', 'audios'] as const) {
    const title = kind === 'videos' ? 'Vídeo' : 'Audio';
    add(`Pistas de ${title.toLowerCase()}`, (f) => String(f[kind].length));
    const count = Math.max(0, ...files.map((f) => f[kind].length));
    for (let i = 0; i < count; i++) {
      const field = (label: string, get: (track: MediaSummary[typeof kind][number]) => string) =>
        add(`${title} ${i + 1} · ${label}`, (f) =>
          f[kind][i] ? get(f[kind][i]) || missing : 'Sin pista',
        );
      field('Códec / perfil', (t) => t.codec);
      field('Bitrate', (t) => `${bitrate(t.bitrate)}${t.bitrateMode ? ` · ${t.bitrateMode}` : ''}`);
      if (kind === 'videos') {
        field('Resolución', (t) => (t.width && t.height ? `${t.width} × ${t.height}` : missing));
        field('HDR', (t) => t.hdr);
        field('Fotogramas', (t) => numeric(t.frameRate, ' fps'));
        field('Profundidad', (t) => numeric(t.bitDepth, ' bits'));
        field('Color', (t) => t.color);
      } else {
        field('Idioma', (t) => t.language);
        field('Título', (t) => t.title);
        field('Canales', (t) => `${numeric(t.channels)}${t.layout ? ` · ${t.layout}` : ''}`);
        field('Frecuencia', (t) =>
          numeric(t.sampleRate === undefined ? undefined : t.sampleRate / 1000, ' kHz'),
        );
        field('Profundidad', (t) => numeric(t.bitDepth, ' bits'));
      }
    }
  }
  return rows;
}

@Component({
  selector: 'mx-mediainfo',
  standalone: true,
  imports: [FormsModule],
  template: `
    <p class="muted">
      Resumen para comparar la calidad y compatibilidad. Los campos ausentes se muestran como «No
      informado».
    </p>
    @if (state.loading()) {
      <p role="status" aria-live="polite">
        Leyendo MediaInfo… Puedes minimizar y seguir navegando.
      </p>
    }
    @if (state.error()) {
      <p class="inline-error" role="alert">{{ state.error() }}</p>
    }
    @if (state.files().length) {
      @if (state.files().length === 2) {
        <label class="mediainfo-filter"
          ><input type="checkbox" [(ngModel)]="differencesOnly" />Solo diferencias</label
        >
        <p class="muted">
          Las diferencias se resaltan. Las pistas se comparan por su posición; un bitrate mayor no
          garantiza por sí solo mejor calidad.
        </p>
      } @else {
        <p class="muted">
          Minimiza a Operaciones y usa «Añadir a comparación» en el menú de otro archivo.
        </p>
      }
      <div class="mediainfo-scroll">
        <table class="mediainfo-table">
          <thead>
            <tr>
              <th scope="col">Datos</th>
              @for (
                file of state.files();
                track file.location.root + ':' + file.location.path;
                let i = $index
              ) {
                <th scope="col">
                  <b>{{ file.location.path.split('/').pop() }}</b
                  ><small>{{ display(file.location) }}</small>
                  <button
                    class="button ghost compact"
                    [disabled]="state.loading()"
                    (click)="remove(i)"
                  >
                    Quitar archivo
                  </button>
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.label) {
              @if (!differencesOnly || state.files().length < 2 || row.different) {
                <tr [class.mediainfo-different]="row.different">
                  <th scope="row">
                    {{ row.label }}
                    @if (row.different) {
                      <small>Diferente</small>
                    }
                  </th>
                  @for (value of row.values; track $index) {
                    <td>{{ value }}</td>
                  }
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class MediaInfoView {
  readonly state = inject(MediaInfoState);
  readonly rows = computed(() => summaryRows(this.state.files()));
  readonly display = displayLocation;
  differencesOnly = false;
  remove(index: number) {
    this.state.files.update((files) => files.filter((_, i) => i !== index));
  }
}
