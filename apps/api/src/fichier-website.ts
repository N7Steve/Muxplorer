import type { DownloadAccount, DownloadAccountStatus } from '@muxplorer/shared';
import { createHash } from 'node:crypto';
import { DomUtils, parseDocument } from 'htmlparser2';
import { HostDownloadError } from './download-provider';

type Credentials = DownloadAccount & { secret: string };
const origin = 'https://1fichier.com';
const login = origin + '/login.pl';
const consolePage = origin + '/console/index.pl';
const site = (host: string) => host === '1fichier.com' || host === 'www.1fichier.com';
const service = (url: URL) =>
  url.protocol === 'https:' &&
  !url.username &&
  !url.password &&
  !url.port &&
  (site(url.hostname) || url.hostname.endsWith('.1fichier.com'));

class WebsiteLoginError extends Error {
  constructor(readonly status: DownloadAccountStatus) {
    super();
  }
}

function challenge(response: Response, html: string) {
  return (
    response.headers.get('cf-mitigated') === 'challenge' ||
    /cf-chl-|g-recaptcha|h-captcha|name=["']captcha/i.test(html)
  );
}

async function pageText(response: Response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  try {
    while (html.length < 192_000) {
      const { value, done } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    await reader.cancel();
  }
}

function downloadError(response: Response, html: string) {
  if (
    response.status === 404 ||
    response.status === 410 ||
    /file not found|fichier introuvable/i.test(html)
  )
    throw new HostDownloadError('1fichier indica que el archivo ya no está disponible.', 'offline');
  if (challenge(response, html))
    throw new HostDownloadError('1fichier requiere resolver un CAPTCHA.', 'captcha');
  if (response.status === 429 || /too fast|you must wait|flood detected/i.test(html))
    throw new HostDownloadError('1fichier ha limitado las solicitudes. Inténtalo más tarde.');
  if (
    response.status === 403 ||
    /professional infrastructure|IP locked|reserved access to the subscribers/i.test(html)
  )
    throw new HostDownloadError('1fichier denegó el acceso al archivo desde esta cuenta o red.');
}

class WebsiteSession {
  constructor(private sid = '') {}
  private readonly signal = AbortSignal.timeout(12000);

  cookie() {
    return this.sid;
  }

  async request(url: string | URL, body?: URLSearchParams, authenticated = true) {
    const target = new URL(url);
    if (!service(target) || (body && !site(target.hostname))) throw new Error();
    const response = await fetch(target, {
      method: body ? 'POST' : 'GET',
      body,
      headers: {
        'Accept-Language': 'en',
        ...(body && { Origin: origin }),
        ...(authenticated && this.sid && site(target.hostname) && { Cookie: this.sid }),
      },
      redirect: 'manual',
      signal: this.signal,
    });
    if (authenticated && site(target.hostname)) {
      for (const header of response.headers.getSetCookie()) {
        const sid = /^SID=([\x21-\x3a\x3c-\x7e]*)(?:;|$)/.exec(header)?.[1];
        if (sid !== undefined) this.sid = sid && sid !== 'deleted' ? 'SID=' + sid : '';
      }
    }
    return response;
  }
}

function downloadLink(page: string, base: URL) {
  const elements = DomUtils.findAll(() => true, parseDocument(page).children);
  const anchor = elements.find(
    (element) =>
      element.name === 'a' &&
      /^(?:Click here to|Start your) download\b/i.test(DomUtils.textContent(element).trim()),
  );
  const href = anchor?.attribs.href && URL.parse(anchor.attribs.href, base);
  if (href && service(href) && href.href !== base.href && !href.pathname.endsWith('.pl'))
    return href;
  return undefined;
}

function downloadForm(html: string, source: URL) {
  const forms = DomUtils.findAll((el) => el.name === 'form', parseDocument(html).children);
  for (const form of forms) {
    const inputs = DomUtils.findAll((el) => el.name === 'input', form.children);
    if (inputs.some((el) => el.attribs.name === 'pass' || el.attribs.type === 'password')) continue;
    const action = URL.parse(form.attribs.action || source.href, source);
    if (
      !action ||
      !service(action) ||
      action.origin !== source.origin ||
      (action.href !== source.href &&
        !(action.pathname === '/download.pl' || action.pathname === '/')) ||
      (action.pathname === '/' && action.search && action.search !== source.search) ||
      form.attribs.method?.toLowerCase() !== 'post'
    )
      continue;
    if (
      !inputs.some((el) => el.attribs.name === 'did' || el.attribs.name === 'dl_no_ssl') &&
      !/\bdownload\b/i.test(DomUtils.textContent(form)) &&
      !inputs.some((el) => el.attribs.type === 'submit' && /download/i.test(el.attribs.value ?? ''))
    )
      continue;
    const fields = new URLSearchParams();
    for (const { attribs } of inputs)
      if (
        attribs.name &&
        attribs.type?.toLowerCase() === 'hidden' &&
        !['save', 'dl_no_ssl'].includes(attribs.name)
      )
        fields.set(attribs.name, attribs.value ?? '');
    fields.set('did', '1');
    if (action.pathname === '/' && !action.search) action.search = source.search;
    return { action, fields };
  }
  return undefined;
}

function redirect(response: Response, base: URL) {
  const location = response.headers.get('location');
  return [301, 302, 303].includes(response.status) && location
    ? URL.parse(location, base)
    : undefined;
}

function loginError(response: Response, html: string) {
  if (challenge(response, html)) return new WebsiteLoginError('captcha');
  if (/name=["']tfa["']/i.test(html)) return new WebsiteLoginError('two-factor');
  if (response.status === 429 || /flood detected|requests are too fast/i.test(html))
    return new WebsiteLoginError('rate-limited');
  if (response.status === 403 || /account will be unlock|IP locked/i.test(html))
    return new WebsiteLoginError('restricted');
  if (
    response.status === 401 ||
    /(?:invalid|incorrect|wrong)[^<>]{0,35}(?:login|email|password)|identification failed|name=["']pass["']/i.test(
      html,
    )
  )
    return new WebsiteLoginError('invalid');
  return new WebsiteLoginError('unavailable');
}

export class FichierWebsite {
  private readonly sessions = new Map<
    string,
    { fingerprint: string; until: number; pending: Promise<string> }
  >();

  forget(id: string) {
    this.sessions.delete(id);
  }

  async verify(account: Credentials): Promise<DownloadAccountStatus> {
    try {
      await this.session(account);
      return 'connected';
    } catch (error) {
      return error instanceof WebsiteLoginError ? error.status : 'unavailable';
    }
  }

  private session(account: Credentials) {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([account.email, account.secret]))
      .digest('hex');
    const existing = this.sessions.get(account.id);
    if (existing?.fingerprint === fingerprint && existing.until > Date.now())
      return existing.pending;
    const pending = this.login(account).catch((error: unknown) => {
      if (this.sessions.get(account.id)?.pending === pending) this.forget(account.id);
      throw error;
    });
    this.sessions.set(account.id, { fingerprint, until: Date.now() + 600_000, pending });
    return pending;
  }

  private async login(account: Credentials) {
    if (!account.email) throw new WebsiteLoginError('invalid');
    const session = new WebsiteSession();
    const start = await session.request(login);
    const startHtml = await pageText(start);
    if (!start.ok || challenge(start, startHtml)) throw loginError(start, startHtml);
    const response = await session.request(
      login,
      new URLSearchParams({
        mail: account.email,
        pass: account.secret,
        valider: 'OK',
      }),
    );
    const next = redirect(response, new URL(login));
    if (next) {
      await response.body?.cancel();
      if (!service(next) || !site(next.hostname)) throw new WebsiteLoginError('unavailable');
    } else {
      const html = await pageText(response);
      if (session.cookie() && /\/logout\.pl\b/i.test(html)) return session.cookie();
      if (!session.cookie() || /name=["']tfa["']/i.test(html)) throw loginError(response, html);
    }
    const accountPage = await session.request(consolePage);
    const html = await pageText(accountPage);
    if (!accountPage.ok || !session.cookie() || !/\/logout\.pl\b/i.test(html))
      throw loginError(accountPage, html);
    return session.cookie();
  }

  async direct(source: URL, account: Credentials): Promise<{ link: string }> {
    const url = new URL(source);
    url.protocol = 'https:';
    if (
      !service(url) ||
      !site(url.hostname) ||
      url.pathname !== '/' ||
      !/^\?[a-z0-9]{5,20}$/i.test(url.search)
    )
      throw new HostDownloadError('Introduce un enlace de archivo de 1fichier válido.');
    url.hash = '';
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const cookie = await this.session(account);
        const session = new WebsiteSession(cookie);
        const response = await session.request(url);
        if (redirect(response, url)?.pathname === '/login.pl') {
          await response.body?.cancel();
          this.forget(account.id);
          continue;
        }
        return { link: await this.resolveFile(url, response, session) };
      }
      throw new WebsiteLoginError('unavailable');
    } catch (error) {
      if (error instanceof HostDownloadError) throw error;
      if (error instanceof WebsiteLoginError) {
        if (error.status === 'invalid')
          throw new HostDownloadError(
            '1fichier rechazó el correo o la contraseña.',
            'account-required',
          );
        if (error.status === 'captcha' || error.status === 'two-factor')
          throw new HostDownloadError(
            'El acceso web de 1fichier requiere una comprobación adicional.',
            'captcha',
          );
      }
      throw new HostDownloadError(
        'No se pudo preparar el archivo mediante el acceso web de 1fichier.',
      );
    }
  }

  private async resolveFile(url: URL, response: Response, session: WebsiteSession) {
    const next = redirect(response, url);
    if (next) {
      await response.body?.cancel();
      if (service(next) && !next.pathname.endsWith('.pl') && next.href !== url.href)
        return next.href;
      throw new HostDownloadError('1fichier no devolvió un enlace directo de descarga.');
    }
    if (response.ok && response.headers.get('content-disposition')?.startsWith('attachment')) {
      await response.body?.cancel();
      const publicFile = await session.request(url, undefined, false);
      await publicFile.body?.cancel();
      if (publicFile.ok && publicFile.headers.get('content-disposition')?.startsWith('attachment'))
        return url.href;
      throw new HostDownloadError('1fichier requiere la sesión web para transferir este enlace.');
    }
    const html = await pageText(response);
    downloadError(response, html);
    if (!response.ok) throw new Error();
    const direct = downloadLink(html, url);
    if (direct) return direct.href;
    const form = downloadForm(html, url);
    if (!form)
      throw new HostDownloadError('1fichier no ofreció una descarga directa para esta cuenta.');
    const submitted = await session.request(form.action, form.fields);
    const target = redirect(submitted, form.action);
    if (target) {
      await submitted.body?.cancel();
      if (service(target) && !target.pathname.endsWith('.pl') && target.href !== url.href)
        return target.href;
    } else if (!submitted.headers.get('content-disposition')?.startsWith('attachment')) {
      const page = await pageText(submitted);
      downloadError(submitted, page);
      const link = downloadLink(page, form.action);
      if (submitted.ok && link) return link.href;
    } else {
      await submitted.body?.cancel();
    }
    throw new HostDownloadError('1fichier no devolvió un enlace directo de descarga.');
  }
}
