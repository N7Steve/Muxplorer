import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { diagnostic } from './diagnostics';
export interface ProcessOptions {
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  allowedCodes?: number[];
  captureLimit?: number;
  timeout?: number;
  secrets?: string[];
  jobId?: string;
}
export class ProcessError extends Error {
  constructor(
    public readonly executable: string,
    public readonly code: number | null,
    detail: string,
    public readonly stdout = '',
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
    const processId = randomUUID();
    const started = Date.now();
    let lastOutput = started;
    diagnostic('process.start', { processId, jobId: options.jobId, executable });
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
        diagnostic('process.stop', { processId, aborted: options.signal?.aborted, timedOut });
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
      const heartbeat = setInterval(
        () =>
          diagnostic('process.running', {
            processId,
            jobId: options.jobId,
            elapsedMs: Date.now() - started,
            outputSilentMs: Date.now() - lastOutput,
          }),
        15_000,
      );
      heartbeat.unref();
      options.signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        lastOutput = Date.now();
        const decoded = decoder.write(chunk);
        if (stdout.length + decoded.length <= limit) stdout += decoded;
        else if (!options.onLine) {
          overflow = true;
          stop();
        }
        pending += decoded;
        // 7-Zip redraws its progress using backspaces, without emitting a newline.
        const lines = pending.split(/[\r\n\b]/);
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
        // A redraw's current percentage is complete before its next backspace/newline.
        // Waiting for that delimiter leaves the UI one update behind until cancellation.
        if (/^\s*\d{1,3}%(?:\s|$)/.test(pending)) {
          try {
            options.onLine?.(sanitize(pending));
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
        lastOutput = Date.now();
        stderr = (stderr + chunk.toString('utf8')).slice(-32_768);
      });
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', stop);
      };
      child.on('error', (error) => {
        cleanup();
        diagnostic('process.spawn_error', { processId, error: sanitize(error.message) });
        reject(new ProcessError(executable, null, sanitize(error.message)));
      });
      child.on('close', (code, signal) => {
        if (options.signal?.aborted || timedOut || overflow || callbackError) kill('SIGKILL');
        cleanup();
        diagnostic('process.exit', {
          processId,
          jobId: options.jobId,
          executable,
          code,
          signal,
          elapsedMs: Date.now() - started,
          aborted: options.signal?.aborted ?? false,
          timedOut,
          overflow,
          ...(code !== 0 ? { detail: sanitize((stderr || stdout).slice(-2000)) } : {}),
        });
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
              sanitize(stdout),
            ),
          );
          return;
        }
        resolve({ stdout: sanitize(stdout), code: code ?? 0 });
      });
    });
  }
}
