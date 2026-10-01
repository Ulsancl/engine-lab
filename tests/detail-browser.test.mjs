import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'output', 'detail-browser');
const address = 'http://127.0.0.1:5246';
const checks = [], errors = [], evidence = [];
const RAD = Math.PI / 180;
let server, browser, context, page;
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const vectorNear = (actual, expected, tolerance = 1e-9) => actual.forEach((value, index) => near(value, expected[index], tolerance));
const cameraNear = (actual, expected) => { for (const key of ['position', 'target']) vectorNear(actual[key], expected[key], 1e-10); near(actual.zoom, expected.zoom, 1e-10); };
const state = () => page.evaluate(() => window.engineLab.getState());
const project = () => page.evaluate(() => window.engineLab.project());
const debug = () => page.evaluate(() => window.engineLab.sceneDebug());
const camera = () => page.evaluate(() => window.engineLab.camera());
const angle = degrees => page.evaluate(value => window.engineLab.setAngle(value), degrees * RAD);
const range = (selector, value) => page.locator(selector).evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
const select = id => page.locator('#part-select').selectOption(id);
const facts = (focus = false) => page.locator(focus ? '#focus-detail-facts .detail-fact' : '#part-detail-facts .detail-fact').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.label, { value: node.dataset.value, unit: node.dataset.unit, text: node.querySelector('dd').textContent.trim() }])));
const rendering = () => page.evaluate(() => {
  const canvas = document.querySelector('#scene canvas'), gl = canvas?.getContext('webgl2'), info = gl?.getExtension('WEBGL_debug_renderer_info');
  const scene = window.engineLab?.sceneDebug();
  return { contextLost: gl?.isContextLost() ?? true, renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER), drawCalls: scene?.drawCalls, triangles: scene?.triangles, canvas: canvas && { width: canvas.width, height: canvas.height } };
});
async function check(name, action) {
  try { await action(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) {
    checks.push({ name, passed: false, error: error.message });
    evidence.push({ failureRendering: await rendering().catch(() => null) });
    // Failure evidence must not repeat a capture with the render clock paused.
    await page?.clock.resume().catch(() => {});
    await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
    throw error;
  }
}
async function capture(name, sceneOnly = false) {
  await page.clock.runFor(80);
  const before = await state(), saved = await project();
  assert.equal(before.running, false, 'Capture only a paused simulation; rendering time must not advance engine motion.');
  // Chromium's screenshot compositor can request a new frame after scrolling.
  // Keep RAFs available until capture completes instead of pausing them between
  // the last render and Page.captureScreenshot (intermittent Windows CI hang).
  await page.clock.resume();
  try {
    if (sceneOnly) await page.locator('#scene').evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const rendered = await rendering();
    assert.equal(rendered.contextLost, false, JSON.stringify(rendered));
    assert.ok(rendered.drawCalls > 0 && rendered.triangles > 0, JSON.stringify(rendered));
    const options = { path: path.join(output, `${name}.png`) };
    if (sceneOnly) {
      options.clip = await page.locator('#scene').boundingBox();
      assert.ok(options.clip && options.clip.width > 0 && options.clip.height > 0);
    } else options.fullPage = true;
    await page.screenshot(options);
    assert.equal((await rendering()).contextLost, false);
    evidence.push({ capture: name, rendering: rendered });
  } finally {
    // pauseAt needs a future wall time. A generous horizon also works on slow CI;
    // fast-forward fires pending UI/save timers once, while the engine is paused.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60000));
  }
  assert.deepEqual(await state(), before, 'Rendering a screenshot must preserve the paused observation.');
  assert.deepEqual(await project(), saved, 'Rendering a screenshot must preserve the saved project and camera.');
}

try {
  await mkdir(output, { recursive: true });
  server = await createServer({ root, server: { host: '127.0.0.1', port: 5246, strictPort: true } }); await server.listen();
  // Match the existing browser suite and let Chromium choose its supported backend.
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
  await context.exposeBinding('__reportDetailContextLoss', (_source, message) => errors.push({ kind: 'webgl', message }));
  await context.addInitScript(() => document.addEventListener('webglcontextlost', event => {
    window.__reportDetailContextLoss(event.statusMessage || 'WebGL context lost');
  }, true));
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push({ kind: 'page', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') errors.push({ kind: 'console', message: message.text() }); });
  page.on('requestfailed', request => errors.push({ kind: 'request', message: request.url() + ': ' + request.failure()?.errorText }));
  await page.clock.install({ time: new Date('2026-10-02T00:00:00Z') });
  await page.goto(address, { waitUntil: 'networkidle' }); await page.waitForFunction(() => window.engineLab?.sceneDebug().drawCalls > 0);
  await page.clock.pauseAt(new Date('2026-10-02T00:01:00Z'));

  await check('The detail workbench renders actual WebGL while preserving the published kinematic model', async () => {
    const current = await state(), scene = await debug();
    assert.equal(current.running, false); assert.equal(current.settings.rpm, 1200);
    assert.equal((await project()).modelVersion, 'engine-kinematics-1');
    assert.ok(scene.drawCalls > 0 && scene.triangles > 0);
    assert.equal(await page.locator('#scene canvas').count(), 1);
    assert.ok(Object.keys(await facts()).length > 0);
    await capture('engine-detail-overview');
  });

  await check('Fractional imported RPM and cam advance stay exact in controls, references and saved settings', async () => {
    const original = await project();
    for (const row of Object.values(await facts())) assert.doesNotMatch(row.text, /^[-−]0(?:\.0+)?(?:\s|$)/, row.text);
    const imported = structuredClone(original); imported.settings = { rpm: 1234.5, intakeAdvanceRad: .1 };
    await page.evaluate(value => window.engineLab.loadProject(JSON.stringify(value)), imported);
    const current = await state(); assert.deepEqual(current.settings, imported.settings);
    near(Number(await page.locator('#rpm').inputValue()), current.settings.rpm);
    near(Number(await page.locator('#cam-advance').inputValue()) * RAD, current.settings.intakeAdvanceRad);
    assert.equal(await page.locator('#rpm').getAttribute('step'), 'any'); assert.equal(await page.locator('#cam-advance').getAttribute('step'), 'any');
    assert.match(await page.locator('#rpm-value').textContent(), /1,234\.5/);
    assert.match(await page.locator('#detail-reference').textContent(), /1,234\.5/);
    assert.deepEqual((await project()).settings, imported.settings);
    await page.evaluate(value => window.engineLab.loadProject(JSON.stringify(value)), await project());
    assert.deepEqual((await state()).settings, imported.settings);
    await page.evaluate(value => window.engineLab.loadProject(JSON.stringify(value)), original);
  });

  await check('The selected cylinder owns the piston facts without changing angle or camera on selection', async () => {
    const savedCamera = await camera(), phases = [0, 540, 180, 360];
    const r = .043, L = .143, omega = 1200 * 2 * Math.PI / 60;
    for (let id = 1; id <= 4; id++) {
      const before = await state(); await select(`c${id}-piston`);
      assert.equal((await state()).angleRad, before.angleRad); cameraNear(await camera(), savedCamera);
      await angle(phases[id - 1] + 90);
      const current = await state(), d = current.detail.cylinder, rows = await facts();
      assert.equal(current.view.selectedCylinder, id); assert.equal(current.detail.selectedCylinderId, id); assert.equal(d.id, id);
      near(d.phaseRad, Math.PI / 2); near(d.piston.velocityYMps, -r * omega);
      near(d.piston.accelerationYMps2, r * r / Math.sqrt(L * L - r * r) * omega * omega, 1e-8);
      near(Number(rows['상사점에서 내려온 거리'].value), (r + L - current.snapshot.cylinders[id - 1].pistonPin.y) * 1000);
      near(Number(rows['피스톤 속도 · 위쪽 +'].value), d.piston.velocityYMps); assert.equal(rows['피스톤 속도 · 위쪽 +'].unit, 'm/s');
      near(Number(rows['피스톤 가속도 · 위쪽 +'].value), d.piston.accelerationYMps2);
      assert.match(await page.locator('#part-detail-note').textContent(), new RegExp(`${id}번 실린더`));
    }
    await angle(360); const top = (await state()).detail.cylinder.piston;
    near(top.travelFromTdcM, 0); near(top.velocityYMps, 0);
    await angle(540); near((await state()).detail.cylinder.piston.travelFromTdcM, .086);
    evidence.push({ selectedPistons: true, topDeadCenter: top });
  });

  await check('Physical velocity and acceleration scale with RPM but remain unchanged while paused or changing playback rate', async () => {
    await select('c3-piston'); await angle(270); await range('#rpm', 1200);
    const before = await state(), beforeFacts = await facts();
    for (const rate of ['0.01', '1', '0.025']) {
      await page.locator('#playback-rate').selectOption(rate); await page.clock.runFor(80);
      const current = await state(); assert.equal(current.running, false); assert.equal(current.angleRad, before.angleRad);
      assert.deepEqual(current.detail, before.detail); assert.deepEqual(await facts(), beforeFacts);
    }
    await range('#rpm', 2400); const doubled = await state();
    near(doubled.detail.cylinder.piston.travelFromTdcM, before.detail.cylinder.piston.travelFromTdcM);
    near(doubled.detail.cylinder.piston.velocityYMps, before.detail.cylinder.piston.velocityYMps * 2);
    near(doubled.detail.cylinder.piston.accelerationYMps2, before.detail.cylinder.piston.accelerationYMps2 * 4, 1e-8);
    near(doubled.detail.cam.rpm, 1200); near(doubled.detail.timing.cycleSeconds, .05);
    assert.match(await page.locator('#part-detail-note').textContent(), /설정 회전수/);
    evidence.push({ physicalRpmScaling: { before: before.detail.cylinder.piston, doubled: doubled.detail.cylinder.piston } });
  });

  await check('The piston chart uses the selected cylinder phase and displays the chosen physical metric', async () => {
    await select('c2-piston'); await angle(630);
    for (const [metric, field, scale, unit] of [['travel', 'travelFromTdcM', 1000, 'mm'], ['velocity', 'velocityYMps', 1, 'm/s'], ['acceleration', 'accelerationYMps2', 1, 'm/s²']]) {
      await page.locator('#piston-metric').selectOption(metric);
      const current = await state(), node = page.locator('#piston-current-value');
      near(Number(await page.locator('#piston-cursor').getAttribute('data-phase-deg')), current.detail.cylinder.phaseRad / RAD);
      const cursorX = 46 + current.detail.cylinder.phaseRad / RAD / 720 * 660;
      near(Number(await page.locator('#piston-cursor').getAttribute('x1')), cursorX);
      near(Number(await page.locator('#piston-dot').getAttribute('cx')), cursorX);
      near(Number(await node.getAttribute('data-value')), current.detail.cylinder.piston[field] * scale);
      assert.equal(await node.getAttribute('data-unit'), unit);
      const curve = await page.locator('#piston-curve').getAttribute('d'); assert.match(curve, /^M/); assert.doesNotMatch(curve, /NaN|Infinity/);
      const displayed = await node.textContent(); await page.locator('#playback-rate').selectOption('0.01');
      assert.equal(await node.textContent(), displayed); assert.equal(await page.locator('#piston-curve').getAttribute('d'), curve);
    }
    await page.locator('#piston-chart').scrollIntoViewIfNeeded(); await capture('piston-acceleration-chart');
    const beforeCamera = await camera();
    const graphPoint = await page.locator('#piston-chart').evaluate(svg => { const point = svg.createSVGPoint(); point.x = 376; point.y = 70; const screen = point.matrixTransform(svg.getScreenCTM()); return { x: screen.x, y: screen.y }; });
    await page.mouse.click(graphPoint.x, graphPoint.y);
    const clicked = await state(); assert.equal(clicked.view.selectedCylinder, 2); near(clicked.detail.cylinder.phaseRad / RAD, 360, 1.5);
    cameraNear(await camera(), beforeCamera);
  });

  await check('Valve facts preserve cylinder phase, physical event duration and the undefined endpoint acceleration', async () => {
    await range('#rpm', 1200); await select('c2-intake-valves');
    for (const advance of [-10, 0, 10]) {
      await range('#cam-advance', advance); const open = 350 - advance, close = 580 - advance;
      for (const phase of [open, close]) {
        await angle(540 + phase); const d = (await state()).detail, rows = await facts();
        assert.equal(d.cylinder.id, 2); near(d.cylinder.valves.intake.liftM, 0); near(d.cylinder.valves.intake.velocityMps, 0);
        assert.equal(d.cylinder.valves.intake.accelerationDefined, false); assert.equal(d.cylinder.valves.intake.accelerationMps2, null);
        assert.equal(rows['밸브 가속도'].value, '끝점에서 불연속'); assert.doesNotMatch(rows['밸브 가속도'].text, /NaN|Infinity|null/);
        near(Number(rows['열림 구간 시간'].value), 230 / 360 * 60 / 1200 * 1000);
      }
      await angle(540 + (open + close) / 2); const peak = (await state()).detail.cylinder.valves.intake;
      near(peak.liftM, .006); near(peak.velocityMps, 0); assert.ok(peak.accelerationDefined && peak.accelerationMps2 < 0);
    }
    await capture('valve-endpoint-detail');
  });

  await check('Global cam and lubrication facts retain the chosen cylinder and do not invent engine load or oil pressure', async () => {
    await select('c4-rod'); await angle(720 + 90); const before = await state();
    await select('intake-camshaft'); const after = await state(), camFacts = await facts();
    assert.equal(after.view.selectedCylinder, 4); assert.equal(after.angleRad, before.angleRad);
    near(Number(camFacts['선택 실린더'].value), 4); near(Number(camFacts['캠 회전수'].value), after.settings.rpm / 2);
    near(Number(camFacts['해당 밸브 리프트'].value), after.detail.cylinders[3].valves.intake.liftM * 1000);
    await select('oil-pump'); const oilFacts = await facts();
    assert.equal(oilFacts['윤활 압력·유량'].value, '계산하지 않음'); assert.equal(oilFacts['오일 온도·유막 두께'].value, '계산하지 않음');
    assert.equal((await state()).view.selectedCylinder, 4);
  });

  await check('Rendered mesh centres preserve slider-crank connections and cam contact throughout the cycle', async () => {
    const rows = await page.evaluate(() => {
      const app = window.engineLab, rows = [];
      for (const advance of [-10, 0, 10]) {
        const input = document.querySelector('#cam-advance'); input.value = String(advance); input.dispatchEvent(new Event('input', { bubbles: true }));
        for (let degrees = 0; degrees < 720; degrees += 30) {
          app.setAngle(degrees * Math.PI / 180); const state = app.getState(), scene = app.sceneDebug();
          rows.push({ advance, degrees, cylinders: state.snapshot.cylinders, mechanical: scene.mechanical, camError: scene.maxCamSupportErrorM });
        }
      }
      return rows;
    });
    let maxContactError = 0;
    for (const row of rows) {
      assert.equal(row.mechanical.length, 4); maxContactError = Math.max(maxContactError, row.camError);
      for (const part of row.mechanical) {
        const cylinder = row.cylinders[part.cylinder - 1], piston = Object.values(cylinder.pistonPin), crank = Object.values(cylinder.crankPin);
        vectorNear(part.pistonPin, piston); vectorNear(part.rodSmallEnd, piston); vectorNear(part.rodBigEnd, crank); vectorNear(part.crankPin, crank);
        near(part.centerDistance, .143); vectorNear(part.pistonCrown, [piston[0], piston[1] + .026, piston[2]], 2e-9);
      }
      assert.ok(row.camError < .00005, JSON.stringify({ advance: row.advance, degrees: row.degrees, error: row.camError }));
    }
    await page.locator('[data-mode="exploded"]').click(); await range('#explode', .65); await angle(235);
    const exploded = await state(), scene = await debug();
    for (const part of scene.mechanical) {
      const c = exploded.snapshot.cylinders[part.cylinder - 1];
      vectorNear(part.pistonPin, [c.pistonPin.x + .065 * .65, c.pistonPin.y, c.pistonPin.z - .05 * .65]);
      vectorNear(part.rodSmallEnd, Object.values(c.pistonPin)); near(part.centerDistance, .143);
    }
    assert.ok(scene.maxCamSupportErrorM < .00005);
    await page.locator('[data-mode="cutaway"]').click();
    evidence.push({ mechanicalSweep: { samples: rows.length, cylindersPerSample: 4, maxContactErrorM: maxContactError } });
  });

  await check('Explicit inspection preserves the user camera and persistent project while isolating real geometry', async () => {
    await select('c3-piston'); await angle(255); await page.locator('#scene').scrollIntoViewIfNeeded();
    await page.locator('[data-camera="iso"]').click(); await page.clock.runFor(80);
    const box = await page.locator('#scene canvas').boundingBox();
    await page.mouse.move(box.x + box.width * .40, box.y + box.height * .52); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .49, box.y + box.height * .57, { steps: 6 }); await page.mouse.up(); await page.clock.runFor(500);
    const before = await state(), savedCamera = await camera(), savedProject = await project();
    await page.locator('#inspect-part').click(); const inspected = await state();
    assert.equal(inspected.inspection.active, true); assert.equal(inspected.inspection.partId, 'c3-piston');
    assert.equal(inspected.view.selectedPart, 'c3-piston'); assert.deepEqual(inspected.snapshot, before.snapshot);
    assert.notDeepEqual((await camera()).position, savedCamera.position); assert.deepEqual(await project(), savedProject);
    const followedCamera = await camera(), followedPin = (await debug()).mechanical[2].pistonPin;
    await angle(285); const movedCamera = await camera(), movedPin = (await debug()).mechanical[2].pistonPin;
    const movement = movedPin.map((value, index) => value - followedPin[index]);
    for (const key of ['position', 'target']) vectorNear(movedCamera[key], followedCamera[key].map((value, index) => value + movement[index]));
    cameraNear((await project()).observation.camera, savedCamera);
    await capture('piston-inspection', true);
    await page.locator('#inspect-part').click(); assert.equal((await state()).inspection.active, false);
    cameraNear(await camera(), savedCamera); await page.clock.runFor(120); cameraNear(await camera(), savedCamera);
    evidence.push({ inspectionCamera: { original: savedCamera, restored: await camera() } });
  });

  await check('Saving and reloading during inspection retains the full-view camera and selected observation', async () => {
    await select('c3-rod'); await angle(302); await page.clock.runFor(300);
    const saved = await project(), beforeCamera = await camera();
    await page.locator('#inspect-part').click(); assert.equal((await state()).inspection.active, true);
    await capture('rod-inspection-default', true);
    await page.locator('[data-camera="front"]').click(); await page.clock.runFor(300);
    assert.deepEqual(await project(), saved);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('engine-lab-project-v1')));
    assert.deepEqual(stored, saved);
    const downloadEvent = page.waitForEvent('download'); await page.locator('#save-project').click(); const download = await downloadEvent;
    const filename = path.join(output, 'inspection-save.engine.json'); await download.saveAs(filename);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), saved);
    await capture('rod-inspection', true);
    await page.reload(); await page.waitForFunction(() => !!window.engineLab); await page.clock.runFor(80);
    assert.equal((await state()).inspection.active, false); assert.deepEqual(await project(), saved); cameraNear(await camera(), beforeCamera);
    assert.equal((await state()).view.selectedCylinder, 3);
  });

  await check('Ordinary selection inside inspection preserves its camera until explicit reinspection or restore', async () => {
    await select('c3-piston'); const originalCamera = await camera(); await page.locator('#inspect-part').click();
    const inspectedCamera = await camera(), before = await state();
    await select('c4-rod'); const selected = await state();
    assert.equal(selected.view.selectedCylinder, 4); assert.equal(selected.inspection.partId, 'c3-piston');
    cameraNear(await camera(), inspectedCamera); assert.deepEqual(selected.snapshot, before.snapshot);
    assert.equal(selected.detail.cylinder.id, 4); assert.match(await page.locator('#part-detail-note').textContent(), /4번 실린더/);
    await page.locator('#inspect-part').click(); assert.equal((await state()).inspection.partId, 'c4-rod');
    await page.locator('#restore-inspection').click(); cameraNear(await camera(), originalCamera);
    assert.equal((await state()).view.selectedPart, 'c4-rod');
    await select('c4-pin'); await page.locator('#inspect-part').click();
    const closeup = await camera(); assert.ok(closeup.zoom > 1 && closeup.zoom <= 4, JSON.stringify(closeup));
    cameraNear((await project()).observation.camera, originalCamera); await capture('pin-inspection', true);
    assert.deepEqual(await page.locator('#scene .engine-part-label:visible').allTextContents(), ['4번 피스톤 핀']);
    assert.match(await page.locator('#scene .engine-scene-note').textContent(), /중공 피스톤 핀/);
    await page.locator('#restore-inspection').click(); cameraNear(await camera(), originalCamera);
  });

  await check('Inspection temporarily reveals a disabled layer and restores it without changing the saved layer choices', async () => {
    await page.locator('.controls details').evaluate(node => { node.open = true; });
    await select('oil-pump'); const beforeCamera = await camera(), originalLayers = (await state()).view.layers; await page.locator('#inspect-part').click();
    assert.equal((await state()).inspection.partId, 'oil-pump'); assert.deepEqual((await state()).view.layers, originalLayers);
    assert.deepEqual((await project()).observation.view.layers, originalLayers);
    await page.locator('#restore-inspection').click(); assert.equal((await state()).inspection.active, false); cameraNear(await camera(), beforeCamera);
    await page.locator('[data-layer="lubrication"]').check(); await page.locator('#inspect-part').click();
    assert.equal((await state()).inspection.partId, 'oil-pump');
    await page.locator('[data-layer="lubrication"]').uncheck(); assert.equal((await state()).inspection.active, false);
    cameraNear(await camera(), beforeCamera);
    await select('c2-piston'); await page.locator('[data-cylinder-mode="single"]').click();
    const singleCamera = await camera(); await page.locator('#inspect-part').click(); await select('c3-piston');
    assert.equal((await state()).inspection.active, false); assert.deepEqual((await debug()).visibleCylinderIds, [3]); cameraNear(await camera(), singleCamera);
    await page.locator('[data-cylinder-mode="all"]').click();
  });

  await check('Guided playback leaves prior isolation and retains physical-RPM details through the completed cycle', async () => {
    await select('c3-piston'); await page.locator('#inspect-part').click(); await page.locator('#one-cycle').click();
    const start = await state(); assert.equal(start.inspection.active, false); assert.equal(start.view.selectedCylinder, 1); assert.equal(start.view.selectedPart, 'c1-piston');
    near(start.playbackRate * start.settings.rpm, 15); near(start.detail.crank.rpm, start.settings.rpm);
    await page.clock.runFor(100); await page.clock.fastForward(1900); const middle = await state(); near(middle.angleRad, Math.PI, .04);
    near(middle.detail.cam.rpm, middle.settings.rpm / 2); near(middle.snapshot.camAngles.exhaust * 2, middle.angleRad);
    await page.clock.fastForward(6100); const ended = await state(); assert.equal(ended.running, false); near(ended.angleRad, 0);
    assert.ok(ended.detail.cylinder.piston.accelerationYMps2 < 0); near(ended.detail.cylinder.piston.velocityYMps, 0);
    assert.match(await page.locator('#toast').textContent(), /한 사이클 완료/);
  });

  await check('Focused narrow observation mirrors selected-cylinder facts and keeps inspection controls usable', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.clock.runFor(100);
    await page.locator('#focus-view').click(); await page.clock.runFor(100);
    assert.equal((await state()).focused, true); assert.equal(await page.locator('#focus-component-details').getAttribute('open'), null);
    await page.locator('#focus-part-select').selectOption('c4-piston');
    const before = await state(), expected = await facts(); assert.equal(before.view.selectedCylinder, 4);
    await page.locator('#focus-component-details summary').click(); assert.deepEqual(await facts(true), expected);
    assert.equal(await page.locator('#focus-detail-note').textContent(), await page.locator('#part-detail-note').textContent());
    await page.locator('#focus-component-details summary').click(); await page.locator('#focus-inspect-part').click();
    assert.equal((await state()).inspection.partId, 'c4-piston'); assert.deepEqual((await state()).snapshot, before.snapshot);
    const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, sceneHeight: document.querySelector('#scene').getBoundingClientRect().height }));
    assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout)); assert.ok(layout.sceneHeight >= 280, JSON.stringify(layout));
    await capture('narrow-piston-inspection'); await page.locator('#restore-inspection').click();
    assert.equal((await state()).inspection.active, false); assert.equal((await state()).view.selectedPart, 'c4-piston');
    await page.keyboard.press('Escape');
  });

  assert.deepEqual(errors, []);
  console.log(`All ${checks.length} engine detail browser checks passed.`);
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'detail-browser-results.json'), JSON.stringify({ version, checks, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length, errors, evidence, rendererScope: 'Headless Chromium with its default backend, recorded per capture; functional and geometry evidence, not a physical GPU performance claim.' }, null, 2));
  await browser?.close(); await server?.close();
}
