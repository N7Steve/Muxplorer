import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DownloadAccounts } from './download-accounts';
import { type DownloadProvider, HostDownloadError, ProviderError } from './download-provider';
import { GopeedDownloadProvider } from './gopeed';
import { MegaDownloads, megaHost } from './mega-downloads';

@Injectable()
export class DownloadRouting implements DownloadProvider {
  constructor(
    private readonly gopeed: GopeedDownloadProvider,
    private readonly mega: MegaDownloads,
    private readonly accounts: DownloadAccounts,
  ) {}

  validate(url: string, accountId?: string) {
    const source = new URL(url);
    const account = accountId && this.accounts.list().find((item) => item.id === accountId);
    if (accountId && !account)
      throw new BadRequestException('La cuenta seleccionada ya no existe.');
    const isMega = megaHost(source.hostname);
    const isFichier = /^(www\.)?1fichier\.com$/.test(source.hostname);
    if (
      account &&
      (!['http:', 'https:'].includes(source.protocol) ||
        (account.provider === 'mega' && !isMega) ||
        (account.provider === '1fichier' && !isFichier))
    )
      throw new BadRequestException('La cuenta seleccionada no admite todos los enlaces del lote.');
    if (
      isMega &&
      (!account || account.provider === 'mega') &&
      (source.protocol !== 'https:' || source.port || !source.hash)
    )
      throw new BadRequestException(
        'Introduce un enlace HTTPS de MEGA con su clave de descifrado.',
      );
    if (isFichier && !account)
      throw new BadRequestException('Guarda y selecciona una cuenta de 1fichier o Real-Debrid.');
  }

  private async direct(url: string, accountId?: string) {
    if (!accountId) return url;
    const account = this.accounts.get(accountId);
    const fichier = account.provider === '1fichier';
    const provider = fichier ? '1fichier' : 'Real-Debrid';
    try {
      const response = await fetch(
        fichier
          ? 'https://api.1fichier.com/v1/download/get_token.cgi'
          : 'https://api.real-debrid.com/rest/1.0/unrestrict/link',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + account.secret,
            'Content-Type': fichier ? 'application/json' : 'application/x-www-form-urlencoded',
          },
          body: fichier
            ? JSON.stringify({ url, restrict_ip: 1 })
            : new URLSearchParams({ link: url }),
          redirect: 'error',
          signal: AbortSignal.timeout(7000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      const data: unknown = await response.json();
      const link = fichier
        ? z.object({ status: z.literal('OK'), url: z.string() }).parse(data).url
        : z.object({ download: z.string() }).parse(data).download;
      const parsed = new URL(link);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
      return parsed.href;
    } catch {
      throw new HostDownloadError(
        provider + ' no generó un enlace de descarga. Comprueba la cuenta, la cuota y el enlace.',
      );
    }
  }

  private useMega(url: string, accountId?: string) {
    return (
      megaHost(new URL(url).hostname) &&
      (!accountId ||
        this.accounts.list().some((item) => item.id === accountId && item.provider === 'mega'))
    );
  }

  info() {
    return this.gopeed.info();
  }

  async list() {
    return [...(await this.gopeed.list()), ...this.mega.list()];
  }

  async get(id: string) {
    return id.startsWith('mega-') ? this.mega.get(id) : this.gopeed.get(id);
  }

  async add(url: string, id: string, accountId?: string) {
    this.validate(url, accountId);
    if (this.useMega(url, accountId)) return this.mega.add(url, id, accountId);
    return this.gopeed.add(await this.direct(url, accountId), id);
  }

  async resolve(url: string, accountId?: string) {
    this.validate(url, accountId);
    try {
      if (this.useMega(url, accountId)) return await this.mega.resolve(url, accountId);
      return await this.gopeed.resolve(await this.direct(url, accountId));
    } catch (error) {
      if (error instanceof HostDownloadError) throw error;
      throw new ProviderError('rejected');
    }
  }

  pause(id: string) {
    return id.startsWith('mega-') ? this.mega.pause(id) : this.gopeed.pause(id);
  }

  resume(id: string) {
    return id.startsWith('mega-') ? this.mega.resume(id) : this.gopeed.resume(id);
  }

  remove(id: string) {
    return id.startsWith('mega-') ? this.mega.remove(id) : this.gopeed.remove(id);
  }

  cancel(id: string) {
    return this.remove(id);
  }
}
