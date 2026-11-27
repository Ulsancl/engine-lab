import { checkedPath, readInput, copyInput, stagingDirectory, publishDirectory, writeArtifact, checkTree } from './safe-files.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const signing = mode === 'package-release';
if (!['start', 'package', 'package-release', 'prepare-test'].includes(mode)) throw new Error('Use start, package, package-release or prepare-test');
if (signing && (process.platform !== 'win32' || !/^[A-Fa-f0-9]{40}$/.test(process.env.ENGINE_SIGNER_THUMBPRINT ?? ''))) {
  throw new Error('Signed release packaging needs Windows and ENGINE_SIGNER_THUMBPRINT (40 hexadecimal characters).');
}
if (mode === 'prepare-test' && process.env.ENGINE_DESKTOP_EXE) process.exit(0);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
function run(executable, args, childEnv = env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env: childEnv, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Process exited with code ${code}`)));
  });
}
async function verifyPublisher(installer, executable) {
  const system = process.env.SystemRoot;
  if (!system || !path.isAbsolute(system)) throw new Error('Cannot locate Windows PowerShell');
  const powershell = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', [
    '$ErrorActionPreference = "Stop"',
    'foreach ($file in @($env:ENGINE_VERIFY_INSTALLER, $env:ENGINE_VERIFY_EXECUTABLE)) {',
    '  $signature = Get-AuthenticodeSignature -LiteralPath $file',
    '  if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Thumbprint -ine $env:ENGINE_SIGNER_THUMBPRINT) {',
    '    throw "The file is not signed by the expected trusted publisher: $file"',
    '  }',
    '}',
  ].join('\n')], { ...env, ENGINE_VERIFY_INSTALLER: installer, ENGINE_VERIFY_EXECUTABLE: executable });
}
for (const input of ['src', 'public', 'desktop', 'docs', 'node_modules/electron']) checkTree(root, path.join(root, input));
const electronPackage = path.dirname(require.resolve('electron/package.json'));
await run(process.execPath, [path.join(electronPackage, 'install.js')]);
await run(process.execPath, [path.join(root, 'scripts', 'build-web.mjs')]);
if (mode === 'start') await run(require('electron'), [root]);
else if (mode === 'package' || signing) {
  const stage = stagingDirectory(root), app = path.join(stage, 'app'), output = path.join(stage, 'windows');
  try {
    const configuration = JSON.parse(readInput(root, path.join(root, 'electron-builder.json')));
    const packageInfo = JSON.parse(readInput(root, path.join(root, 'package.json')));
    const inputs = [...new Set(['desktop', 'dist', 'src/project-limits.json', 'package.json', ...configuration.extraResources.map(item => item.from)])];
    for (const input of inputs.filter(file => !inputs.some(parent => file !== parent && file.startsWith(parent + '/')))) {
      copyInput(root, path.join(root, input), path.join(app, input));
    }
    for (const dependency of Object.keys(packageInfo.dependencies || {})) {
      copyInput(root, path.join(root, 'node_modules', dependency), path.join(app, 'node_modules', dependency));
    }
    const electronDist = checkedPath(root, path.join(root, 'node_modules', 'electron', 'dist'));
    checkTree(root, electronDist);
    const buildConfig = path.join(stage, 'electron-builder.json');
    fs.writeFileSync(buildConfig, JSON.stringify({
      ...configuration, electronDist, npmRebuild: false,
      directories: { ...configuration.directories, output },
      forceCodeSigning: signing,
    }), { flag: 'wx', mode: 0o600 });
    await run(process.execPath, [path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js'),
      '--win', 'nsis', '--x64', '--config', buildConfig, '--projectDir', app, '--publish', 'never']);
    const file = path.join(output, `Engine-Lab-Setup-${packageInfo.version}.exe`);
    if (signing) await verifyPublisher(file, path.join(output, 'win-unpacked', 'Engine Lab.exe'));
    writeArtifact(root, file + '.sha256', `${createHash('sha256').update(readInput(root, file)).digest('hex')}  ${path.basename(file)}\n`);
    publishDirectory(root, output, path.join(root, 'release', 'windows'));
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  console.log('Installer output: release/windows');
}
