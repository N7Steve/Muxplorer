import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { config } from './config';
import { ProviderError, type DownloadProvider, type EngineTask } from './download-provider';

const bytes = z.number().int().nonnegative();
const engineId = z.string().regex(/^[\w-]{1,128}$/);
const resource = z.object({
  name: z.string(),
  size: bytes,
  files: z.array(z.object({ name: z.string(), path: z.string(), size: bytes })),
});
const task = z.object({
  id: engineId,
  status: z.enum(['ready', 'running', 'pause', 'wait', 'error', 'done']),
  meta: z.object({
    req: z.object({ labels: z.record(z.string(), z.string()).nullish() }),
    opts: z.object({
      path: z.string(),
      name: z.string(),
      selectFiles: z.array(z.number().int().nonnegative()).nullish(),
    }),
    res: resource.nullish(),
  }),
  progress: z.object({ speed: z.number().finite(), downloaded: bytes }).nullish(),
});
const envelope = z.object({ code: z.number().int(), data: z.unknown() });
const ENGINE_STAGING = '/app/Downloads';
export const engineDirectory = (id: string) => ENGINE_STAGING + '/' + id;

const statuses = {
  ready: 'pending',
  wait: 'pending',
  running: 'running',
  pause: 'paused',
  error: 'failed',
  done: 'done',
} as const;

function normalize(raw: z.infer<typeof task>): EngineTask {
  const { req, opts, res } = raw.meta;
  const id = req.labels?.muxplorer;
  return {
    id: raw.id,
    requestId: id && opts.path === engineDirectory(id) ? id : undefined,
    status: statuses[raw.status],
    resource: res ?? undefined,
    outputName: opts.name,
    selectedFiles: opts.selectFiles ?? undefined,
    downloaded: raw.progress?.downloaded ?? 0,
    speed: Math.max(0, raw.progress?.speed ?? 0),
  };
}

@Injectable()
export class GopeedDownloadProvider implements DownloadProvider {
  constructor(
    @Optional() private readonly baseUrl = config.GOPEED_URL,
    @Optional() private readonly token = config.GOPEED_API_TOKEN,
  ) {}

  private async request<T>(
    endpoint: string,
    schema: z.ZodType<T>,
    method = 'GET',
    body?: unknown,
    timeout = 5000,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL('/api/v1/' + endpoint, this.baseUrl), {
        method,
        headers: { 'X-Api-Token': this.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
    } catch {
      throw new ProviderError('connection');
    }
    if (response.status === 401 || response.status === 403) throw new ProviderError('auth');
    if (!response.ok) throw new ProviderError('response');

    const result = envelope.safeParse(await response.json().catch(() => null));
    if (!result.success) throw new ProviderError('response');
    if (result.data.code === 2001) throw new ProviderError('missing');
    if (result.data.code !== 0) throw new ProviderError('rejected');
    const data = schema.safeParse(result.data.data);
    if (!data.success) throw new ProviderError('response');
    return data.data;
  }

  info() {
    return this.request('info', z.object({ version: z.string().regex(/^[\w.-]{1,64}$/) }));
  }

  list() {
    return this.request('tasks', z.array(task).nullable()).then((tasks) =>
      (tasks ?? []).map(normalize),
    );
  }

  async get(id: string) {
    try {
      const current = await this.request('tasks/' + engineId.parse(id), task);
      if (current.id !== id) throw new ProviderError('response');
      return normalize(current);
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'missing') return null;
      throw error;
    }
  }

  add(url: string, id: string) {
    return this.request('tasks', engineId, 'POST', {
      req: { url, labels: { muxplorer: id } },
      opts: { path: engineDirectory(id), extra: { autoExtract: false, autoTorrent: false } },
    });
  }

  async resolve(url: string) {
    const result = await this.request(
      'resolve',
      z.object({ res: resource }),
      'POST',
      {
        req: { url },
        opts: { path: ENGINE_STAGING },
      },
      20_000,
    );
    return result.res;
  }

  async pause(id: string) {
    await this.request('tasks/' + engineId.parse(id) + '/pause', z.null(), 'PUT');
  }

  async resume(id: string) {
    await this.request('tasks/' + engineId.parse(id) + '/continue', z.null(), 'PUT');
  }

  // Gopeed uses the same endpoint for cancellation and removal. Muxplorer manages
  // cleanup of the isolated directory and retains a cancelled row until dismissed.
  cancel(id: string) {
    return this.remove(id);
  }

  async remove(id: string) {
    await this.request('tasks/' + engineId.parse(id) + '?force=false', z.null(), 'DELETE');
  }
}
