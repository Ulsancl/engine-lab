import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { sampleEngine, GEOMETRY, FIRING_PHASES, camSupport } from '../src/model.js';
import { SCENE_DIMENSIONS as D, OIL_PUMP_GEOMETRY, oilCircuitPaths, crankOilPassage, valveGeometry, camOutline, camContact, createCamGeometry, annulus, sprocketGeometry, timingPath, layoutLabels, visibleMeshCorners, fitEngineCamera } from '../src/scene-geometry.js';

test('scene physical dimensions match the model contract', () => {
  for (const key of ['bore', 'cylinderPitch', 'valveTilt', 'valveSeatY', 'valveSeatX', 'valvePairZ', 'camBaseRadius', 'followerRadius']) assert.equal(D[key], GEOMETRY[key], key);
  assert.equal(D.camStemOffset, GEOMETRY.camSeatDistance);
});

test('cam contact matches all cylinders and both advance limits over a complete cycle', () => {
  for (const advance of [-10, 0, 10]) for (let degrees = 0; degrees <= 720; degrees += 2) {
    const state = sampleEngine(degrees * Math.PI / 180, { intakeAdvanceRad: advance * Math.PI / 180 });
    state.cylinders.forEach((cylinder, index) => {
      for (const kind of ['intake', 'exhaust']) {
        const contact = camContact(kind, state.camAngles[kind], index, cylinder.pistonPin.z);
        assert.ok(Math.abs(contact.lift - cylinder.valveLifts[kind]) < 1e-12);
        const dot = contact.point.reduce((sum, value, axis) => sum + (value - contact.followerFace[axis]) * contact.n[axis], 0);
        assert.ok(Math.abs(dot) < 1e-12, 'contact lies on the moving flat follower plane');
        const lateral = Math.hypot(...contact.point.map((value, axis) => value - contact.followerFace[axis]));
        assert.ok(lateral < D.followerRadius, 'contact remains inside the follower disk');
        assert.ok(Math.hypot(lateral, D.camLobeWidth / 2) < D.followerRadius, 'entire finite-width lobe contact line fits the circular follower');
      }
    });
  }
});

test('convex cam mesh stays below its analytic follower plane', () => {
  for (const kind of ['intake', 'exhaust']) {
    const points = camOutline(kind, 720);
    for (let index = 0; index < 360; index++) {
      const phi = index * Math.PI / 180, { h, ddh } = camSupport(kind, phi);
      assert.ok(h + ddh > .0065, 'positive radius of curvature');
      const projection = Math.max(...points.map(([x, y]) => x * Math.cos(phi) + y * Math.sin(phi)));
      assert.ok(projection <= h + 1e-12); assert.ok(h - projection < .000001, 'polygon contact error below one micrometre at sampled normals');
    }
  }
});

test('valve heads fit bore and avoid the conservative TDC piston envelope', () => {
  for (const kind of ['intake', 'exhaust']) for (const pair of [-1, 1]) {
    const valve = valveGeometry(kind, 0, pair);
    assert.ok(Math.hypot(valve.seat[0], valve.seat[2]) + D.valveHeadRadius < GEOMETRY.bore / 2);
    const lowestHead = valve.seat[1] - GEOMETRY.valveMaxLift * valve.n[1] - D.valveHeadRadius * Math.sin(D.valveTilt);
    const highestCrown = GEOMETRY.stroke / 2 + GEOMETRY.rodLength + GEOMETRY.pinToCrown;
    assert.ok(lowestHead - highestCrown > .0035);
  }
  const centers = [valveGeometry('intake').center, valveGeometry('exhaust').center];
  assert.ok(centers[1][0] - centers[0][0] - 2 * (D.camBaseRadius + GEOMETRY.valveMaxLift) > .011);
});

test('generated section and cam geometries have finite positions and normals', () => {
  for (const geometry of [createCamGeometry('intake'), createCamGeometry('exhaust'), annulus(.043, .0485, .116, Math.PI / 2, Math.PI), sprocketGeometry(36, .0415, .007)]) {
    for (const attribute of ['position', 'normal']) assert.ok([...geometry.attributes[attribute].array].every(Number.isFinite));
    assert.ok(geometry.attributes.position.count > 100); geometry.dispose();
  }
});

test('timing route is closed and includes both cam shafts and crank drive', () => {
  const route = timingPath(); assert.ok(route.total > .6 && route.total < 1);
  assert.deepEqual(route.sample(0), route.sample(route.total));
  const points = Array.from({ length: 500 }, (_, index) => route.sample(route.total * index / 500));
  assert.ok(Math.min(...points.map(point => point.y)) < -.020);
  assert.ok(Math.max(...points.map(point => point.y)) > .326);
  assert.ok(Math.max(...points.map(point => point.x)) > .083);
});

test('labels keep selected part, remain inside the viewport, and do not collide', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({ id: String(index), x: index % 2 ? 100 : 650, y: 140, priority: index, selected: index === 29 }));
  const labels = layoutLabels(candidates, 800, 420); assert.ok(labels.some(label => label.id === '29'));
  for (const label of labels) { assert.ok(label.left >= 0 && label.left + label.width <= 800); assert.ok(label.top >= 0 && label.top + 27 <= 420); }
  for (const left of [12, 800 - 132 - 12]) {
    const column = labels.filter(label => label.left === left).sort((a, b) => a.top - b.top);
    for (let index = 1; index < column.length; index++) assert.ok(column[index].top - column[index - 1].top >= 32);
  }
});

test('both label columns reserve the caption above y=60 even for high anchors', () => {
  for (const [width, height] of [[800, 420], [390, 320]]) {
    const candidates = Array.from({ length: 24 }, (_, index) => ({ id: String(index), x: index % 2 ? 10 : width - 10, y: -200, priority: index, selected: index === 23 }));
    const labels = layoutLabels(candidates, width, height);
    assert.ok(labels.some(label => label.left === 12)); assert.ok(labels.some(label => label.left > width / 2));
    for (const label of labels) assert.ok(label.top >= 60, 'caption reserved on both sides');
    assert.ok(labels.some(label => label.id === '23'));
  }
});

test('preset fitting includes visible exploded parts and chain instances, excluding hidden meshes', () => {
  const root = new THREE.Group(), material = new THREE.MeshBasicMaterial();
  const addBox = (size, position, parent = root) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material); mesh.position.set(...position); parent.add(mesh); return mesh; };
  // A disassembled cylinder's head, liner, crank, and offset piston span its true size.
  addBox([.159, .025, .12], [0, .44, .052]); addBox([.095, .116, .095], [-.04, .157, .052]);
  addBox([.10, .15, .32], [0, -.005, -.04]); addBox([.086, .048, .085], [.065, .13, .052]);
  const hidden = new THREE.Group(); hidden.visible = false; root.add(hidden); addBox([30, 30, 30], [20, 20, 20], hidden);
  const links = new THREE.InstancedMesh(new THREE.BoxGeometry(.006, .003, .012), material, 3); root.add(links);
  [[-.084, .31, -.29], [.084, .327, -.29], [0, -.025, -.29]].forEach((point, index) => links.setMatrixAt(index, new THREE.Matrix4().makeTranslation(...point)));
  const points = visibleMeshCorners(root); assert.equal(points.length, 7 * 8);
  assert.ok(Math.min(...points.map(point => point.z)) <= -.295); assert.ok(Math.max(...points.map(point => point.x)) < 1);
  for (const aspect of [.45, 1, 1.85]) for (const direction of [new THREE.Vector3(1, .13, -.015), new THREE.Vector3(.03, .17, -1), new THREE.Vector3(.88, .54, -.91)]) {
    const camera = new THREE.PerspectiveCamera(37, aspect, .005, 12), fit = fitEngineCamera(camera, root, { aspect, direction });
    assert.ok(fit.distance >= .17 && fit.distance <= 2.7);
    for (const point of points) { const projected = point.clone().project(camera); assert.ok(Math.abs(projected.x) <= .84 + 1e-9); assert.ok(Math.abs(projected.y) <= .78 + 1e-9); assert.ok(projected.z > -1 && projected.z < 1); }
    assert.ok(fit.projectedBounds.top <= .78 + 1e-9 && fit.projectedBounds.bottom >= -.78 - 1e-9);
  }
  root.traverse(node => node.geometry?.dispose()); material.dispose();
});

test('oil supply joins the pump, filter, every end bearing, and both cam galleries', () => {
  for (const [first, last] of [[0, 4], [0, 1], [1, 2], [2, 3], [3, 4]]) {
    const paths = oilCircuitPaths(first, last), byId = new Map(paths.map(path => [path.id, path]));
    const endpoint = id => byId.get(id).points.at(-1), start = id => byId.get(id).points[0];
    assert.deepEqual(endpoint('pickup-pump'), [...OIL_PUMP_GEOMETRY.inlet]);
    assert.deepEqual(endpoint('pickup-pump'), start('pump-internal')); assert.deepEqual(endpoint('pump-internal'), start('pump-filter')); assert.deepEqual(endpoint('pump-filter'), start('filter-gallery'));
    const onSegment = (point, a, b) => {
      const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b), vp = new THREE.Vector3(...point), segment = new THREE.Line3(va, vb);
      assert.ok(segment.closestPointToPoint(vp, true, new THREE.Vector3()).distanceTo(vp) < 1e-12, 'branch is actually connected to its parent gallery');
    };
    onSegment(endpoint('filter-gallery'), start('main-gallery'), endpoint('main-gallery'));
    for (let station = first; station <= last; station++) {
      const z = -.208 + station * GEOMETRY.cylinderPitch;
      onSegment(start(`main-bearing-${station + 1}`), start('main-gallery'), endpoint('main-gallery'));
      assert.deepEqual(endpoint(`main-bearing-${station + 1}`), [0, 0, z]);
      for (const kind of ['intake', 'exhaust']) {
        assert.deepEqual(start(`${kind}-head-feed`), endpoint('main-gallery'));
        assert.deepEqual(endpoint(`${kind}-head-feed`), start(`${kind}-gallery`));
        onSegment(start(`${kind}-bearing-${station + 1}`), start(`${kind}-gallery`), endpoint(`${kind}-gallery`));
        const center = valveGeometry(kind).center; assert.deepEqual(endpoint(`${kind}-bearing-${station + 1}`), [center[0], center[1], z]);
      }
    }
    const mainBranches = paths.filter(path => /^main-bearing-/.test(path.id)); assert.equal(mainBranches.length, last - first + 1);
  }
});

test('direct-drive oil pump is coaxial with crank and crank drillings follow each rod journal', () => {
  assert.equal(OIL_PUMP_GEOMETRY.axis[0], 0); assert.equal(OIL_PUMP_GEOMETRY.axis[1], 0);
  assert.ok(OIL_PUMP_GEOMETRY.axis[2] >= -.247 && OIL_PUMP_GEOMETRY.axis[2] <= .247);
  for (let degrees = 0; degrees <= 720; degrees += 15) {
    const angle = degrees * Math.PI / 180, state = sampleEngine(angle);
    state.cylinders.forEach((cylinder, index) => {
      const passage = crankOilPassage(index), transform = new THREE.Matrix4().makeRotationZ(-angle + FIRING_PHASES[index]);
      const end = new THREE.Vector3(...passage.at(-1)).applyMatrix4(transform), start = new THREE.Vector3(...passage[0]).applyMatrix4(transform);
      assert.ok(end.distanceTo(new THREE.Vector3(cylinder.crankPin.x, cylinder.crankPin.y, cylinder.crankPin.z)) < 1e-12);
      assert.ok(Math.hypot(start.x, start.y) < 1e-12); assert.ok(Math.abs(start.z - (-.208 + index * .104)) < 1e-12);
    });
  }
});
