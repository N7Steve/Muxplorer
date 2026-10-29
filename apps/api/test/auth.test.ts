import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { Auth } from '../src/auth';
import { Store } from '../src/store';
import { config } from '../src/config';

const password = 'My-admin-password-2026';
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mux-auth-'));
  const previous = config.CONFIG_DIR;
  config.CONFIG_DIR = directory;
  const store = new Store(directory);
  const auth = new Auth(store);
  let cookie = '';
  const req = { ip: '127.0.0.1', headers: {} } as Request;
  const res = {
    cookie: (name: string, token: string) => {
      cookie = `${name}=${token}`;
    },
    clearCookie: () => {
      cookie = '';
    },
  } as unknown as Response;
  return {
    directory,
    store,
    auth,
    req,
    res,
    request: () => ({ ...req, headers: { cookie } }) as Request,
    close: () => {
      store.close();
      config.CONFIG_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test('first setup creates one named administrator without a token and persists hashed credentials', () => {
  const f = fixture();
  try {
    f.auth.onModuleInit();
    assert.equal(f.auth.ready(), false);
    assert.equal(existsSync(path.join(f.directory, 'setup-token')), false);
    assert.deepEqual(f.auth.setup(' Steve ', password, f.req, f.res), {
      authenticated: true,
      username: 'Steve',
    });
    assert.equal(f.auth.ready(), true);
    assert.equal(f.store.get('username'), 'Steve');
    const savedHash = f.store.get('password');
    assert.ok(savedHash && !savedHash.includes(password));
    assert.equal(f.auth.authenticated(f.request()), true);
    assert.throws(
      () => f.auth.setup('replacement', 'Other-admin-password-2026', f.req, f.res),
      /ya está configurado/,
    );
    assert.equal(f.store.get('password'), savedHash);
    assert.equal(f.store.get('username'), 'Steve');
    f.auth.logout(f.request(), f.res);
    assert.equal(f.auth.authenticated(f.request()), false);
    const restarted = new Auth(f.store);
    restarted.onModuleInit();
    assert.equal(restarted.login('Steve', password, f.req, f.res).authenticated, true);
    assert.equal(restarted.authenticated(f.request()), true);
  } finally {
    f.close();
  }
});
test('both username and password are required; invalid setup never configures a partial account', () => {
  const f = fixture();
  try {
    assert.throws(() => f.auth.setup('admin', 'short', f.req, f.res), /12 y 256/);
    assert.throws(() => f.auth.setup('  ', password, f.req, f.res));
    assert.throws(() => f.auth.setup('bad\nname', password, f.req, f.res));
    assert.equal(f.auth.ready(), false);
    assert.equal(f.store.get('username'), undefined);
    f.auth.setup('administrador', password, f.req, f.res);
    assert.throws(
      () => f.auth.login('otro', password, f.req, f.res),
      /Usuario o contraseña incorrectos/,
    );
    assert.throws(
      () => f.auth.login('administrador', 'Wrong-password-2026', f.req, f.res),
      /Usuario o contraseña incorrectos/,
    );
  } finally {
    f.close();
  }
});
test('legacy password-only accounts retain their password under admin and obsolete setup tokens are removed', () => {
  const f = fixture();
  try {
    f.auth.setup('temporary', password, f.req, f.res);
    const savedHash = f.store.get('password');
    f.store.db.prepare('DELETE FROM settings WHERE key=?').run('username');
    f.store.set('setupToken', 'obsolete');
    writeFileSync(path.join(f.directory, 'setup-token'), 'obsolete');
    f.auth.onModuleInit();
    assert.equal(f.auth.username(), 'admin');
    assert.equal(f.store.get('password'), savedHash);
    assert.equal(f.store.get('setupToken'), undefined);
    assert.equal(existsSync(path.join(f.directory, 'setup-token')), false);
    assert.equal(f.auth.login('admin', password, f.req, f.res).authenticated, true);
  } finally {
    f.close();
  }
});
