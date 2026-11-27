import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readProjectFile, writeProjectFile } from '../desktop/project-files.cjs';
import { windowsPowerShell, windowsPowerShellEnv } from '../desktop/windows-save.cjs';
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

test('Windows saves retain an explicit destination DACL and create private new files', { skip: process.platform !== 'win32' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-acl-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, '엔진 관찰.engine.json');
  const fresh = path.join(dir, '새 엔진 관찰.engine.json');
  const replacement = serializeProject(createProject({ settings: { rpm: 2250 } }));
  await fs.writeFile(target, serializeProject(createProject()));
  const runPowerShell = script => execFileSync(windowsPowerShell(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, env: windowsPowerShellEnv({ ENGINE_TEST_EXISTING: target, ENGINE_TEST_FRESH: fresh }) }).trim();
  const readDacl = "[IO.File]::GetAccessControl($env:ENGINE_TEST_EXISTING).GetSecurityDescriptorSddlForm('Access')";
  const daclBefore = runPowerShell(`
    $ErrorActionPreference = 'Stop'
    $acl = [IO.File]::GetAccessControl($env:ENGINE_TEST_EXISTING)
    $acl.SetAccessRuleProtection($true, $false)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow'))
    [IO.File]::SetAccessControl($env:ENGINE_TEST_EXISTING, $acl)
    ${readDacl}
  `);
  assert.match(daclBefore, /^D:P/);

  await writeProjectFile(target, replacement);
  await writeProjectFile(fresh, replacement);

  assert.equal(runPowerShell(readDacl), daclBefore);
  assert.equal(runPowerShell(`
    $ErrorActionPreference = 'Stop'
    $acl = [IO.File]::GetAccessControl($env:ENGINE_TEST_FRESH)
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rules.Count -eq 1 -and $rules[0].IdentityReference -eq $user
  `), 'True');
  for (const file of [target, fresh]) assert.equal(await readProjectFile(file), replacement);
  assert.deepEqual((await fs.readdir(dir)).sort(), [path.basename(target), path.basename(fresh)].sort());
});
