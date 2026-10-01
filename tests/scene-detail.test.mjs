import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GEOMETRY } from '../src/model.js';
import { annulus } from '../src/scene-geometry.js';
import { PISTON_DETAIL as P, pistonCrownGeometry, pistonSkirtGeometry, rodBeamGeometry, rodFlangeGeometry, crankCheekGeometry, metalFinishTexture } from '../src/mechanical-geometry.js';

function surfaceAudit(geometry) {
  const mesh = geometry.index ? geometry.toNonIndexed() : geometry;
  const p = mesh.attributes.position, n = mesh.attributes.normal, edges = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const key = v => v.toArray().map(value => Math.round(value * 1e8)).join(',');
  let volume = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    const normal = b.clone().sub(a).cross(c.clone().sub(a));
    assert(normal.lengthSq() > 1e-23, 'no degenerate triangles');
    volume += a.dot(b.clone().cross(c)) / 6;
    for (let offset = 0; offset < 3; offset++) {
      const given = new THREE.Vector3().fromBufferAttribute(n, i + offset);
      assert(Math.abs(given.length() - 1) < 1e-5, 'unit shading normals');
      assert(given.dot(normal) > 0, 'shading normal agrees with outward winding');
    }
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const x = key(from), y = key(to), edge = x < y ? `${x}|${y}` : `${y}|${x}`;
      const entry = edges.get(edge) || { count: 0, orientation: 0 };
      entry.count++; entry.orientation += x < y ? 1 : -1; edges.set(edge, entry);
    }
  }
  for (const edge of edges.values()) { assert.equal(edge.count, 2, 'watertight geometric edges'); assert.equal(edge.orientation, 0, 'consistent winding across seams'); }
  assert(volume > 0, 'positive enclosed material volume');
  for (const attribute of Object.values(mesh.attributes)) assert([...attribute.array].every(Number.isFinite));
  return volume;
}

function ray(geometry, from, direction) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld(); return new THREE.Raycaster(new THREE.Vector3(...from), new THREE.Vector3(...direction)).intersectObject(mesh);
}

test('hollow piston, relieved skirts and forged plates have closed outward surfaces with finite unit normals', () => {
  for (const geometry of [pistonCrownGeometry(), pistonSkirtGeometry(-P.skirtArc / 2), pistonSkirtGeometry(Math.PI - P.skirtArc / 2), rodBeamGeometry(), rodFlangeGeometry(), crankCheekGeometry()]) {
    surfaceAudit(geometry); geometry.dispose();
  }
});

test('actual piston crown respects the model envelope while its underside is hollow', () => {
  const geometry = pistonCrownGeometry();
  assert(Math.abs(geometry.boundingBox.max.y - GEOMETRY.pinToCrown) < 1e-8);
  assert(Math.max(Math.abs(geometry.boundingBox.min.x), geometry.boundingBox.max.x) < GEOMETRY.bore / 2);
  const fromUnder = ray(geometry, [0, -.02, 0], [0, 1, 0]);
  assert(Math.abs(fromUnder[0].point.y - P.undersideY) < 1e-8, 'no solid piston interior below the crown');
  const centreCrown = ray(geometry, [0, .04, 0], [0, -1, 0]);
  assert(centreCrown[0].point.y < GEOMETRY.pinToCrown, 'shallow crown bowl remains below rim datum');
  const ringCrown = ray(geometry, [.035, .04, 0], [0, -1, 0]);
  assert(Math.abs(ringCrown[0].point.y - GEOMETRY.pinToCrown) < 1e-8);
});

test('three ring slots have radial roots, side clearance and staggered end gaps', () => {
  const geometry = pistonCrownGeometry();
  for (const ring of P.rings) {
    const hit = ray(geometry, [.06, ring.y, 0], [-1, 0, 0])[0];
    assert(Math.abs(hit.point.x - ring.grooveRadius) < 1e-8, 'actual rendered groove root');
    assert(ring.grooveWidth > ring.width);
    assert(.0418 > ring.grooveRadius, 'radial back clearance');
    assert(.0428 < GEOMETRY.bore / 2, 'ring remains inside cylinder bore');
    for (const other of P.rings.filter(other => other !== ring)) assert(Math.abs(other.phase - ring.phase) > 1, 'visible gaps are not artificially aligned');
  }
  assert(Math.abs(ray(geometry, [.06, .0155, 0], [-1, 0, 0])[0].point.x - P.outerRadius) < 1e-8, 'lands retain full piston diameter');
});

test('thrust skirts leave both pin windows open and retain clearance to pin bosses', () => {
  const skirts = [pistonSkirtGeometry(-P.skirtArc / 2), pistonSkirtGeometry(Math.PI - P.skirtArc / 2)];
  assert.equal(skirts.flatMap(geometry => ray(geometry, [0, 0, -.08], [0, 0, 1])).length, 0, 'Z-directed pin can pass through both skirt reliefs');
  assert(ray(skirts[0], [.07, -.01, 0], [-1, 0, 0]).length > 0, 'positive-X thrust face exists');
  assert(ray(skirts[1], [-.07, -.01, 0], [1, 0, 0]).length > 0, 'negative-X thrust face exists');
  assert(P.pinBossInnerRadius > P.pinRadius);
  assert(2 * (P.pinBossZ - P.pinBossWidth / 2) > .014, 'small rod end fits between the two bosses');
});

test('tapered I section and bevels leave both bearing passages open without widening crank cheeks', () => {
  for (const geometry of [rodBeamGeometry(), rodFlangeGeometry()]) {
    for (const y of [0, GEOMETRY.rodLength]) {
      for (const offset of [-.0098, 0, .0098]) assert.equal(ray(geometry, [0, y + offset, -.05], [0, 0, 1]).length, 0, 'web/flanges do not occlude bearing bore');
    }
  }
  const cheek = crankCheekGeometry();
  assert(Math.abs(cheek.boundingBox.max.z - cheek.boundingBox.min.z - .014) < 1e-8);
  assert(cheek.boundingBox.min.y > -.051 && cheek.boundingBox.max.y < .062, 'retains previous rotating clearance envelope');
});

test('machined and cast finishes use bounded mipmapped texture samples and deterministic disposal-ready textures', () => {
  for (const kind of ['turned', 'linear', 'cast']) {
    const first = metalFinishTexture(kind), second = metalFinishTexture(kind);
    assert.equal(first.image.width, 512); assert.equal(first.image.height, 512);
    assert.deepEqual(first.image.data, second.image.data, 'repeatable appearance without time-driven noise');
    assert.equal(first.minFilter, THREE.LinearMipmapLinearFilter); assert(first.generateMipmaps);
    const values = first.image.data.filter((_, i) => i % 4 === 0);
    assert(values.every(value => value >= 100 && value <= 155), 'subtle height variation rather than coarse ridges');
    first.dispose(); second.dispose();
  }
});

test('turned annuli smooth the bore and outer wall while preserving axial and cut face normals', () => {
  const geometry = annulus(.0101, .014, .012, .23, 4.7, 48), p = geometry.attributes.position, n = geometry.attributes.normal;
  let bores = 0, outers = 0, faces = 0, cuts = 0;
  for (let i = 0; i < p.count; i += 3) {
    const radii = [0, 1, 2].map(j => Math.hypot(p.getX(i + j), p.getY(i + j)));
    if (Math.abs(n.getZ(i)) > .9) {
      faces++; for (let j = 0; j < 3; j++) assert(Math.abs(n.getX(i + j)) + Math.abs(n.getY(i + j)) < 1e-8);
    } else if (Math.max(...radii) - Math.min(...radii) < 1e-8) {
      const sign = radii[0] < .012 ? -1 : 1; if (sign < 0) bores++; else outers++;
      for (let j = 0; j < 3; j++) {
        assert(Math.abs(n.getX(i + j) - sign * p.getX(i + j) / radii[j]) < 1e-6);
        assert(Math.abs(n.getY(i + j) - sign * p.getY(i + j) / radii[j]) < 1e-6);
      }
    } else {
      cuts++; for (let j = 1; j < 3; j++) assert(new THREE.Vector3().fromBufferAttribute(n, i).distanceTo(new THREE.Vector3().fromBufferAttribute(n, i + j)) < 1e-8);
    }
  }
  assert(bores > 0 && outers > 0 && faces > 0 && cuts > 0);
});
