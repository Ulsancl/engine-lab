import { GEOMETRY, FIRING_PHASES, normalizeSettings, valveTiming,
  valveLiftDerivative, valveLiftSecondDerivative } from './model.js';

const TAU = 2 * Math.PI, CYCLE = 2 * TAU;
const endpointTolerance = 8 * Number.EPSILON * CYCLE;

/** Observations at constant physical RPM. Playback speed is deliberately absent. */
export function engineDetail(snapshot, settings, selectedCylinder = 1) {
  if (!Number.isFinite(snapshot?.cycleAngleRad) || !Array.isArray(snapshot.cylinders)
    || snapshot.cylinders.length !== FIRING_PHASES.length
    || !snapshot.cylinders.every(c => Number.isFinite(c.phaseRad) && Number.isFinite(c.pistonPin?.y)
      && Number.isFinite(c.rodAngleRad) && Number.isFinite(c.valveLifts?.intake) && Number.isFinite(c.valveLifts?.exhaust))) return null;
  const cfg = normalizeSettings(settings), omega = cfg.rpm * TAU / 60;
  const { bore, stroke, rodLength: length } = GEOMETRY, r = stroke / 2;
  const boreAreaM2 = Math.PI * bore * bore / 4, sweptVolumePerCylinderM3 = boreAreaM2 * stroke;
  const events = valveTiming(cfg), timing = { cycleSeconds: CYCLE / omega,
    overlapRad: events.overlapRad, overlapSeconds: events.overlapRad / omega };
  for (const kind of ['intake', 'exhaust']) timing[kind] = {
    openRad: events[kind].open, closeRad: events[kind].close,
    durationRad: events[kind].close - events[kind].open,
    durationSeconds: (events[kind].close - events[kind].open) / omega,
  };
  const cylinders = snapshot.cylinders.map(c => {
    const sin = Math.sin(c.phaseRad), cos = Math.cos(c.phaseRad);
    const q = Math.sqrt(length * length - r * r * sin * sin);
    const dy = -r * sin - r * r * sin * cos / q;
    const ddy = -r * cos - r * r * (cos * cos - sin * sin) / q
      - r ** 4 * sin * sin * cos * cos / q ** 3;
    const travelFromTdcM = r + length - c.pistonPin.y;
    const valves = {};
    for (const kind of ['intake', 'exhaust']) {
      const event = timing[kind];
      const accelerationDefined = Math.abs(c.phaseRad - event.openRad) > endpointTolerance
        && Math.abs(c.phaseRad - event.closeRad) > endpointTolerance;
      valves[kind] = {
        liftM: c.valveLifts[kind],
        velocityMps: valveLiftDerivative(c.phaseRad, kind, cfg) * omega,
        accelerationMps2: accelerationDefined ? valveLiftSecondDerivative(c.phaseRad, kind, cfg) * omega * omega : null,
        accelerationDefined,
      };
    }
    return {
      id: c.id, phaseRad: c.phaseRad, stroke: c.stroke,
      piston: {
        travelFromTdcM, remainingToBdcM: stroke - travelFromTdcM,
        velocityYMps: dy * omega, accelerationYMps2: ddy * omega * omega,
        meanSpeedMps: 2 * stroke * cfg.rpm / 60,
        sweptVolumeFromTdcM3: boreAreaM2 * travelFromTdcM,
        sweptVolumeRateM3PerS: -boreAreaM2 * dy * omega,
      },
      rod: {
        angleRad: c.rodAngleRad,
        angularVelocityRadPerS: r * cos / q * omega,
        angularAccelerationRadPerS2: -r * (length * length - r * r) * sin / q ** 3 * omega * omega,
      },
      valves,
    };
  });
  const selectedCylinderId = Number.isInteger(selectedCylinder) && selectedCylinder >= 1 && selectedCylinder <= cylinders.length ? selectedCylinder : 1;
  return {
    crank: { rpm: cfg.rpm, omegaRadPerS: omega, rotationZRpm: -cfg.rpm, pinCentripetalAccelerationMps2: r * omega * omega },
    cam: { rpm: cfg.rpm / 2, omegaRadPerS: omega / 2, rotationZRpm: -cfg.rpm / 2 },
    geometry: { boreM: bore, strokeM: stroke, rodLengthM: length, boreAreaM2,
      sweptVolumePerCylinderM3, totalSweptVolumeM3: sweptVolumePerCylinderM3 * cylinders.length },
    timing, cylinders, selectedCylinderId, cylinder: cylinders[selectedCylinderId - 1],
  };
}
