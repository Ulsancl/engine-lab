import * as THREE from 'three';

const TAU = Math.PI * 2;

// Representative manufacturing details, in metres. These do not alter the
// slider-crank dimensions or claim a production piston/rod design.
export const PISTON_DETAIL = Object.freeze({
  outerRadius: .0423, innerRadius: .036, crownY: .026, undersideY: .0215,
  skirtBottomY: -.017, beltBottomY: .002, pinRadius: .010,
  pinBossInnerRadius: .0101, pinBossOuterRadius: .014, pinBossZ: .025,
  pinBossWidth: .012, skirtArc: 1.70,
  rings: Object.freeze([
    Object.freeze({ y: .018, width: .0015, grooveWidth: .0018, grooveRadius: .0408, gapAngle: .08, phase: .18 }),
    Object.freeze({ y: .013, width: .0015, grooveWidth: .0018, grooveRadius: .0408, gapAngle: .08, phase: 2.28 }),
    Object.freeze({ y: .007, width: .0027, grooveWidth: .0031, grooveRadius: .0406, gapAngle: .10, phase: 4.38 }),
  ]),
});

// A closed radial section revolved about Y. Separate vertices at section corners
// retain machined edges, while analytic azimuthal normals keep turned surfaces
// smooth. Axis triangles are collapsed deliberately, never emitted as zero area.
export function revolvedSection(section, { segments = 96, start = 0, angle = TAU } = {}) {
  const positions = [], normals = [], uvs = [], groups = [];
  const maxR = Math.max(...section.map(p => p[0]));
  const minY = Math.min(...section.map(p => p[1])), maxY = Math.max(...section.map(p => p[1]));
  const point = (p, phi) => [p[0] * Math.cos(phi), p[1], p[0] * Math.sin(phi)];
  function triangle(a, b, c, na, nb, nc, uvA, uvB, uvC) {
    const ab = new THREE.Vector3(...b).sub(new THREE.Vector3(...a));
    const ac = new THREE.Vector3(...c).sub(new THREE.Vector3(...a));
    if (ab.cross(ac).lengthSq() < 1e-26) return;
    positions.push(...a, ...b, ...c); normals.push(...na, ...nb, ...nc); uvs.push(...uvA, ...uvB, ...uvC);
  }
  for (let edge = 0; edge < section.length; edge++) {
    const a = section[edge], b = section[(edge + 1) % section.length];
    const dr = b[0] - a[0], dy = b[1] - a[1], scale = Math.hypot(dr, dy);
    if (scale < 1e-12 || a[0] + b[0] === 0) continue;
    const offset = positions.length / 3;
    const n = phi => [dy / scale * Math.cos(phi), -dr / scale, dy / scale * Math.sin(phi)];
    const uv = (p, phi) => Math.abs(dy) < 1e-10
      ? [.5 + p[0] * Math.cos(phi) / (2 * maxR), .5 + p[0] * Math.sin(phi) / (2 * maxR)]
      : [phi / TAU, (p[1] - minY) / (maxY - minY)];
    for (let i = 0; i < segments; i++) {
      const phi = start + angle * i / segments, next = start + angle * (i + 1) / segments;
      triangle(point(a, phi), point(b, phi), point(b, next), n(phi), n(phi), n(next), uv(a, phi), uv(b, phi), uv(b, next));
      triangle(point(a, phi), point(b, next), point(a, next), n(phi), n(next), n(next), uv(a, phi), uv(b, next), uv(a, next));
    }
    groups.push([offset, positions.length / 3 - offset, a[2] ?? 0]);
  }
  if (angle < TAU - 1e-10) {
    const faces = THREE.ShapeUtils.triangulateShape(section.map(p => new THREE.Vector2(p[0], p[1])), []);
    for (const [phi, sign] of [[start, -1], [start + angle, 1]]) {
      const offset = positions.length / 3, normal = [-sign * Math.sin(phi), 0, sign * Math.cos(phi)];
      for (const face of faces) {
        let vertices = face.map(i => point(section[i], phi));
        const cross = new THREE.Vector3(...vertices[1]).sub(new THREE.Vector3(...vertices[0])).cross(new THREE.Vector3(...vertices[2]).sub(new THREE.Vector3(...vertices[0])));
        if (cross.dot(new THREE.Vector3(...normal)) < 0) vertices = [vertices[0], vertices[2], vertices[1]];
        const map = p => [Math.hypot(p[0], p[2]) / maxR, (p[1] - minY) / (maxY - minY)];
        triangle(...vertices, normal, normal, normal, ...vertices.map(map));
      }
      groups.push([offset, positions.length / 3 - offset, 0]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  for (const group of groups) if (group[1]) geometry.addGroup(...group);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return geometry;
}

export function pistonCrownGeometry() {
  const r = PISTON_DETAIL.outerRadius;
  // Outer ring lands have actual recessed roots. Slots retain 0.15/0.20 mm
  // axial side clearance around their rings; the crown never exceeds 26 mm.
  const profile = [[.036, .002, 0], [.0420, .002, 2], [r, .0024, 2]];
  for (const ring of [...PISTON_DETAIL.rings].reverse()) {
    const low = ring.y - ring.grooveWidth / 2, high = ring.y + ring.grooveWidth / 2;
    profile.push([r, low, 0], [ring.grooveRadius, low, 2], [ring.grooveRadius, high, 0], [r, high, 2]);
  }
  profile.push([r, .0238, 2], [.0417, .026, 0], [.030, .026, 0], [.0285, .0253, 0], [0, .0253, 1], [0, .0215, 1], [.036, .0215, 1]);
  return revolvedSection(profile);
}

export function pistonSkirtGeometry(start) {
  return revolvedSection([
    [.036, -.017, 0], [.0416, -.017, 2], [.0423, -.0163, 2],
    [.0423, .0024, 0], [.036, .0024, 1],
  ], { start, angle: PISTON_DETAIL.skirtArc, segments: 30 });
}

export function beveledPlate(points, depth, bevel = .0006) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  // Extrusion bevel extends outside the face plane; translate/reduce the body
  // so its final physical thickness, and therefore journal clearances, stay exact.
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: depth - 2 * bevel, bevelEnabled: true, bevelThickness: bevel,
    bevelSize: bevel, bevelSegments: 2, curveSegments: 24, steps: 1,
  });
  geometry.translate(0, 0, -depth / 2 + bevel); geometry.computeBoundingBox(); return geometry;
}

export function rodBeamGeometry(depth = .006) {
  return beveledPlate([[-.009, .020], [-.0062, .041], [-.0048, .120], [-.0072, .130], [.0072, .130], [.0048, .120], [.0062, .041], [.009, .020]], depth, .0005);
}

export function rodFlangeGeometry() {
  return beveledPlate([[-.012, .020], [-.0092, .041], [-.0078, .120], [-.009, .130], [.009, .130], [.0078, .120], [.0092, .041], [.012, .020]], .0028, .00045);
}

export function crankCheekGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-.012, .058);
  shape.quadraticCurveTo(-.020, .056, -.019, .042);
  shape.lineTo(-.017, .009); shape.quadraticCurveTo(-.029, -.009, -.024, -.033);
  shape.quadraticCurveTo(-.022, -.049, 0, -.049);
  shape.quadraticCurveTo(.022, -.049, .024, -.033);
  shape.quadraticCurveTo(.029, -.009, .017, .009); shape.lineTo(.019, .042);
  shape.quadraticCurveTo(.020, .056, .012, .058); shape.quadraticCurveTo(0, .062, -.012, .058);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: .0124, bevelEnabled: true, bevelThickness: .0008, bevelSize: .0008, bevelSegments: 3, curveSegments: 20 });
  geometry.translate(0, 0, -.0062); geometry.computeBoundingBox(); return geometry;
}

// Frequencies stay below pi radians/texel. Mipmaps then filter real fine marks
// rather than magnifying a low-resolution aliased pattern into false broad bands.
export function metalFinishTexture(kind = 'turned', size = 512) {
  const data = new Uint8Array(size * size * 4);
  let seed = 0x29ab716e;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const noise = (seed >>> 0) / 4294967296 - .5;
    const coordinate = kind === 'turned' ? Math.hypot(x - size / 2, y - size / 2) : y;
    const value = kind === 'cast' ? 128 + 45 * noise : 128 + 13 * Math.sin(coordinate * 1.31) + 5 * Math.sin(coordinate * 2.37) + 3 * noise;
    const offset = (y * size + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = Math.round(value); data[offset + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true;
  texture.needsUpdate = true; return texture;
}
