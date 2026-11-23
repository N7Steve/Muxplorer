import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from './auth';
import { parse } from './contracts';
import { Downloads } from './downloads';

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
    links: z.array(z.object({ id, url }).strict()).min(1).max(20),
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
  })
  .strict();
const action = z.enum(['pause', 'resume', 'cancel', 'remove', 'publish']);

@Controller('api/downloads')
@UseGuards(AuthGuard)
export class DownloadsController {
  constructor(private readonly downloads: Downloads) {}

  @Get() list(@Query() query: unknown) {
    const { page, limit } = parse(pagination, query);
    return this.downloads.list(page, limit);
  }

  @Get('status') status() {
    return this.downloads.status();
  }

  @Post() add(@Body() body: unknown) {
    return this.downloads.add(parse(batch, body).links);
  }

  @Post('resolve') analyze(@Body() body: unknown) {
    return this.downloads.analyze(parse(z.object({ url }).strict(), body).url);
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
