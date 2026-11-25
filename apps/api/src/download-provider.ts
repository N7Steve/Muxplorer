import type { DownloadLinkCheck, DownloadLinkStatus } from '@muxplorer/shared';

export interface DownloadResource {
  name: string;
  size: number;
  files: { name: string; path: string; size: number }[];
}

export interface EngineTask {
  id: string;
  // Set by the adapter after verifying the task's ownership and staging path.
  requestId?: string;
  status: 'pending' | 'running' | 'paused' | 'failed' | 'done';
  outputName?: string;
  selectedFiles?: number[];
  resource?: DownloadResource;
  downloaded: number;
  speed: number;
  error?: string;
}

export interface DownloadProvider {
  info(): Promise<{ version: string }>;
  list(): Promise<EngineTask[]>;
  get(id: string): Promise<EngineTask | null>;
  validate?(url: string, accountId?: string): void;
  add(url: string, id: string, accountId?: string): Promise<string>;
  resolve?(url: string, accountId?: string): Promise<DownloadResource>;
  check?(url: string, accountId?: string): Promise<DownloadLinkCheck>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}
export const DOWNLOAD_PROVIDER = Symbol('DownloadProvider');

export class HostDownloadError extends Error {
  constructor(
    message: string,
    readonly status: Exclude<DownloadLinkStatus, 'online' | 'warning'> = 'unknown',
  ) {
    super(message);
  }
}

export class ProviderError extends Error {
  constructor(readonly kind: 'auth' | 'connection' | 'response' | 'rejected' | 'missing') {
    super(
      {
        auth: 'El motor rechazó la autenticación. Revisa el token del servicio.',
        connection: 'No se pudo conectar con el motor de descargas.',
        response: 'El motor devolvió una respuesta inesperada.',
        rejected: 'El motor no pudo realizar la operación solicitada.',
        missing: 'La tarea ya no existe en el motor de descargas.',
      }[kind],
    );
  }
}
