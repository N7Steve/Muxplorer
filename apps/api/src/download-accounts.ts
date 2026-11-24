import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { constants, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DownloadAccount, DownloadAccountStatus } from '@muxplorer/shared';
import { Store } from './store';

type AccountRecord = DownloadAccount & { secret: string };
export type AccountInput = Omit<DownloadAccount, 'id'> & { id?: string; secret?: string };

@Injectable()
export class DownloadAccounts {
  constructor(private readonly store: Store) {}

  private records(): AccountRecord[] {
    return JSON.parse(this.store.get('downloadAccounts') ?? '[]') as AccountRecord[];
  }

  list(): DownloadAccount[] {
    return this.records().map(({ id, provider, label, email, status, checkedAt }) => ({
      id,
      provider,
      label,
      email,
      ...(status && { status, checkedAt }),
    }));
  }

  save(input: AccountInput) {
    const accounts = this.records();
    const previous = accounts.find((item) => item.id === input.id);
    if (input.id && (!previous || previous.provider !== input.provider))
      throw new NotFoundException('Cuenta de descarga no encontrada.');
    if (!previous && accounts.length >= 50)
      throw new BadRequestException('Puedes guardar hasta 50 cuentas.');
    if ((!previous || previous.email !== input.email) && !input.secret)
      throw new BadRequestException('Introduce la clave o contraseña de la cuenta.');
    const id = previous?.id ?? randomUUID();
    const record: AccountRecord = {
      id,
      provider: input.provider,
      label: input.label,
      email: input.email,
      secret: input.secret ? this.seal(input.secret, id) : previous!.secret,
      ...(!input.secret && { status: previous?.status, checkedAt: previous?.checkedAt }),
    };
    if (previous) accounts[accounts.indexOf(previous)] = record;
    else accounts.push(record);
    this.store.set('downloadAccounts', JSON.stringify(accounts));
    return this.list();
  }

  remove(id: string) {
    this.store.set(
      'downloadAccounts',
      JSON.stringify(this.records().filter((item) => item.id !== id)),
    );
    return this.list();
  }

  get(id: string) {
    const account = this.records().find((item) => item.id === id);
    if (!account) throw new NotFoundException('Cuenta de descarga no encontrada.');
    return { ...account, secret: this.unseal(account.secret, id) };
  }

  async check(id: string, verify: (account: AccountRecord) => Promise<DownloadAccountStatus>) {
    const before = this.records().find((item) => item.id === id);
    if (!before) throw new NotFoundException('Cuenta de descarga no encontrada.');
    const checkedAt = new Date().toISOString();
    const status = await Promise.resolve()
      .then(() => verify(this.get(id)))
      .catch(() => 'unavailable' as const);
    const accounts = this.records();
    const current = accounts.find((item) => item.id === id);
    if (
      current &&
      current.secret === before.secret &&
      current.email === before.email &&
      (!current.checkedAt || current.checkedAt <= checkedAt)
    ) {
      Object.assign(current, { status, checkedAt });
      this.store.set('downloadAccounts', JSON.stringify(accounts));
    }
    return this.list();
  }

  private key(create: boolean) {
    const file = path.join(this.store.directory, 'download-credentials.key');
    if (create) {
      try {
        writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return readFileSync(file, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
  }

  seal(value: string, context: string) {
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key(true), iv);
      cipher.setAAD(Buffer.from(context));
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    } catch {
      throw new BadRequestException('No se pudo guardar el secreto de descarga.');
    }
  }

  unseal(value: string, context: string) {
    try {
      const data = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key(false), data.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      throw new BadRequestException('No se pudo leer el secreto de descarga guardado.');
    }
  }
}
