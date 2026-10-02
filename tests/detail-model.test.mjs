import test from 'node:test';
import assert from 'node:assert/strict';
import { GEOMETRY, FIRING_PHASES, sampleEngine, valveLift, valveLiftDerivative,
  valveLiftSecondDerivative, valveTiming } from '../src/model.js';
import { engineDetail } from '../src/detail-model.js';
import { describeEngineDetail } from '../src/detail-readouts.js';

const TAU = Math.PI * 2, rad = x => x * Math.PI / 180;
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Number.isFinite(actual)
  && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (±${tolerance})`);
const detail = (phase, settings = { rpm: 1200 }, cylinder = 1) => engineDetail(sampleEngine(phase, settings), settings, cylinder);
const derivatives = (f, x, h = .001) => {
  const a = f(x - 2 * h), b = f(x - h), c = f(x), d = f(x + h), e = f(x + 2 * h);
  return [(a - 8 * b + 8 * d - e) / (12 * h), (-a + 16 * b - 30 * c + 16 * d - e) / (12 * h * h)];
};

test('piston and rod time derivatives reconstruct independent sampled positions for all cylinders', () => {
  for (const rpm of [100, 1200, 6000]) for (const phase of [-.19, 0, .41, Math.PI / 2, Math.PI, 5.7, 8.1, 12.3]) {
    const d = detail(phase, { rpm }), omega = TAU * rpm / 60;
    for (const c of d.cylinders) {
      const y = derivatives(angle => sampleEngine(angle).cylinders[c.id - 1].pistonPin.y, phase);
      near(c.piston.velocityYMps / omega, y[0], 3e-12);
      near(c.piston.accelerationYMps2 / omega ** 2, y[1], 2e-10);
      const beta = derivatives(angle => sampleEngine(angle).cylinders[c.id - 1].rodAngleRad, phase);
      near(c.rod.angularVelocityRadPerS / omega, beta[0], 3e-11);
      near(c.rod.angularAccelerationRadPerS2 / omega ** 2, beta[1], 9e-10);
    }
  }
});

test('dead centres give zero piston speed and unequal finite-rod accelerations', () => {
  const settings = { rpm: 6000 }, top = detail(0, settings), bottom = detail(Math.PI, settings);
  const r = GEOMETRY.stroke / 2, L = GEOMETRY.rodLength, omega = top.crank.omegaRadPerS;
  near(top.cylinder.piston.travelFromTdcM, 0);
  near(bottom.cylinder.piston.travelFromTdcM, GEOMETRY.stroke);
  near(top.cylinder.piston.velocityYMps, 0); near(bottom.cylinder.piston.velocityYMps, 0);
  near(top.cylinder.piston.accelerationYMps2, -r * omega ** 2 * (1 + r / L));
  near(bottom.cylinder.piston.accelerationYMps2, r * omega ** 2 * (1 - r / L));
  assert.ok(Math.abs(top.cylinder.piston.accelerationYMps2) > Math.abs(bottom.cylinder.piston.accelerationYMps2));
  near(top.cylinder.rod.angularVelocityRadPerS, r / L * omega);
  near(bottom.cylinder.rod.angularVelocityRadPerS, -r / L * omega);
  const quarter = detail(Math.PI / 2, settings).cylinder;
  near(quarter.rod.angleRad, Math.asin(r / L)); near(quarter.rod.angularVelocityRadPerS, 0);
  assert.ok(quarter.piston.velocityYMps < 0);
});

test('integrated speed reconstructs each stroke, mean piston speed and swept volume without a clearance volume', () => {
  const rpm = 1800, omega = TAU * rpm / 60, count = 4096, dTheta = TAU / count;
  let signedFirstHalf = 0, distance = 0, volumeFirstHalf = 0;
  // Midpoint quadrature over a mechanical revolution, independent of the position formula.
  for (let i = 0; i < count; i++) {
    const p = detail((i + .5) * dTheta, { rpm }).cylinder.piston, dt = dTheta / omega;
    distance += Math.abs(p.velocityYMps) * dt;
    if (i < count / 2) { signedFirstHalf += p.velocityYMps * dt; volumeFirstHalf += p.sweptVolumeRateM3PerS * dt; }
  }
  const top = detail(0, { rpm }), bottom = detail(Math.PI, { rpm });
  near(signedFirstHalf, -GEOMETRY.stroke, 2e-8);
  near(distance, 2 * GEOMETRY.stroke, 4e-8);
  near(distance / (60 / rpm), top.cylinder.piston.meanSpeedMps, 2e-6);
  near(volumeFirstHalf, bottom.geometry.sweptVolumePerCylinderM3, 2e-10);
  near(bottom.cylinder.piston.sweptVolumeFromTdcM3, bottom.geometry.sweptVolumePerCylinderM3);
  near(top.cylinder.piston.sweptVolumeFromTdcM3, 0);
  near(top.geometry.totalSweptVolumeM3 * 1e3, 1.998228856871709, 1e-12);
  assert.equal(Object.hasOwn(top.geometry, 'compressionRatio'), false);
  assert.equal(Object.hasOwn(top.cylinder.piston, 'chamberVolumeM3'), false);
});

test('speed scales with RPM and acceleration with RPM squared while geometry and angles remain unchanged', () => {
  const phase = rad(413), lowSettings = { rpm: 700, intakeAdvanceRad: rad(7) }, highSettings = { ...lowSettings, rpm: 1400 };
  const low = detail(phase, lowSettings), high = detail(phase, highSettings);
  assert.deepEqual(low.geometry, high.geometry);
  near(high.crank.rpm, low.crank.rpm * 2); near(high.cam.rpm, high.crank.rpm / 2);
  near(high.crank.rotationZRpm, -high.crank.rpm); near(high.cam.rotationZRpm, -high.cam.rpm);
  near(high.timing.cycleSeconds, low.timing.cycleSeconds / 2);
  for (let i = 0; i < 4; i++) {
    const a = low.cylinders[i], b = high.cylinders[i];
    near(a.piston.travelFromTdcM, b.piston.travelFromTdcM);
    near(b.piston.velocityYMps, 2 * a.piston.velocityYMps);
    near(b.piston.accelerationYMps2, 4 * a.piston.accelerationYMps2);
    near(b.rod.angularVelocityRadPerS, 2 * a.rod.angularVelocityRadPerS);
    near(b.rod.angularAccelerationRadPerS2, 4 * a.rod.angularAccelerationRadPerS2);
    for (const kind of ['intake', 'exhaust']) {
      near(b.valves[kind].liftM, a.valves[kind].liftM);
      near(b.valves[kind].velocityMps, 2 * a.valves[kind].velocityMps);
      near(b.valves[kind].accelerationMps2, 4 * a.valves[kind].accelerationMps2);
    }
  }
  const snapshot = sampleEngine(phase, lowSettings);
  assert.deepEqual(engineDetail(snapshot, { ...lowSettings, playbackRate: .01, running: false }),
    engineDetail(snapshot, { ...lowSettings, playbackRate: 1, running: true }));
});

test('valve time derivatives match finite differences of sampled lift with advance applied once', () => {
  for (const advance of [-10, 0, 10]) for (const kind of ['intake', 'exhaust']) {
    const settings = { rpm: 3400, intakeAdvanceRad: rad(advance) }, event = valveTiming(settings)[kind];
    for (const fraction of [-.1, .11, .27, .5, .78, 1.1]) {
      const phase = event.open + fraction * (event.close - event.open), omega = TAU * settings.rpm / 60;
      const [first, second] = derivatives(angle => valveLift(angle, kind, settings), phase, .002);
      near(valveLiftSecondDerivative(phase, kind, settings), second, 8e-12);
      for (let id = 1; id <= 4; id++) {
        const v = detail(phase + FIRING_PHASES[id - 1], settings, id).cylinder.valves[kind];
        near(v.velocityMps / omega, first, 3e-14);
        near(v.accelerationMps2 / omega ** 2, second, 8e-12);
      }
    }
  }
});

test('valve endpoint acceleration is not reported as a physical zero and peak lift reverses motion', () => {
  const settings = { rpm: 1200, intakeAdvanceRad: rad(10) }, omega = TAU * settings.rpm / 60;
  for (const kind of ['intake', 'exhaust']) {
    const event = valveTiming(settings)[kind], epsilon = 1e-6;
    for (const boundary of [event.open, event.close]) {
      for (let id = 1; id <= 4; id++) {
        const v = detail(boundary + FIRING_PHASES[id - 1], settings, id).cylinder.valves[kind];
        assert.equal(v.accelerationDefined, false); assert.equal(v.accelerationMps2, null);
        near(v.liftM, 0); near(v.velocityMps, 0);
        const rendered = describeEngineDetail(`c${id}-${kind}-valves`, sampleEngine(boundary + FIRING_PHASES[id - 1], settings), settings, 1);
        assert.equal(rendered.facts.find(f => f.label === '밸브 가속도').value, '끝점에서 불연속');
      }
      assert.equal(valveLiftSecondDerivative(boundary, kind, settings), 0, 'shared export documents its closed-branch endpoint convention');
    }
    const outside = detail(event.open - epsilon, settings).cylinder.valves[kind];
    const inside = detail(event.open + epsilon, settings).cylinder.valves[kind];
    assert.equal(outside.accelerationMps2, 0); assert.ok(inside.accelerationMps2 > 10);
    const derivativeJumpEstimate = valveLiftDerivative(event.open + epsilon, kind, settings) / epsilon * omega ** 2;
    near(inside.accelerationMps2, derivativeJumpEstimate, 1e-5);
    const peak = detail((event.open + event.close) / 2, settings).cylinder.valves[kind];
    near(peak.liftM, GEOMETRY.valveMaxLift); near(peak.velocityMps, 0);
    assert.ok(peak.accelerationMps2 < 0);
    assert.ok(detail(event.open + .2, settings).cylinder.valves[kind].velocityMps > 0);
    assert.ok(detail(event.close - .2, settings).cylinder.valves[kind].velocityMps < 0);
  }
});

test('valve velocity integral recovers total lift travel and timing durations at physical RPM', () => {
  const settings = { rpm: 900, intakeAdvanceRad: rad(-10) }, timing = valveTiming(settings), omega = TAU * settings.rpm / 60;
  const d = detail(rad(360), settings);
  near(d.timing.overlapRad, rad(10)); near(d.timing.overlapSeconds, 10 / 360 * 60 / 900);
  near(d.timing.cycleSeconds, 120 / 900);
  for (const kind of ['intake', 'exhaust']) {
    const event = timing[kind], duration = event.close - event.open, count = 4096, da = duration / count;
    let signed = 0, distance = 0;
    for (let i = 0; i < count; i++) {
      const v = detail(event.open + (i + .5) * da, settings).cylinder.valves[kind].velocityMps;
      signed += v * da / omega; distance += Math.abs(v) * da / omega;
    }
    near(signed, 0); near(distance, 2 * GEOMETRY.valveMaxLift, 2e-9);
    near(d.timing[kind].durationSeconds, 230 / 360 * 60 / 900);
  }
});

test('per-cylinder detail follows the explicit selected part and stays periodic across cycle wrapping', () => {
  const settings = { rpm: 1234, intakeAdvanceRad: rad(3) }, phase = rad(417);
  for (let id = 1; id <= 4; id++) {
    const a = detail(phase, settings, id), b = detail(phase + 4 * Math.PI, settings, id);
    assert.equal(a.cylinder, a.cylinders[id - 1]); assert.equal(a.selectedCylinderId, id);
    near(a.cylinder.piston.velocityYMps, b.cylinder.piston.velocityYMps);
    const rows = describeEngineDetail(`c${id}-piston`, sampleEngine(phase, settings), settings, id === 1 ? 4 : 1).facts;
    near(rows.find(f => f.label === '상사점에서 내려온 거리').value, a.cylinder.piston.travelFromTdcM * 1000);
  }
  assert.equal(detail(phase, settings, 0).selectedCylinderId, 1);
  assert.equal(detail(phase, settings, 1.5).selectedCylinderId, 1);
});

test('all 50 selected-part readouts stay finite, compact and preserve snapshots/settings', () => {
  const ids = ['block', 'head', 'cam-cover', 'crankshaft', 'intake-camshaft', 'exhaust-camshaft',
    'timing-chain', 'timing-guide', 'oil-pump', 'oil-filter', 'oil-gallery', 'oil-pan', 'flywheel',
    ...Array.from({ length: 5 }, (_, i) => `main-bearing-${i + 1}`),
    ...Array.from({ length: 4 }, (_, i) => ['piston', 'rings', 'pin', 'rod', 'liner', 'intake-valves', 'exhaust-valves', 'spark-plug'].map(id => `c${i + 1}-${id}`)).flat()];
  assert.equal(ids.length, 50);
  const settings = Object.freeze({ rpm: 6000, intakeAdvanceRad: rad(-10) }), snapshot = sampleEngine(rad(360), settings), before = structuredClone(snapshot);
  const freeze = object => { Object.freeze(object); for (const value of Object.values(object)) if (value && typeof value === 'object') freeze(value); };
  freeze(snapshot);
  for (const id of ids) {
    const result = describeEngineDetail(id, snapshot, settings, 4);
    assert.ok(result.facts.length >= 3 && result.facts.length <= 6, id);
    assert.equal(new Set(result.facts.map(f => f.label)).size, result.facts.length);
    for (const fact of result.facts) assert.ok(typeof fact.value === 'string' || Number.isFinite(fact.value), id);
    assert.ok(result.note.length > 30);
  }
  const observed = engineDetail(snapshot, settings, 4); observed.cylinder.piston.travelFromTdcM = 999;
  assert.deepEqual(snapshot, before); assert.deepEqual(settings, { rpm: 6000, intakeAdvanceRad: rad(-10) });
  assert.equal(engineDetail(null, settings), null);
  assert.equal(engineDetail({ cycleAngleRad: 0, cylinders: [] }, settings), null);
  assert.deepEqual(describeEngineDetail('crankshaft', null, settings), { facts: [], note: '계산 상태를 확인할 수 없습니다.' });
});
