import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL_VERSION, GEOMETRY, FIRING_PHASES, normalizeSettings, sampleEngine, advanceAngle,
  valveLift, valveLiftDerivative, valveTiming, camSupport } from '../src/model.js';

const rad = degrees => degrees * Math.PI / 180;
const cycle = 4 * Math.PI;
const close = (actual, expected, tolerance = 1e-12) => assert(Math.abs(actual - expected) <= tolerance,
  `Expected ${actual} to equal ${expected} within ${tolerance}`);
const angleDistance = (a, b) => Math.abs(Math.atan2(Math.sin((a - b) / 2), Math.cos((a - b) / 2)) * 2);

test('fixed representative SI geometry and immutable firing phases are explicit', () => {
  assert.equal(MODEL_VERSION, 'engine-kinematics-1');
  close(GEOMETRY.bore, 0.086); close(GEOMETRY.stroke, 0.086); close(GEOMETRY.rodLength, 0.143);
  assert(GEOMETRY.rodLength > GEOMETRY.stroke / 2);
  assert(Object.isFrozen(GEOMETRY)); assert(Object.isFrozen(FIRING_PHASES));
  assert.deepEqual(FIRING_PHASES, [0, 3 * Math.PI, Math.PI, 2 * Math.PI]);
});

test('settings normalize finite inputs without coercion or source mutation', () => {
  assert.deepEqual(normalizeSettings(), { rpm: 1200, intakeAdvanceRad: 0 });
  assert.deepEqual(normalizeSettings(null), normalizeSettings());
  assert.deepEqual(normalizeSettings({ rpm: '2500', intakeAdvanceRad: NaN }), normalizeSettings());
  const source = Object.freeze({ rpm: 20000, intakeAdvanceRad: 99, extra: true });
  assert.deepEqual(normalizeSettings(source), { rpm: 6000, intakeAdvanceRad: rad(10) });
  assert.deepEqual(normalizeSettings({ rpm: -1, intakeAdvanceRad: -99 }), { rpm: 100, intakeAdvanceRad: rad(-10) });
  assert.equal(source.rpm, 20000);
});

test('known dead centres produce the specified 86 mm stroke', () => {
  const top = sampleEngine(0).cylinders[0], bottom = sampleEngine(Math.PI).cylinders[0];
  close(top.pistonPin.y, 0.186); close(bottom.pistonPin.y, 0.100);
  close(top.pistonPin.y - bottom.pistonPin.y, GEOMETRY.stroke);
  close(top.crankPin.x, 0); close(top.crankPin.y, 0.043);
  close(bottom.crankPin.x, 0); close(bottom.crankPin.y, -0.043);
  close(top.rodAngleRad, 0); close(bottom.rodAngleRad, 0);
});

test('every rod remains rigid and both rod endpoints meet their pins through a complete cycle', () => {
  for (let degree = 0; degree < 720; degree += 0.75) {
    for (const cylinder of sampleEngine(rad(degree)).cylinders) {
      const { pistonPin: p, crankPin: c, rodAngleRad: beta } = cylinder;
      close(Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z), GEOMETRY.rodLength);
      close(c.x - Math.sin(beta) * GEOMETRY.rodLength, p.x);
      close(c.y + Math.cos(beta) * GEOMETRY.rodLength, p.y);
      close(Math.hypot(c.x, c.y), GEOMETRY.stroke / 2);
      close(p.z, c.z);
    }
  }
});

test('finite connecting-rod length gives the correct nonsinusoidal quarter-turn position', () => {
  const quarter = sampleEngine(Math.PI / 2).cylinders[0];
  const independentHeight = Math.sqrt(0.143 ** 2 - 0.043 ** 2);
  close(quarter.pistonPin.y, independentHeight);
  assert(Math.abs(quarter.pistonPin.y - 0.143) > 0.006, 'A simple sinusoid must not replace the rod constraint');
});

test('cylinder spacing, paired piston positions and differing strokes follow the inline-four arrangement', () => {
  for (let degree = 0; degree < 720; degree += 7) {
    const c = sampleEngine(rad(degree)).cylinders;
    close(c[0].pistonPin.y, c[3].pistonPin.y); close(c[1].pistonPin.y, c[2].pistonPin.y);
    assert.notEqual(c[0].stroke, c[3].stroke); assert.notEqual(c[1].stroke, c[2].stroke);
    for (let i = 1; i < 4; i++) close(c[i].pistonPin.z - c[i - 1].pistonPin.z, 0.104);
  }
});

test('power-stroke starts are 180 crank degrees apart in firing order 1-3-4-2', () => {
  const order = [0, 180, 360, 540].map(degree => {
    const starts = sampleEngine(rad(degree)).cylinders.filter(c => c.phaseRad === 0 && c.stroke === 'power');
    assert.equal(starts.length, 1); return starts[0].id;
  });
  assert.deepEqual(order, [1, 3, 4, 2]);
});

test('stroke boundaries partition the 720-degree cycle, with one cylinder in each stroke', () => {
  for (const [degree, stroke] of [[0, 'power'], [180, 'exhaust'], [360, 'intake'], [540, 'compression'], [720, 'power']]) {
    assert.equal(sampleEngine(rad(degree)).cylinders[0].stroke, stroke);
  }
  for (let degree = 0; degree < 720; degree += 5.25) {
    assert.deepEqual(sampleEngine(rad(degree)).cylinders.map(c => c.stroke).sort(), ['compression', 'exhaust', 'intake', 'power']);
  }
});

test('piston position repeats after 360 degrees while the full cycle needs 720 degrees', () => {
  const first = sampleEngine(rad(37)), turn = sampleEngine(rad(397)), full = sampleEngine(rad(757));
  for (let i = 0; i < 4; i++) {
    close(first.cylinders[i].pistonPin.y, turn.cylinders[i].pistonPin.y);
    assert.notEqual(first.cylinders[i].stroke, turn.cylinders[i].stroke);
    close(first.cylinders[i].phaseRad, full.cylinders[i].phaseRad);
    close(first.cylinders[i].valveLifts.intake, full.cylinders[i].valveLifts.intake);
  }
});

test('cam angles turn at half crank speed and intake advance uses half the crank-angle setting', () => {
  const settings = { rpm: 1500, intakeAdvanceRad: rad(8) };
  const a = sampleEngine(rad(40), settings), b = sampleEngine(rad(240), settings);
  close(b.camAngles.exhaust - a.camAngles.exhaust, rad(100));
  close(b.camAngles.intake - a.camAngles.intake, rad(100));
  close(a.camAngles.intake - a.camAngles.exhaust, rad(4));
});

test('valves are seated with exactly zero first derivative at both opening and closing boundaries', () => {
  for (const [kind, open, closed] of [['intake', 350, 580], ['exhaust', 140, 370]]) {
    for (const degree of [open, closed]) {
      assert.equal(valveLift(rad(degree), kind), 0);
      assert.equal(valveLiftDerivative(rad(degree), kind), 0);
    }
    assert.equal(valveLift(rad(open - 1), kind), 0);
    assert.equal(valveLift(rad(closed + 1), kind), 0);
    assert(valveLift(rad(open + 0.01), kind) > 0);
    assert(valveLift(rad(closed - 0.01), kind) > 0);
    close(valveLift(rad((open + closed) / 2), kind), 0.006);
  }
});

test('valve lift remains between zero and the six-millimetre bound for all allowed advances', () => {
  for (const advance of [-10, 0, 10]) for (let degree = -720; degree <= 1440; degree += 1.125) {
    for (const kind of ['intake', 'exhaust']) {
      const lift = valveLift(rad(degree), kind, { intakeAdvanceRad: rad(advance) });
      assert(lift >= 0 && lift <= GEOMETRY.valveMaxLift);
      close(lift, valveLift(rad(degree + 720), kind, { intakeAdvanceRad: rad(advance) }), 2e-16);
    }
  }
});

test('analytic valve derivatives agree with centred finite differences inside the event', () => {
  const epsilon = 1e-5;
  for (const [kind, degrees] of [['intake', [355, 420, 500, 575]], ['exhaust', [145, 210, 300, 365]]]) {
    for (const degree of degrees) {
      const theta = rad(degree);
      const finiteDifference = (valveLift(theta + epsilon, kind) - valveLift(theta - epsilon, kind)) / (2 * epsilon);
      close(valveLiftDerivative(theta, kind), finiteDifference, 1e-12);
    }
  }
});

test('valve profile meets the seated profile with a zero one-sided slope', () => {
  for (const [kind, open, closed] of [['intake', 350, 580], ['exhaust', 140, 370]]) {
    const epsilon = 1e-7;
    assert(Math.abs(valveLiftDerivative(rad(open) + epsilon, kind)) < 1e-8);
    assert(Math.abs(valveLiftDerivative(rad(closed) - epsilon, kind)) < 1e-8);
    assert(valveLift(rad(open) + epsilon, kind) / epsilon < 1e-8);
    assert(valveLift(rad(closed) - epsilon, kind) / epsilon < 1e-8);
  }
});

test('positive intake advance moves the whole event earlier without changing duration or peak', () => {
  for (const advance of [-10, 10]) {
    const settings = { intakeAdvanceRad: rad(advance) };
    close(valveLift(rad(465 - advance), 'intake', settings), 0.006);
    for (const boundary of [350, 580]) for (const turn of [-720, 0, 720]) {
      assert.equal(valveLift(rad(boundary - advance + turn), 'intake', settings), 0);
      assert.equal(valveLiftDerivative(rad(boundary - advance + turn), 'intake', settings), 0);
    }
    for (const degree of [0, 140, 349, 350, 400, 465, 579, 580, 700]) {
      close(valveLift(rad(degree - advance), 'intake', settings), valveLift(rad(degree), 'intake'), 2e-16);
      close(valveLift(rad(degree), 'exhaust', settings), valveLift(rad(degree), 'exhaust'));
    }
  }
});

test('overlap exists across the 360-degree exhaust/intake change without redefining strokes', () => {
  for (const degree of [351, 359, 360, 369]) {
    const cylinder = sampleEngine(rad(degree)).cylinders[0];
    assert(cylinder.valveLifts.intake > 0 && cylinder.valveLifts.exhaust > 0);
    assert.equal(cylinder.stroke, degree < 360 ? 'exhaust' : 'intake');
  }
  assert.equal(valveLift(rad(349), 'intake'), 0);
  assert.equal(valveLift(rad(371), 'exhaust'), 0);
});

test('intake advance changes simultaneous-open duration to 10, 20 or 30 crank degrees', () => {
  for (const [advance, expectedOverlap] of [[-10, 10], [0, 20], [10, 30]]) {
    const settings = { intakeAdvanceRad: rad(advance) };
    // Sample interval midpoints independently over the complete cycle.
    let overlap = 0;
    for (let degree = 0.125; degree < 720; degree += 0.25) {
      const cylinder = sampleEngine(rad(degree), settings).cylinders[0];
      if (cylinder.valveLifts.intake > 0 && cylinder.valveLifts.exhaust > 0) overlap += 0.25;
    }
    assert.equal(overlap, expectedOverlap);
  }
});

test('timing accessor agrees with independent event angles, lift boundaries and normalized limits', () => {
  for (const [advance, open, closed, overlap] of [[-10, 360, 590, 10], [0, 350, 580, 20], [10, 340, 570, 30]]) {
    const settings = { intakeAdvanceRad: rad(advance) }, timing = valveTiming(settings);
    close(timing.intake.open, rad(open)); close(timing.intake.close, rad(closed));
    close(timing.exhaust.open, rad(140)); close(timing.exhaust.close, rad(370));
    close(timing.overlapRad, rad(overlap));
    for (const kind of ['intake', 'exhaust']) {
      const event = timing[kind];
      assert.equal(valveLift(event.open, kind, settings), 0);
      assert.equal(valveLift(event.close, kind, settings), 0);
      assert(valveLift(event.open + rad(1), kind, settings) > 0);
      assert(valveLift(event.close - rad(1), kind, settings) > 0);
    }
  }
  assert.deepEqual(valveTiming({ intakeAdvanceRad: 99 }), valveTiming({ intakeAdvanceRad: rad(10) }));
  assert.deepEqual(valveTiming({ intakeAdvanceRad: NaN }), valveTiming());
  const altered = valveTiming(); altered.intake.open = 0; altered.exhaust.close = 0;
  close(valveTiming().intake.open, rad(350)); close(valveTiming().exhaust.close, rad(370));
});

test('cam support derivatives agree with numerical derivatives and remain strictly convex', () => {
  let minimumRadius = Infinity;
  for (const kind of ['intake', 'exhaust']) {
    for (let i = 0; i < 4096; i++) {
      const phi = (i + 0.27) * 2 * Math.PI / 4096;
      const support = camSupport(kind, phi);
      minimumRadius = Math.min(minimumRadius, support.h + support.ddh);
      assert(support.h + support.ddh > 0.0065, 'Support envelope must remain convex');
      assert(support.h >= 0.030 && support.h <= 0.036);
    }
    const phi = kind === 'intake' ? rad(430) / 2 : rad(240) / 2;
    const e = 1e-4, centre = camSupport(kind, phi), left = camSupport(kind, phi - e), right = camSupport(kind, phi + e);
    close(centre.dh, (right.h - left.h) / (2 * e), 1e-9);
    close(centre.ddh, (right.h - 2 * centre.h + left.h) / e ** 2, 3e-9);
    close(camSupport(kind, phi + 2 * Math.PI).h, centre.h);
  }
  close(minimumRadius, 0.006601194, 2e-7);
});

test('cam support contact agrees with each cylinder lift and applies intake advance only once', () => {
  const followerAngle = -1.2;
  for (const advance of [-10, 0, 10]) for (let degree = 0; degree < 720; degree += 11) {
    const snapshot = sampleEngine(rad(degree), { intakeAdvanceRad: rad(advance) });
    for (const cylinder of snapshot.cylinders) for (const kind of ['intake', 'exhaust']) {
      const lobeRotation = followerAngle - snapshot.camAngles[kind] + FIRING_PHASES[cylinder.id - 1] / 2;
      const localFollowerAngle = followerAngle - lobeRotation;
      close(camSupport(kind, localFollowerAngle).h - GEOMETRY.camBaseRadius, cylinder.valveLifts[kind], 2e-16);
    }
  }
});

test('RPM advances crank angle in SI time independently of observation playback speed', () => {
  close(advanceAngle(0, 0.025, { rpm: 1200 }), Math.PI);
  close(advanceAngle(rad(32), 120 / 1200, { rpm: 1200 }), rad(32));
  close(advanceAngle(rad(32), 0, { rpm: 1200 }), rad(32));
  close(advanceAngle(rad(32), -1, { rpm: 1200 }), rad(32));
  close(advanceAngle(rad(32), Infinity, { rpm: 1200 }), rad(32));
});

test('consumer observation speeds retain the intended four-second and eight-second cycles', () => {
  // A 1200 rpm input with 1/40 playback draws 30 rpm: two turns take 4 s.
  close(advanceAngle(0, 1 * 0.025, { rpm: 1200 }), Math.PI);
  close(advanceAngle(0, 2 * 0.025, { rpm: 1200 }), 2 * Math.PI);
  close(advanceAngle(0, 4 * 0.025, { rpm: 1200 }), 0);
  for (const rpm of [100, 1200, 6000]) {
    const guidedRate = 15 / rpm;
    close(rpm * guidedRate, 15);
    close(advanceAngle(0, 2 * guidedRate, { rpm }), Math.PI);
    close(advanceAngle(0, 4 * guidedRate, { rpm }), 2 * Math.PI);
    close(advanceAngle(0, 8 * guidedRate, { rpm }), 0);
  }
});

test('frame partitioning leaves angle, piston and valve states equivalent', () => {
  for (const rpm of [100, 1200, 6000]) {
    const settings = { rpm, intakeAdvanceRad: rad(7) }, start = rad(37), duration = 2.437;
    const whole = advanceAngle(start, duration, settings);
    let partitioned = start;
    for (let i = 0; i < 1000; i++) partitioned = advanceAngle(partitioned, duration / 1000, settings);
    assert(angleDistance(whole, partitioned) < 1e-10);
    const a = sampleEngine(whole, settings), b = sampleEngine(partitioned, settings);
    for (let i = 0; i < 4; i++) {
      close(a.cylinders[i].pistonPin.y, b.cylinders[i].pistonPin.y, 1e-11);
      close(a.cylinders[i].valveLifts.intake, b.cylinders[i].valveLifts.intake, 1e-11);
    }
  }
});

test('long running and extreme finite time steps never accumulate an unbounded angle', () => {
  let angle = 0;
  for (let i = 0; i < 100000; i++) {
    angle = advanceAngle(angle, 1 / 60, { rpm: 5999 });
    assert(Number.isFinite(angle) && angle >= 0 && angle < cycle);
  }
  for (const dt of [1e10, 1e100, Number.MAX_VALUE]) {
    const result = advanceAngle(angle, dt, { rpm: 6000 });
    assert(Number.isFinite(result) && result >= 0 && result < cycle);
  }
});

test('angles wrap consistently and sampling neither mutates settings nor shares state', () => {
  close(sampleEngine(rad(-1)).cycleAngleRad, rad(719));
  close(sampleEngine(rad(1440)).cycleAngleRad, 0);
  close(sampleEngine(Infinity).cycleAngleRad, 0);
  const settings = Object.freeze({ rpm: 1500, intakeAdvanceRad: rad(2) });
  const first = sampleEngine(rad(40), settings), copy = structuredClone(first);
  sampleEngine(rad(300), settings);
  assert.deepEqual(first, copy);
  assert.throws(() => valveLift(0, 'unknown'), RangeError);
  assert.throws(() => valveLift(0, 'constructor'), RangeError);
  assert.throws(() => camSupport('unknown', 0), RangeError);
});

test('negative sub-ULP angles stay in the half-open cycle interval and retain a canonical zero', () => {
  for (const angle of [-Number.MIN_VALUE, -Number.EPSILON, -0, -cycle, 0, cycle]) {
    const snapshot = sampleEngine(angle);
    assert.equal(snapshot.cycleAngleRad, 0);
    assert.equal(Object.is(snapshot.cycleAngleRad, -0), false);
    assert.equal(snapshot.cylinders[0].phaseRad, 0);
    assert.equal(snapshot.cylinders[0].stroke, 'power');
    assert.equal(advanceAngle(angle, 0), 0);
  }
  for (const angle of [-Number.MAX_VALUE, -cycle - 1e-12, -cycle + 1e-12, -1e-12, cycle - 1e-12, Number.MAX_VALUE]) {
    const snapshot = sampleEngine(angle);
    for (const phase of [snapshot.cycleAngleRad, ...snapshot.cylinders.map(c => c.phaseRad)]) {
      assert(Number.isFinite(phase) && phase >= 0 && phase < cycle, `Invalid wrapped phase ${phase}`);
    }
  }
});
