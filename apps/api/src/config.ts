import path from 'node:path';
import { z } from 'zod';
const env = z
  .object({
    PORT: z.coerce.number().int().min(1024).max(65535).default(8098),
    CONFIG_DIR: z.string().default(path.resolve('.local/config')),
    DOWNLOADS_ROOT: z.string().default(path.resolve('.local/downloads')),
    PLEX_ROOT: z.string().default(path.resolve('.local/plex')),
    WEB_DIR: z.string().default(path.resolve('../web/dist/browser')),
    JOB_CONCURRENCY: z.coerce.number().int().min(1).default(1),
    COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
    SEVENZIP_BIN: z.string().default('7zz'),
    MKVMERGE_BIN: z.string().default('mkvmerge'),
    MKVPROPEDIT_BIN: z.string().default('mkvpropedit'),
    MAKEMKV_BIN: z.string().default('makemkvcon'),
    SANDBOX_BIN: z.string().default('mux-sandbox'),
    RENAME_BIN: z.string().default('mux-rename'),
    MAKEMKV_HOME: z.string().optional(),
    LICENSE_FILE: z.string().default('/app/licenses/makemkv.txt'),
  })
  .parse(process.env);
export const config = {
  ...env,
  CONFIG_DIR: path.resolve(env.CONFIG_DIR),
  roots: {
    downloads: path.resolve(env.DOWNLOADS_ROOT),
    plex: path.resolve(env.PLEX_ROOT),
  },
};
