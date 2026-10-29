import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  Query,
  Param,
  Sse,
  UseGuards,
  OnModuleInit,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { interval, map, merge, takeUntil, takeWhile } from 'rxjs';
import { z } from 'zod';
import { readFile, access } from 'node:fs/promises';
import { Auth, AuthGuard } from './auth';
import { Files } from './files';
import { Paths } from './paths';
import { Jobs } from './jobs';
import { Archives, ExtractRequest } from './archives';
import { Mkv } from './mkv';
import { MakeMkv, MakeRequest } from './makemkv';
import { Processes } from './process';
import { config } from './config';
import { errorText, problem } from './errors';
import * as contract from './contracts';
@Controller('api')
export class PublicController {
  constructor(private readonly auth: Auth) {}
  @Get('health') health() {
    return { status: 'ok', application: 'Muxplorer' };
  }
  @Get('auth/session') session(@Req() req: Request) {
    const authenticated = this.auth.authenticated(req);
    return {
      configured: this.auth.ready(),
      authenticated,
      ...(authenticated ? { username: this.auth.username() } : {}),
    };
  }
  @Post('auth/setup') setup(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = contract.parse(
      z.object({ username: z.string().min(1).max(64), password: z.string().max(256) }).strict(),
      body,
    );
    return this.auth.setup(data.username, data.password, req, res);
  }
  @Post('auth/login') login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = contract.parse(
      z.object({ username: z.string().min(1).max(64), password: z.string().max(256) }).strict(),
      body,
    );
    return this.auth.login(data.username, data.password, req, res);
  }
  @Post('auth/logout') logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.auth.logout(req, res);
    return { ok: true };
  }
}
@Controller('api')
@UseGuards(AuthGuard)
export class ApiController implements OnModuleInit {
  constructor(
    private readonly files: Files,
    private readonly paths: Paths,
    private readonly jobs: Jobs,
    private readonly archives: Archives,
    private readonly mkv: Mkv,
    private readonly make: MakeMkv,
    private readonly processes: Processes,
    private readonly auth: Auth,
  ) {}
  onModuleInit() {
    for (const kind of ['copy', 'move', 'delete'] as const)
      this.jobs.register(kind, (payload, context) =>
        this.files.operate(kind, contract.parse(contract.fileOperation, payload), context),
      );
    this.jobs.register('extract', (payload, context) =>
      this.archives.extract(payload as ExtractRequest, context),
    );
    this.jobs.register('remux', (payload, context) =>
      this.mkv.remux(contract.parse(contract.remux, payload), context),
    );
    this.jobs.register('makemkv', (payload, context) =>
      this.make.convert(payload as MakeRequest, context),
    );
  }
  @Get('roots') roots() {
    return this.paths.listRoots();
  }
  @Get('files') list(@Query() query: unknown) {
    return this.files.list(contract.parse(contract.location, query));
  }
  @Post('files/mkdir') mkdir(@Body() body: unknown) {
    const data = contract.parse(
      z.object({ parent: contract.location, name: z.string() }).strict(),
      body,
    );
    return this.files.create(data.parent, data.name);
  }
  @Post('files/rename') rename(@Body() body: unknown) {
    const data = contract.parse(
      z.object({ source: contract.location, name: z.string() }).strict(),
      body,
    );
    return this.files.rename(data.source, data.name);
  }
  @Post('files/operation') operation(@Body() body: unknown) {
    const data = contract.parse(contract.fileOperation, body);
    if (data.kind === 'delete' && !data.confirmed) problem('Confirma la eliminación.');
    return this.jobs.enqueue(data.kind, data, data.sources, data.destination);
  }
  @Post('archives/extract') extract(@Body() body: unknown) {
    const data = contract.parse(contract.extract, body);
    const persisted = { ...data };
    delete persisted.password;
    return this.jobs.enqueue(
      'extract',
      persisted,
      [data.source],
      data.destination,
      data.password ? data : undefined,
    );
  }
  @Post('media/inspect') inspect(@Body() body: unknown) {
    return this.mkv.inspect(contract.parse(contract.location, body));
  }
  @Post('media/remux') remux(@Body() body: unknown) {
    const data = contract.parse(contract.remux, body);
    return this.jobs.enqueue('remux', data, data.sources, data.destination);
  }
  @Post('makemkv/inspect') disc(@Body() body: unknown) {
    return this.make.inspect(contract.parse(contract.location, body));
  }
  @Get('makemkv/license') async license(@Res() res: Response) {
    res.type('text/plain').send(await readFile(config.LICENSE_FILE, 'utf8'));
  }
  @Post('makemkv/accept-license') accept(@Body() body: unknown) {
    contract.parse(z.object({ accepted: z.literal(true) }).strict(), body);
    this.make.acceptLicense();
    return { ok: true };
  }
  @Post('makemkv/convert') convert(@Body() body: unknown) {
    const data = contract.parse(contract.make, body);
    return this.jobs.enqueue('makemkv', data, [data.source], data.destination);
  }
  @Get('jobs') listJobs() {
    return this.jobs.list();
  }
  @Sse('jobs/events') events(@Req() req: Request) {
    return merge(
      this.jobs.events,
      interval(15_000).pipe(map(() => ({ data: { heartbeat: true } }))),
    ).pipe(
      takeUntil(this.jobs.shutdown),
      takeWhile(() => this.auth.authenticated(req)),
    );
  }
  @Post('jobs/:id/cancel') cancel(@Param('id') id: string) {
    this.jobs.cancel(id);
    return { ok: true };
  }
  @Post('jobs/:id/review') review(@Param('id') id: string, @Body() body: unknown) {
    const data = contract.parse(
      z
        .object({
          files: z
            .array(
              z
                .object({
                  index: z.number().int().nonnegative(),
                  name: z
                    .string()
                    .max(240)
                    .regex(/\.mkv$/i),
                  tracks: z.array(contract.choice).min(1).max(256),
                })
                .strict(),
            )
            .min(1)
            .max(100),
        })
        .strict(),
      body,
    );
    const job = this.jobs.get(id);
    if (job.kind !== 'makemkv') problem('Trabajo incompatible.');
    const payload = this.jobs.payload(id) as MakeRequest;
    payload.review = data.files;
    return this.jobs.resumeReview(id, payload);
  }
  @Post('jobs/:id/cleanup') async cleanup(@Param('id') id: string) {
    const job = this.jobs.get(id);
    if (['running', 'pending'].includes(job.status))
      problem('Cancela el trabajo antes de limpiar.');
    if (job.destination)
      await this.files.exclusive(() => this.files.cleanup(job.destination!, job.id));
    this.jobs.markCleaned(id);
    return { ok: true };
  }
  @Get('system') async system() {
    const tools = await Promise.all(
      [
        ['sevenZip', config.SEVENZIP_BIN, ['i']],
        ['mkvmerge', config.MKVMERGE_BIN, ['--version']],
        ['makemkv', config.MAKEMKV_BIN, ['-r', '--noscan', '--cache=1', 'info', 'disc:9999']],
      ].map(async ([key, binary, args]) => {
        if (key === 'makemkv' && !this.make.accepted()) {
          const installed = await access('/usr/bin/makemkvcon')
            .then(() => true)
            .catch(() => false);
          return [
            key,
            {
              available: false,
              installed,
              licenseRequired: true,
              error: 'Lee y acepta la licencia de MakeMKV para habilitarlo.',
            },
          ];
        }
        try {
          const result = await this.processes.run(binary as string, args as string[], {
            timeout: 15_000,
            allowedCodes: [0, 1],
          });
          return [
            key,
            {
              available: true,
              version:
                result.stdout.split(/\r?\n/).find((line) => /7-Zip|mkvmerge|MakeMKV/i.test(line)) ??
                result.stdout.slice(0, 180),
            },
          ];
        } catch (error) {
          return [key, { available: false, error: errorText(error) }];
        }
      }),
    );
    return { tools: Object.fromEntries(tools), concurrency: config.JOB_CONCURRENCY };
  }
}
