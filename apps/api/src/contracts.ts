import { z } from 'zod';
import { problem } from './errors';
export const location = z
  .object({ root: z.enum(['downloads', 'plex']), path: z.string().max(4096) })
  .strict();
export const choice = z
  .object({
    source: z.number().int().min(0).max(15),
    id: z.number().int().nonnegative(),
    enabled: z.boolean(),
    name: z.string().max(512),
    language: z.string().regex(/^[a-zA-Z]{2,8}([_-][a-zA-Z0-9]{1,8})*$/),
    default: z.boolean(),
    forced: z.boolean(),
  })
  .strict();
export const remux = z
  .object({
    sources: z.array(location).min(1).max(16),
    tracks: z.array(choice).min(1).max(256),
    title: z.string().max(512),
    destination: location,
    name: z.string().min(1).max(240),
  })
  .strict();
export const metadata = z
  .object({
    source: location,
    revision: z.string().min(1).max(128),
    title: z.string().max(512),
    tracks: z
      .array(choice.omit({ source: true, enabled: true }))
      .min(1)
      .max(256),
  })
  .strict();
export const extract = z
  .object({
    source: location,
    destination: location,
    folder: z.string().max(240).optional(),
    password: z.string().max(256).optional(),
  })
  .strict();
export const make = z
  .object({
    source: location,
    destination: location,
    titles: z.array(z.number().int().min(0).max(99999)).min(1).max(100),
    name: z.string().min(1).max(220),
    title: z.string().max(512).optional(),
  })
  .strict();
export const fileOperation = z
  .object({
    kind: z.enum(['copy', 'move', 'delete']),
    sources: z.array(location).min(1).max(1000),
    destination: location.optional(),
    confirmed: z.boolean().optional(),
  })
  .strict();
export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    problem(
      `Solicitud no válida: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return result.data;
}
