import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const packaged = !!process.env.ENGINE_DESKTOP_EXE;
const executablePath = packaged ? process.env.ENGINE_DESKTOP_EXE : require('electron');
assert.ok(path.isAbsolute(executablePath), 'The tested executable must be an absolute path');
const output = path.join(root, 'output', `${packaged ? 'desktop-packaged' : 'desktop'}-v${expectedVersion}`);
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(output, 'profile-'));
const evidence = path.join(profile, 'test-artifacts');
await fs.mkdir(evidence);
const env = { ...process.env, ENGINE_LAB_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const projectPath = path.join(evidence, '엔진 관찰.engine.json');
const checks = [], errors = [], remoteRequests = [], processes = [];
let app, page, saved, windowRestoration, realtimeGuide, gpu, failure;
const state = () => page.evaluate(() => window.engineLab.getState());
const project = () => page.evaluate(() => window.engineLab.project());

async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
function sameProject(actual, expected) {
  assert.equal(actual.type, expected.type); assert.equal(actual.schemaVersion, expected.schemaVersion);
  assert.equal(actual.modelVersion, expected.modelVersion); assert.deepEqual(actual.settings, expected.settings);
  assert.deepEqual(actual.observation.view, expected.observation.view);
  assert.equal(actual.observation.playbackRate, expected.observation.playbackRate);
  assert.ok(Math.abs(actual.observation.angleRad - expected.observation.angleRad) < 1e-12, 'Saved crank angle changed');
  const a = actual.observation.camera, b = expected.observation.camera;
  if (b === null) assert.equal(a, null);
  else {
    assert.ok(a);
    for (const key of ['position', 'target']) for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(a[key][i] - b[key][i]) < 1e-9, `Camera ${key}[${i}] changed`);
    }
    assert.equal(a.zoom ?? 1, b.zoom ?? 1);
  }
}
async function launch() {
  app = await electron.launch({ executablePath, args: packaged ? [] : [root], env, timeout: 45000 });
  const child = app.process(), processRecord = { pid: child.pid, exited: false };
  processes.push(processRecord);
  child.once('exit', (code, signal) => Object.assign(processRecord, { exited: true, code, signal }));
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await page.waitForFunction(() => window.engineLab?.project && document.querySelector('#scene canvas'));
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setTitle('Engine Lab · 자동 검사'); window.focus(); });
}
async function closeNormally() {
  await app.close(); app = null; page = null;
  await waitFor(() => processes.at(-1).exited, 'normal native process exit');
  assert.equal(processes.at(-1).code, 0); assert.equal(processes.at(-1).signal, null);
}
async function menu(group, label) {
  await app.evaluate(({ Menu }, names) => {
    const item = Menu.getApplicationMenu().items.find(value => value.label === names[0])?.submenu?.items.find(value => value.label === names[1]);
    if (!item || typeof item.click !== 'function') throw new Error(`Missing native menu: ${names.join(' > ')}`);
    item.click();
  }, [group, label]);
}
async function saveDialog(filePath, canceled = false) {
  await app.evaluate(({ dialog }, payload) => {
    globalThis.engineSaveCalls = 0;
    dialog.showSaveDialog = async () => { globalThis.engineSaveCalls++; return { canceled: payload.canceled, filePath: payload.filePath }; };
  }, { filePath, canceled });
}
async function openDialog(filePath, canceled = false) {
  await app.evaluate(({ dialog }, payload) => {
    globalThis.engineOpenCalls = 0;
    dialog.showOpenDialog = async () => { globalThis.engineOpenCalls++; return { canceled: payload.canceled, filePaths: payload.canceled ? [] : [payload.filePath] }; };
  }, { filePath, canceled });
}
async function freshToast(action, pattern) {
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#toast').textContent = ''; });
  await action();
  await page.waitForFunction(pattern => {
    const node = document.querySelector('#toast'); return !node.hidden && new RegExp(pattern).test(node.textContent);
  }, pattern);
}
async function stableBounds(label) {
  let actual, previous, stable = 0;
  await waitFor(async () => {
    actual = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
    stable = JSON.stringify(actual) === JSON.stringify(previous) ? stable + 1 : 0; previous = actual;
    return stable >= 2;
  }, label);
  return actual;
}

try {
  await launch();
  await check('isolated Engine Lab identity, offline bundle, sandbox and native bridge', async () => {
    assert.equal(page.url(), 'app://engine/');
    const identity = await app.evaluate(({ app, BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { name: app.name, version: app.getVersion(), userData: app.getPath('userData'), sandbox: p.sandbox,
        contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
    });
    assert.deepEqual(identity, { name: 'Engine Lab', version: expectedVersion, userData: profile,
      sandbox: true, contextIsolation: true, nodeIntegration: false });
    const bridge = await page.evaluate(() => ({ keys: Object.keys(window.engineDesktop).sort(), native: window.engineDesktop.isDesktop,
      node: typeof window.require, process: typeof window.process, brake: typeof window.brakeDesktop }));
    assert.deepEqual(bridge, { keys: ['isDesktop', 'onCommand', 'openProject', 'saveProject', 'setBusy'],
      native: true, node: 'undefined', process: 'undefined', brake: 'undefined' });
    assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
    const access = await page.evaluate(async () => ({
      local: await fetch('app://engine/index.html').then(response => response.ok),
      remote: await fetch('https://example.com/').then(() => true).catch(() => false),
      popup: window.open('https://example.com/') === null,
    }));
    assert.equal(access.local, true); assert.equal(access.remote, false);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    // Ignore the intentionally denied fetch's CSP message, not application errors.
    assert.ok(errors.every(message => /Content Security Policy|Refused to connect|fetch/i.test(message)), errors.join('\n'));
    errors.length = 0; remoteRequests.length = 0;
    gpu = await app.evaluate(async ({ app }) => ({ info: await app.getGPUInfo('basic'), features: app.getGPUFeatureStatus() }));
    gpu.sceneContext = await page.evaluate(() => {
      const gl = document.querySelector('#scene canvas').getContext('webgl2');
      if (!gl) return { webgl2: false, unmaskedRenderer: null };
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return { webgl2: true, renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION),
        unmaskedRenderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
        unmaskedVendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null };
    });
  });
  await check('native play menu advances real crank motion and the 10-degree button steps a paused engine', async () => {
    await page.locator('#reset-angle').click();
    await page.locator('#step').click();
    assert.ok(Math.abs((await state()).angleRad - Math.PI / 18) < 1e-12);
    const before = (await state()).angleRad;
    await menu('실험', '운동 시작 / 일시정지');
    await waitFor(async () => { const current = await state(); return current.running && current.angleRad > before + .01; }, 'live crank motion');
    await menu('실험', '운동 시작 / 일시정지');
    await waitFor(async () => !(await state()).running, 'native pause');
    const paused = (await state()).angleRad;
    await delay(120);
    assert.equal((await state()).angleRad, paused);
    await page.locator('#step').click();
    assert.ok(Math.abs((await state()).angleRad - ((paused + Math.PI / 18) % (4 * Math.PI))) < 1e-12);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    assert.equal(await page.evaluate(() => document.hidden), false);
    const startedAt = performance.now();
    await page.locator('#one-cycle').click();
    realtimeGuide = { requestedCycleSeconds: 8, scope: 'One visible foreground observation on this machine; not a general performance guarantee', samples: [] };
    await waitFor(async () => (await state()).running, 'guided cycle starts');
    let sampleAtTwoSeconds = false;
    await waitFor(async () => {
      const observed = await page.evaluate(() => ({ ...window.engineLab.getState(), hidden: document.hidden }));
      const elapsedMs = performance.now() - startedAt;
      assert.equal(observed.hidden, false, 'The native guided observation was hidden and paused');
      if (!sampleAtTwoSeconds && elapsedMs >= 2000) {
        realtimeGuide.samples.push({ elapsedMs, angleRad: observed.angleRad, running: observed.running, hidden: observed.hidden });
        sampleAtTwoSeconds = true;
      }
      if (observed.running) return false;
      realtimeGuide.elapsedMs = elapsedMs; realtimeGuide.finalAngleRad = observed.angleRad;
      realtimeGuide.finalGuidedRemaining = observed.guidedRemaining;
      return true;
    }, 'complete real-time guided cycle', 15000);
    assert.ok(realtimeGuide.elapsedMs >= 7800 && realtimeGuide.elapsedMs <= 12000, `Guided cycle wall time: ${realtimeGuide.elapsedMs} ms`);
    assert.equal(realtimeGuide.finalAngleRad, 0); assert.equal(realtimeGuide.finalGuidedRemaining, null);
    assert.match(await page.locator('#toast').textContent(), /한 사이클 완료/);
  });
  await check('native save replaces a file atomically and open restores settings, phase, layers and camera', async () => {
    await page.locator('#rpm').fill('2300'); await page.locator('#cam-advance').fill('6');
    await page.locator('#playback-rate').selectOption('0.01');
    await page.locator('[data-cylinder-mode="single"]').click(); await page.locator('#selected-cylinder').selectOption('3');
    await page.locator('[data-mode="exploded"]').click(); await page.locator('#explode').fill('0.42');
    await page.locator('#labels').uncheck(); await page.locator('#angle').fill('405');
    await page.locator('[data-camera="timing"]').click();
    await delay(200);
    saved = await project();
    assert.equal(saved.settings.rpm, 2300); assert.equal(saved.observation.view.selectedCylinder, 3);
    assert.equal(saved.observation.view.mode, 'exploded');
    await fs.writeFile(projectPath, 'existing destination, replaced only by a complete JSON');
    await saveDialog(projectPath);
    await freshToast(() => menu('파일', '실험 저장…'), '파일로 저장했습니다');
    assert.equal(await app.evaluate(() => globalThis.engineSaveCalls), 1);
    const raw = await fs.readFile(projectPath, 'utf8'); sameProject(JSON.parse(raw), saved);
    assert.equal((await fs.readdir(evidence)).some(name => name.endsWith('.tmp')), false);
    await menu('파일', '새 실험');
    await waitFor(async () => (await state()).settings.rpm === 1200, 'new experiment');
    assert.equal((await state()).angleRad, 0);
    await openDialog(projectPath);
    await freshToast(() => menu('파일', '실험 열기…'), '엔진 관찰을 불러왔습니다');
    assert.equal(await app.evaluate(() => globalThis.engineOpenCalls), 1);
    sameProject(await project(), saved); assert.equal(await fs.readFile(projectPath, 'utf8'), raw);
    const bomPath = path.join(evidence, 'Windows-UTF8.engine.json'), bomRaw = '\ufeff' + raw;
    await fs.writeFile(bomPath, bomRaw);
    await menu('파일', '새 실험'); await waitFor(async () => (await state()).settings.rpm === 1200, 'new before BOM import');
    await openDialog(bomPath);
    await freshToast(() => page.locator('#open-project').click(), '엔진 관찰을 불러왔습니다');
    sameProject(await project(), saved); assert.equal(await fs.readFile(bomPath, 'utf8'), bomRaw);
  });
  await check('cancellation, malformed files, future versions and the byte limit preserve current and original records', async () => {
    const before = await project(), original = await fs.readFile(projectPath, 'utf8');
    await saveDialog(projectPath, true); await page.locator('#save-project').click();
    await waitFor(() => app.evaluate(() => globalThis.engineSaveCalls === 1), 'save cancellation');
    await openDialog(projectPath, true); await page.locator('#open-project').click();
    await waitFor(() => app.evaluate(() => globalThis.engineOpenCalls === 1), 'open cancellation');
    sameProject(await project(), before); assert.equal(await fs.readFile(projectPath, 'utf8'), original);
    for (const [name, raw] of [
      ['broken.json', '{synthetic invalid JSON\r\n원문'],
      ['future.json', JSON.stringify({ ...saved, schemaVersion: 2 })],
      ['future-model.json', JSON.stringify({ ...saved, modelVersion: 'engine-kinematics-2' })],
      ['too-large.json', ' '.repeat(10 * 1024 * 1024 + 1)],
    ]) {
      const file = path.join(evidence, name); await fs.writeFile(file, raw);
      await openDialog(file);
      await freshToast(() => page.locator('#open-project').click(), '불러오지 못했습니다');
      sameProject(await project(), before); assert.equal(await fs.readFile(file, 'utf8'), raw);
    }
  });
  await check('About version and observation scope are accurate and help/view commands are reversible', async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.engineAbout = null;
      dialog.showMessageBox = async (_window, options) => { globalThis.engineAbout = options; return { response: 0 }; };
    });
    await menu('도움말', '프로그램 정보');
    const about = await app.evaluate(() => globalThis.engineAbout);
    assert.equal(about.message, `Engine Lab ${expectedVersion}`);
    assert.match(about.detail, /DOHC 4행정/); assert.match(about.detail, /출력.*계산하지 않습니다/);
    await menu('도움말', '사용 안내'); await waitFor(() => page.locator('#help-dialog').evaluate(node => node.open), 'help dialog');
    assert.match(await page.locator('#help-dialog').textContent(), /720°|크랭크 두 바퀴/);
    await page.locator('#close-help').click();
    await menu('보기', '3D 크게 보기'); await waitFor(async () => (await state()).focused, 'large view');
    await menu('보기', '3D 크게 보기'); await waitFor(async () => !(await state()).focused, 'normal view');
    sameProject(await project(), saved);
  });
  await check('an outstanding native file dialog prevents close and cancel leaves the original file intact', async () => {
    const before = await project(), original = await fs.readFile(projectPath, 'utf8');
    await app.evaluate(({ dialog }) => {
      globalThis.enginePendingSave = false; globalThis.engineClosePrompts = 0;
      dialog.showSaveDialog = () => new Promise(resolve => { globalThis.engineResolveSave = resolve; globalThis.enginePendingSave = true; });
      dialog.showMessageBox = async () => { globalThis.engineClosePrompts++; return { response: 0 }; };
    });
    await page.locator('#save-project').click();
    await waitFor(() => app.evaluate(() => globalThis.enginePendingSave), 'pending native save dialog');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await waitFor(() => app.evaluate(() => globalThis.engineClosePrompts === 1), 'busy close prompt');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    sameProject(await project(), before);
    await app.evaluate(() => { globalThis.engineResolveSave({ canceled: true }); globalThis.enginePendingSave = false; });
    await delay(60);
    assert.equal(await fs.readFile(projectPath, 'utf8'), original); sameProject(await project(), before);
  });
  await check('reload and repeated full relaunch preserve observations and arbitrary-position window dimensions', async () => {
    saved = await project();
    const display = await app.evaluate(({ screen, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; if (window.isMaximized()) window.unmaximize();
      const current = window.getNormalBounds(), display = screen.getDisplayMatching(current);
      return { bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor, minimumSize: window.getMinimumSize() };
    });
    const area = display.workArea, [minWidth, minHeight] = display.minimumSize;
    const gridStep = Array.from({ length: 100 }, (_, index) => index + 1)
      .find(step => Math.abs(step * display.scaleFactor - Math.round(step * display.scaleFactor)) < 1e-7);
    assert.ok(gridStep);
    const sizeOnGrid = (desired, minimum, available) => Math.max(Math.ceil(minimum / gridStep), Math.floor(Math.min(desired, available - 32) / gridStep)) * gridStep;
    const requested = { width: sizeOnGrid(1050, minWidth, area.width), height: sizeOnGrid(780, minHeight, area.height) };
    const centered = (origin, start, available, size) => origin + Math.floor((start + (available - size) / 2 - origin) / gridStep) * gridStep;
    requested.x = centered(display.bounds.x, area.x, area.width, requested.width);
    requested.y = centered(display.bounds.y, area.y, area.height, requested.height);
    windowRestoration = { display, gridStep, requested };
    await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setBounds(target), requested);
    const aligned = await stableBounds('aligned native rectangle'); windowRestoration.aligned = aligned;
    assert.deepEqual(aligned, requested);
    await page.reload(); await page.waitForFunction(() => window.engineLab?.project && document.querySelector('#scene canvas'));
    sameProject(await project(), saved); assert.deepEqual(await stableBounds('reloaded native rectangle'), aligned);
    await closeNormally();
    const savedWindow = JSON.parse(await fs.readFile(path.join(profile, 'window.json'), 'utf8'));
    assert.deepEqual(savedWindow, { ...aligned, maximized: false });
    await launch(); sameProject(await project(), saved);
    assert.deepEqual(await stableBounds('restarted aligned rectangle'), aligned);
    const offset = (coordinate, start, available, size) => coordinate + size + 2 <= start + available ? coordinate + 1 : coordinate - 1 >= start ? coordinate - 1 : coordinate;
    const arbitrary = { ...requested, x: offset(requested.x, area.x, area.width, requested.width), y: offset(requested.y, area.y, area.height, requested.height) };
    await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setBounds(target), arbitrary);
    const initialActual = await stableBounds('arbitrary native rectangle');
    assert.ok(Math.abs(initialActual.width - arbitrary.width) <= 1 && Math.abs(initialActual.height - arbitrary.height) <= 1);
    windowRestoration.arbitraryPosition = { requested: arbitrary, initialActual, cycles: [] };
    for (let restart = 1; restart <= 2; restart++) {
      await closeNormally();
      const recorded = JSON.parse(await fs.readFile(path.join(profile, 'window.json'), 'utf8'));
      assert.deepEqual(recorded, { ...initialActual, maximized: false });
      await launch(); sameProject(await project(), saved);
      const restored = await stableBounds(`arbitrary rectangle after restart ${restart}`);
      assert.deepEqual(restored, initialActual);
      windowRestoration.arbitraryPosition.cycles.push({ restart, saved: recorded, restored });
    }
    await page.screenshot({ path: path.join(evidence, 'native-app-restarted.png') });
  });
  await check('corrupt automatic-save original can be exported verbatim from its native recovery control', async () => {
    const raw = '{synthetic Engine Lab original\r\n원문 보존';
    // Seed the synthetic original before the new renderer reads storage. The
    // existing renderer legitimately saves its current observation on unload.
    await page.addInitScript(value => {
      if (location.protocol === 'app:' && location.hostname === 'engine') localStorage.setItem('engine-lab-project-v1', value);
    }, raw);
    await page.reload();
    await page.waitForFunction(() => window.engineLab?.project && !document.querySelector('#storage-recovery').hidden);
    const target = path.join(evidence, 'recovered-original.txt');
    await app.evaluate(({ session }, filename) => {
      globalThis.engineDownload = null;
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(filename); item.once('done', (_event, status) => { globalThis.engineDownload = status; });
      });
    }, target);
    await page.locator('#recover-original').click();
    await waitFor(() => app.evaluate(() => globalThis.engineDownload === 'completed'), 'native original download');
    assert.equal(await fs.readFile(target, 'utf8'), raw);
    assert.ok(await page.evaluate(value => Object.keys(localStorage).some(key => key.startsWith('engine-lab-project-v1-original-') && localStorage.getItem(key) === value), raw));
  });
  await check('all native workflows finish without application errors or external content', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
  });
} catch (error) {
  failure = error; process.exitCode = 1;
  const diagnostic = page ? await page.evaluate(() => ({ toast: document.querySelector('#toast')?.textContent, state: window.engineLab?.getState() })).catch(() => null) : null;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 3000 }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors, remoteRequests, windowRestoration, diagnostic }, null, 2));
  console.error(error.stack);
} finally {
  if (app) {
    await app.evaluate(() => { globalThis.engineResolveSave?.({ canceled: true }); }).catch(() => {});
    await page?.evaluate(() => window.engineDesktop?.setBusy(false)).catch(() => {});
    await closeNormally().catch(error => { failure ??= error; process.exitCode = 1; });
  }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: failure ? 'FAILED' : 'PASSED', version: expectedVersion,
    packaged, executablePath, profile, evidence, checks, errors, remoteRequests, processes, windowRestoration, realtimeGuide, gpu,
    ...(failure ? { failure: failure.message } : {}) }, null, 2));
  console.log(`Desktop validation: ${checks.length} checks ${failure ? 'completed before failure' : 'passed'}.`);
}
