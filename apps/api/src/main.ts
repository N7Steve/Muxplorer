import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { diagnostic } from './diagnostics';
import { config } from './config';
import { Store } from './store';
import { Auth, AuthGuard } from './auth';
import { Processes } from './process';
import { Paths } from './paths';
import { Files } from './files';
import { Jobs } from './jobs';
import { Archives } from './archives';
import { Mkv } from './mkv';
import { MakeMkv } from './makemkv';
import { Discs } from './discs';
import { ApiController, PublicController } from './controller';
import { ApiErrors } from './errors';
@Module({
  controllers: [PublicController, ApiController],
  providers: [Store, Auth, AuthGuard, Processes, Paths, Files, Jobs, Archives, Mkv, MakeMkv, Discs],
})
class AppModule {}
async function bootstrap() {
  process.umask(0o027);
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
    }),
  );
  app.use(express.json({ limit: '512kb' }));
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path.startsWith('/api') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const started = Date.now();
      res.once('finish', () =>
        diagnostic('http.mutation', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          elapsedMs: Date.now() - started,
        }),
      );
    }
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (req.headers['x-muxplorer'] !== '1') {
          res.status(403).json({ message: 'Solicitud de otro origen bloqueada.' });
          return;
        }
        if (req.headers.origin) {
          try {
            if (new URL(req.headers.origin).host !== req.headers.host) throw new Error();
          } catch {
            res.status(403).json({ message: 'Origen no autorizado.' });
            return;
          }
        }
      }
    }
    next();
  });
  app.useGlobalFilters(new ApiErrors());
  app.use(express.static(config.WEB_DIR, { index: false }));
  app
    .getHttpAdapter()
    .get('/', (_req: express.Request, res: express.Response) =>
      res.sendFile(path.join(config.WEB_DIR, 'index.html')),
    );
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  const { version } = JSON.parse(
    await readFile(path.join(__dirname, '../package.json'), 'utf8'),
  ) as { version: string };
  diagnostic('server.ready', {
    version,
    node: process.version,
    port: config.PORT,
    concurrency: config.JOB_CONCURRENCY,
  });
}
void bootstrap();
