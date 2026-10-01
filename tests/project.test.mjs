import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, parseProject, serializeProject, DEFAULT_VIEW,
  normalizeView, normalizePlaybackRate, ProjectError } from '../src/project.js';

function configured() {
  return createProject({ settings: { rpm: 2300, intakeAdvanceRad: .1 }, angleRad: 8.7,
    playbackRate: 15 / 2300,
    view: { cylinderMode: 'single', selectedCylinder: 3, mode: 'exploded', explode: .68,
      labels: false, layers: { block: false, head: true, timing: false, lubrication: true }, selectedPart: 'c3-intake-valves' },
    camera: { position: [.7, .6, .9], target: [.01, .12, .03], zoom: 1 } });
}
function invalid(change, code = 'INVALID_PROJECT') {
  const original = configured(), before = structuredClone(original), bad = structuredClone(original);
  change(bad);
  const text = JSON.stringify(bad);
  assert.throws(() => parseProject(text), error => error instanceof ProjectError
    && error.code === code && error.preserveOriginal === true);
  assert.deepEqual(original, before, 'A failed import must not mutate a current experiment');
  assert.equal(JSON.stringify(bad), text, 'Validation must not modify the imported object');
}

test('exact observation, guided speed, layers and camera survive deterministic JSON round trips', () => {
  const project = configured(), original = structuredClone(project);
  const text = serializeProject(project), restored = parseProject(text);
  assert.deepEqual(restored, project);
  assert.equal(serializeProject(restored), text);
  assert.equal(restored.observation.playbackRate, 15 / 2300);
  assert.equal(restored.observation.angleRad, 8.7);
  assert.deepEqual(project, original);
  restored.observation.camera.position[0] = 4;
  restored.observation.view.layers.head = false;
  assert.deepEqual(project, original, 'Restored nested values must not alias the source');
});

test('an observation produced by the preserved 0.1.0 codec remains exactly compatible', () => {
  // Generated with the preserved 0.1.0 source's createProject, before modifying
  // this candidate. Keep the literal independent of the current creator.
  const original = '{"type":"engine-lab-project","schemaVersion":1,"modelVersion":"engine-kinematics-1","settings":{"rpm":2300,"intakeAdvanceRad":0.10471975511965977},"observation":{"angleRad":7.068583470577034,"playbackRate":0.01,"view":{"cylinderMode":"single","selectedCylinder":3,"mode":"exploded","explode":0.42,"labels":false,"layers":{"block":false,"head":true,"timing":true,"lubrication":true},"selectedPart":"c3-intake-valves"},"camera":{"position":[0.6,0.7,-0.5],"target":[0,0.121,0.052],"zoom":1}}}';
  const restored = parseProject(original);
  assert.deepEqual(restored, JSON.parse(original));
  assert.deepEqual(parseProject(serializeProject(restored)), JSON.parse(original));
});

test('Windows UTF-8 BOM is accepted without weakening schema or changing the original text', () => {
  const project = configured(), original = '\ufeff' + serializeProject(project), before = original;
  assert.deepEqual(parseProject(original), project);
  assert.equal(original, before);
  const future = { ...project, schemaVersion: 2 };
  assert.throws(() => parseProject('\ufeff' + JSON.stringify(future)), error => error.code === 'FUTURE_SCHEMA' && error.preserveOriginal);
  assert.throws(() => parseProject('\ufeff\ufeff' + serializeProject(project)), error => error.code === 'INVALID_JSON');
});

test('safe creation normalizes invalid live values and wraps only the live angle', () => {
  const project = createProject({ settings: { rpm: Infinity, intakeAdvanceRad: '10' }, angleRad: -Math.PI,
    playbackRate: 0, view: { selectedCylinder: 99, explode: -1, labels: 'false' },
    camera: { position: [0, 0, 0], target: [0, 0, 0] } });
  assert.deepEqual(project.settings, { rpm: 1200, intakeAdvanceRad: 0 });
  assert.equal(project.observation.angleRad, 3 * Math.PI);
  assert.equal(project.observation.playbackRate, .001);
  assert.equal(project.observation.view.selectedCylinder, 4);
  assert.equal(project.observation.view.explode, 0);
  assert.equal(project.observation.view.labels, true);
  assert.equal(project.observation.camera, null);
  assert.equal(createProject({ angleRad: 4 * Math.PI }).observation.angleRad, 0);
  assert.equal(createProject({ angleRad: -Number.EPSILON }).observation.angleRad, 0);
  assert.equal(createProject({ angleRad: Number.MAX_VALUE }).observation.angleRad >= 0, true);
  assert.equal(createProject().observation.playbackRate, .025);
  assert.deepEqual(parseProject(serializeProject(project)), project);
});

test('view defaults are isolated and saved modes, layers and part IDs are strict', () => {
  const view = normalizeView();
  view.layers.block = false;
  assert.equal(DEFAULT_VIEW.layers.block, true);
  assert.deepEqual(normalizeView(null), DEFAULT_VIEW);
  for (const change of [
    p => { p.observation.view.mode = 'xray'; },
    p => { p.observation.view.cylinderMode = 'six'; },
    p => { p.observation.view.selectedCylinder = 1.5; },
    p => { p.observation.view.selectedCylinder = 5; },
    p => { p.observation.view.selectedPart = 'c5-piston'; },
    p => { p.observation.view.layers.timing = 'false'; },
    p => { delete p.observation.view.layers.head; },
    p => { p.observation.view.layers.extra = true; },
    p => { p.observation.view.labels = 1; },
    p => { p.observation.view.explode = 1.01; },
  ]) invalid(change);
});

test('future schema and model records are marked for preservation; foreign files are rejected', () => {
  for (const [field, value, code] of [
    ['schemaVersion', 2, 'FUTURE_SCHEMA'], ['modelVersion', 'engine-kinematics-2', 'FUTURE_MODEL'],
  ]) {
    invalid(p => { p[field] = value; }, code);
    const future = configured(); future[field] = value;
    assert.throws(() => parseProject(JSON.stringify(future)), error => error.futureVersion === true);
  }
  invalid(p => { p.type = 'brake-lab-project'; }, 'UNSUPPORTED_FORMAT');
  invalid(p => { p.modelVersion = 'unknown'; }, 'UNSUPPORTED_MODEL');
  invalid(p => { p.schemaVersion = '1'; }, 'UNSUPPORTED_SCHEMA');
});

test('import refuses malformed, nonfinite, missing and out-of-range SI values without clamping', () => {
  for (const change of [
    p => { p.settings.rpm = '2300'; }, p => { p.settings.rpm = null; },
    p => { p.settings.rpm = 99; }, p => { p.settings.rpm = 6001; },
    p => { p.settings.intakeAdvanceRad = 10; }, p => { p.settings.intakeAdvanceRad = Infinity; },
    p => { delete p.settings.intakeAdvanceRad; }, p => { p.settings.intakeAdvanceDeg = 5; },
    p => { p.observation.angleRad = -1; }, p => { p.observation.angleRad = 4 * Math.PI; },
    p => { p.observation.playbackRate = 0; }, p => { p.observation.playbackRate = 1.01; },
    p => { p.observation.angleRad = NaN; }, p => { delete p.observation.camera; },
    p => { p.observation.savedAt = 'invented'; }, p => { p.unrecognized = true; },
  ]) invalid(change);
  assert.throws(() => parseProject(serializeProject(configured()).replace('2300', '1e999')), ProjectError);
  assert.throws(() => serializeProject({ ...configured(), settings: { rpm: NaN, intakeAdvanceRad: 0 } }), ProjectError);
});

test('camera retains optional zoom and rejects viewpoints the scene cannot restore', () => {
  const noZoom = configured(); delete noZoom.observation.camera.zoom;
  assert.deepEqual(parseProject(serializeProject(noZoom)), noZoom);
  const noCamera = configured(); noCamera.observation.camera = null;
  assert.deepEqual(parseProject(serializeProject(noCamera)), noCamera);
  for (const camera of [
    { position: [0, 0, 0], target: [0, 0, 0] },
    { position: [0, 0, .01], target: [0, 0, 0] },
    { position: [11, 0, 0], target: [0, 0, 0] },
    { position: [101, 0, 0], target: [100, 0, 0] },
    { position: [0, 0], target: [0, 0, 0] },
    { position: ['1', 1, 1], target: [0, 0, 0] },
    { position: [1, 1, 1], target: [0, 0, 0], zoom: .24 },
    { position: [1, 1, 1], target: [0, 0, 0], zoom: 4.01 },
    { position: [1, 1, 1], target: [0, 0, 0], extra: true },
  ]) invalid(p => { p.observation.camera = camera; });
});

test('scene camera distance and zoom endpoints retain floating point values without drift', () => {
  for (const distance of [.17, .17 - 1e-16, 2.7, 2.7 + 1e-15]) {
    for (const zoom of [.25, 1, 4]) {
      const project = configured();
      project.observation.camera = { position: [0, 0, distance], target: [0, 0, 0], zoom };
      assert.deepEqual(parseProject(serializeProject(project)).observation.camera, project.observation.camera);
    }
  }
  for (const distance of [.17 - 1e-8, 2.7 + 1e-8]) {
    invalid(p => { p.observation.camera = { position: [0, 0, distance], target: [0, 0, 0], zoom: 1 }; });
  }
});

test('JSON syntax, type and UTF-8 byte limits are validated before reading a project', () => {
  for (const text of [null, {}, 'null', '[]', '{broken']) assert.throws(() => parseProject(text), ProjectError);
  const oversizedUtf8 = ' '.repeat(1) + JSON.stringify({ note: '가'.repeat(3_500_000) });
  assert.ok(oversizedUtf8.length < 10 * 1024 * 1024);
  assert.throws(() => parseProject(oversizedUtf8), error => error.code === 'PROJECT_TOO_LARGE');
  assert.throws(() => parseProject(' '.repeat(10 * 1024 * 1024 + 1)), error => error.code === 'PROJECT_TOO_LARGE');
});

test('playback normalization supports guided 15 rpm observation and finite limits', () => {
  for (const rpm of [100, 1200, 6000]) assert.equal(normalizePlaybackRate(15 / rpm), 15 / rpm);
  assert.equal(normalizePlaybackRate(.0001), .001);
  assert.equal(normalizePlaybackRate(2), 1);
  for (const invalid of [undefined, null, NaN, Infinity, '.1']) assert.equal(normalizePlaybackRate(invalid), .025);
});
