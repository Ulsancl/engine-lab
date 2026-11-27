const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, screen } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { readProjectFile, writeProjectFile } = require('./project-files.cjs');
const { maxProjectBytes } = require('../src/project-limits.json');
const contentSecurityPolicy = require('./content-security-policy.cjs');

const APP_URL = 'app://engine/';
const APP_NAME = 'Engine Lab';
const APP_ID = 'local.enginelab.workbench';
const MAX_RECOVERY_BYTES = 10 * 1024 * 1024;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
let mainWindow, nativeBusy = false, closePrompt = false;

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
// Stable profile and origin preserve user data across ordinary app updates.
const profileOverride = process.env.ENGINE_LAB_DATA_DIR;
if (profileOverride && !path.isAbsolute(profileOverride)) throw new Error('ENGINE_LAB_DATA_DIR must be absolute');
app.setPath('userData', profileOverride || path.join(app.getPath('appData'), APP_NAME));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

function log(message) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'desktop.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* Logging is optional. */ }
}
function trustedURL(value) {
  try { const url = new URL(value); return url.protocol === 'app:' && url.host === 'engine' && !url.username && !url.password; }
  catch { return false; }
}
function trustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame || !trustedURL(event.senderFrame?.url)) {
    throw new Error('Invalid application sender');
  }
}
function command(value) { mainWindow?.webContents.send('engine:command', value); }
async function serveBundle(request) {
  if (!trustedURL(request.url)) return new Response('Not found', { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  try {
    const root = path.join(app.getAppPath(), 'dist');
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || pathname.includes('\0')) {
      return new Response('Forbidden', { status: 403 });
    }
    const actual = await fsp.realpath(target), actualRelative = path.relative(root, actual);
    if (!actualRelative || actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) {
      return new Response('Forbidden', { status: 403 });
    }
    const data = await fsp.readFile(actual);
    return new Response(request.method === 'HEAD' ? null : data, { headers: {
      'Content-Type': mime[path.extname(actual)] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `${contentSecurityPolicy}; frame-ancestors 'none'`,
    } });
  } catch { return new Response('Not found', { status: 404 }); }
}

async function fileAction(event, action) {
  trustedSender(event);
  if (nativeBusy) return { canceled: true };
  nativeBusy = true;
  try { return await action(); } finally { nativeBusy = false; }
}

async function saveDocument(contents, { name, title, filter, extension, maxBytes }) {
  if (typeof contents !== 'string' || contents.length > maxBytes || Buffer.byteLength(contents, 'utf8') > maxBytes) {
    throw new Error('저장할 텍스트의 형식 또는 크기가 허용 범위를 벗어났습니다.');
  }
  if (extension === 'json') {
    try {
      const parsed = JSON.parse(contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    } catch { throw new Error('JSON 실험 파일을 읽을 수 없습니다.'); }
  }
  const result = await dialog.showSaveDialog(mainWindow, { title,
    defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: filter, extensions: [extension] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  if (path.extname(result.filePath).toLowerCase() !== '.' + extension) throw new Error('허용된 파일 확장자를 선택해 주세요.');
  await writeProjectFile(result.filePath, contents);
  return { canceled: false };
}

function registerFileActions() {
  ipcMain.handle('engine:open-project', event => fileAction(event, async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '엔진 실험 열기',
      properties: ['openFile'], filters: [{ name: '엔진 실험 JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, content: await readProjectFile(result.filePaths[0]) };
  }));
  ipcMain.handle('engine:save-project', (event, contents) => fileAction(event, () => saveDocument(contents, {
    name: '엔진 관찰.engine.json', title: '엔진 실험 저장', filter: '엔진 실험 JSON', extension: 'json', maxBytes: maxProjectBytes,
  })));
  ipcMain.handle('engine:save-recovery', (event, contents) => fileAction(event, () => saveDocument(contents, {
    name: '엔진-저장원문.txt', title: '저장 원문 보관', filter: '텍스트', extension: 'txt', maxBytes: MAX_RECOVERY_BYTES,
  })));
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '파일', submenu: [
      { label: '새 실험', accelerator: 'CmdOrCtrl+N', click: () => command('new-project') },
      { label: '실험 열기…', accelerator: 'CmdOrCtrl+O', click: () => command('open-project') },
      { label: '실험 저장…', accelerator: 'CmdOrCtrl+S', click: () => command('save-project') },
      { type: 'separator' }, { label: '종료', accelerator: 'Alt+F4', click: () => mainWindow?.close() },
    ] },
    { label: '편집', submenu: [{ label: '실행 취소', role: 'undo' }, { label: '다시 실행', role: 'redo' },
      { type: 'separator' }, { label: '잘라내기', role: 'cut' }, { label: '복사', role: 'copy' },
      { label: '붙여넣기', role: 'paste' }, { label: '전체 선택', role: 'selectAll' }] },
    { label: '실험', submenu: [
      { label: '운동 시작 / 일시정지', accelerator: 'CmdOrCtrl+Shift+P', click: () => command('toggle-running') },
    ] },
    { label: '보기', submenu: [
      { label: '3D 크게 보기', accelerator: 'CmdOrCtrl+Shift+F', click: () => command('focus') },
      { type: 'separator' }, { label: '실제 크기', role: 'resetZoom' }, { label: '확대', role: 'zoomIn' },
      { label: '축소', role: 'zoomOut' }, { label: '전체 화면', accelerator: 'F11', role: 'togglefullscreen' },
    ] },
    { label: '도움말', submenu: [
      { label: '사용 안내', accelerator: 'F1', click: () => command('help') },
      { label: '저장 폴더 열기', click: () => shell.openPath(app.getPath('userData')) },
      { label: '프로그램 정보', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: APP_NAME,
        message: `${APP_NAME} ${app.getVersion()}`,
        detail: 'DOHC 4행정 엔진의 구조와 기하학적 운동을 관찰하는 앱입니다.\n\n관찰 설정은 이 앱에 자동 저장하며 실험 JSON으로 백업할 수 있습니다.\n\n피스톤·크랭크·밸브의 운동을 보여 줍니다. 실제 연소·출력·토크·열·마찰은 계산하지 않습니다.', buttons: ['확인'] }) },
    ] },
  ]));
}

function windowBounds(saved) {
  const primary = screen.getPrimaryDisplay().workArea;
  const number = (value, fallback) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-1000000, Math.min(1000000, Math.round(value))) : fallback;
  const candidate = { x: number(saved.x, primary.x), y: number(saved.y, primary.y),
    width: Math.max(100, Math.min(32768, number(saved.width, 1440))),
    height: Math.max(100, Math.min(32768, number(saved.height, 1000))) };
  const area = screen.getDisplayMatching(candidate).workArea;
  const minWidth = Math.min(960, area.width), minHeight = Math.min(640, area.height);
  const width = Math.max(minWidth, Math.min(candidate.width, area.width));
  const height = Math.max(minHeight, Math.min(candidate.height, area.height));
  const x = Math.max(area.x, Math.min(number(saved.x, area.x + (area.width - width) / 2), area.x + area.width - width));
  const y = Math.max(area.y, Math.min(number(saved.y, area.y + (area.height - height) / 2), area.y + area.height - height));
  return { x, y, width, height, minWidth, minHeight };
}

function restoreWindowBounds(window, preferred) {
  const keys = ['x', 'y', 'width', 'height'];
  const requested = Object.fromEntries(keys.map(key => [key, preferred[key]]));
  // On Windows at fractional DPI, setBounds/getNormalBounds can differ by a DIP
  // because the native frame rounds its edges to physical pixels. Restore the
  // saved *actual* rectangle, rather than feeding that rounding error into the
  // next saved size. Keep the correction bounded if the OS constrains a window.
  for (let attempt = 0; attempt < 3; attempt++) {
    window.setBounds(requested);
    if (process.platform !== 'win32') break;
    const actual = window.getNormalBounds();
    const differences = keys.map(key => preferred[key] - actual[key]);
    if (differences.every(value => value === 0) || differences.some(value => Math.abs(value) > 2)) break;
    keys.forEach((key, index) => { requested[key] += differences[index]; });
  }
}

function createWindow() {
  let saved = {};
  try { const value = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'window.json'), 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) saved = value; } catch { /* First launch. */ }
  const preferredBounds = windowBounds(saved);
  mainWindow = new BrowserWindow({ ...preferredBounds, title: APP_NAME, show: false,
    backgroundColor: '#101820', icon: path.join(__dirname, 'assets', 'app.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const denyNavigation = event => event.preventDefault();
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
    mainWindow.webContents.on(name, denyNavigation);
  }
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`Renderer ended: ${details.reason}`);
    dialog.showMessageBox(mainWindow, { type: 'error', title: APP_NAME, message: '화면을 계속 표시하지 못했습니다.',
      detail: '저장된 관찰 설정은 유지됩니다. 프로그램을 다시 시작해 주세요.', buttons: ['확인'] });
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    log(`Load failed: ${code} ${description} ${url}`);
    dialog.showErrorBox(APP_NAME, '프로그램 파일을 읽지 못했습니다. 설치 파일로 다시 설치해 주세요.'); app.quit();
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Correct the visible normal frame before maximizing so its restored size
    // also stays stable when the app was closed maximized.
    restoreWindowBounds(mainWindow, preferredBounds);
    if (saved.maximized === true) mainWindow.maximize();
  });
  mainWindow.on('close', event => {
    if (nativeBusy) {
      event.preventDefault(); if (closePrompt) return; closePrompt = true;
      dialog.showMessageBox(mainWindow, { type: 'warning', title: '작업 진행 중',
        message: '자료 처리 또는 파일 작업이 진행 중입니다.', detail: '작업이 끝난 후 창을 닫아 주세요.',
        buttons: ['작업 계속', '작업 중단 후 종료'], defaultId: 0, cancelId: 0, noLink: true,
      }).then(({ response }) => { closePrompt = false; if (response === 1) app.exit(0); }).catch(() => { closePrompt = false; });
      return;
    }
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'window.json'), JSON.stringify({
      ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized(),
    })); } catch { /* Window layout is optional. */ }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  createMenu(); mainWindow.loadURL(APP_URL);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus();
  } });
  app.whenReady().then(async () => {
    protocol.handle('app', serveBundle);
    session.defaultSession.webRequest.onBeforeRequest(({ url }, callback) => {
      callback({ cancel: !trustedURL(url) && !url.startsWith('data:') });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    registerFileActions(); createWindow(); log(`Started ${app.getVersion()}`);
  }).catch(error => { log(`Startup failed: ${error.stack}`);
    dialog.showErrorBox(APP_NAME, `프로그램을 시작하지 못했습니다.\n${error.message}`); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
