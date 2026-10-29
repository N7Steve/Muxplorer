import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, link } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Paths, relativePath, safeName } from '../src/paths';
import { validateArchiveListing } from '../src/archives';
import { parse } from '../src/contracts';
import { location } from '../src/contracts';
for (const value of [
  '../secret',
  '/etc/passwd',
  'a/../../x',
  'a\\b',
  'C:/x',
  'a//b',
  'a/./b',
  'a\0b',
  '.muxplorer-private/x',
])
  test(`reject path ${JSON.stringify(value)}`, () => assert.throws(() => relativePath(value)));
for (const value of [
  '.',
  '..',
  'a/b',
  'a\\b',
  'a:b',
  'line\nbreak',
  '.muxplorer-job',
  'x'.repeat(241),
])
  test(`reject name ${JSON.stringify(value)}`, () => assert.throws(() => safeName(value)));
test('accept normal Unicode paths; never double-decode percent encoding', () => {
  assert.equal(relativePath('Películas/Ágora 2024.mkv'), 'Películas/Ágora 2024.mkv');
  assert.equal(relativePath('%2e%2e'), '%2e%2e');
});
test('strict request validation rejects unexpected root and absolute payload extras', () => {
  assert.throws(() => parse(location, { root: 'host', path: '' }));
  assert.throws(() => parse(location, { root: 'plex', path: '', absolute: '/etc' }));
});
test('filesystem resolution blocks symlink parents, leaves and missing-leaf escapes', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mux-path-'));
  try {
    const root = path.join(temporary, 'root'),
      outside = path.join(temporary, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret'), 'private');
    await symlink(
      outside,
      path.join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const paths = new Paths({ downloads: root, plex: root });
    await assert.rejects(paths.resolve({ root: 'downloads', path: 'escape' }));
    await assert.rejects(paths.resolve({ root: 'downloads', path: 'escape/secret' }));
    await assert.rejects(paths.resolve({ root: 'downloads', path: 'escape/new' }, true));
    assert.equal(
      await paths.resolve({ root: 'downloads', path: 'new' }, true),
      path.join(root, 'new'),
    );
    await writeFile(path.join(root, 'a'), 'data');
    await link(path.join(root, 'a'), path.join(root, 'b'));
    await assert.rejects(paths.tree(root));
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
test('archive preflight rejects traversal, absolute paths and links', () => {
  for (const listing of [
    'Path = ../../outside\nSize = 4',
    'Path = /etc/passwd\nSize = 4',
    'Path = C:\\a\nSize = 4',
    'Path = a\nSymbolic Link = /tmp/x',
    'Path = a\nHard Link = b',
  ])
    assert.throws(() => validateArchiveListing(listing));
  assert.doesNotThrow(() =>
    validateArchiveListing('Path = Movie/sub.srt\nSize = 42\n\nPath = Movie\nFolder = +'),
  );
});
