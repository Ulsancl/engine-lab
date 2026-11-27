import { artifactDirectory } from '../scripts/safe-files.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { autosaveLockName } from '../src/browser-autosave.js';
import { chromium } from 'playwright';
import { preview } from 'vite';

async function until(action, message) {
  const deadline = performance.now() + 15_000;
  do {
    if (await action()) return;
    await delay(25);
  } while (performance.now() < deadline);
  assert.fail(message);
}

const root = path.resolve(import.meta.dirname, '..');
const output = artifactDirectory(root, path.join(root, 'output/browser-integration'));
await fs.mkdir(output, { recursive: true });
const server = await preview({ root, preview: { host: '127.0.0.1', port: 5198, strictPort: true } });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await context.newPage(), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const state = () => page.evaluate(() => window.engineLab.getState());
const project = () => page.evaluate(() => window.engineLab.project());
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const range = (selector, value) => page.locator(selector).evaluate((input, number) => { input.value = number; input.dispatchEvent(new Event('input', { bubbles: true })); }, String(value));
const closeCamera = (actual, expected) => {
  for (const key of ['position', 'target']) actual[key].forEach((v, i) => assert(Math.abs(v - expected[key][i]) < 1e-10, `${key} moved on selection`));
};
try {
  await page.clock.install({ time: new Date('2026-10-01T00:00:00Z') });
  await page.goto('http://127.0.0.1:5198/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.engineLab);
  await page.clock.pauseAt(new Date('2026-10-01T00:01:00Z'));
  await check('real 3D canvas, labelled components and initial paused observation', async () => {
    assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /form-action 'none'/);
    assert.equal(await page.locator('#scene canvas').count(), 1);
    const initial = await state(); assert.equal(initial.running, false); assert.equal(initial.settings.rpm, 1200); assert.equal(initial.view.mode, 'cutaway');
    assert((await page.evaluate(() => window.engineLab.components())).length >= 30);
    const scene = await page.evaluate(() => window.engineLab.sceneDebug());
    assert(scene.drawCalls > 0); assert(scene.triangles > 0);
    assert.equal(await page.locator('#explode').isDisabled(), true);
    assert((await page.locator('.engine-part-label:visible').count()) > 1);
    assert(await page.locator('#scene-part-select').isHidden());
    await page.screenshot({ path: path.join(output, 'engine-cutaway.png'), fullPage: true });
  });
  await check('500px touch layout keeps only the selected callout and exposes all file actions', async () => {
    const mobile = await browser.newContext({ viewport: { width: 500, height: 900 }, isMobile: true, hasTouch: true, acceptDownloads: true });
    try {
      const tab = await mobile.newPage();
      await tab.goto('http://127.0.0.1:5198/');
      await tab.waitForFunction(() => window.engineLab?.sceneDebug().drawCalls > 0);
      const actions = tab.getByRole('navigation', { name: '실험 파일' });
      const newProject = actions.getByRole('button', { name: '새 실험' });
      const save = actions.getByRole('button', { name: '실험 저장' });
      const open = actions.getByRole('button', { name: '실험 열기' });
      const help = actions.getByRole('button', { name: '사용 안내' });
      for (const button of [newProject, save, open, help]) {
        const box = await button.boundingBox();
        assert(box.width >= 44 && box.height >= 44 && box.x + box.width <= 500);
      }
      assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth), 500);
      await newProject.focus();
      for (const id of ['save-project', 'open-project', 'help']) {
        await tab.keyboard.press('Tab');
        assert.equal(await tab.evaluate(() => document.activeElement.id), id);
      }
      await tab.keyboard.press('Enter');
      assert(await tab.locator('#help-dialog').isVisible());
      await tab.keyboard.press('Escape');

      const labels = tab.locator('.engine-part-label:visible');
      const picker = tab.getByRole('combobox', { name: '장면에서 부품 선택' });
      await picker.selectOption('c4-piston');
      await labels.getByText('4번 피스톤', { exact: true }).waitFor();
      assert.deepEqual(await labels.allTextContents(), ['4번 피스톤']);
      await tab.locator('[data-camera="timing"]').tap();
      await picker.selectOption('timing-chain');
      await labels.getByText('타이밍 체인 · 2:1 구동').tap();
      assert.deepEqual(await labels.allTextContents(), ['타이밍 체인 · 2:1 구동']);
      await tab.locator('#labels').uncheck();
      await labels.first().waitFor({ state: 'hidden' });
      assert.equal(await picker.inputValue(), 'timing-chain');
      await tab.locator('#labels').check();
      await labels.getByText('타이밍 체인 · 2:1 구동').waitFor();

      const expected = await tab.evaluate(() => window.engineLab.project());
      const downloadEvent = tab.waitForEvent('download');
      await save.tap();
      const exported = await downloadEvent;
      const filename = path.join(output, 'mobile-observation.engine.json');
      await exported.saveAs(filename);
      assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), expected);
      await newProject.tap();
      assert.equal(await picker.inputValue(), 'c1-piston');
      await tab.locator('#undo-new').tap();
      assert.deepEqual(await tab.evaluate(() => window.engineLab.project()), expected);
      await newProject.tap();
      const fileChooser = tab.waitForEvent('filechooser');
      await open.tap();
      await (await fileChooser).setFiles(filename);
      await tab.waitForFunction(() => window.engineLab.getState().view.selectedPart === 'timing-chain');
      assert.deepEqual(await tab.evaluate(() => window.engineLab.project()), expected);
    } finally { await mobile.close(); }
  });
  await check('guided eight-second cycle retains elapsed time across delayed frames and the two-to-one cam ratio', async () => {
    await page.locator('#one-cycle').click();
    await page.clock.runFor(100); await page.clock.fastForward(1900);
    const mid = await state(); assert(mid.running); assert(Math.abs(mid.angleRad - Math.PI) < .07);
    assert(Math.abs(mid.snapshot.camAngles.exhaust * 2 - mid.angleRad) < 1e-12);
    const drawn = await page.evaluate(() => window.engineLab.sceneDebug());
    assert(Math.abs(drawn.crankRotation + mid.angleRad) < 1e-12);
    assert(drawn.maxCamSupportErrorM < .00005, JSON.stringify(drawn.camContacts));
    await page.clock.fastForward(6100); const ended = await state(); assert.equal(ended.running, false); assert.equal(ended.angleRad, 0);
    assert.match(await page.locator('#toast').textContent(), /한 사이클 완료/);
  });
  await check('manual angle exposes equal piston heights with different strokes', async () => {
    await range('#angle', 360); const current = await state();
    assert.equal(current.snapshot.cylinders[0].stroke, 'intake'); assert.equal(current.snapshot.cylinders[3].stroke, 'power');
    assert(Math.abs(current.snapshot.cylinders[0].pistonPin.y - current.snapshot.cylinders[3].pistonPin.y) < 1e-12);
    assert.match(await page.locator('#cycle-explanation').textContent(), /오버랩/);
    await range('#cam-advance', 10); const advanced = await state();
    assert(Math.abs(advanced.settings.intakeAdvanceRad - Math.PI / 18) < 1e-12);
    assert(advanced.snapshot.cylinders[0].valveLifts.intake > current.snapshot.cylinders[0].valveLifts.intake);
    assert(Math.abs(advanced.snapshot.camAngles.intake - advanced.snapshot.camAngles.exhaust - Math.PI / 36) < 1e-12);
  });
  await check('part selection preserves the camera and single-cylinder view preserves engine phase', async () => {
    const camera = await page.evaluate(() => window.engineLab.camera()), before = await state();
    await page.locator('#part-select').selectOption('c3-rod'); await page.clock.runFor(80);
    const selected = await state(); assert.equal(selected.view.selectedCylinder, 3); assert.equal(selected.angleRad, before.angleRad);
    closeCamera(await page.evaluate(() => window.engineLab.camera()), camera);
    await page.locator('[data-cylinder-mode="single"]').click(); assert.equal((await state()).angleRad, before.angleRad);
    assert.equal((await state()).view.cylinderMode, 'single');
    assert.deepEqual((await page.evaluate(() => window.engineLab.sceneDebug())).visibleCylinderIds, [3]);
    await page.locator('[data-phase="180"]').click(); assert.equal((await state()).snapshot.cylinders[2].stroke, 'exhaust');
  });
  await check('valve comparison follows selected-cylinder phase and advancing the intake expands overlap', async () => {
    await range('#cam-advance', 0);
    const base = await page.locator('#valve-intake').getAttribute('d');
    assert.equal(base, await page.locator('#valve-baseline').getAttribute('d'));
    assert.match(await page.locator('#valve-events').textContent(), /350–580°.*오버랩 20°/);
    await range('#cam-advance', 10);
    assert.notEqual(await page.locator('#valve-intake').getAttribute('d'), base);
    assert.equal(await page.locator('#valve-baseline').getAttribute('d'), base);
    assert.match(await page.locator('#valve-events').textContent(), /340–570°.*오버랩 30°/);
    await page.locator('#show-overlap').click();
    const overlap = await state(), selected = overlap.snapshot.cylinders[2];
    assert.equal(overlap.running, false); assert.equal(overlap.view.selectedCylinder, 3);
    assert(selected.valveLifts.intake > 0 && selected.valveLifts.exhaust > 0);
    assert(Math.abs(selected.phaseRad * 180 / Math.PI - 355) < 1e-10);
    await range('#valve-angle', 360);
    const scrubbed = await state();
    assert(Math.abs(scrubbed.angleRad * 180 / Math.PI - 540) < 1e-10);
    assert.equal(scrubbed.snapshot.cylinders[2].stroke, 'intake');
    assert.equal(await page.locator('#valve-angle-value').textContent(), '360°');
    assert.match(await page.locator('#timing-cylinder').textContent(), /3번/);
    assert(Math.abs(Number(await page.locator('#valve-cursor').getAttribute('x1')) - 360) < 1e-10);
    await range('#cam-advance', -10);
    assert.match(await page.locator('#valve-events').textContent(), /360–590°.*오버랩 10°/);
  });
  await check('cutaway, explosion, lubrication and camera presets remain interactive', async () => {
    await page.locator('[data-mode="exploded"]').click(); await range('#explode', .65);
    assert.equal(await page.locator('#explode').isDisabled(), false); assert.equal((await state()).view.explode, .65);
    await page.locator('.controls details').evaluate(node => { node.open = true; }); await page.locator('[data-layer="lubrication"]').check();
    await page.locator('[data-camera="front"]').click(); await page.clock.runFor(80);
    const framing = await page.evaluate(() => window.engineLab.sceneDebug());
    const bounds = framing.lastPresetFit.projectedBounds;
    assert(bounds.left >= -.841 && bounds.right <= .841 && bounds.bottom >= -.781 && bounds.top <= .781, JSON.stringify(bounds));
    assert(Math.abs(Math.hypot(...framing.camera.position.map((v, i) => v - framing.camera.target[i])) - framing.lastPresetFit.distance) < 1e-10);
    const labelTops = await page.locator('.engine-part-label:visible').evaluateAll(nodes => nodes.map(n => parseFloat(n.style.top)));
    assert(labelTops.every(top => top >= 60), JSON.stringify(labelTops));
    await page.screenshot({ path: path.join(output, 'single-exploded.png'), fullPage: true });
    await page.locator('[data-mode="assembled"]').click(); assert.equal(await page.locator('#explode').isDisabled(), true);
    await page.locator('[data-mode="cutaway"]').click();
    await page.locator('#labels').uncheck(); await page.locator('#show-overlap').click();
    await page.locator('[data-camera="iso"]').click(); await page.clock.runFor(80);
    await page.screenshot({ path: path.join(output, 'single-cutaway-lubrication.png'), fullPage: true });
    await page.locator('#labels').check();
  });
  await check('Space toggles once while inputs retain their own keyboard behavior', async () => {
    await page.locator('#scene').focus(); await page.keyboard.press('Space'); assert.equal((await state()).running, true);
    await page.clock.runFor(200); await page.keyboard.press('Space'); const stopped = await state(); assert.equal(stopped.running, false);
    await page.clock.runFor(200); assert.equal((await state()).angleRad, stopped.angleRad);
    await page.locator('#rpm').focus(); await page.keyboard.press('Space'); assert.equal((await state()).running, false);
  });
  await check('compact windows retain the visible disassembly spacing control', async () => {
    await page.setViewportSize({ width: 1024, height: 768 }); await page.clock.runFor(100);
    await page.locator('[data-mode="exploded"]').click();
    assert.equal(await page.locator('#explode').isVisible(), true);
    await page.locator('#explode').fill('0.42');
    assert.equal((await state()).view.explode, .42);
    await page.screenshot({ path: path.join(output, 'compact-disassembly.png'), fullPage: true });
    await page.setViewportSize({ width: 1600, height: 1100 }); await page.clock.runFor(100);
  });
  await check('file download and reopen preserve the complete settings, view, angle and camera', async () => {
    await page.clock.runFor(300); const original = await project();
    const downloadEvent = page.waitForEvent('download'); await page.locator('#save-project').click(); const download = await downloadEvent;
    const filename = path.join(output, 'observation.engine.json'); await download.saveAs(filename);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), original);
    await page.evaluate(() => window.engineLab.reset());
    await page.locator('#file-input').setInputFiles(filename); await page.clock.runFor(100);
    assert.deepEqual(await project(), original);
    await page.clock.runFor(300);
    await until(() => page.evaluate(project => JSON.stringify(JSON.parse(localStorage.getItem('engine-lab-project-v1'))) === JSON.stringify(project), original), 'imported experiment must save before reload');
    await page.reload(); await page.waitForFunction(() => !!window.engineLab);
    assert.deepEqual(await project(), original);
  });
  await check('starting a new experiment can restore the preceding observation and camera', async () => {
    const original = await project();
    await page.evaluate(() => window.engineLab.reset());
    assert.equal((await state()).angleRad, 0);
    await page.locator('#undo-new').click();
    assert.deepEqual(await project(), original);
    assert.equal(await page.locator('#undo-new').isVisible(), false);
  });
  await check('future and invalid imports leave the current experiment intact', async () => {
    const original = await project();
    const failure = await page.evaluate(project => {
      const failures = [];
      for (const text of ['{not json', JSON.stringify({ ...project, schemaVersion: 99 })]) {
        try { window.engineLab.loadProject(text); } catch (error) { failures.push(error.message); }
      }
      return failures;
    }, original);
    assert.equal(failure.length, 2); assert.deepEqual(await project(), original);
  });
  await check('a newer automatic-save format stays untouched while observing a separate experiment', async () => {
    const raw = JSON.stringify({ ...(await project()), schemaVersion: 99 });
    const futureContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      await futureContext.addInitScript(text => localStorage.setItem('engine-lab-project-v1', text), raw);
      const future = await futureContext.newPage();
      await future.goto('http://127.0.0.1:5198/', { waitUntil: 'networkidle' });
      await future.waitForFunction(() => !!window.engineLab);
      assert.match(await future.locator('#storage-recovery strong').textContent(), /새로운 버전/);
      await future.locator('#step').click();
      await future.waitForTimeout(260);
      assert.equal(await future.evaluate(() => localStorage.getItem('engine-lab-project-v1')), raw);
      assert.equal((await future.evaluate(() => window.engineLab.project())).schemaVersion, 1);
      const originals = () => future.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('engine-lab-project-v1-original-')).sort());
      const firstLaunch = await originals();
      assert.equal(firstLaunch.length, 1);
      await future.reload({ waitUntil: 'networkidle' });
      await future.waitForFunction(() => !!window.engineLab);
      assert.deepEqual(await originals(), firstLaunch);
    } finally { await futureContext.close(); }
  });
  await check('corrupt automatic-save text is retained and recoverable byte for byte', async () => {
    const original = '{original invalid engine experiment\n한글 remains intact';
    // The observation context deliberately freezes timers. Give autosave its
    // own real clock and seed the original only once, not on every restart.
    const recoveryContext = await browser.newContext({ acceptDownloads: true });
    await recoveryContext.addInitScript(raw => {
      if (!sessionStorage.getItem('recovery-test-seeded')) {
        localStorage.setItem('engine-lab-project-v1', raw);
        sessionStorage.setItem('recovery-test-seeded', '1');
      }
    }, original);
    const recovery = await recoveryContext.newPage(); await recovery.goto('http://127.0.0.1:5198/', { waitUntil: 'domcontentloaded' });
    await recovery.waitForFunction(() => window.engineLab && !document.querySelector('#storage-recovery').hidden);
    await recovery.waitForFunction(raw => Object.keys(localStorage).some(key => key.startsWith('engine-lab-project-v1-original-') && localStorage.getItem(key) === raw), original);
    // Once an ordinary observation replaces the damaged primary, restart
    // before exporting and check both the recovered original and the new data.
    await recovery.locator('#step').click();
    await recovery.waitForFunction(raw => {
      const stored = localStorage.getItem('engine-lab-project-v1');
      return stored !== raw && JSON.parse(stored)?.observation.angleRad > 0;
    }, original);
    const saved = await recovery.evaluate(() => localStorage.getItem('engine-lab-project-v1'));
    await recovery.reload({ waitUntil: 'networkidle' });
    await recovery.waitForFunction(() => !!window.engineLab);
    assert.equal(await recovery.locator('#storage-recovery').isVisible(), true);
    assert.match(await recovery.locator('#storage-recovery strong').textContent(), /이전에 보관한/);
    assert.equal(await recovery.evaluate(() => window.engineLab.project().observation.angleRad), JSON.parse(saved).observation.angleRad);
    const downloaded = recovery.waitForEvent('download'); await recovery.locator('#recover-original').click(); const file = await downloaded;
    const dest = path.join(output, 'recovered-original.txt'); await file.saveAs(dest); assert.equal(await fs.readFile(dest, 'utf8'), original);
    await recovery.locator('#dismiss-recovery').click();
    await recovery.waitForFunction(() => localStorage.getItem('engine-lab-project-v1-dismissed-original') !== null);
    await recovery.reload({ waitUntil: 'networkidle' });
    await recovery.waitForFunction(() => !!window.engineLab);
    assert.equal(await recovery.locator('#storage-recovery').isHidden(), true);
    await recoveryContext.close();
  });
  await check('narrow-screen observation stays usable without horizontal overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.clock.runFor(100);
    await page.locator('.valve-timing').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'narrow-valve-chart.png'), fullPage: true });
    await page.locator('#focus-view').click(); await page.clock.runFor(100);
    assert.equal(await page.locator('#toast').isVisible(), false);
    const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, scene: document.querySelector('#scene').getBoundingClientRect().toJSON() }));
    assert(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout)); assert(layout.scene.height >= 280);
    await page.screenshot({ path: path.join(output, 'narrow-observation.png'), fullPage: true });
  });
  await check('exporting and closing a stale tab preserves both observations', async () => {
    const tabs = await browser.newContext({ acceptDownloads: true });
    const key = 'engine-lab-project-v1';
    const openTab = async () => {
      const tab = await tabs.newPage();
      await tab.goto('http://127.0.0.1:5198/', { waitUntil: 'domcontentloaded' });
      await tab.waitForFunction(() => !!window.engineLab);
      return tab;
    };
    try {
      const stale = await openTab();
      await stale.evaluate(() => window.engineLab.setAngle(1));
      await stale.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.observation.angleRad === 1, key);
      const current = await openTab();
      await current.evaluate(() => window.engineLab.setAngle(2));
      await current.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.observation.angleRad === 2, key);
      const newest = await current.evaluate(key => localStorage.getItem(key), key);
      assert.equal(JSON.parse(newest).observation.angleRad, 2);
      const pending = stale.waitForEvent('download'); await stale.locator('#save-project').click();
      const download = await pending;
      const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
      assert.equal(exported.observation.angleRad, 1);
      const closed = stale.waitForEvent('close');
      await stale.close({ runBeforeUnload: true }); await closed;
      assert.equal(await current.evaluate(key => localStorage.getItem(key), key), newest);
    } finally { await tabs.close(); }
  });

  const saveKey = 'engine-lab-project-v1';
  const lockName = autosaveLockName(saveKey);
  const stored = tab => tab.evaluate(key => localStorage.getItem(key), saveKey);
  const experiment = tab => tab.evaluate(() => window.engineLab.project());
  const edit = (tab, value) => tab.evaluate(value => window.engineLab.setAngle(value), value);
  const exitsWithWarning = tab => tab.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
  const open = async (tabs, init) => {
    const tab = await tabs.newPage();
    tab.on('pageerror', error => errors.push(error.message));
    if (init) await tab.addInitScript(init[0], init[1]);
    await tab.goto('http://127.0.0.1:5198/', { waitUntil: 'domcontentloaded' });
    await tab.waitForFunction(() => !!window.engineLab);
    return tab;
  };
  const reload = async tab => {
    const accept = dialog => dialog.accept();
    tab.on('dialog', accept);
    try { await tab.reload({ waitUntil: 'domcontentloaded' }); }
    finally { tab.off('dialog', accept); }
    await tab.waitForFunction(() => !!window.engineLab);
  };
  const exportCurrent = async (tab, destination) => {
    const pending = tab.waitForEvent('download');
    await tab.locator('#export-unsaved-project').click();
    const file = await pending;
    assert.match(file.suggestedFilename(), /\.engine\.json$/);
    const target = path.join(output, destination);
    await file.saveAs(target);
    return JSON.parse(await fs.readFile(target, 'utf8'));
  };

  await check('real concurrent tabs share a lock, retain newest experiment and export the conflicted one', async () => {
    const tabs = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    let holder;
    try {
      holder = await open(tabs);
      await edit(holder, 1);
      await until(async () => JSON.parse(await stored(holder))?.observation.angleRad === 1, 'initial observation must be saved');
      const original = await stored(holder);
      const first = await open(tabs), second = await open(tabs);
      for (const tab of [first, second]) assert.equal((await experiment(tab)).observation.angleRad, 1);
      await holder.evaluate(name => new Promise((ready, fail) => {
        navigator.locks.request(name, () => new Promise(resolve => {
          window.releaseAutosaveTestLock = resolve;
          ready();
        })).catch(fail);
      }), lockName);
      const pendingClients = count => until(async () => {
        const observed = await holder.evaluate(async ({ name, key }) => {
          const { pending, held } = await navigator.locks.query();
          return {
            raw: localStorage.getItem(key), held: held.some(lock => lock.name === name),
            clients: new Set(pending.filter(lock => lock.name === name).map(lock => lock.clientId)).size,
          };
        }, { name: lockName, key: saveKey });
        assert.equal(observed.raw, original, 'must not write while another tab holds the lock');
        return observed.held && observed.clients === count;
      }, `expected ${count} distinct queued Web Locks clients`);

      await edit(first, 2);
      await pendingClients(1);
      await edit(first, 3);
      await edit(second, 4);
      await pendingClients(2);
      assert.equal(await exitsWithWarning(second), true, 'queued work is not durable yet');
      await holder.evaluate(() => window.releaseAutosaveTestLock());

      await until(async () => JSON.parse(await stored(holder))?.observation.angleRad === 3, 'the first waiting tab must save its latest edit');
      await second.locator('#autosave-recovery').waitFor({ state: 'visible' });
      assert.match(await second.locator('#autosave-title').textContent(), /다른 탭/);
      assert.equal(await exitsWithWarning(second), true, 'conflicted edits are still unsaved');
      const winner = await stored(holder);
      await edit(second, 5);
      const expected = await experiment(second);
      const file = await exportCurrent(second, 'autosave-conflicted-tab.json');
      assert.deepEqual(file, expected);
      assert.equal(file.observation.angleRad, 5);
      assert.equal(await exitsWithWarning(second), true, 'download requests do not commit edits');
      assert.equal(await stored(second), winner);
      // Further edits stay recoverable without altering the shared primary.
      await second.locator('#step').click();
      assert.equal(await exitsWithWarning(second), true);
      await exportCurrent(second, 'autosave-edited-again.json');
      assert.equal(await exitsWithWarning(second), true);
      await reload(second);
      assert.equal(await second.locator('#tab-draft-recovery').isVisible(), true);
      assert.equal((await experiment(second)).observation.angleRad, 3);
      assert.equal(await second.locator('#autosave-recovery').isHidden(), true);
      assert.equal(await stored(second), winner);
    } finally {
      await holder?.evaluate(() => window.releaseAutosaveTestLock?.()).catch(() => {});
      await tabs.close();
    }
  });

  await check('rapid same-tab reload restores pending work and keeps stale drafts separate', async () => {
    const tabs = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    let holder;
    try {
      holder = await open(tabs);
      await edit(holder, 1);
      await until(async () => JSON.parse(await stored(holder))?.observation.angleRad === 1, 'seed observation must be saved');
      const original = await stored(holder);
      const rapid = await open(tabs);
      await holder.evaluate(name => new Promise((ready, fail) => {
        navigator.locks.request(name, () => new Promise(resolve => {
          window.releaseAutosaveTestLock = resolve;
          ready();
        })).catch(fail);
      }), lockName);

      // Navigate while the real lock prevents the shared save; do not wait
      // for the debounce timer or synthesize a storage write in the test.
      await edit(rapid, 2);
      await reload(rapid);
      assert.equal((await experiment(rapid)).observation.angleRad, 2, 'current tab draft must survive reload');
      assert.equal(await stored(rapid), original, 'reloaded draft must not bypass the held lock');

      await holder.evaluate(() => window.releaseAutosaveTestLock());
      await until(async () => JSON.parse(await stored(rapid))?.observation.angleRad === 2, 'the resumed draft commits through the ordinary lock');
      await until(() => rapid.evaluate(key => sessionStorage.getItem(`${key}:tab-draft`) === null, saveKey), 'committed journal must be cleared');

      const other = await open(tabs);
      await edit(other, 4);
      await until(async () => JSON.parse(await stored(other))?.observation.angleRad === 4, 'the other tab must save newer bytes');
      const latest = await stored(other);
      await edit(rapid, 5);
      const older = await experiment(rapid);
      await reload(rapid);
      assert.equal((await experiment(rapid)).observation.angleRad, 4, 'newer shared bytes take priority over a conflicting draft');
      assert.equal(await stored(rapid), latest);
      assert.equal(await rapid.locator('#tab-draft-recovery').isVisible(), true);
      const draftKey = saveKey + ':tab-draft';
      const readDraft = () => rapid.evaluate(key => sessionStorage.getItem(key), draftKey);
      const journal = await readDraft();
      // Simulate a download which the browser declines to start.
      await rapid.evaluate(() => window.addEventListener('click', event => {
        if (event.target instanceof HTMLAnchorElement && event.target.download) event.preventDefault();
      }));
      await rapid.locator('#export-interrupted-draft').click();
      assert.equal(await readDraft(), journal);
      await reload(rapid);
      assert.equal(await rapid.locator('#tab-draft-recovery').isVisible(), true);
      const downloaded = rapid.waitForEvent('download');
      await rapid.locator('#export-interrupted-draft').click();
      const file = await downloaded;
      assert.deepEqual(JSON.parse(await fs.readFile(await file.path(), 'utf8')), older);
      assert.equal(await readDraft(), journal);
      assert.equal(await rapid.locator('#tab-draft-recovery').isVisible(), true);
      await rapid.locator('#forget-interrupted-draft').click();
      assert.equal(await rapid.locator('#tab-draft-recovery').isHidden(), true);
      assert.equal(await readDraft(), null);
      assert.equal(await stored(rapid), latest);
    } finally {
      await holder?.evaluate(() => window.releaseAutosaveTestLock?.()).catch(() => {});
      await tabs.close();
    }
  });

  await check('absent or denied Web Locks keep the autosave read-only but allow current file export', async () => {
    const raw = JSON.stringify(await experiment(page));
    const reference = JSON.parse(raw).observation.angleRad;
    for (const denied of [false, true]) {
      const tabs = await browser.newContext({ acceptDownloads: true });
      try {
        const tab = await open(tabs, [({ key, raw, denied }) => {
          Object.defineProperty(navigator, 'locks', { value: denied ? {
            request: () => Promise.reject(new DOMException('test denial', 'SecurityError')),
          } : undefined });
          localStorage.setItem(key, raw);
        }, { key: saveKey, raw, denied }]);
        assert.equal((await experiment(tab)).observation.angleRad, reference);
        const next = reference === 2 ? 3 : 2;
        await edit(tab, next);
        await tab.locator('#autosave-recovery').waitFor({ state: 'visible' });
        assert.match(await tab.locator('#autosave-title').textContent(), /안전한 자동 저장/);
        await tab.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        assert.equal(await exitsWithWarning(tab), true);
        assert.equal(await stored(tab), raw);
        const file = await exportCurrent(tab, `autosave-unavailable-${denied}.json`);
        assert.equal(file.observation.angleRad, next);
        assert.equal(await exitsWithWarning(tab), true);
        assert.equal(await stored(tab), raw);
      } finally { await tabs.close(); }
    }
  });

  await check('no browser JavaScript or resource errors', async () => { assert.deepEqual(errors, []); });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'PASSED', checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors }, null, 2));
  throw error;
} finally { await browser.close(); await server.close(); }
