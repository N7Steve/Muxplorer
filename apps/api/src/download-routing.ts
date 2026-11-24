import { BadRequestException, Injectable } from '@nestjs/common';
import type { DownloadAccountProvider, DownloadLinkCheck } from '@muxplorer/shared';
import { DownloadHosts, nativeHost } from './download-hosts';
import { DownloadAccounts } from './download-accounts';
import { type DownloadProvider, HostDownloadError } from './download-provider';
import { GopeedDownloadProvider } from './gopeed';
import { MegaDownloads, megaHost } from './mega-downloads';
import { safeName } from './paths';

const providerHost = (provider: DownloadAccountProvider) =>
  provider === '1fichier-web' ? '1fichier' : provider;

@Injectable()
export class DownloadRouting implements DownloadProvider {
  constructor(
    private readonly gopeed: GopeedDownloadProvider,
    private readonly mega: MegaDownloads,
    private readonly accounts: DownloadAccounts,
  ) {}

  private readonly hosts = new DownloadHosts();

  async saveAccount(input: Parameters<DownloadAccounts['save']>[0]) {
    const accounts = this.accounts.save(input);
    return this.checkAccount(input.id ?? accounts[accounts.length - 1].id);
  }

  checkAccount(id: string) {
    return this.accounts.check(id, (account) =>
      account.provider === 'mega' ? this.mega.verify(account) : this.hosts.verify(account),
    );
  }

  removeAccount(id: string) {
    this.hosts.forget(id);
    return this.accounts.remove(id);
  }

  validate(url: string, accountId?: string) {
    const source = new URL(url);
    const account = accountId && this.accounts.list().find((item) => item.id === accountId);
    if (accountId && !account)
      throw new BadRequestException('La cuenta seleccionada ya no existe.');
    const host = megaHost(source.hostname) ? 'mega' : nativeHost(source.hostname);
    if (
      account &&
      (!['http:', 'https:'].includes(source.protocol) ||
        (account.provider !== 'real-debrid' && providerHost(account.provider) !== host))
    )
      throw new BadRequestException('La cuenta seleccionada no admite este enlace.');
    if (
      host === 'mega' &&
      (!account || account.provider === 'mega') &&
      (source.protocol !== 'https:' || source.port || !source.hash)
    )
      throw new BadRequestException(
        'Introduce un enlace HTTPS de MEGA con su clave de descifrado.',
      );
  }

  private async route<T>(
    url: string,
    accountId: string | undefined,
    use: (source: URL, mega: boolean, accountId?: string) => Promise<T>,
  ): Promise<T> {
    this.validate(url, accountId);
    const source = new URL(url);
    const host = megaHost(source.hostname) ? 'mega' : nativeHost(source.hostname);
    const publicMega =
      host === 'mega' && source.protocol === 'https:' && !source.port && !!source.hash;
    if (accountId)
      return use(source, publicMega && this.accounts.get(accountId).provider === 'mega', accountId);
    if (source.protocol === 'magnet:') return use(source, false);

    const accounts = this.accounts.list().filter((account) => account.status !== 'invalid');
    accounts.sort((a, b) => Number(b.status === 'connected') - Number(a.status === 'connected'));
    const native = accounts.filter(
      (account) => providerHost(account.provider) === host && (host !== 'mega' || publicMega),
    );
    const debrid = accounts.filter((account) => account.provider === 'real-debrid');
    let failure: unknown;
    for (const account of native) {
      try {
        return await use(source, publicMega, account.id);
      } catch (error) {
        if (!(error instanceof HostDownloadError)) throw error;
        if (error.status === 'offline') throw error;
        failure = error;
      }
    }
    if (publicMega) return use(source, true);
    if (debrid.length && (await this.hosts.debridSupports(source.hostname))) {
      for (const account of debrid) {
        try {
          return await use(source, false, account.id);
        } catch (error) {
          if (!(error instanceof HostDownloadError)) throw error;
          if (error.status === 'offline') throw error;
          failure ??= error;
        }
      }
    }
    try {
      return await use(source, false);
    } catch (error) {
      if (error instanceof HostDownloadError && ['offline', 'captcha'].includes(error.status))
        throw error;
      throw failure ?? error;
    }
  }

  private async direct(source: URL, accountId?: string) {
    if (accountId) return (await this.hosts.direct(source, this.accounts.get(accountId))).link;
    if (megaHost(source.hostname))
      throw new HostDownloadError('Introduce un enlace HTTPS de MEGA con su clave de descifrado.');
    const host = nativeHost(source.hostname);
    if (!host) return source.href;
    const result = await this.hosts.publicLink(source, host).catch((error: unknown) => {
      if (error instanceof HostDownloadError) throw error;
      throw new HostDownloadError('No se pudo conectar con el proveedor de este enlace.');
    });
    if ('link' in result) return result.link;
    throw new HostDownloadError(result.message, result.status);
  }

  private async resolveMega(url: string, accountId?: string) {
    try {
      return await this.mega.resolve(url, accountId);
    } catch (error) {
      if (error instanceof Error && /^ENOENT/.test(error.message) && !accountId)
        throw new HostDownloadError('El enlace de MEGA ya no está disponible.', 'offline');
      throw new HostDownloadError('MEGA no pudo abrir el enlace. Comprueba la clave y el acceso.');
    }
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

  add(url: string, id: string, accountId?: string) {
    return this.route(url, accountId, async (source, mega, selected) => {
      if (mega) {
        if (selected && !accountId) await this.resolveMega(source.href, selected);
        return this.mega.add(source.href, id, selected);
      }
      return this.gopeed.add(await this.direct(source, selected), id);
    });
  }

  resolve(url: string, accountId?: string) {
    return this.route(url, accountId, async (source, mega, selected) => {
      if (mega) return this.resolveMega(source.href, selected);
      return this.gopeed.resolve(await this.direct(source, selected));
    });
  }

  async check(url: string): Promise<DownloadLinkCheck> {
    try {
      return await this.route<DownloadLinkCheck>(url, undefined, async (source, mega, selected) => {
        if (mega) {
          const resource = await this.resolveMega(source.href, selected);
          return {
            status: 'online',
            name: resource.name || resource.files[0]?.name,
            total: resource.size,
          };
        }
        if (selected) {
          const result = await this.hosts.direct(source, this.accounts.get(selected), true);
          if (result.name) return { status: 'online', name: result.name, total: result.total };
          const resource = await this.gopeed.resolve(result.link);
          return {
            status: 'online',
            name: resource.name || resource.files[0]?.name,
            total: resource.size,
          };
        }
        if (megaHost(source.hostname))
          throw new HostDownloadError(
            'Introduce un enlace HTTPS de MEGA con su clave de descifrado.',
          );
        const host = nativeHost(source.hostname);
        if (host) {
          const result = await this.hosts.publicLink(source, host);
          if ('status' in result) return result;
          const resource = await this.gopeed.resolve(result.link);
          return {
            status: 'online',
            name: result.name || resource.name || resource.files[0]?.name,
            total: result.total ?? resource.size,
          };
        }
        const resource = await this.gopeed.resolve(source.href);
        return {
          status: 'online',
          name: resource.name || resource.files[0]?.name,
          total: resource.size,
        };
      }).then((result: DownloadLinkCheck) => ({
        ...result,
        name: result.name && this.displayName(result.name),
      }));
    } catch (error) {
      return error instanceof HostDownloadError
        ? { status: error.status, message: error.message }
        : { status: 'unknown', message: 'No se pudo confirmar la disponibilidad del enlace.' };
    }
  }

  private displayName(name: string) {
    try {
      return safeName(name);
    } catch {
      return undefined;
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
