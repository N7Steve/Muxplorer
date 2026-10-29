import { Component, computed, effect, input, output, signal, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { DragDropModule, CdkDragDrop } from '@angular/cdk/drag-drop';
import type { Entry, Location, RootId } from '@muxplorer/shared';
import { Api, bytes, rootName } from './api';
import { Icon, IconName } from './icon';
export interface Action {
  action: string;
  entries: Entry[];
  location: Location;
  x?: number;
  y?: number;
  destination?: Location;
}
@Component({
  selector: 'mx-explorer',
  standalone: true,
  imports: [FormsModule, DatePipe, DragDropModule, Icon],
  templateUrl: './explorer.html',
  host: { '[class.focused]': 'active()', '[class.picker]': 'picker()' },
})
export class Explorer {
  readonly api = inject(Api);
  readonly panelId = input('left');
  readonly initialRoot = input<RootId>('downloads');
  readonly active = input(false);
  readonly picker = input(false);
  readonly filePicker = input(false);
  readonly action = output<Action>();
  readonly activated = output<void>();
  readonly navigated = output<Location>();
  readonly location = signal<Location>({ root: 'downloads', path: '' });
  readonly entries = signal<Entry[]>([]);
  readonly selected = signal<Set<string>>(new Set());
  readonly loading = signal(false);
  readonly error = signal('');
  readonly query = signal('');
  readonly sort = signal<'name' | 'size' | 'extension' | 'modified'>('name');
  readonly descending = signal(false);
  readonly history = signal<Location[]>([]);
  readonly future = signal<Location[]>([]);
  private anchor = 0;
  private requestId = 0;
  readonly visible = computed(() => {
    const query = this.query().toLocaleLowerCase();
    const key = this.sort(),
      direction = this.descending() ? -1 : 1;
    return this.entries()
      .filter(
        (e) =>
          (!this.picker() || this.filePicker() || e.kind === 'directory') &&
          e.name.toLocaleLowerCase().includes(query),
      )
      .sort((a, b) =>
        a.kind === 'directory' && b.kind !== 'directory'
          ? -1
          : b.kind === 'directory' && a.kind !== 'directory'
            ? 1
            : direction *
              (key === 'size'
                ? a.size - b.size
                : String(a[key]).localeCompare(String(b[key]), 'es', { numeric: true })),
      );
  });
  readonly selection = computed(() => this.entries().filter((e) => this.selected().has(e.name)));
  readonly crumbs = computed(() =>
    this.location()
      .path.split('/')
      .filter(Boolean)
      .map((name, i, a) => ({ name, path: a.slice(0, i + 1).join('/') })),
  );
  readonly total = computed(() =>
    this.entries()
      .filter((e) => e.kind === 'file')
      .reduce((n, e) => n + e.size, 0),
  );
  readonly selectedBytes = computed(() =>
    this.selection().reduce((n, e) => n + (e.kind === 'file' ? e.size : 0), 0),
  );
  readonly bytes = bytes;
  readonly rootName = rootName;
  constructor() {
    effect(() => {
      const root = this.initialRoot();
      this.location.set({ root, path: '' });
    });
    effect(() => {
      const location = this.location();
      this.api.revision();
      void this.load(location);
    });
  }
  async load(location = this.location()) {
    const id = ++this.requestId;
    this.loading.set(true);
    this.error.set('');
    try {
      const entries = await this.api.list(location);
      if (id === this.requestId) {
        this.entries.set(entries);
        this.selected.update(
          (s) => new Set([...s].filter((name) => entries.some((e) => e.name === name))),
        );
      }
    } catch (error) {
      if (id === this.requestId) {
        this.entries.set([]);
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (id === this.requestId) this.loading.set(false);
    }
  }
  navigate(location: Location, record = true) {
    if (record) {
      this.history.update((h) => [...h, this.location()]);
      this.future.set([]);
    }
    this.selected.set(new Set());
    this.query.set('');
    this.location.set(location);
    this.navigated.emit(location);
  }
  root(root: string) {
    this.navigate({ root: root as RootId, path: '' });
  }
  back() {
    const previous = this.history().at(-1);
    if (previous) {
      this.future.update((f) => [...f, this.location()]);
      this.history.update((h) => h.slice(0, -1));
      this.navigate(previous, false);
    }
  }
  forward() {
    const next = this.future().at(-1);
    if (next) {
      this.history.update((h) => [...h, this.location()]);
      this.future.update((f) => f.slice(0, -1));
      this.navigate(next, false);
    }
  }
  up() {
    this.navigate({
      ...this.location(),
      path: this.location().path.split('/').slice(0, -1).join('/'),
    });
  }
  select(entry: Entry, event: MouseEvent | KeyboardEvent, index: number) {
    this.activated.emit();
    if (entry.kind === 'blocked') return;
    if (event.shiftKey) {
      const names = this.visible()
        .slice(Math.min(this.anchor, index), Math.max(this.anchor, index) + 1)
        .filter((e) => e.kind !== 'blocked')
        .map((e) => e.name);
      this.selected.set(
        new Set(event.ctrlKey || event.metaKey ? [...this.selected(), ...names] : names),
      );
    } else if (event.ctrlKey || event.metaKey) {
      this.selected.update((s) => {
        const copy = new Set(s);
        if (copy.has(entry.name)) copy.delete(entry.name);
        else copy.add(entry.name);
        return copy;
      });
      this.anchor = index;
    } else {
      this.selected.set(new Set([entry.name]));
      this.anchor = index;
    }
  }
  open(entry: Entry) {
    if (entry.kind === 'directory') this.navigate(entry.location);
    else if (this.filePicker()) this.emit('choose', [entry]);
    else if (entry.kind === 'file') this.emit('properties', [entry]);
  }
  context(event: MouseEvent, entry?: Entry) {
    event.preventDefault();
    this.activated.emit();
    if (entry && !this.selected().has(entry.name)) this.selected.set(new Set([entry.name]));
    this.action.emit({
      action: 'context',
      entries: entry ? this.selection() : [],
      location: this.location(),
      x: event.clientX,
      y: event.clientY,
    });
  }
  emit(action: string, entries = this.selection()) {
    this.action.emit({ action, entries, location: this.location() });
  }
  order(key: 'name' | 'size' | 'extension' | 'modified') {
    if (this.sort() === key) this.descending.update((v) => !v);
    else {
      this.sort.set(key);
      this.descending.set(false);
    }
  }
  dragEntries(entry: Entry) {
    return this.selected().has(entry.name) ? this.selection() : [entry];
  }
  drop(event: CdkDragDrop<Entry[]>) {
    if (event.previousContainer === event.container) return;
    const entries = event.item.data as Entry[];
    this.action.emit({
      action: 'drop',
      entries,
      location: this.location(),
      destination: this.location(),
    });
  }
  key(event: KeyboardEvent) {
    if ((event.target as HTMLElement).matches('input,select,textarea,button')) return;
    if (event.key === '/') {
      event.preventDefault();
      (event.currentTarget as HTMLElement)
        .querySelector<HTMLInputElement>('input[aria-label="Filtrar archivos"]')
        ?.focus();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selected.set(
        new Set(
          this.visible()
            .filter((e) => e.kind !== 'blocked')
            .map((e) => e.name),
        ),
      );
    } else if (event.key === 'Enter' && this.selection().length === 1) {
      event.preventDefault();
      this.open(this.selection()[0]);
    } else if (event.key === 'Backspace' && this.location().path) {
      event.preventDefault();
      this.up();
    } else if (event.key === 'F2' && this.selection().length === 1) {
      event.preventDefault();
      this.emit('rename');
    } else if (event.key === 'Delete' && this.selection().length) {
      event.preventDefault();
      this.emit('delete');
    } else if (event.key === 'Escape') this.selected.set(new Set());
    else if (event.key === 'F5') {
      event.preventDefault();
      void this.load();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const index = Math.max(0, Math.min(this.visible().length - 1, this.anchor + step));
      const entry = this.visible()[index];
      if (entry) this.select(entry, event, index);
    } else if (
      (event.ctrlKey || event.metaKey) &&
      ['c', 'x', 'v'].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      this.emit(
        event.key.toLowerCase() === 'c'
          ? 'clipboard-copy'
          : event.key.toLowerCase() === 'x'
            ? 'clipboard-move'
            : 'paste',
      );
    }
  }
  icon(entry: Entry): IconName {
    if (entry.kind === 'directory') return 'Folder';
    if (entry.kind === 'blocked') return 'LockKeyhole';
    if (/\.(rar|zip|7z|tar|gz|xz|tgz|\d{3})$/i.test(entry.name)) return 'FileArchive';
    if (/\.(mkv|mp4|avi|mov|m2ts|ts|webm)$/i.test(entry.name)) return 'FileVideo';
    if (/\.(iso|bdmv)$/i.test(entry.name)) return 'Disc3';
    if (/\.(flac|ac3|aac|dts|mp3|wav|m4a)$/i.test(entry.name)) return 'FileAudio';
    return 'File';
  }
}
