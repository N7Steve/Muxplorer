import type {
  DownloadAccount,
  DownloadAccountProvider,
  DownloadAccountStatus,
} from '@muxplorer/shared';
import { z } from 'zod';
import { HostDownloadError } from './download-provider';
import { FichierWebsite } from './fichier-website';

type Credentials = DownloadAccount & { secret: string };
type NativeHost = Exclude<DownloadAccountProvider, 'mega' | 'real-debrid' | '1fichier-web'>;
type Json = Record<string, unknown>;
type PublicLink =
  | { link: string; name?: string; total?: number }
  | { status: HostDownloadError['status']; message: string; name?: string; total?: number };

const hosts: Record<NativeHost, string[]> = {
  '1fichier': ['1fichier.com'],
  rapidgator: ['rapidgator.net', 'rapidgator.asia', 'rg.to'],
  nitroflare: ['nitroflare.com', 'nitroflare.net', 'nitro.download'],
  katfile: ['katfile.com'],
  terabox: ['terabox.com', 'terabox.app', 'teraboxlink.com', '1024terabox.com', '1024tera.com'],
};
const fichier = 'https://api.1fichier.com/v1/';
const debrid = 'https://api.real-debrid.com/rest/1.0/';
const rapidgator = 'https://rapidgator.net/api/v2/';
const nitroflare = 'https://nitroflare.com/api/v2/';
const katfile = 'https://katfile.com/api/';
const terabox = 'https://www.terabox.com/openapi/';
const object = z.record(z.string(), z.unknown());
const text = z.string().min(1);

export function nativeHost(hostname: string) {
  const host = hostname.replace(/^www\./, '');
  return (Object.keys(hosts) as NativeHost[]).find((provider) => hosts[provider].includes(host));
}

function json(value: unknown) {
  return object.parse(value);
}

class AccountRejected extends Error {
  constructor(readonly status: DownloadAccountStatus) {
    super();
  }
}

function missing() {
  return new HostDownloadError(
    'El servidor indica que el archivo ya no está disponible.',
    'offline',
  );
}

function captcha() {
  return new HostDownloadError('El servidor requiere resolver un CAPTCHA.', 'captcha');
}

function accountRequired() {
  return new HostDownloadError(
    'Este enlace necesita una cuenta compatible o acceso prémium.',
    'account-required',
  );
}

function browserRequired() {
  return new HostDownloadError('Abre el enlace en el proveedor para comprobar el acceso.');
}

async function request(
  base: string,
  endpoint: string,
  params?: Record<string, string>,
  init?: RequestInit,
) {
  const url = new URL(endpoint, base);
  if (params) url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(7000),
  });
  if (response.headers.get('cf-mitigated') === 'challenge') {
    await response.body?.cancel();
    throw captcha();
  }
  const data = object.safeParse(await response.json().catch(() => null)).data;
  if (response.status === 403 && !data && base !== fichier) throw new Error();
  return { http: response.status, data: data ?? {} };
}

const bearer = (secret: string) => ({ Authorization: 'Bearer ' + secret });
const post = (secret: string, body: Json) => ({
  method: 'POST',
  headers: { ...bearer(secret), 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function accepted(http: number) {
  if (http === 401 || http === 403) throw new AccountRejected('invalid');
  if (http < 200 || http >= 300) throw new Error();
}

function fichierError(http: number, data: Json, checkingFile = false) {
  const message = String(data.message ?? '');
  if (
    http === 429 ||
    /too many requests|rate limit|requests? too frequent|flood detected/i.test(message)
  )
    throw new AccountRejected('rate-limited');
  if (/captcha/i.test(message)) throw captcha();
  if (
    http === 403 ||
    /(?:ip|country|account).*(?:blocked|banned|restricted)|(?:access|permission) denied/i.test(
      message,
    )
  )
    throw new AccountRejected('restricted');
  if (http === 401 || /invalid (api )?key|key (?:is )?not valid|not authenticated/i.test(message))
    throw new AccountRejected('invalid');
  if (checkingFile && (http === 404 || /not found|does not exist|deleted/i.test(message)))
    throw missing();
}

export class DownloadHosts {
  private readonly fichierWebsite = new FichierWebsite();
  private readonly rapidSessions = new Map<
    string,
    { secret: string; expires: number; token: Promise<string> }
  >();
  private debridHosts?: { expires: number; domains: Promise<string[]> };

  debridSupports(host: string) {
    if (!this.debridHosts || this.debridHosts.expires < Date.now()) {
      this.debridHosts = {
        expires: Date.now() + 300_000,
        domains: fetch(new URL('hosts/domains', debrid), {
          redirect: 'error',
          signal: AbortSignal.timeout(7000),
        })
          .then(async (response) => {
            if (!response.ok) {
              await response.body?.cancel();
              throw new Error();
            }
            return z.array(z.string()).parse(await response.json());
          })
          .catch(() => {
            this.debridHosts = undefined;
            return [];
          }),
      };
    }
    return this.debridHosts.domains.then((domains) =>
      domains.some((domain) => host === domain || host.endsWith('.' + domain)),
    );
  }

  forget(id: string) {
    this.fichierWebsite.forget(id);
    this.rapidSessions.delete(id);
  }

  private async rapid(endpoint: string, params: Record<string, string>) {
    const { http, data } = await request(rapidgator, endpoint, params);
    const status = Number(data.status ?? http);
    if (status === 404 && endpoint === 'file/info') throw missing();
    if (status === 401) throw new AccountRejected('invalid');
    if (/captcha/i.test(String(data.response_details ?? data.details ?? ''))) throw captcha();
    if (status !== 200 || http !== 200) throw new Error();
    return json(data.response);
  }

  private rapidToken(account: Credentials) {
    const previous = this.rapidSessions.get(account.id);
    if (previous?.secret === account.secret && previous.expires > Date.now()) return previous.token;
    const token = this.rapid('user/login', { login: account.email!, password: account.secret })
      .then((result) => text.parse(result.token ?? result.session_id))
      .catch((error: unknown) => {
        if (this.rapidSessions.get(account.id)?.token === token) this.forget(account.id);
        throw error;
      });
    this.rapidSessions.set(account.id, {
      secret: account.secret,
      expires: Date.now() + 600_000,
      token,
    });
    return token;
  }

  private async rapidFile(
    account: Credentials,
    endpoint: 'file/info' | 'file/download',
    fileId: string,
  ) {
    const token = await this.rapidToken(account);
    try {
      return await this.rapid(endpoint, { token, file_id: fileId });
    } catch (error) {
      if (!(error instanceof AccountRejected)) throw error;
      this.forget(account.id);
      return this.rapid(endpoint, { token: await this.rapidToken(account), file_id: fileId });
    }
  }

  private async nitro(endpoint: string, params: Record<string, string>) {
    const { http, data } = await request(nitroflare, endpoint, params);
    switch (data.code) {
      case 1:
        throw accountRequired();
      case 4:
        throw missing();
      case 6:
      case 12:
        throw captcha();
      case 8:
        throw new AccountRejected('invalid');
    }
    accepted(http);
    if (data.type === 'error') throw new Error();
    return json(data.result);
  }

  private async kata(endpoint: string, params: Record<string, string>) {
    const { http, data } = await request(katfile, endpoint, params);
    const message = String(data.msg ?? '');
    if (/invalid.*key|wrong.*key/i.test(message)) throw new AccountRejected('invalid');
    if (/captcha/i.test(message)) throw captcha();
    if (endpoint === 'file/direct_link' && /not found|not owned|own files/i.test(message))
      throw accountRequired();
    accepted(http);
    if (Number(data.status ?? 200) !== 200 || (message && message !== 'OK')) throw new Error();
    return json(data.result);
  }

  private async tera(endpoint: string, token: string, params: Record<string, string> = {}) {
    const { http, data } = await request(terabox, endpoint, { access_tokens: token, ...params });
    accepted(http);
    const errno = Number(data.errno ?? 0);
    if (
      [-6, 110, 111, 200002].includes(errno) ||
      /(?:invalid|expired) access[_ ]token/i.test(String(data.show_msg ?? ''))
    )
      throw new AccountRejected('invalid');
    if (errno !== 0) throw browserRequired();
    return data;
  }

  async verify(account: Credentials): Promise<DownloadAccountStatus> {
    try {
      switch (account.provider) {
        case '1fichier-web':
          return this.fichierWebsite.verify(account);
        case '1fichier': {
          const { http, data } = await request(
            fichier,
            'user/info.cgi',
            undefined,
            post(account.secret, {}),
          );
          fichierError(http, data);
          if (http < 200 || http >= 300 || data.status !== 'OK') throw new Error();
          break;
        }
        case 'real-debrid': {
          const { http, data } = await request(debrid, 'user', undefined, {
            headers: bearer(account.secret),
          });
          accepted(http);
          text.parse(data.username);
          break;
        }
        case 'rapidgator':
          this.forget(account.id);
          await this.rapidToken(account);
          break;
        case 'nitroflare': {
          const result = await this.nitro('getKeyInfo', {
            user: account.email!,
            premiumKey: account.secret,
          });
          text.parse(result.status);
          break;
        }
        case 'katfile':
          await this.kata('account/info', { key: account.secret });
          break;
        case 'terabox': {
          const user = await this.tera('uinfo', account.secret);
          if (!user.uk) throw new Error();
          break;
        }
      }
      return 'connected';
    } catch (error) {
      if (error instanceof AccountRejected) return error.status;
      if (error instanceof HostDownloadError && error.status === 'captcha') return 'captcha';
      return 'unavailable';
    }
  }

  private async teraFile(source: URL, account: Credentials) {
    const short =
      source.pathname.match(/^\/s\/1([\w-]+)\/?$/)?.[1] ?? source.searchParams.get('surl');
    if (!short || !/^[\w-]+$/.test(short)) throw browserRequired();
    const data = await this.tera('share/list', account.secret, {
      shorturl: short,
      root: '1',
      page: '1',
      num: '100',
    });
    const files = z.array(object).parse(data.list);
    const requested = source.searchParams.get('fsid');
    const file = requested
      ? files.find((entry) => String(entry.fs_id ?? entry.fid_id) === requested)
      : files.length === 1
        ? files[0]
        : undefined;
    if (!file || Number(file.isdir) !== 0) throw browserRequired();
    const fid = String(file.fs_id ?? file.fid_id);
    if (!/^\d+$/.test(fid)) throw new Error();
    const result = file.dlink
      ? file
      : z.array(object).parse(
          (
            await this.tera('share/download', account.secret, {
              shareid: String(data.shareid),
              uk: String(data.uk),
              fid_list: '[' + fid + ']',
            })
          ).list,
        )[0];
    return {
      link: text.parse(result?.dlink),
      name: text.parse(file.server_filename),
      total: Number(file.size) || 0,
    };
  }

  async direct(
    source: URL,
    account: Credentials,
    checking = false,
  ): Promise<{ link: string; name?: string; total?: number }> {
    try {
      const url = source.href;
      let result: { link: string; name?: string; total?: number };
      switch (account.provider) {
        case '1fichier-web':
          return await this.fichierWebsite.direct(source, account);
        case '1fichier': {
          if (checking) {
            const info = await request(
              fichier,
              'file/info.cgi',
              undefined,
              post(account.secret, { url }),
            );
            fichierError(info.http, info.data, true);
            if (
              info.http === 200 &&
              info.data.status === 'OK' &&
              typeof info.data.filename === 'string'
            )
              return { link: url, name: info.data.filename, total: Number(info.data.size) || 0 };
          }
          const { http, data } = await request(
            fichier,
            'download/get_token.cgi',
            undefined,
            post(account.secret, { url, restrict_ip: 1 }),
          );
          fichierError(http, data, true);
          if (http < 200 || http >= 300 || data.status !== 'OK') throw new Error();
          result = { link: text.parse(data.url) };
          break;
        }
        case 'real-debrid': {
          const { http, data } = await request(
            debrid,
            checking ? 'unrestrict/check' : 'unrestrict/link',
            undefined,
            {
              method: 'POST',
              headers: {
                ...bearer(account.secret),
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({ link: url }),
            },
          );
          if (
            data.error === 'file_not_found' ||
            (data.error === 'hoster_unavailable' && http === 404)
          )
            throw missing();
          if (data.error === 'captcha_required') throw captcha();
          accepted(http);
          if (checking)
            return {
              link: url,
              name: text.parse(data.filename),
              total: Number(data.filesize) || 0,
            };
          result = { link: text.parse(data.download) };
          break;
        }
        case 'rapidgator': {
          const id = source.pathname.match(/^\/file\/([a-z0-9]{32}|\d+)(?:\/|$)/i)?.[1];
          if (!id) throw browserRequired();
          if (checking) {
            const file = json((await this.rapidFile(account, 'file/info', id)).file);
            return { link: url, name: text.parse(file.name), total: Number(file.size) || 0 };
          }
          result = {
            link: text.parse((await this.rapidFile(account, 'file/download', id)).download_url),
          };
          break;
        }
        case 'nitroflare': {
          const id = source.pathname.match(/^\/view\/([a-z0-9]+)(?:\/|$)/i)?.[1];
          if (!id) throw browserRequired();
          const file = checking ? await this.nitroInfo(id) : undefined;
          const data = await this.nitro('getDownloadLink', {
            user: account.email!,
            premiumKey: account.secret,
            file: id,
          });
          if (data.recaptchaPublic) throw captcha();
          result = { ...file, link: text.parse(data.url) };
          break;
        }
        case 'katfile': {
          const id = source.pathname.match(/^\/([a-z0-9]{12})(?:\/|$)/i)?.[1];
          if (!id) throw browserRequired();
          const data = await this.kata('file/direct_link', { key: account.secret, file_code: id });
          result = { link: text.parse(data.url), total: Number(data.size) || 0 };
          break;
        }
        case 'terabox':
          result = await this.teraFile(source, account);
          break;
        default:
          throw new Error();
      }
      const parsed = new URL(result.link);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
      return { ...result, link: parsed.href };
    } catch (error) {
      if (error instanceof HostDownloadError) throw error;
      if (error instanceof AccountRejected) {
        if (error.status === 'rate-limited')
          throw new HostDownloadError(
            '1fichier limitó las solicitudes. Vuelve a intentarlo más tarde.',
          );
        if (error.status === 'restricted')
          throw new HostDownloadError(
            '1fichier denegó el acceso. Revisa los permisos de API de la cuenta.',
          );
        throw new HostDownloadError('La cuenta fue rechazada o caducó.', 'account-required');
      }
      throw new HostDownloadError(
        'El proveedor no pudo preparar el archivo. Comprueba la cuenta, la cuota y el enlace.',
      );
    }
  }

  private async nitroInfo(id: string) {
    const data = await this.nitro('getFileInfo', { files: id });
    const file = object.safeParse(object.safeParse(data.files).data?.[id]).data;
    if ((Array.isArray(data.files) && !data.files.length) || file?.status === 'offline')
      throw missing();
    if (file?.status !== 'online') throw new Error();
    return { name: text.parse(file.name), total: Number(file.size) || 0 };
  }

  async publicLink(source: URL, host: NativeHost): Promise<PublicLink> {
    if (host === 'nitroflare') {
      const id = source.pathname.match(/^\/view\/([a-z0-9]+)(?:\/|$)/i)?.[1];
      if (id) {
        const file = await this.nitroInfo(id);
        const data = await this.nitro('getDownloadLink', { file: id }).catch(
          (error: unknown): Json => {
            if (error instanceof HostDownloadError) return { error };
            throw error;
          },
        );
        if (data.error instanceof HostDownloadError)
          return { ...file, status: data.error.status, message: data.error.message };
        if (data.recaptchaPublic)
          return { ...file, status: 'captcha' as const, message: captcha().message };
        if (typeof data.url === 'string') {
          const parsed = new URL(data.url);
          if (parsed.protocol === 'https:' && !parsed.username && !parsed.password)
            return { ...file, link: parsed.href };
        }
      }
    }
    const url = new URL('https://' + hosts[host][0]);
    url.pathname = source.pathname;
    url.search = source.search;
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(7000) });
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      throw missing();
    }
    if (response.ok && response.headers.get('content-disposition')?.startsWith('attachment')) {
      await response.body?.cancel();
      return { link: url.href };
    }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let page = '';
    try {
      while (reader && page.length < 96_000) {
        const { value, done } = await reader.read();
        if (done) break;
        page += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader?.cancel();
    }
    if (
      /file (?:not found|doesn.t exist|was deleted|has been removed)|fichier introuvable/i.test(
        page,
      )
    )
      throw missing();
    if (/cf-chl-|g-recaptcha|h-captcha|captcha-container|captcha required/i.test(page))
      throw captcha();
    if (
      /premium (?:users|account) only|only for premium/i.test(page) ||
      host === '1fichier' ||
      host === 'terabox'
    )
      throw accountRequired();
    throw browserRequired();
  }
}
