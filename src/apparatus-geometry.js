import * as THREE from 'three';
import { revolvedSection } from './mechanical-geometry.js';

const TAU = Math.PI * 2;

function groupTurnedSurfaces(geometry) {
  const indices = [];
  const materials = new Set(geometry.groups.map(group => group.materialIndex));
  const groups = geometry.groups.slice();
  geometry.clearGroups();
  for (const material of materials) {
    const start = indices.length;
    for (const group of groups) {
      if (group.materialIndex !== material) continue;
      for (let index = group.start; index < group.start + group.count; index++) indices.push(index);
    }
    geometry.addGroup(start, indices.length - start, material);
  }
  geometry.setIndex(indices);
  return geometry;
}

export function linerGeometry(cut) {
  // Positive X is the inspection opening. The honed surface keeps the
  // same radius from the deck lip to the bottom of the liner.
  const geometry = revolvedSection([
    [.043, -.058, 1], [.0473, -.058, 2], [.0485, -.0568, 2],
    [.0485, .049, 2], [.0495, .050, 2], [.0495, .0572, 2],
    [.0487, .058, 0], [.043, .058, 1],
  ], { start: cut ? Math.PI / 2 : 0, angle: cut ? Math.PI : TAU });
  return groupTurnedSurfaces(geometry);
}

export function honingTexture() {
  const size = 256, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // UVs are azimuth and height. These slopes give roughly 46° of
    // included angle on the physical bore. The map adds no physical ridges.
    const a = Math.cos(TAU * (75 * x + 77 * y) / size);
    const b = Math.cos(TAU * (81 * x - 83 * y) / size);
    const varied = Math.cos(TAU * (3 * x + 5 * y) / size);
    const value = 225 - (28 + 5 * varied) * (Math.max(0, a) ** 4 + Math.max(0, b) ** 4);
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = value;
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function roundHole(shape, x, y, radius) {
  const opening = new THREE.Path();
  opening.absarc(x, y, radius, 0, TAU, true);
  shape.holes.push(opening);
}

export function blockDeckGeometry(cut) {
  const shape = new THREE.Shape();
  // Metal follows both the cylinder opening and its head-bolt pads. For
  // the half-section the bore is opened into the inspection plane.
  shape.moveTo(0, -.052);
  shape.lineTo(-.058, -.052);
  shape.quadraticCurveTo(-.070, -.052, -.070, -.043);
  shape.lineTo(-.066, -.012);
  shape.lineTo(-.066, .012);
  shape.lineTo(-.070, .043);
  shape.quadraticCurveTo(-.070, .052, -.058, .052);
  shape.lineTo(0, .052);
  if (cut) {
    shape.lineTo(0, .0498);
    shape.absarc(0, 0, .0498, Math.PI / 2, 3 * Math.PI / 2, false);
  } else {
    shape.lineTo(.058, .052);
    shape.quadraticCurveTo(.070, .052, .070, .043);
    shape.lineTo(.066, .012);
    shape.lineTo(.066, -.012);
    shape.lineTo(.070, -.043);
    shape.quadraticCurveTo(.070, -.052, .058, -.052);
    roundHole(shape, 0, 0, .0498);
  }
  shape.closePath();
  for (const x of cut ? [-.057] : [-.057, .057]) {
    roundHole(shape, x, -.041, .004);
    roundHole(shape, x, .023, .0037);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: .009, bevelEnabled: false, curveSegments: 28 });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export function portFlangeGeometry() {
  const flange = new THREE.Shape();
  flange.moveTo(-.048, -.013);
  flange.lineTo(.048, -.013);
  flange.quadraticCurveTo(.051, -.013, .051, -.010);
  flange.lineTo(.048, .012);
  flange.lineTo(.034, .017);
  flange.lineTo(-.034, .017);
  flange.lineTo(-.048, .012);
  flange.quadraticCurveTo(-.051, -.010, -.048, -.013);
  for (const z of [-.018, .018]) roundHole(flange, z, 0, .009);
  const geometry = new THREE.ExtrudeGeometry(flange, { depth: .006, bevelEnabled: false, curveSegments: 24 });
  geometry.translate(0, 0, -.003);
  geometry.rotateY(Math.PI / 2);
  return geometry;
}

export function headDeckGeometry(cut) {
  const shape = new THREE.Shape();
  const plugBore = .0032;
  if (cut) {
    shape.absarc(0, 0, .059, Math.PI / 2, 3 * Math.PI / 2);
    shape.lineTo(0, -plugBore);
    shape.absarc(0, 0, plugBore, 3 * Math.PI / 2, Math.PI / 2, true);
  } else {
    shape.absarc(0, 0, .059, 0, TAU);
    roundHole(shape, 0, 0, plugBore);
  }
  shape.closePath();
  for (const x of cut ? [-.019] : [-.019, .019]) {
    for (const z of [-.018, .018]) roundHole(shape, x, z, .0126);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: .005, bevelEnabled: false, curveSegments: 32 });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export function portShellGeometry(curve) {
  // The inside wall and both mouth rims are part of the same solid shell.
  const segments = 16, rings = 22, outer = .011, inner = .009;
  const frames = curve.computeFrenetFrames(segments, false);
  const positions = [], uvs = [], indices = [];
  for (const radius of [outer, inner]) {
    for (let step = 0; step <= segments; step++) {
      const point = curve.getPointAt(step / segments);
      for (let ring = 0; ring <= rings; ring++) {
        const angle = ring / rings * TAU;
        const vertex = point.clone().addScaledVector(frames.normals[step], radius * Math.cos(angle))
          .addScaledVector(frames.binormals[step], radius * Math.sin(angle));
        positions.push(vertex.x, vertex.y, vertex.z);
        uvs.push(step / segments, ring / rings);
      }
    }
  }
  const pitch = rings + 1, layer = (segments + 1) * pitch;
  for (let step = 0; step < segments; step++) {
    for (let ring = 0; ring < rings; ring++) {
      const a = step * pitch + ring, b = a + pitch;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
      indices.push(layer + a, layer + b, layer + a + 1, layer + a + 1, layer + b, layer + b + 1);
    }
  }
  const sides = indices.length;
  for (let ring = 0; ring < rings; ring++) {
    const end = segments * pitch + ring;
    indices.push(ring, layer + ring, ring + 1, ring + 1, layer + ring, layer + ring + 1);
    indices.push(end, end + 1, layer + end, end + 1, layer + end + 1, layer + end);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.addGroup(0, sides, 0);
  geometry.addGroup(sides, indices.length - sides, 1);
  geometry.computeVertexNormals();
  return geometry;
}

export function valveFaceGeometry() {
  return groupTurnedSurfaces(revolvedSection([
    [0, 0, 0], [.0108, 0, 0], [.0095, .0025, 0],
    [.0065, .0036, 1], [.0030, .0051, 1], [.0025, .0072, 1],
    [0, .0072, 1],
  ], { segments: 40 }));
}

export function valveSeatGeometry() {
  return groupTurnedSurfaces(revolvedSection([
    [.0108, 0, 0], [.0121, 0, 1], [.0125, .0006, 1],
    [.0125, .0038, 1], [.00935, .0038, 0], [.0095, .0025, 0],
  ], { segments: 40 }));
}

export function hardenedJournalGeometry(radius, length) {
  const half = length / 2, fillet = .0011;
  const geometry = revolvedSection([
    [0, -half, 1], [radius - .0007, -half, 1],
    [radius - .00016, -half + fillet * .45, 1], [radius, -half + fillet, 0],
    [radius, half - fillet, 1], [radius - .00016, half - fillet * .45, 1],
    [radius - .0007, half, 1], [0, half, 1],
  ], { segments: 64 });
  geometry.rotateX(Math.PI / 2);
  return groupTurnedSurfaces(geometry);
}

export function boltGeometry() {
  const geometry = revolvedSection([
    [0, -.005, 1], [.00185, -.005, 1], [.00185, -.0015, 2],
    [.0037, -.0015, 2], [.0039, -.00115, 2], [.0039, -.00055, 2],
    [.0034, -.00025, 2], [.0031, -.00025, 0], [.0031, .0014, 0],
    [.00255, .00205, 0], [0, .00205, 0],
  ], { segments: 24 });
  // Clip only the head to six wrench flats. The integral flange stays round.
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index++) {
    if (positions.getY(index) <= -.00026) continue;
    const x = positions.getX(index), z = positions.getZ(index);
    const angle = Math.atan2(z, x);
    const flat = TAU / 6;
    const sector = angle - flat * Math.floor(angle / flat) - flat / 2;
    const maxRadius = .0031 * Math.cos(flat / 2) / Math.cos(sector);
    const scale = Math.min(1, maxRadius / (Math.hypot(x, z) || 1));
    positions.setX(index, x * scale);
    positions.setZ(index, z * scale);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return groupTurnedSurfaces(geometry);
}

export function chainPlateGeometry() {
  const plate = new THREE.Shape();
  plate.moveTo(-.0053, 0);
  plate.quadraticCurveTo(-.0053, .0024, -.0031, .0022);
  plate.quadraticCurveTo(0, .0011, .0031, .0022);
  plate.quadraticCurveTo(.0053, .0024, .0053, 0);
  plate.quadraticCurveTo(.0053, -.0024, .0031, -.0022);
  plate.quadraticCurveTo(0, -.0011, -.0031, -.0022);
  plate.quadraticCurveTo(-.0053, -.0024, -.0053, 0);
  const geometry = new THREE.ExtrudeGeometry(plate, { depth: .0012, bevelEnabled: false, curveSegments: 5 });
  geometry.translate(0, 0, -.0006);
  return geometry;
}
