import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import contentSecurityPolicy from '../desktop/content-security-policy.cjs';
import { checkTree, copyInput, publishDirectory, readInput, stagingDirectory } from './safe-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'dist');
if (fs.lstatSync(target, { throwIfNoEntry: false })) checkTree(root, target);
const stage = stagingDirectory(root);
try {
  const web = path.join(stage, 'web');
  const output = path.join(stage, 'dist');
  const packageInfo = JSON.parse(readInput(root, path.join(root, 'package.json')));
  for (const input of ['index.html', 'src', 'public', 'package.json']) {
    copyInput(root, path.join(root, input), path.join(web, input));
  }
  for (const dependency of Object.keys(packageInfo.dependencies)) {
    const input = path.join('node_modules', dependency);
    copyInput(root, path.join(root, input), path.join(web, input));
  }
  await build({
    root: web, base: './', configFile: false, envFile: false,
    css: { postcss: { plugins: [] } },
    build: { outDir: output, emptyOutDir: false },
    plugins: [{
      name: 'engine-lab-content-security-policy',
      transformIndexHtml() {
        return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy },
          injectTo: 'head-prepend' }];
      },
    }],
  });
  checkTree(root, output);
  publishDirectory(root, output, target);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
