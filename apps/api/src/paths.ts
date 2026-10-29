import { Injectable, Optional } from '@nestjs/common';
import { lstat, realpath, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { Location, Root, RootId } from '@muxplorer/shared';
import { config } from './config';
import { problem } from './errors';
export function safeName(name: string): string {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[\x00-\x1f\x7f\\/:]/.test(name) ||
    name.startsWith('.muxplorer-') ||
    Buffer.byteLength(name) > 240
  )
    problem('Nombre no válido. Evita separadores, caracteres de control y nombres reservados.');
  return name;
}
export function relativePath(value: string): string {
  if (value === '') return '';
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes(':') ||
    value.split('/').some((s) => !s || s === '.' || s === '..')
  )
    problem('Ruta no válida.');
  value.split('/').forEach(safeName);
  return value;
}
export function childLocation(parent: Location, name: string): Location {
  return { root: parent.root, path: [parent.path, safeName(name)].filter(Boolean).join('/') };
}
@Injectable()
export class Paths {
  constructor(@Optional() readonly roots: Record<RootId, string> = config.roots) {}
  async resolve(location: Location, allowMissingLeaf = false): Promise<string> {
    if (!location || !(location.root in this.roots)) problem('Ubicación no autorizada.');
    const relative = relativePath(location.path);
    const root = this.roots[location.root];
    const rootStat = await lstat(root);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      path.resolve(await realpath(root)) !== path.resolve(root)
    )
      problem('La raíz debe ser un directorio real, sin enlaces simbólicos.');
    let current = root;
    const parts = relative ? relative.split('/') : [];
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      try {
        const item = await lstat(current);
        if (item.isSymbolicLink()) problem('Los enlaces simbólicos están bloqueados.');
        if (i < parts.length - 1 && !item.isDirectory())
          problem('Una parte de la ruta no es un directorio.');
      } catch (error) {
        if (
          allowMissingLeaf &&
          i === parts.length - 1 &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        )
          return current;
        throw error;
      }
    }
    return current;
  }
  async directory(location: Location) {
    const absolute = await this.resolve(location);
    if (!(await lstat(absolute)).isDirectory()) problem('Selecciona una carpeta.');
    return absolute;
  }
  async file(location: Location) {
    const absolute = await this.resolve(location);
    if (!(await lstat(absolute)).isFile()) problem('Selecciona un archivo regular.');
    return absolute;
  }
  assertMutable(location: Location) {
    if (!relativePath(location.path)) problem('No se puede modificar la raíz de almacenamiento.');
  }
  async tree(absolute: string): Promise<void> {
    const item = await lstat(absolute);
    if (
      item.isSymbolicLink() ||
      (!item.isDirectory() && !item.isFile()) ||
      (item.isFile() && item.nlink > 1)
    )
      problem('El árbol contiene enlaces o archivos especiales; operación bloqueada.');
    if (item.isDirectory())
      for (const name of await readdir(absolute)) {
        safeName(name);
        await this.tree(path.join(absolute, name));
      }
  }
  async listRoots(): Promise<Root[]> {
    return Promise.all(
      (['downloads', 'plex'] as const).map(async (id) => {
        try {
          const absolute = await this.directory({ root: id, path: '' });
          const space = await statfs(absolute);
          return {
            id,
            name: id === 'downloads' ? 'Downloads' : 'PlexMedia',
            available: true,
            free: space.bavail * space.bsize,
          };
        } catch {
          return { id, name: id === 'downloads' ? 'Downloads' : 'PlexMedia', available: false };
        }
      }),
    );
  }
}
