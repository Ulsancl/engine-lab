import * as THREE from 'three';
import { camSupport, FIRING_PHASES } from './model.js';

export const SCENE_DIMENSIONS = Object.freeze({
  valveTilt: 20 * Math.PI / 180, valveSeatY: .225, valveSeatX: .020,
  valvePairZ: .018, valveHeadRadius: .011, camStemOffset: .064,
  camBaseRadius: .030, followerRadius: .011, followerThickness: .004,
  camLobeWidth: .010, cylinderPitch: .104, bore: .086,
});

export const OIL_PUMP_GEOMETRY = Object.freeze({ axis: [0, 0, -.228], innerRadius: .0152, rotorRadius: .027, housingRadius: .034, inlet: [0, -.030, -.228], outlet: [.029, 0, -.228] });

// An explicit connected circuit is shared by the meshes and CPU geometry checks.
// These are representative drilled galleries, not measured hydraulic simulation.
export function oilCircuitPaths(firstStation = 0, lastStation = 4) {
  const first = Math.max(0, Math.min(3, firstStation)), last = Math.max(first + 1, Math.min(4, lastStation));
  const startZ = -.208 + first * .104, endZ = -.208 + last * .104;
  const galleryStart = [-.052, .076, startZ], galleryEnd = [-.052, .076, endZ];
  const feedZ = Math.max(startZ, Math.min(endZ, -.14));
  const pickup = [0, -.070, -.060], filterIn = [.092, .024, -.14], filterOut = [.092, .070, -.14];
  const paths = [
    { id: 'pickup-pump', points: [pickup, [.022, -.064, -.14], [.005, -.045, -.205], [...OIL_PUMP_GEOMETRY.inlet]] },
    { id: 'pump-internal', points: [[...OIL_PUMP_GEOMETRY.inlet], [.017, -.015, -.228], [...OIL_PUMP_GEOMETRY.outlet]] },
    { id: 'pump-filter', points: [[...OIL_PUMP_GEOMETRY.outlet], [.060, .002, -.19], filterIn] },
    { id: 'filter-gallery', points: [filterIn, [.097, .047, -.14], filterOut, [.048, .076, -.14], [-.052, .076, feedZ]] },
    { id: 'main-gallery', points: [galleryStart, galleryEnd], straight: true },
  ];
  for (let station = first; station <= last; station++) {
    const z = -.208 + station * .104;
    paths.push({ id: `main-bearing-${station + 1}`, station, points: [[-.052, .076, z], [-.042, .036, z], [-.023, 0, z], [0, 0, z]] });
  }
  for (const kind of ['intake', 'exhaust']) {
    const center = valveGeometry(kind).center, x = center[0] + (kind === 'intake' ? -.017 : .017), y = center[1] - .016;
    paths.push({ id: `${kind}-head-feed`, points: [galleryEnd, [-.061, .19, endZ], [x, y, endZ]] });
    paths.push({ id: `${kind}-gallery`, points: [[x, y, endZ], [x, y, startZ]], straight: true });
    for (let station = first; station <= last; station++) {
      const z = -.208 + station * .104;
      paths.push({ id: `${kind}-bearing-${station + 1}`, station, points: [[x, y, z], [center[0], center[1] - .011, z], [center[0], center[1], z]], straight: true });
    }
  }
  return paths;
}

export function crankOilPassage(cylinderIndex) {
  const z = (cylinderIndex - 1.5) * SCENE_DIMENSIONS.cylinderPitch;
  return [[0, 0, z - .052], [0, 0, z - .026], [0, .043, z - .017], [0, .043, z]];
}

export function valveGeometry(kind, cylinderZ = 0, pair = 1) {
  const sign = kind === 'intake' ? -1 : 1;
  const n = [sign * Math.sin(SCENE_DIMENSIONS.valveTilt), Math.cos(SCENE_DIMENSIONS.valveTilt), 0];
  const seat = [sign * SCENE_DIMENSIONS.valveSeatX, SCENE_DIMENSIONS.valveSeatY, cylinderZ + pair * SCENE_DIMENSIONS.valvePairZ];
  const center = seat.map((value, index) => value + n[index] * SCENE_DIMENSIONS.camStemOffset);
  return { n, seat, center, alpha: Math.atan2(-n[1], -n[0]) };
}

export function camOutline(kind, segments = 720) {
  const points = [];
  for (let index = 0; index < segments; index++) {
    const phi = index / segments * Math.PI * 2;
    const { h, dh } = camSupport(kind, phi);
    points.push([h * Math.cos(phi) - dh * Math.sin(phi), h * Math.sin(phi) + dh * Math.cos(phi)]);
  }
  return points;
}

export function camContact(kind, camAngle, cylinderIndex = 0, cylinderZ = 0, pair = 1) {
  const valve = valveGeometry(kind, cylinderZ, pair);
  const phi = camAngle - FIRING_PHASES[cylinderIndex] / 2;
  const rotation = valve.alpha - camAngle + FIRING_PHASES[cylinderIndex] / 2;
  const { h, dh, ddh } = camSupport(kind, phi);
  const local = [h * Math.cos(phi) - dh * Math.sin(phi), h * Math.sin(phi) + dh * Math.cos(phi)];
  const point = [valve.center[0] + local[0] * Math.cos(rotation) - local[1] * Math.sin(rotation), valve.center[1] + local[0] * Math.sin(rotation) + local[1] * Math.cos(rotation), valve.center[2]];
  const followerFace = valve.center.map((value, index) => value - valve.n[index] * h);
  return { ...valve, phi, rotation, h, dh, ddh, point, followerFace, lift: h - SCENE_DIMENSIONS.camBaseRadius };
}

export function createCamGeometry(kind) {
  const points = camOutline(kind);
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: SCENE_DIMENSIONS.camLobeWidth, bevelEnabled: false, steps: 1 });
  geometry.translate(0, 0, -SCENE_DIMENSIONS.camLobeWidth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

// Closed radial end faces make the cut surface a real section rather than a transparent shell.
export function annulus(inner, outer, depth, start = 0, length = Math.PI * 2, segments = 64) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, start, start + length, false);
  shape.lineTo(inner * Math.cos(start + length), inner * Math.sin(start + length));
  shape.absarc(0, 0, inner, start + length, start, true);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: segments });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

export function sprocketGeometry(teeth, radius, thickness, holeRadius = radius * .25) {
  const shape = new THREE.Shape();
  for (let index = 0; index < teeth * 4; index++) {
    const angle = index / (teeth * 4) * Math.PI * 2;
    const r = radius * (index % 4 === 1 || index % 4 === 2 ? 1 : .91);
    const x = r * Math.cos(angle), y = r * Math.sin(angle);
    if (index === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  const hole = new THREE.Path(); hole.absarc(0, 0, holeRadius, 0, Math.PI * 2, true); shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelSegments: 1, bevelSize: .0004, bevelThickness: .0004 });
  geometry.translate(0, 0, -thickness / 2);
  return geometry;
}

// Convex outside route around the three pitch circles. Teeth/links are a representative drive;
// crank and cam angular motion is the exact 2:1 model contract.
export function timingPath() {
  const cam = valveGeometry('exhaust').center;
  const points = [];
  for (const [cx, cy, radius] of [[-cam[0], cam[1], .042], [cam[0], cam[1], .042], [0, 0, .021]]) {
    for (let index = 0; index < 128; index++) {
      const angle = index / 128 * Math.PI * 2;
      points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
    }
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const lower = [], upper = [];
  for (const point of points) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop(); lower.push(point); }
  for (const point of [...points].reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop(); upper.push(point); }
  const loop = lower.slice(0, -1).concat(upper.slice(0, -1));
  const lengths = [0];
  for (let index = 0; index < loop.length; index++) lengths.push(lengths.at(-1) + Math.hypot(loop[(index + 1) % loop.length][0] - loop[index][0], loop[(index + 1) % loop.length][1] - loop[index][1]));
  const total = lengths.at(-1);
  return { total, sample(distance) {
    const d = ((distance % total) + total) % total;
    let index = 0; while (index < loop.length - 1 && lengths[index + 1] <= d) index++;
    const a = loop[index], b = loop[(index + 1) % loop.length], span = lengths[index + 1] - lengths[index], f = (d - lengths[index]) / span;
    return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  } };
}

export function layoutLabels(candidates, width, height) {
  const labelWidth = Math.min(width < 600 ? 110 : 132, width * .27);
  const top = 80, bottom = Math.max(top, height - 60), gap = 32;
  const capacity = Math.max(1, Math.floor((bottom - top) / gap));
  const out = [];
  for (const side of [0, 1]) {
    const entries = candidates.filter(item => (item.x < width / 2 ? 0 : 1) === side).sort((a, b) => Number(b.selected) - Number(a.selected) || a.priority - b.priority).slice(0, capacity).sort((a, b) => a.y - b.y);
    let previous = top - gap;
    entries.forEach((entry, index) => {
      const y = Math.min(bottom - (entries.length - index - 1) * gap, Math.max(top, previous + gap, entry.y)); previous = y;
      out.push({ ...entry, left: side === 0 ? 12 : width - labelWidth - 12, top: y - 13, width: labelWidth, edgeX: side === 0 ? labelWidth + 12 : width - labelWidth - 12, edgeY: y });
    });
  }
  return out;
}

// Every visible instance contributes its transformed local bounds. Traversing the root
// with Box3.setFromObject would also include hidden cylinders and disabled layers.
export function visibleMeshCorners(root) {
  root.updateMatrixWorld(true);
  const points = [], localMatrix = new THREE.Matrix4(), worldMatrix = new THREE.Matrix4();
  root.traverseVisible(node => {
    if (!node.isMesh || !node.geometry?.attributes.position) return;
    const geometry = node.geometry; if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox; if (!box || box.isEmpty()) return;
    const count = node.isInstancedMesh ? node.count : 1;
    for (let index = 0; index < count; index++) {
      if (node.isInstancedMesh) { node.getMatrixAt(index, localMatrix); worldMatrix.multiplyMatrices(node.matrixWorld, localMatrix); }
      else worldMatrix.copy(node.matrixWorld);
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) points.push(new THREE.Vector3(x, y, z).applyMatrix4(worldMatrix));
    }
  });
  return points;
}

export function fitEngineCamera(camera, root, { aspect = 1, direction = new THREE.Vector3(.88, .54, -.91), fillX = .84, fillY = .78 } = {}) {
  const points = visibleMeshCorners(root);
  if (!points.length) return null;
  const bounds = new THREE.Box3().setFromPoints(points), target = bounds.getCenter(new THREE.Vector3()), axis = direction.clone().normalize();
  camera.aspect = aspect; camera.zoom = 1; camera.position.copy(target).add(axis); camera.lookAt(target); camera.updateMatrixWorld(true); camera.updateProjectionMatrix();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), horizontal = vertical * aspect;
  let distance = .17;
  for (const point of points) {
    const relative = point.clone().sub(target), depth = relative.dot(axis);
    distance = Math.max(distance, depth + camera.near * 2, depth + Math.abs(relative.dot(right)) / (horizontal * fillX), depth + Math.abs(relative.dot(up)) / (vertical * fillY));
  }
  camera.position.copy(target).addScaledVector(axis, distance); camera.lookAt(target); camera.updateMatrixWorld(true); camera.updateProjectionMatrix();
  const projected = points.map(point => point.clone().project(camera));
  return { target, distance, bounds, projectedBounds: { left: Math.min(...projected.map(point => point.x)), right: Math.max(...projected.map(point => point.x)), bottom: Math.min(...projected.map(point => point.y)), top: Math.max(...projected.map(point => point.y)) } };
}
