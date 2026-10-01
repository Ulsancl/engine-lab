import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output/browser-integration');
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5198, strictPort: true } });
await server.listen();
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
    assert.equal(await page.locator('#scene canvas').count(), 1);
    const initial = await state(); assert.equal(initial.running, false); assert.equal(initial.settings.rpm, 1200); assert.equal(initial.view.mode, 'cutaway');
    assert((await page.evaluate(() => window.engineLab.components())).length >= 30);
    const scene = await page.evaluate(() => window.engineLab.sceneDebug());
    assert(scene.drawCalls > 0); assert(scene.triangles > 0);
    assert.equal(await page.locator('#explode').isDisabled(), true);
    await page.screenshot({ path: path.join(output, 'engine-cutaway.png'), fullPage: true });
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
  await check('file download and reopen preserve the complete settings, view, angle and camera', async () => {
    await page.clock.runFor(300); const original = await project();
    const downloadEvent = page.waitForEvent('download'); await page.locator('#save-project').click(); const download = await downloadEvent;
    const filename = path.join(output, 'observation.engine.json'); await download.saveAs(filename);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), original);
    await page.evaluate(() => window.engineLab.reset());
    await page.locator('#file-input').setInputFiles(filename); await page.clock.runFor(100);
    assert.deepEqual(await project(), original);
    await page.clock.runFor(300); await page.reload(); await page.waitForFunction(() => !!window.engineLab);
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
    } finally { await futureContext.close(); }
  });
  await check('corrupt automatic-save text is retained and recoverable byte for byte', async () => {
    const original = '{original invalid engine experiment\n한글 remains intact';
    await page.evaluate(raw => localStorage.setItem('engine-lab-project-v1', raw), original);
    // Reload invokes beforeunload; remove its autosave handler by opening a separate
    // same-origin page, whose fresh load reads the deliberately corrupt fixture.
    const recovery = await context.newPage(); await recovery.goto('http://127.0.0.1:5198/', { waitUntil: 'networkidle' });
    await recovery.waitForFunction(() => window.engineLab && !document.querySelector('#storage-recovery').hidden);
    assert(await recovery.evaluate(raw => Object.keys(localStorage).some(key => key.startsWith('engine-lab-project-v1-original-') && localStorage.getItem(key) === raw), original));
    const downloaded = recovery.waitForEvent('download'); await recovery.locator('#recover-original').click(); const file = await downloaded;
    const dest = path.join(output, 'recovered-original.txt'); await file.saveAs(dest); assert.equal(await fs.readFile(dest, 'utf8'), original);
    await recovery.close();
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
  await check('no browser JavaScript or resource errors', async () => { assert.deepEqual(errors, []); });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'PASSED', checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors }, null, 2));
  throw error;
} finally { await browser.close(); await server.close(); }
