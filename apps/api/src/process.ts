import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
export interface ProcessOptions {
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  allowedCodes?: number[];
  captureLimit?: number;
  timeout?: number;
  secrets?: string[];
}
export class ProcessError extends Error {
  constructor(
    public readonly executable: string,
    public readonly code: number | null,
    detail: string,
  ) {
    super(`${executable}: ${detail}`);
  }
}
@Injectable()
export class Processes {
  async run(
    executable: string,
    args: string[],
    options: ProcessOptions = {},
  ): Promise<{ stdout: string; code: number }> {
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const limit = options.captureLimit ?? 4 * 1024 * 1024;
      let stdout = '',
        stderr = '',
        overflow = false,
        timedOut = false;
      let callbackError: unknown;
      const sanitize = (value: string) =>
        (options.secrets ?? []).reduce(
          (s, secret) => (secret ? s.split(secret).join('[oculto]') : s),
          value,
        );
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let killTimer: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      };
      const stop = () => {
        kill('SIGTERM');
        killTimer ??= setTimeout(() => kill('SIGKILL'), 5000);
        killTimer.unref();
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          stop();
        },
        options.timeout ?? 24 * 3600_000,
      );
      timer.unref();
      options.signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        const decoded = decoder.write(chunk);
        if (stdout.length + decoded.length <= limit) stdout += decoded;
        else if (!options.onLine) {
          overflow = true;
          stop();
        }
        pending += decoded;
        const lines = pending.split(/[\r\n]/);
        pending = lines.pop() ?? '';
        for (const line of lines)
          if (line) {
            try {
              options.onLine?.(sanitize(line));
            } catch (error) {
              callbackError = error;
              stop();
            }
          }
        if (pending.length > 1024 * 1024) {
          overflow = true;
          stop();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-32_768);
      });
      const cleanup = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', stop);
      };
      child.on('error', (error) => {
        cleanup();
        reject(new ProcessError(executable, null, sanitize(error.message)));
      });
      child.on('close', (code) => {
        if (options.signal?.aborted || timedOut || overflow || callbackError) kill('SIGKILL');
        cleanup();
        const finalText = decoder.end();
        stdout += finalText;
        pending += finalText;
        if (pending) {
          try {
            options.onLine?.(sanitize(pending));
          } catch (error) {
            callbackError = error;
          }
        }
        if (callbackError) {
          reject(callbackError);
          return;
        }
        if (options.signal?.aborted) {
          reject(new DOMException('Operación cancelada', 'AbortError'));
          return;
        }
        if (overflow || timedOut || !(options.allowedCodes ?? [0]).includes(code ?? -1)) {
          reject(
            new ProcessError(
              executable,
              code,
              timedOut
                ? 'Tiempo de espera agotado.'
                : overflow
                  ? 'Salida del proceso demasiado grande.'
                  : sanitize((stderr || stdout).slice(-8000)) || `Código de salida ${code}`,
            ),
          );
          return;
        }
        resolve({ stdout: sanitize(stdout), code: code ?? 0 });
      });
    });
  }
}
