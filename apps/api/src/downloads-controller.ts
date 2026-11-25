import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from './auth';
import { location, parse } from './contracts';
import { DownloadAccounts } from './download-accounts';
import { DownloadRouting } from './download-routing';
import { Downloads } from './downloads';
import { safeName } from './paths';

const id = z.uuid().transform((value) => value.toLowerCase());
const url = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => {
    const parsed = URL.parse(value);
    return (
      parsed &&
      !/[\x00-\x20\x7f]/.test(value) &&
      ((!parsed.username &&
        !parsed.password &&
        parsed.hostname &&
        /^https?:\/\//i.test(value) &&
        ['http:', 'https:'].includes(parsed.protocol)) ||
        (parsed.protocol === 'magnet:' &&
          /^magnet:\?/i.test(value) &&
          parsed.searchParams
            .getAll('xt')
            .some((item) => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(item))))
    );
  }, 'Introduce un enlace HTTP, HTTPS o magnet de BitTorrent válido.');
const batch = z
  .object({
    links: z
      .array(
        z.strictObject({
          id,
          url,
          name: z.string().min(1).max(240).optional(),
          expectedParts: z.number().int().min(1).max(99999).optional(),
        }),
      )
      .min(1),
    destination: location.optional(),
    accountId: id.optional(),
  })
  .strict()
  .refine(
    ({ links }) => new Set(links.map((link) => link.id)).size === links.length,
    'Los identificadores del lote deben ser únicos.',
  );
const pagination = z
  .object({
    page: z.coerce.number().int().min(0).max(1_000_000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    filter: z.enum(['all', 'active', 'paused', 'issues', 'completed', 'cancelled']).default('all'),
    query: z.string().trim().max(240).default(''),
  })
  .strict();
const action = z.enum(['pause', 'resume', 'cancel', 'remove', 'publish']);
const bulk = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('all'),
    action: z.enum(['pause', 'resume', 'clear-finished']),
  }),
  z.strictObject({
    scope: z.literal('ids'),
    ids: z.array(id).min(1).max(200),
    action,
  }),
]);
const accountFields = {
  id: id.optional(),
  label: z.string().trim().min(1).max(80),
};
const token = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .regex(/^[\x21-\x7e]+$/)
  .optional();
const account = z.discriminatedUnion('provider', [
  z.strictObject({ ...accountFields, provider: z.literal('1fichier'), secret: token }),
  z.strictObject({
    ...accountFields,
    provider: z.literal('1fichier-web'),
    email: z.email().max(254),
    secret: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({ ...accountFields, provider: z.literal('real-debrid'), secret: token }),
  z.strictObject({ ...accountFields, provider: z.literal('terabox'), secret: token }),
  z.strictObject({ ...accountFields, provider: z.literal('katfile'), secret: token }),
  z.strictObject({
    ...accountFields,
    provider: z.literal('nitroflare'),
    email: z.email().max(254),
    secret: token,
  }),
  z.strictObject({
    ...accountFields,
    provider: z.literal('rapidgator'),
    email: z.email().max(254),
    secret: z.string().min(1).max(1024).optional(),
  }),
  z.strictObject({
    ...accountFields,
    provider: z.literal('mega'),
    email: z.email().max(254),
    secret: z.string().min(1).max(1024).optional(),
  }),
]);

@Controller('api/downloads')
@UseGuards(AuthGuard)
export class DownloadsController {
  constructor(
    private readonly downloads: Downloads,
    private readonly accounts: DownloadAccounts,
    private readonly routing: DownloadRouting,
  ) {}

  @Get() list(@Query() query: unknown) {
    const { page, limit, filter, query: name } = parse(pagination, query);
    return this.downloads.list(page, limit, filter, name);
  }

  @Get('status') status() {
    return this.downloads.status();
  }

  @Post() add(@Body() body: unknown) {
    const { links, destination, accountId } = parse(batch, body);
    for (const link of links) if (link.name) safeName(link.name);
    return this.downloads.add(links, destination, accountId);
  }

  @Post('resolve') analyze(@Body() body: unknown) {
    const source = parse(z.strictObject({ url, accountId: id.optional() }), body);
    return this.downloads.analyze(source.url, source.accountId);
  }

  @Post('check') check(@Body() body: unknown) {
    const source = parse(z.strictObject({ url, accountId: id.optional() }), body);
    return this.downloads.check(source.url, source.accountId);
  }

  @Post('bulk') bulk(@Body() body: unknown) {
    return this.downloads.bulk(parse(bulk, body));
  }

  @Get('settings') settings() {
    return { destination: this.downloads.destination(), accounts: this.accounts.list() };
  }

  @Post('settings') async setSettings(@Body() body: unknown) {
    const { destination } = parse(z.strictObject({ destination: location }), body);
    await this.downloads.setDestination(destination);
    return this.settings();
  }

  @Post('accounts') saveAccount(@Body() body: unknown) {
    return this.routing.saveAccount(parse(account, body));
  }

  @Post('accounts/check') checkAccount(@Body() body: unknown) {
    return this.routing.checkAccount(parse(z.strictObject({ id }), body).id);
  }

  @Post('accounts/remove') removeAccount(@Body() body: unknown) {
    return this.routing.removeAccount(parse(z.strictObject({ id }), body).id);
  }

  @Get(':id') detail(@Param('id') value: string) {
    return this.downloads.get(parse(id, value));
  }

  @Get(':id/location') location(@Param('id') value: string) {
    return this.downloads.result(parse(id, value));
  }

  @Post(':id/:action') command(@Param('id') value: string, @Param('action') operation: string) {
    return this.downloads.command(parse(id, value), parse(action, operation));
  }
}
