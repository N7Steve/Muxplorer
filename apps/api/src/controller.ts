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
  Header,
  UseGuards,
  OnModuleInit,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { interval, map, merge, takeUntil, takeWhile } from 'rxjs';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { Auth, AuthGuard } from './auth';
import { Files } from './files';
import { Paths } from './paths';
import { Jobs } from './jobs';
import { Archives, ExtractRequest } from './archives';
import { Mkv } from './mkv';
import { MakeMkv, MakeRequest, robotFields } from './makemkv';
import { Processes } from './process';
import { config } from './config';
import { errorText, problem } from './errors';
import * as contract from './contracts';
import { diagnostic } from './diagnostics';
import { Discs, DiscRequest } from './discs';
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
    private readonly discs: Discs,
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
    this.jobs.register('disc', (payload, context) =>
      this.discs.convert(payload as DiscRequest, context),
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
  @Post('disc/inspect') inspectDisc(@Body() body: unknown) {
    return this.discs.inspect(contract.parse(contract.location, body));
  }
  @Post('disc/prepare') prepareDisc(@Body() body: unknown) {
    const source = contract.parse(contract.location, body);
    const parent = { ...source, path: source.path.split('/').slice(0, -1).join('/') };
    return this.jobs.enqueue(
      'disc',
      { source, destination: parent, titles: [], name: '', prepare: true },
      [source],
      parent,
    );
  }
  @Post('jobs/:id/disc-selection') selectDisc(@Param('id') id: string, @Body() body: unknown) {
    const data = contract.parse(contract.make.omit({ source: true }), body);
    const job = this.jobs.get(id);
    if (
      job.kind !== 'disc' ||
      !job.awaitingDisc ||
      data.titles.some((title) => !job.awaitingDisc!.titles.some((t) => t.id === title))
    )
      problem('El análisis o la selección de títulos no es válido.');
    const payload = this.jobs.payload(id) as DiscRequest;
    return this.jobs.resumeDisc(id, { ...payload, ...data, prepare: false }, data.destination);
  }
  @Post('disc/convert') convertDisc(@Body() body: unknown) {
    const data = contract.parse(contract.make, body);
    return this.jobs.enqueue('disc', data, [data.source], data.destination);
  }
  @Get('makemkv/license') async license(@Res() res: Response) {
    res.type('text/plain').send(await readFile(config.LICENSE_FILE, 'utf8'));
  }
  @Post('makemkv/convert') convert(@Body() body: unknown) {
    const data = contract.parse(contract.make, body);
    return this.jobs.enqueue('makemkv', data, [data.source], data.destination);
  }
  @Get('jobs') listJobs() {
    return this.jobs.list();
  }
  @Header('X-Accel-Buffering', 'no')
  @Sse('jobs/events')
  events(@Req() req: Request) {
    diagnostic('sse.connected');
    req.once('close', () => diagnostic('sse.disconnected'));
    return merge(
      this.jobs.events,
      interval(15_000).pipe(map(() => ({ data: { heartbeat: true } }))),
    ).pipe(
      takeUntil(this.jobs.shutdown),
      takeWhile(() => this.auth.authenticated(req)),
    );
  }
  @Post('jobs/:id/cancel') async cancel(@Param('id') id: string) {
    this.jobs.cancel(id);
    const job = this.jobs.get(id);
    if (job.kind === 'disc' && job.status === 'cancelled')
      await this.discs.cleanupPreparation(job.sources[0], id);
    return { ok: true };
  }
  @Post('jobs/:id/start') start(@Param('id') id: string) {
    return this.jobs.start(id);
  }
  @Post('jobs/:id/dismiss') async dismiss(@Param('id') id: string) {
    const job = this.jobs.get(id);
    if (!['completed', 'failed', 'cancelled'].includes(job.status))
      problem('Termina o cancela la operación antes de retirarla.');
    if (job.destination) await this.files.exclusive(() => this.files.cleanup(job.destination!, id));
    if (job.kind === 'disc') await this.discs.cleanupPreparation(job.sources[0], id);
    this.jobs.markCleaned(id);
    return this.jobs.dismiss(id);
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
    if (!['makemkv', 'disc'].includes(job.kind)) problem('Trabajo incompatible.');
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
    if (job.kind === 'disc') await this.discs.cleanupPreparation(job.sources[0], job.id);
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
        try {
          const result = await this.processes.run(binary as string, args as string[], {
            timeout: 15_000,
            allowedCodes: key === 'makemkv' ? [0, 1, 10, 253] : [0, 1],
            ...(key === 'makemkv' ? { env: this.make.env() } : {}),
          });
          const versionLine =
            result.stdout.split(/\r?\n/).find((line) => /7-Zip|mkvmerge|MakeMKV/i.test(line)) ??
            result.stdout.slice(0, 180);
          const version =
            key === 'makemkv' && versionLine.startsWith('MSG:')
              ? (robotFields(versionLine.slice(4))[3] ?? versionLine)
              : versionLine;
          return [
            key,
            {
              available: true,
              version,
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
