import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { Store } from './store';
import { config } from './config';
import { problem } from './errors';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
@Injectable()
export class Auth implements OnModuleInit {
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private readonly store: Store) {}
  onModuleInit() {
    // Preserve accounts created before usernames were introduced.
    if (this.ready() && !this.store.get('username')) this.store.set('username', 'admin');
    this.store.db.prepare('DELETE FROM settings WHERE key=?').run('setupToken');
    try {
      unlinkSync(path.join(config.CONFIG_DIR, 'setup-token'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  ready() {
    return !!this.store.get('password');
  }
  username() {
    return this.store.get('username');
  }
  private passwordHash(password: string) {
    if (password.length < 12 || password.length > 256)
      problem('La contraseña debe tener entre 12 y 256 caracteres.');
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
  }
  private limit(req: Request) {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    for (const [ip, item] of this.attempts) if (item.until < now) this.attempts.delete(ip);
    const entry = this.attempts.get(key) ?? { count: 0, until: now + 15 * 60_000 };
    if (++entry.count > 15 || this.attempts.size > 10_000)
      throw new UnauthorizedException('Demasiados intentos. Espera 15 minutos.');
    this.attempts.set(key, entry);
  }
  setup(username: string, password: string, req: Request, res: Response) {
    this.limit(req);
    username = username.trim().normalize('NFC');
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._@-]{0,63}$/u.test(username))
      problem(
        'El usuario debe tener entre 1 y 64 caracteres: letras, números, punto, guion, guion bajo o @.',
      );
    if (this.ready())
      throw new UnauthorizedException('El administrador ya está configurado. Inicia sesión.');
    const passwordHash = this.passwordHash(password);
    // Commit both credentials together; a concurrent first setup must never replace the account.
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.ready())
        throw new UnauthorizedException('El administrador ya está configurado. Inicia sesión.');
      this.store.set('username', username);
      this.store.set('password', passwordHash);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    this.attempts.delete(req.ip ?? 'unknown');
    return this.session(res);
  }
  login(username: string, password: string, req: Request, res: Response) {
    this.limit(req);
    const stored = this.store.get('password');
    if (!stored) throw new UnauthorizedException('Configura el administrador primero.');
    const [salt, expected] = stored.split(':');
    const validPassword = this.equal(scryptSync(password, salt, 64).toString('hex'), expected);
    if (!validPassword || username.trim().normalize('NFC') !== this.username())
      throw new UnauthorizedException('Usuario o contraseña incorrectos.');
    this.attempts.delete(req.ip ?? 'unknown');
    return this.session(res);
  }
  private equal(a: string, b: string) {
    return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
  private session(res: Response) {
    const token = randomBytes(32).toString('hex');
    const expires = Date.now() + 12 * 3600_000;
    this.store.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    this.store.db.prepare('INSERT INTO sessions VALUES (?, ?)').run(hash(token), expires);
    res.cookie('mux_session', token, {
      httpOnly: true,
      secure: config.COOKIE_SECURE === 'true',
      sameSite: 'strict',
      path: '/',
      maxAge: 12 * 3600_000,
    });
    return { authenticated: true, username: this.username() };
  }
  private token(req: Request) {
    return /(?:^|;\s*)mux_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
  }
  authenticated(req: Request) {
    return !!this.store.db
      .prepare('SELECT hash FROM sessions WHERE hash=? AND expires>?')
      .get(hash(this.token(req)), Date.now());
  }
  logout(req: Request, res: Response) {
    this.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(this.token(req)));
    res.clearCookie('mux_session', { path: '/' });
  }
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: Auth) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    if (!this.auth.authenticated(req))
      throw new UnauthorizedException('Inicia sesión para continuar.');
    return true;
  }
}
