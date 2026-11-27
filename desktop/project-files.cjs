const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { windowsWriteProject } = require('./windows-save.cjs');
const { maxProjectBytes } = require('../src/project-limits.json');

async function readProjectFile(file) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  const invalidFile = () => new Error('실험 파일은 256 KiB 이하의 일반 JSON 파일이어야 합니다.');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxProjectBytes) throw invalidFile();
    const buffer = Buffer.alloc(maxProjectBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxProjectBytes) throw invalidFile();
    return buffer.toString('utf8', 0, length);
  } finally { await handle.close(); }
}

async function writeProjectFile(destination, contents) {
  if (process.platform === 'win32') return windowsWriteProject(destination, contents);
  // Own the staging directory before cleanup. Keeping it beside the target
  // permits a same-filesystem rename and preserves the previous file on failure.
  const directory = await fs.mkdtemp(path.join(path.dirname(destination), '.engine-save-'));
  const temporary = path.join(directory, 'document');
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, destination);
  } finally { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
}

module.exports = { readProjectFile, writeProjectFile };
