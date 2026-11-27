import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRING_PHASES, GEOMETRY, INTAKE_PROFILE, camSupport, normalizeSettings, sampleEngine,
  valveLift, valveLiftDerivative, valveLiftSecondDerivative, valveTiming,
} from '../src/model.js';
import { createProject, parseProject, serializeProject } from '../src/project.js';

const rad = degrees => degrees * (Math.PI / 180);
const near = (actual, expected, tolerance = 1e-12) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`,
);

test('old project settings keep their original curve, phase, and serialized shape', () => {
  const legacy = '{"type":"engine-lab-project","schemaVersion":1,"modelVersion":"engine-kinematics-1","settings":{"rpm":2300,"intakeAdvanceRad":0.10471975511965977},"observation":{"angleRad":7.068583470577034,"playbackRate":0.01,"view":{"cylinderMode":"single","selectedCylinder":3,"mode":"exploded","explode":0.42,"labels":false,"layers":{"block":false,"head":true,"timing":true,"lubrication":true},"selectedPart":"c3-intake-valves"},"camera":{"position":[0.6,0.7,-0.5],"target":[0,0.121,0.052],"zoom":1}}}';
  const project = parseProject(legacy);
  assert.deepEqual(project, JSON.parse(legacy));
  assert.deepEqual(parseProject(serializeProject(project)), project);
  const { settings } = project;
  const explicitDefaults = { ...settings, intakeDurationRad: INTAKE_PROFILE.durationRad.default, intakeMaxLiftM: .006 };
  assert.deepEqual(normalizeSettings(explicitDefaults), settings);
  const { intake, exhaust, overlapRad } = valveTiming(settings);
  near(intake.open, rad(344));
  near(intake.close, rad(574));
  near(exhaust.open, rad(140));
  near(exhaust.close, rad(370));
  near(overlapRad, rad(26));
  for (let degrees = 0; degrees < 720; degrees++) {
    const phase = rad(degrees), u = (degrees - 344) / 230 * Math.PI;
    const lift = degrees > 344 && degrees < 574 ? .006 * Math.sin(u) ** 2 : 0;
    near(valveLift(phase, 'intake', settings), lift);
    assert.deepEqual(sampleEngine(phase, settings), sampleEngine(phase, explicitDefaults));
  }
});

test('duration widens equally around the advanced center, while peak lift scales the curve', () => {
  for (const { duration, advance, lift, opening, closing, overlap } of [
    { duration: 260, advance: 8, lift: .006, opening: 327, closing: 587, overlap: 43 },
    { duration: 220, advance: -7, lift: .0044, opening: 362, closing: 582, overlap: 8 },
  ]) {
    const settings = { intakeDurationRad: rad(duration), intakeAdvanceRad: rad(advance), intakeMaxLiftM: lift };
    const event = valveTiming(settings);
    near(event.intake.open, rad(opening));
    near(event.intake.close, rad(closing));
    near(event.overlapRad, rad(overlap));
    assert.deepEqual(event.exhaust, valveTiming().exhaust);
    const center = rad(465 - advance), width = rad(duration);
    near(valveLift(center, 'intake', settings), lift);
    near(valveLiftDerivative(center, 'intake', settings), 0);
    near(valveLiftSecondDerivative(center, 'intake', settings), -2 * lift * (Math.PI / width) ** 2);
    near(valveLift(event.intake.open + width / 4, 'intake', settings), lift / 2);
    near(valveLiftDerivative(event.intake.open + width / 4, 'intake', settings), lift * Math.PI / width);
    for (const phase of [event.intake.open, event.intake.close]) {
      assert.equal(valveLift(phase, 'intake', settings), 0);
      assert.equal(valveLiftDerivative(phase, 'intake', settings), 0);
      assert.equal(valveLiftSecondDerivative(phase, 'intake', settings), 0);
    }
  }
});

test('cam profile and cylinder lift share duration and peak, with phase applied once', () => {
  for (const duration of [220, 260]) for (const lift of [.004, .006]) {
    const settings = { intakeDurationRad: rad(duration), intakeAdvanceRad: rad(8), intakeMaxLiftM: lift };
    for (let degrees = 0; degrees < 720; degrees += 2) {
      const phase = rad(degrees), snapshot = sampleEngine(phase, settings);
      for (const kind of ['intake', 'exhaust']) for (const [index, cylinder] of snapshot.cylinders.entries()) {
        const phi = snapshot.camAngles[kind] - FIRING_PHASES[index] / 2;
        const support = camSupport(kind, phi, settings);
        near(support.h - GEOMETRY.camBaseRadius, cylinder.valveLifts[kind]);
        near(support.dh, 2 * valveLiftDerivative(cylinder.phaseRad, kind, settings));
        near(support.ddh, 4 * valveLiftSecondDerivative(cylinder.phaseRad, kind, settings));
        assert.ok(support.h + support.ddh > 0, 'supported profiles keep the lobe convex');
      }
      assert.deepEqual(camSupport('exhaust', phase / 2, settings), camSupport('exhaust', phase / 2));
    }
  }
});

test('projects round-trip valid overrides in SI and reject malformed supplied values', () => {
  const settings = { rpm: 2300, intakeAdvanceRad: rad(-3.5), intakeDurationRad: rad(242.375), intakeMaxLiftM: .004625 };
  const project = createProject({ settings, angleRad: 1 });
  assert.deepEqual(project.settings, settings);
  assert.deepEqual(parseProject(serializeProject(project)), project);
  for (const override of [
    { intakeDurationRad: rad(220) }, { intakeDurationRad: rad(260) }, { intakeMaxLiftM: .004 },
  ]) {
    const one = createProject({ settings: override });
    assert.deepEqual(parseProject(serializeProject(one)), one);
    assert.deepEqual(one.settings, { rpm: 1200, intakeAdvanceRad: 0, ...override });
  }
  for (const bad of [
    { intakeDurationRad: 242 }, { intakeDurationRad: rad(219) }, { intakeDurationRad: null },
    { intakeMaxLiftM: 4.6 }, { intakeMaxLiftM: .0061 }, { intakeMaxLiftM: '.0046' },
    { intakeDurationDeg: 242 }, { intakeMaxLiftMm: 4.6 },
  ]) {
    const raw = JSON.stringify({ ...project, settings: { ...settings, ...bad } });
    assert.throws(() => parseProject(raw), { code: 'INVALID_PROJECT', preserveOriginal: true });
  }
  assert.deepEqual(normalizeSettings({ intakeDurationRad: 0, intakeMaxLiftM: 0 }), {
    rpm: 1200, intakeAdvanceRad: 0, intakeDurationRad: rad(220), intakeMaxLiftM: .004,
  });
});
