import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readProjectFile, writeProjectFile } from '../desktop/project-files.cjs';
import { MAX_PROJECT_BYTES, createProject, serializeProject, parseProject } from '../src/project.js';

test('project reads accept BOM and a full valid file at the byte limit', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-project-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = createProject({ settings: { rpm: 2300 } });
  const content = '\ufeff' + serializeProject(project);
  const atLimit = content + ' '.repeat(MAX_PROJECT_BYTES - Buffer.byteLength(content));
  const file = path.join(dir, 'observation.engine.json');
  await fs.writeFile(file, atLimit);
  assert.equal(await readProjectFile(file), atLimit);
  assert.deepEqual(parseProject(await readProjectFile(file)), project);
  await fs.appendFile(file, ' ');
  await assert.rejects(readProjectFile(file), /256 KiB/);
  await assert.rejects(readProjectFile(dir));
});

test('project writes replace a file and clean up only their own staging on failure', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-project-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'new.engine.json');
  const otherSave = path.join(dir, '.engine-save-existing');
  await fs.mkdir(otherSave);
  await fs.writeFile(path.join(otherSave, 'document'), 'previous');
  await writeProjectFile(file, 'first');
  await writeProjectFile(file, 'second');
  assert.equal(await fs.readFile(file, 'utf8'), 'second');
  await assert.rejects(writeProjectFile(otherSave, 'third'));
  assert.equal(await fs.readFile(path.join(otherSave, 'document'), 'utf8'), 'previous');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['.engine-save-existing', 'new.engine.json']);
});
