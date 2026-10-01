// Representative four-stroke mechanism. Distances are metres and angles radians.
export const MODEL_VERSION = 'engine-kinematics-1';
export const GEOMETRY = Object.freeze({
  bore: 0.086, stroke: 0.086, rodLength: 0.143, cylinderPitch: 0.104,
  pinToCrown: 0.026, deckY: 0.214, valveSeatY: 0.225,
  valveTilt: 20 * Math.PI / 180, camBaseRadius: 0.030,
  valveMaxLift: 0.006, valveSeatX: 0.020, valvePairZ: 0.018,
  camSeatDistance: 0.064, followerRadius: 0.011,
});

export const FIRING_PHASES = Object.freeze([0, 3 * Math.PI, Math.PI, 2 * Math.PI]);
const CYCLE = 4 * Math.PI;
const ADVANCE_LIMIT = 10 * Math.PI / 180;
const VALVE_EVENTS = Object.freeze({
  intake: Object.freeze({ open: 350 * Math.PI / 180, close: 580 * Math.PI / 180 }),
  exhaust: Object.freeze({ open: 140 * Math.PI / 180, close: 370 * Math.PI / 180 }),
});
const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function wrapCycle(angle) {
  const value = finite(angle, 0);
  if (value >= 0 && value < CYCLE) return value === 0 ? 0 : value;
  const remainder = value % CYCLE;
  const wrapped = remainder < 0 ? remainder + CYCLE : remainder;
  // Adding the period to a tiny negative remainder can round up to CYCLE.
  return wrapped === 0 || wrapped === CYCLE ? 0 : wrapped;
}

export function normalizeSettings(settings = {}) {
  const value = settings && typeof settings === 'object' ? settings : {};
  return {
    rpm: clamp(finite(value.rpm, 1200), 100, 6000),
    intakeAdvanceRad: clamp(finite(value.intakeAdvanceRad, 0), -ADVANCE_LIMIT, ADVANCE_LIMIT),
  };
}

// Event boundaries in crank radians for the selected cylinder's 720° cycle.
export function valveTiming(settings = {}) {
  const { intakeAdvanceRad } = normalizeSettings(settings);
  const intake = {
    open: VALVE_EVENTS.intake.open - intakeAdvanceRad,
    close: VALVE_EVENTS.intake.close - intakeAdvanceRad,
  };
  const exhaust = { ...VALVE_EVENTS.exhaust };
  return {
    intake, exhaust,
    overlapRad: Math.max(0, Math.min(intake.close, exhaust.close) - Math.max(intake.open, exhaust.open)),
  };
}

function liftTerms(phaseRad, kind, intakeAdvanceRad = 0) {
  if (kind !== 'intake' && kind !== 'exhaust') throw new RangeError(`Unknown valve kind: ${String(kind)}`);
  const event = VALVE_EVENTS[kind];
  const phase = wrapCycle(wrapCycle(phaseRad) + (kind === 'intake' ? intakeAdvanceRad : 0));
  // Arithmetic such as (350° - advance) + advance can differ by a few ULPs.
  const endpointTolerance = 8 * Number.EPSILON * CYCLE;
  if (phase <= event.open + endpointTolerance || phase >= event.close - endpointTolerance) {
    return { lift: 0, derivative: 0, secondDerivative: 0 };
  }
  const duration = event.close - event.open;
  const u = Math.PI * (phase - event.open) / duration;
  const amplitude = GEOMETRY.valveMaxLift;
  return {
    lift: amplitude * Math.sin(u) ** 2,
    derivative: amplitude * Math.PI / duration * Math.sin(2 * u),
    secondDerivative: 2 * amplitude * (Math.PI / duration) ** 2 * Math.cos(2 * u),
  };
}

export function valveLift(phaseRad, kind, settings = {}) {
  return liftTerms(phaseRad, kind, normalizeSettings(settings).intakeAdvanceRad).lift;
}

// Derivative with respect to crank angle, in metres per crank radian.
export function valveLiftDerivative(phaseRad, kind, settings = {}) {
  return liftTerms(phaseRad, kind, normalizeSettings(settings).intakeAdvanceRad).derivative;
}

// Piecewise derivative with respect to crank angle (m/rad²). At an event
// boundary this returns the closed-branch convention, not a two-sided limit.
export function valveLiftSecondDerivative(phaseRad, kind, settings = {}) {
  return liftTerms(phaseRad, kind, normalizeSettings(settings).intakeAdvanceRad).secondDerivative;
}

// Fixed basic lobe support function. The scene applies advance through camAngles.
// phi is a cam-profile angle: d(2 phi)/d phi = 2.
export function camSupport(kind, phi) {
  // Reduce before multiplying so even very large finite inputs stay finite.
  const camPhase = wrapCycle(phi) % (2 * Math.PI);
  const { lift, derivative, secondDerivative } = liftTerms(2 * camPhase, kind);
  return {
    h: GEOMETRY.camBaseRadius + lift,
    dh: 2 * derivative,
    ddh: 4 * secondDerivative,
  };
}

export function sampleEngine(angleRad, settings = {}) {
  const normalized = normalizeSettings(settings);
  const cycleAngleRad = wrapCycle(angleRad);
  const radius = GEOMETRY.stroke / 2, length = GEOMETRY.rodLength;
  return {
    cycleAngleRad,
    camAngles: {
      intake: cycleAngleRad / 2 + normalized.intakeAdvanceRad / 2,
      exhaust: cycleAngleRad / 2,
    },
    cylinders: FIRING_PHASES.map((firingPhase, index) => {
      const phaseRad = wrapCycle(cycleAngleRad - firingPhase);
      const z = (index - 1.5) * GEOMETRY.cylinderPitch;
      const crankPin = { x: radius * Math.sin(phaseRad), y: radius * Math.cos(phaseRad), z };
      const verticalRodSpan = Math.sqrt(length ** 2 - crankPin.x ** 2);
      const pistonPin = { x: 0, y: crankPin.y + verticalRodSpan, z };
      const phaseIndex = Math.min(3, Math.floor(phaseRad / Math.PI));
      return {
        id: index + 1, phaseRad,
        stroke: ['power', 'exhaust', 'intake', 'compression'][phaseIndex],
        pistonPin, crankPin,
        // Standard positive rotation about +Z for a rod initially along +Y.
        rodAngleRad: Math.atan2(crankPin.x, verticalRodSpan),
        valveLifts: {
          intake: valveLift(phaseRad, 'intake', normalized),
          exhaust: valveLift(phaseRad, 'exhaust', normalized),
        },
      };
    }),
  };
}

export function advanceAngle(angleRad, dtSeconds, settings = {}) {
  const start = wrapCycle(angleRad), dt = Math.max(0, finite(dtSeconds, 0));
  const { rpm } = normalizeSettings(settings);
  // Keep accumulated state bounded, and avoid rpm * hugeDt overflowing.
  const cycleSeconds = 120 / rpm;
  const withinCycleSeconds = dt % cycleSeconds;
  return wrapCycle(start + withinCycleSeconds * rpm * (2 * Math.PI / 60));
}
