import { Injectable, OnApplicationShutdown, Optional } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config } from './config';
@Injectable()
export class Store implements OnApplicationShutdown {
  readonly db: DatabaseSync;
  constructor(@Optional() directory = config.CONFIG_DIR) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'muxplorer.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL, payload TEXT NOT NULL);`);
  }
  get(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value;
  }
  set(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, value);
  }
  close() {
    // Explicit disposal for isolated tests; Nest closes only after Jobs has drained.
    this.db.close();
  }
  onApplicationShutdown() {
    this.close();
  }
}
