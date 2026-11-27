import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FIRING_PHASES, GEOMETRY, normalizeSettings } from './model.js';
import { SCENE_DIMENSIONS as D, OIL_PUMP_GEOMETRY, oilCircuitPaths, crankOilPassage, valveGeometry, createCamGeometry, annulus, sprocketGeometry, timingPath, layoutLabels, fitEngineCamera } from './scene-geometry.js';
import { PISTON_DETAIL, pistonCrownGeometry, pistonSkirtGeometry, beveledPlate, rodBeamGeometry, rodFlangeGeometry, crankCheekGeometry, metalFinishTexture } from './mechanical-geometry.js';
import { linerGeometry, honingTexture, blockDeckGeometry, headDeckGeometry, portFlangeGeometry, portShellGeometry, valveFaceGeometry, valveSeatGeometry, hardenedJournalGeometry, boltGeometry, chainPlateGeometry } from './apparatus-geometry.js';
import './scene.css';

const TAU = Math.PI * 2;
const vec = values => new THREE.Vector3(...values);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const STAGE_BACKDROP = '#18242e';
const COMPACT_SCENE_WIDTH = 600;
const DEFAULT_VIEW = { cylinderMode: 'all', selectedCylinder: 1, mode: 'cutaway', explode: .35, labels: true, layers: { block: true, head: true, timing: true, lubrication: false }, selectedPart: 'c1-piston' };
const STROKES = { power: ['팽창', 0xefb56e], exhaust: ['배기', 0xd88073], intake: ['흡기', 0x63c6df], compression: ['압축', 0xb4a0dd] };
const PORT_COLORS = { intake: 0x69deff, exhaust: 0xff9b76 };
const SPRING_BOTTOM = .013;
const SPRING_HEIGHT = .013;
const CHAMBER_ROOF = .218;

export class EngineScene {
  constructor(container, { onSelect = () => {} } = {}) {
    this.container = container; this.onSelect = onSelect; this.view = { ...DEFAULT_VIEW, layers: { ...DEFAULT_VIEW.layers } };
    this.components = new Map(); this.cylinders = []; this.staticMeshes = []; this.materials = new Set(); this.geometries = new Set(); this.textures = new Set(); this.highlighted = []; this.disposed = false;
    container.classList.add('engine-scene');
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(STAGE_BACKDROP);
    this.scene.fog = new THREE.Fog(STAGE_BACKDROP, 1.2, 3.4);
    this.camera = new THREE.PerspectiveCamera(37, 1, .005, 12);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.04;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label', '회전하고 부품을 선택할 수 있는 4행정 엔진 3D 구조');
    container.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = true; this.controls.dampingFactor = .11;
    this.controls.minDistance = .17; this.controls.maxDistance = 2.7; this.controls.maxPolarAngle = Math.PI; this.controls.zoomSpeed = .7; this.controls.panSpeed = .65;
    this.controls.addEventListener('change', () => { this.needsRender = true; });
    const environment = new RoomEnvironment(); const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(environment, .025); this.scene.environment = this.environment.texture; environment.dispose(); pmrem.dispose();
    this.scene.environmentIntensity = .76;
    this.scene.add(new THREE.HemisphereLight(0xc7e6ff, 0x263344, .76));
    const key = new THREE.DirectionalLight(0xffead1, 2.9); key.position.set(.43, 1.3, -.64); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -.65; key.shadow.camera.right = .65; key.shadow.camera.top = .65; key.shadow.camera.bottom = -.65;
    key.shadow.camera.near = .1; key.shadow.camera.far = 3; key.shadow.bias = -.0002; key.shadow.normalBias = .001;
    this.scene.add(key); const rim = new THREE.DirectionalLight(0x86b8d9, 1.5); rim.position.set(-.7, .5, .8); this.scene.add(rim);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.createMaterials(); this.buildEngine(); this.buildStage(); this.buildOverlay();
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.pointerDown = event => {
      this.down = event.isPrimary && event.button === 0 ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
    };
    this.pointerUp = event => this.pick(event);
    this.pointerCancel = () => { this.down = null; };
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown); this.renderer.domElement.addEventListener('pointerup', this.pointerUp);
    this.renderer.domElement.addEventListener('pointercancel', this.pointerCancel);
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container); this.resize(); this.setCameraPreset('iso');
    this.needsRender = true; this.frame = requestAnimationFrame(() => this.animate());
  }

  material(parameters) { const material = new THREE.MeshStandardMaterial(parameters); this.materials.add(material); return material; }
  createMaterials() {
    const finish = kind => { const texture = metalFinishTexture(kind); texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy()); this.textures.add(texture); return texture; };
    const turned = finish('turned'), linear = finish('linear'), cast = finish('cast');
    const hone = honingTexture(); hone.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy()); this.textures.add(hone);
    this.mat = {
      aluminum: this.material({ color: '#b3bdc3', metalness: .88, roughness: .3, bumpMap: linear, bumpScale: .000035 }),
      turned: this.material({ color: '#c3cbd0', metalness: .9, roughness: .27, bumpMap: turned, bumpScale: .000035 }),
      cast: this.material({ color: '#737f88', metalness: .72, roughness: .57, bumpMap: cast, bumpScale: .000085 }),
      steel: this.material({ color: '#9aa9b4', metalness: .96, roughness: .23 }),
      darkSteel: this.material({ color: '#43525b', metalness: .91, roughness: .3 }),
      polished: this.material({ color: '#d4e0e5', metalness: .98, roughness: .15 }),
      bronze: this.material({ color: '#b4a17c', metalness: .86, roughness: .3 }),
      black: this.material({ color: '#202c34', metalness: .35, roughness: .56 }),
      cut: this.material({ color: '#c8b693', metalness: .63, roughness: .36 }),
      section: this.material({ color: '#a9bfcb', metalness: .48, roughness: .48, emissive: '#466978', emissiveIntensity: .16 }),
      honed: this.material({ color: '#87999e', metalness: .74, roughness: .53, map: hone, bumpMap: hone, bumpScale: .00025, roughnessMap: hone }),
      intake: this.material({ color: '#549cac', metalness: .65, roughness: .32 }),
      exhaust: this.material({ color: '#9c8070', metalness: .83, roughness: .4 }),
      oil: this.material({ color: '#eea82a', emissive: '#ac6711', emissiveIntensity: .42, metalness: .3, roughness: .24, transparent: true, opacity: .55, depthWrite: false, depthTest: false }),
      oilMarker: this.material({ color: '#ffe8a1', emissive: '#ffc15d', emissiveIntensity: .86, metalness: .1, roughness: .32, transparent: true, opacity: .88, depthWrite: false, depthTest: false }),
      ceramic: this.material({ color: '#efebe0', metalness: .05, roughness: .27 }),
      transparent: this.material({ color: '#87aabc', metalness: .28, roughness: .36, transparent: true, opacity: .12, depthWrite: false, side: THREE.DoubleSide }),
    };
    this.fastenerGeometry = boltGeometry();
    this.fastenerMaterials = [this.mat.steel, this.mat.darkSteel, this.mat.turned];
    this.linerGeometries = [linerGeometry(false), linerGeometry(true)];
    this.deckGeometries = [blockDeckGeometry(false), blockDeckGeometry(true)];
    this.headDeckGeometries = [headDeckGeometry(false), headDeckGeometry(true)];
    this.portFlangeGeometry = portFlangeGeometry();
    this.portShellGeometries = new Map();
    this.valveFaceGeometry = valveFaceGeometry();
    this.valveSeatGeometry = valveSeatGeometry();
    this.camProfiles = { intake: createCamGeometry('intake'), exhaust: createCamGeometry('exhaust') };
    this.intakeProfile = this.intakeProfileKey({});
    this.crankPinGeometry = hardenedJournalGeometry(.0133, .026);
    this.mainJournalGeometry = hardenedJournalGeometry(.022, .027);
    this.cheekGeometry = crankCheekGeometry();
    this.chamberGeometry = new THREE.CylinderGeometry(.0408, .0408, 1, 52, 1, true);
    this.curtainGeometry = new THREE.CylinderGeometry(.01065, .01065, 1, 36, 1, true);
    this.gasMarkerGeometry = new THREE.SphereGeometry(.0027, 10, 8);
  }
  mesh(geometry, material, parent, position = null) {
    this.geometries.add(geometry); const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = !material.transparent; mesh.receiveShadow = true;
    if (position) mesh.position.set(...position); parent.add(mesh); return mesh;
  }
  box(size, material, parent, position) { return this.mesh(new THREE.BoxGeometry(...size), material, parent, position); }
  cylinder(radius, length, material, parent, position, axis = 'y', segments = 48) {
    const mesh = this.mesh(new THREE.CylinderGeometry(radius, radius, length, segments), material, parent, position);
    if (axis === 'z') mesh.rotation.x = Math.PI / 2; if (axis === 'x') mesh.rotation.z = Math.PI / 2; return mesh;
  }
  rodBetween(a, b, radius, material, parent, segments = 16) {
    const start = vec(a), end = vec(b), delta = end.clone().sub(start);
    const mesh = this.mesh(new THREE.CylinderGeometry(radius, radius, delta.length(), segments), material, parent);
    mesh.position.copy(start.add(end).multiplyScalar(.5)); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); return mesh;
  }
  tube(points, radius, material, parent, smooth = true) {
    const curve = smooth ? new THREE.CatmullRomCurve3(points.map(vec)) : new THREE.CurvePath();
    if (!smooth) for (let index = 1; index < points.length; index++) curve.add(new THREE.LineCurve3(vec(points[index - 1]), vec(points[index])));
    const mesh = this.mesh(new THREE.TubeGeometry(curve, 40, radius, 8, false), material, parent); return { mesh, curve };
  }
  part(id, name, description, material, parent = this.root, cylinder = null, anchor = [0, 0, 0], priority = 9) {
    const node = new THREE.Group(); node.name = id; node.userData.partId = id; parent.add(node);
    const component = { id, name, description, material, node, cylinder, anchor: vec(anchor), priority };
    this.components.set(id, component); return node;
  }
  ring(inner, outer, width, material, parent, position, axis = 'z', start = 0, length = TAU) {
    const mesh = this.mesh(annulus(inner, outer, width, start, length), material, parent, position); if (axis === 'y') mesh.rotation.x = Math.PI / 2; return mesh;
  }
  bolt(parent, position, axis = 'y', scale = 1) {
    const head = this.mesh(this.fastenerGeometry, this.fastenerMaterials, parent, position);
    head.scale.setScalar(scale);
    if (axis === 'z') head.rotation.x = Math.sign(position[2]) * Math.PI / 2;
    if (axis === 'x') head.rotation.z = -Math.sign(position[0]) * Math.PI / 2;
    if (axis === 'y' && position[1] < 0) head.rotation.x = Math.PI;
    return head;
  }
  intakeProfileKey(settings) {
    const { intakeDurationRad, intakeMaxLiftM } = normalizeSettings(settings);
    return `${intakeDurationRad ?? 'default'}:${intakeMaxLiftM ?? 'default'}`;
  }
  updateIntakeProfile(settings) {
    const key = this.intakeProfileKey(settings);
    if (key === this.intakeProfile) return;
    const previous = this.camProfiles.intake;
    const geometry = createCamGeometry('intake', settings);
    this.camProfiles.intake = geometry;
    this.intakeProfile = key;
    this.geometries.add(geometry);
    for (const lobe of this.cams.intake.lobes) lobe.mesh.geometry = geometry;
    this.geometries.delete(previous);
    previous.dispose();
  }
  buildHeadPod(parent, z, cut) {
    const head = new THREE.Group(), m = this.mat;
    head.position.z = z;
    parent.add(head);
    this.mesh(this.headDeckGeometries[Number(cut)], cut ? [m.cut, m.section] : [m.cut, m.cast], head, [0, CHAMBER_ROOF, 0]);
    for (const kind of ['intake', 'exhaust']) {
      const sign = kind === 'intake' ? -1 : 1;
      if (!cut || kind === 'intake') {
        this.mesh(this.portFlangeGeometry, [m.aluminum, m.cast], head, [sign * .075, .243, 0]);
        for (const zz of [-.036, 0, .036]) this.bolt(head, [sign * .079, .248, zz], 'x', .72);
      }
      for (const pair of [-1, 1]) {
        const { seat, n } = valveGeometry(kind, 0, 0);
        const bowl = vec(seat).addScaledVector(vec(n), .004);
        const truncated = cut && kind === 'exhaust';
        const key = `${kind}-${truncated}`;
        if (!this.portShellGeometries.has(key)) {
          const port = new THREE.CubicBezierCurve3(
            new THREE.Vector3(sign * (truncated ? .043 : .078), truncated ? .244 : .243, 0),
            new THREE.Vector3(sign * (truncated ? .037 : .049), .243, 0),
            bowl.clone().addScaledVector(vec(n), .007),
            bowl,
          );
          this.portShellGeometries.set(key, portShellGeometry(port));
        }
        this.mesh(this.portShellGeometries.get(key), [m.cast, m.aluminum], head, [0, 0, pair * D.valvePairZ]);
      }
    }
    return head;
  }
  buildValveFlow(kind, geometry, group, guide, pair) {
    const color = PORT_COLORS[kind], transparent = { color, emissive: color, transparent: true, depthWrite: false, side: THREE.DoubleSide };
    const gap = this.mesh(this.curtainGeometry, this.material({ ...transparent, opacity: .28, emissiveIntensity: .58 }), guide);
    gap.userData.ignorePick = true;
    const direction = Math.sign(geometry.seat[0]);
    const [x, y, z] = geometry.seat;
    const markerMaterial = this.material({ ...transparent, opacity: .65, emissiveIntensity: 1.35 });
    const markers = Array.from({ length: 3 }, () => {
      const mesh = this.mesh(this.gasMarkerGeometry, markerMaterial, group);
      mesh.userData.ignorePick = true;
      return mesh;
    });
    const route = new THREE.CatmullRomCurve3([
      new THREE.Vector3(direction * .085, .243, z),
      new THREE.Vector3(direction * .047, .243, z),
      new THREE.Vector3(x, y - .002, z + pair * .011),
      new THREE.Vector3(x * .78, y - .023, z + pair * .010),
    ]);
    return { gap, markers, route };
  }
  buildEngine() {
    const m = this.mat;
    this.block = this.part('block', '실린더 블록', '4개 실린더와 크랭크 지지부를 연결하는 주조 몸체입니다. 절개에서는 관찰면의 벽을 제거합니다.', '알루미늄 합금 · 주철 라이너', this.root, null, [-.061, .15, 0], 8);
    this.blockFull = new THREE.Group(); this.blockCut = new THREE.Group(); this.block.add(this.blockFull, this.blockCut);
    const sideWall = beveledPlate([
      [-.209, .105], [-.188, .096], [.189, .096], [.209, .108],
      [.211, .195], [.199, .208], [-.199, .208], [-.211, .195],
    ], .016, .0016);
    sideWall.rotateY(Math.PI / 2);
    const rib = beveledPlate([[.065, .111], [.071, .116], [.0694, .176], [.065, .183]], .018, .0007);
    for (const [shell, side] of [[this.blockCut, -1], [this.blockFull, -1], [this.blockFull, 1]]) {
      this.mesh(sideWall, [m.cast, m.aluminum], shell, [side * .059, 0, 0]);
      this.box([.018, .006, .413], m.cast, shell, [side * .061, .104, 0]);
      this.box([.012, .0035, .410], m.aluminum, shell, [side * .064, .198, 0]);
      for (let index = 0; index < 5; index++) {
        const stiffener = this.mesh(rib, m.cast, shell, [0, 0, (index - 2) * .102]);
        stiffener.rotation.y = side < 0 ? Math.PI : 0;
      }
    }
    for (let index = 0; index < 5; index++) {
      const z = -.208 + index * .104;
      this.box([.13, .008, .013], m.cast, this.blockCut, [0, .099, z]); this.box([.13, .008, .013], m.cast, this.blockFull, [0, .099, z]);
      this.box([.013, .106, .018], m.cast, this.blockCut, [-.059, .154, z]);
      this.bolt(this.blockCut, [-.058, .105, z]);
    }
    this.head = this.part('head', '실린더 헤드', '연소실 위에서 밸브 시트·가이드와 캠축 베어링을 지지합니다. 자체 제작한 대표 DOHC 형상입니다.', '알루미늄 합금', this.root, null, [-.056, .248, 0], 8);
    this.headFull = new THREE.Group(); this.headCut = new THREE.Group(); this.head.add(this.headFull, this.headCut);
    for (const z of [-.219, .219]) { this.box([.153, .038, .012], m.cast, this.headFull, [0, .251, z]); this.box([.081, .025, .012], m.cast, this.headCut, [-.033, .248, z]); }
    this.cover = this.part('cam-cover', '캠 커버', '캠축 위를 덮어 오일을 가두는 커버입니다. 절개에서는 내부를 관찰할 수 있도록 투명하게 표시합니다.', '알루미늄 합금 · 고무 개스킷', this.head, null, [0, .338, 0], 20);
    const coverOutline = [[-.060, -.223], [.060, -.223], [.079, -.207], [.079, .207], [.059, .223], [-.059, .223], [-.079, .207], [-.079, -.207]];
    const lid = beveledPlate(coverOutline, .019, .003); lid.rotateX(-Math.PI / 2);
    const flange = beveledPlate(coverOutline, .003, .0006); flange.rotateX(-Math.PI / 2);
    this.coverSolid = this.mesh(lid, m.cast, this.cover, [0, .336, 0]);
    this.mesh(flange, m.aluminum, this.coverSolid, [0, -.0098, 0]);
    this.coverGhost = this.mesh(lid, m.transparent, this.cover, [0, .336, 0]);
    const coverRib = beveledPlate([[-.007, -.195], [.007, -.195], [.007, .195], [-.007, .195]], .005, .0018);
    coverRib.rotateX(-Math.PI / 2);
    for (const x of [-.033, .033]) this.mesh(coverRib, [m.cast, m.aluminum], this.coverSolid, [x, .010, 0]);
    for (const x of [-.066, .066]) for (const z of [-.205, -.104, 0, .104, .205]) this.bolt(this.coverSolid, [x, .0115, z]);
    this.crank = this.part('crankshaft', '크랭크축', '크랭크 핀의 원운동과 커넥팅로드가 피스톤 왕복운동을 연결합니다. 1·4번과 2·3번 핀은 180° 차이입니다.', '단조 강철', this.root, null, [0, 0, -.025], 1);
    this.crankRotating = new THREE.Group(); this.crank.add(this.crankRotating);
    this.crankShaftMesh = this.cylinder(.015, .494, m.polished, this.crankRotating, [0, 0, 0], 'z');
    this.crankJournals = []; this.bearingSupports = [];
    for (let index = 0; index < 5; index++) {
      const z = -.208 + index * .104;
      const journal = new THREE.Group(); journal.position.z = z; this.crankRotating.add(journal); this.crankJournals.push(journal);
      this.mesh(this.mainJournalGeometry, [m.polished, m.turned], journal);
      if (index === 2) for (const side of [-1, 1]) this.ring(.022, .027, .0014, m.turned, journal, [0, 0, side * .0153]);
      const bearing = this.part(`main-bearing-${index + 1}`, `메인 베어링 ${index + 1}`, '위·아래로 분할된 미끄럼 베어링이 크랭크 저널을 감쌉니다. 위쪽 지지부는 블록에 연결되고 아래 캡은 볼트로 고정됩니다.', '다층 베어링 합금 · 강철', this.root, null, [.024, 0, z], 18);
      this.ring(.0223, .0254, .025, m.bronze, bearing, [0, 0, z], 'z', Math.PI, Math.PI);
      this.ring(.0223, .0254, .025, m.bronze, bearing, [0, 0, z], 'z', 0, Math.PI);
      const upperBody = this.ring(.0254, .034, .021, m.cast, bearing, [0, 0, z], 'z', 0, Math.PI);
      const backWeb = this.box([.053, .078, .021], m.cast, bearing, [-.0405, .060, z]);
      const frontWeb = this.box([.053, .078, .021], m.cast, bearing, [.0405, .060, z]);
      this.bearingSupports.push({ upperBody, backWeb, frontWeb });
      this.ring(.0254, .036, .029, m.cast, bearing, [0, 0, z], 'z', Math.PI, Math.PI);
      for (const x of [-.031, .031]) {
        this.mesh(beveledPlate([[x - .008, -.008], [x + .008, -.008], [x + .008, -.022], [x - .008, -.022]], .029), [m.steel, m.cast], bearing, [0, 0, z]);
        this.cylinder(.0022, .024, m.darkSteel, bearing, [x, -.012, z]); this.bolt(bearing, [x, -.025, z]);
      }
    }
    this.cams = {};
    for (const kind of ['intake', 'exhaust']) {
      const c = valveGeometry(kind).center;
      const group = this.part(`${kind}-camshaft`, kind === 'intake' ? '흡기 캠축' : '배기 캠축', '크랭크 2회전에 1회전합니다. 로브 외곽은 평면 팔로워와 닿도록 리프트 함수의 포락선으로 구성했습니다.', '표면 경화 강철', this.root, null, [c[0], c[1], -.1], 2);
      const shaft = this.cylinder(.009, .486, m.darkSteel, group, [c[0], c[1], 0], 'z');
      const lobes = [], supports = [];
      for (let index = 0; index < 5; index++) {
        const z = -.208 + index * .104;
        const support = new THREE.Group(); group.add(support); supports.push(support);
        this.ring(.0091, .013, .013, m.bronze, support, [c[0], c[1], z]);
        this.mesh(annulus(.013, .018, .018, 0, Math.PI), [m.aluminum, m.cast], support, [c[0], c[1], z]);
        const lowerSaddle = this.mesh(annulus(.013, .018, .018, Math.PI, Math.PI), m.cast, support, [c[0], c[1], z]); lowerSaddle.userData.headSupport = true;
        for (const offset of [-.022, .022]) { const pedestal = this.box([.012, .066, .018], m.cast, support, [c[0] + offset, .253, z]); pedestal.userData.headSupport = true; }
        for (const offset of [-.022, .022]) this.bolt(support, [c[0] + offset, c[1] + .003, z]);
      }
      this.cams[kind] = { group, lobes, center: c, shaft, supports };
    }
    for (let index = 0; index < 4; index++) this.buildCylinder(index);
    this.buildTiming(); this.buildOil(); this.buildFlywheel();
    this.root.traverse(node => { if (node.isMesh && !node.userData.partId) { let parent = node.parent; while (parent && !parent.userData.partId) parent = parent.parent; if (parent) node.userData.partId = parent.userData.partId; } });
  }

  buildCylinder(index) {
    const m = this.mat, number = index + 1, z = (index - 1.5) * .104;
    const group = new THREE.Group(); group.name = `cylinder-${number}`; this.root.add(group);
    const piston = this.part(`c${number}-piston`, `${number}번 피스톤`, '알루미늄 피스톤의 왕복 위치는 크랭크 반경과 로드 길이에서 계산합니다. 링과 핀은 각각 밀봉·연결을 담당합니다.', '알루미늄 합금', group, number, [.035, .022, 0], 0);
    const pistonBody = this.mesh(pistonCrownGeometry(), [m.turned, m.cast, m.aluminum], piston);
    for (const phase of [0, Math.PI]) this.mesh(pistonSkirtGeometry(phase - PISTON_DETAIL.skirtArc / 2), [m.turned, m.cast, m.aluminum], piston);
    for (const bossZ of [-PISTON_DETAIL.pinBossZ, PISTON_DETAIL.pinBossZ]) {
      this.ring(PISTON_DETAIL.pinBossInnerRadius, PISTON_DETAIL.pinBossOuterRadius, PISTON_DETAIL.pinBossWidth, m.aluminum, piston, [0, 0, bossZ]);
      // Upper ribs tie the pin bosses into the crown, leaving the pin bore open.
      for (const sign of [-1, 1]) this.mesh(beveledPlate([[sign * .010, .009], [sign * .020, .022], [sign * .007, .022], [sign * .004, .014]], .010, .0004), [m.aluminum, m.cast], piston, [0, 0, bossZ]);
    }
    const rings = this.part(`c${number}-rings`, `${number}번 피스톤 링`, '두 압축 링과 오일 제어 링을 대표합니다. 작은 링 끝 간극을 두어 피스톤 둘레의 별도 부품으로 표시했습니다.', '합금 주철 · 강철', piston, number, [.041, .015, 0], 13);
    for (const ring of PISTON_DETAIL.rings) this.ring(.0418, .0428, ring.width, m.darkSteel, rings, [0, ring.y, 0], 'y', ring.phase + ring.gapAngle / 2, TAU - ring.gapAngle);
    const pin = this.part(`c${number}-pin`, `${number}번 피스톤 핀`, '피스톤과 로드 작은 끝을 연결하는 중공 강철 핀입니다.', '경화 강철', piston, number, [0, 0, -.034], 16);
    const pinMesh = this.ring(.007, .010, .074, m.polished, pin, [0, 0, 0]);
    const rod = this.part(`c${number}-rod`, `${number}번 커넥팅로드`, '큰 끝과 작은 끝의 중심 사이 길이는 143 mm로 고정됩니다. 핀 두 위치를 연결해 움직입니다.', '단조 강철', group, number, [0, .070, 0], 1);
    const rodSmallEnd = this.ring(.0103, .016, .014, m.steel, rod, [0, .143, 0]);
    this.ring(.0101, .0112, .0142, m.bronze, rod, [0, .143, 0]);
    // Distinct cap halves expose the split plane and retain a continuous journal
    // passage. The brass shell spans the split without changing the 143 mm centres.
    this.ring(.014, .024, .020, m.steel, rod, [0, 0, 0], 'z', .006, Math.PI - .012);
    this.ring(.014, .024, .020, m.darkSteel, rod, [0, 0, 0], 'z', Math.PI + .006, Math.PI - .012);
    const rodBigEnd = this.ring(.0134, .0141, .018, m.bronze, rod, [0, 0, 0]);
    this.mesh(rodBeamGeometry(), [m.steel, m.darkSteel], rod);
    for (const zz of [-.0044, .0044]) this.mesh(rodFlangeGeometry(), [m.steel, m.darkSteel], rod, [0, 0, zz]);
    for (const xx of [-.022, .022]) {
      this.mesh(beveledPlate([[xx - .004, -.009], [xx + .004, -.009], [xx + .004, .008], [xx - .004, .008]], .016, .0004), [m.steel, m.darkSteel], rod);
      this.cylinder(.0019, .023, m.polished, rod, [xx, .001, 0]); this.bolt(rod, [xx, -.012, 0], 'y', .8);
    }
    const crankThrow = new THREE.Group(); crankThrow.rotation.z = FIRING_PHASES[index]; this.crankRotating.add(crankThrow);
    const crankPinMesh = this.mesh(this.crankPinGeometry, [m.polished, m.turned], crankThrow, [0, .043, z]);
    for (const zz of [z - .021, z + .021]) {
      this.mesh(this.cheekGeometry, [m.turned, m.darkSteel], crankThrow, [0, 0, zz]);
    }
    const crankOil = this.tube(crankOilPassage(index), .00135, m.oil, crankThrow, false).mesh; crankOil.userData.partId = 'oil-gallery'; crankOil.renderOrder = 4;
    const liner = this.part(`c${number}-liner`, `${number}번 실린더 라이너`, '피스톤이 왕복하는 원통면입니다. 절개에서는 절반을 제거하고 절단면을 밝게 표시합니다.', '내마모 주철', group, number, [-.043, .168, z], 14);
    const linerFull = this.mesh(this.linerGeometries[0], [m.cut, m.honed, m.cast], liner, [0, .157, z]);
    const linerCut = this.mesh(this.linerGeometries[1], [m.section, m.honed, m.cast], liner, [0, .157, z]);
    const blockDeck = new THREE.Group(); this.block.add(blockDeck); blockDeck.position.z = z;
    const decks = [false, true].map(cut => {
      const deck = new THREE.Group(); blockDeck.add(deck);
      this.mesh(this.deckGeometries[Number(cut)], [m.aluminum, cut ? m.section : m.cast], deck, [0, GEOMETRY.deckY - .009, 0]);
      for (const x of cut ? [-.057] : [-.057, .057]) {
        this.ring(.0038, .0058, .0013, m.turned, deck, [x, GEOMETRY.deckY + .0002, .041], 'y');
        this.ring(.0035, .0048, .001, m.darkSteel, deck, [x, GEOMETRY.deckY - .0004, -.023], 'y');
      }
      return deck;
    });
    const headRingFull = this.buildHeadPod(this.headFull, z, false);
    const headRingCut = this.buildHeadPod(this.headCut, z, true);
    headRingFull.userData.cylinder = number; headRingCut.userData.cylinder = number;
    const valves = {};
    for (const kind of ['intake', 'exhaust']) {
      const valveGroup = this.part(`c${number}-${kind}-valves`, `${number}번 ${kind === 'intake' ? '흡기' : '배기'} 밸브`, '기울어진 두 밸브가 캠 리프트와 같은 거리로 축을 따라 열립니다. 캠·평면 팔로워·스프링을 한 연결로 볼 수 있습니다.', '내열 강철 · 스프링 강철', group, number, [kind === 'intake' ? -.027 : .027, .25, z], 3);
      const instances = [];
      for (const pair of [-1, 1]) {
        const geometry = valveGeometry(kind, z, pair), n = vec(geometry.n);
        const moving = new THREE.Group(); moving.position.copy(vec(geometry.seat)); moving.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n); valveGroup.add(moving);
        this.mesh(this.valveFaceGeometry, [m.turned, m.steel], moving);
        this.cylinder(.00245, .026, m.polished, moving, [0, .019, 0]);
        this.cylinder(.011, .004, m.polished, moving, [0, .032, 0]);
        this.ring(.0025, .0084, .002, m.darkSteel, moving, [0, .027, 0], 'y');
        this.ring(.0025, .0042, .0025, m.bronze, moving, [0, .029, 0], 'y');
        const guide = new THREE.Group(); guide.position.copy(vec(geometry.seat)); guide.quaternion.copy(moving.quaternion); valveGroup.add(guide);
        this.ring(.0027, .005, .015, m.bronze, guide, [0, .010, 0], 'y');
        this.mesh(this.valveSeatGeometry, [m.polished, m.bronze], guide);
        this.ring(.005, .0085, .0014, m.darkSteel, guide, [0, SPRING_BOTTOM - .0007, 0], 'y');
        const spring = new THREE.Group(); spring.position.copy(vec(geometry.seat)); spring.quaternion.copy(moving.quaternion); valveGroup.add(spring);
        const points = []; for (let step = 0; step <= 96; step++) { const angle = step / 96 * TAU * 5; points.push([Math.cos(angle) * .0068, step / 96 * SPRING_HEIGHT, Math.sin(angle) * .0068]); }
        const springCurve = new THREE.CatmullRomCurve3(points.map(vec)); const springMesh = this.mesh(new THREE.TubeGeometry(springCurve, 96, .00065, 6, false), m.steel, spring);
        const cam = this.mesh(this.camProfiles[kind], [m.turned, m.polished], this.cams[kind].group, geometry.center); cam.userData.cylinder = number;
        this.cams[kind].lobes.push({ mesh: cam, alpha: geometry.alpha, index });
        instances.push({ geometry, moving, guide, springMesh, flow: this.buildValveFlow(kind, geometry, valveGroup, guide, pair) });
      }
      valves[kind] = { group: valveGroup, instances };
    }
    const spark = this.part(`c${number}-spark-plug`, `${number}번 점화 플러그`, '압축 상사점 근처의 점화 위치를 표시합니다. 불빛은 행정 안내이며 연소 압력 계산이 아닙니다.', '세라믹 · 니켈 합금', group, number, [0, .277, z], 12);
    this.cylinder(.0045, .026, m.ceramic, spark, [0, .263, z]); this.cylinder(.006, .012, m.steel, spark, [0, .243, z], 'y', 6); this.cylinder(.003, .014, m.polished, spark, [0, .229, z]);
    this.cylinder(.0007, .004, m.steel, spark, [0, .220, z], 'y', 12);
    this.rodBetween([.0023, .222, z], [.0023, .2174, z], .00055, m.steel, spark, 8);
    this.rodBetween([.0023, .2174, z], [.0001, .2174, z], .00055, m.steel, spark, 8);
    for (let k = 0; k < 4; k++) this.cylinder(.0052, .0015, m.ceramic, spark, [0, .259 + k * .0035, z]);
    const flashMaterial = this.material({ color: '#ffcb81', emissive: '#ff8e31', emissiveIntensity: 2, transparent: true, opacity: .36, depthWrite: false });
    const flash = this.mesh(new THREE.SphereGeometry(.004, 16, 12), flashMaterial, spark, [0, .2177, z]); flash.userData.ignorePick = true;
    const gasMaterial = this.material({ color: '#69cbd5', emissive: '#69cbd5', emissiveIntensity: .08, transparent: true, opacity: .055, depthWrite: false, side: THREE.DoubleSide });
    const gas = this.mesh(this.chamberGeometry, gasMaterial, group, [0, .2, z]); gas.userData.ignorePick = true;
    this.cylinders.push({ number, z, group, piston, pistonBody, rings, pin, pinMesh, rod, rodSmallEnd, rodBigEnd, crankPinMesh, liner, linerFull, linerCut, valves, spark, flash, gas, headRingFull, headRingCut, blockDeck, decks, crankThrow, crankOil });
  }

  buildTiming() {
    const m = this.mat, z = -.239;
    this.timing = this.part('timing-chain', '타이밍 체인 · 2:1 구동', '크랭크 스프로킷 18개와 캠 스프로킷 36개의 톱니를 대표합니다. 체인은 같은 방향으로 구동하고 캠축은 크랭크 속도의 절반으로 회전합니다.', '강철 링크 · 경화 스프로킷', this.root, null, [.065, .17, z], 4);
    this.sprockets = [];
    for (const [kind, center, radius, teeth] of [['crank', [0, 0, z], .02075, 18], ['intake', [...this.cams.intake.center.slice(0, 2), z], .0415, 36], ['exhaust', [...this.cams.exhaust.center.slice(0, 2), z], .0415, 36]]) {
      const gear = new THREE.Group(); gear.position.set(...center); this.timing.add(gear);
      this.mesh(sprocketGeometry(teeth, radius, .007), [m.turned, m.steel], gear);
      this.ring(radius * .57, radius * .82, .0015, m.darkSteel, gear, [0, 0, -.0039]);
      this.ring(radius * .65, radius * .675, .001, m.turned, gear, [0, 0, -.0046]);
      const hub = new THREE.Group(); gear.add(hub);
      this.ring(radius * .21, radius * .53, .003, m.aluminum, hub, [0, 0, -.0044]);
      for (let k = 0; k < 6; k++) {
        const a = k / 6 * TAU, x = Math.cos(a) * radius * .40, y = Math.sin(a) * radius * .40;
        this.bolt(hub, [x, y, -.006], 'z', radius > .03 ? .52 : .32);
      }
      this.bolt(hub, [0, 0, -.0075], 'z', radius > .03 ? 1.6 : 1.15);
      this.box([radius * .045, radius * .11, .0008], m.bronze, gear, [0, radius * .76, -.0051]);
      if (kind === 'intake') this.box([radius * .043, radius * .10, .0009], m.polished, hub, [0, radius * .51, -.0061]);
      this.sprockets.push({ kind, gear, hub });
    }
    this.chainPath = timingPath(); this.chainCount = 2 * Math.ceil(this.chainPath.total / .014);
    const linkGeometry = chainPlateGeometry(); this.geometries.add(linkGeometry);
    this.chainLinks = new THREE.InstancedMesh(linkGeometry, m.darkSteel, this.chainCount * 2); this.chainLinks.castShadow = true; this.chainLinks.receiveShadow = true; this.chainLinks.userData.partId = 'timing-chain'; this.timing.add(this.chainLinks);
    const pinGeometry = new THREE.CylinderGeometry(.00125, .00125, .0096, 10); pinGeometry.rotateX(Math.PI / 2); this.geometries.add(pinGeometry);
    this.chainPins = new THREE.InstancedMesh(pinGeometry, m.turned, this.chainCount); this.chainPins.userData.partId = 'timing-chain'; this.timing.add(this.chainPins);
    const rollerGeometry = new THREE.CylinderGeometry(.00185, .00185, .0058, 12); rollerGeometry.rotateX(Math.PI / 2); this.geometries.add(rollerGeometry);
    this.chainRollers = new THREE.InstancedMesh(rollerGeometry, m.steel, this.chainCount); this.chainRollers.userData.partId = 'timing-chain'; this.timing.add(this.chainRollers);
    const plateColor = new THREE.Color();
    for (let index = 0; index < this.chainCount; index++) {
      plateColor.setHex(index % 2 === 0 ? 0xb2c3c9 : 0xf1f5f6);
      this.chainLinks.setColorAt(index * 2, plateColor); this.chainLinks.setColorAt(index * 2 + 1, plateColor);
    }
    this.chainDummy = new THREE.Object3D();
    this.guides = this.part('timing-guide', '체인 가이드 · 텐셔너', '긴 체인 구간의 경로를 안내하고 느슨함을 억제하는 대표 고정 가이드와 텐셔너입니다.', '강철 지지대 · 내열 수지', this.root, null, [-.071, .16, z], 17);
    this.tube([[-.036, .055, z], [-.055, .139, z], [-.069, .222, z]], .0041, m.black, this.guides);
    this.tube([[.036, .055, z], [.055, .139, z], [.069, .222, z]], .0041, m.black, this.guides);
    this.cylinder(.008, .027, m.steel, this.guides, [.064, .115, z], 'x');
    this.box([.017, .025, .019], m.cast, this.guides, [.084, .115, z]);
    for (const y of [.066, .212]) this.cylinder(.0035, .013, m.polished, this.guides, [-.046 - (y - .066) * .16, y, z], 'z', 6);
  }

  buildOil() {
    const m = this.mat;
    this.pan = this.part('oil-pan', '오일팬 · 흡입망', '오일을 모으는 하부 저장 공간입니다. 흡입망에서 펌프를 거쳐 필터와 베어링으로 이어지는 대표 경로를 볼 수 있습니다.', '주조 알루미늄 · 강철 망', this.root, null, [.06, -.067, .09], 11);
    this.panFull = new THREE.Group(); this.panCut = new THREE.Group(); this.pan.add(this.panFull, this.panCut);
    for (const parent of [this.panFull, this.panCut]) {
      this.box([.145, .007, .414], m.cast, parent, [0, -.09, 0]); this.box([.007, .048, .414], m.cast, parent, [-.069, -.066, 0]);
      this.box([.145, .005, .014], m.aluminum, parent, [0, -.039, -.207]); this.box([.145, .005, .014], m.aluminum, parent, [0, -.039, .207]);
      for (const z of [-.18, -.09, 0, .09, .18]) this.bolt(parent, [-.066, -.037, z]);
    }
    this.box([.007, .048, .414], m.cast, this.panFull, [.069, -.066, 0]);
    for (const z of [-.204, .204]) this.box([.135, .048, .007], m.cast, this.panFull, [0, -.066, z]);
    this.box([.12, .002, .38], this.material({ color: '#916221', roughness: .19, metalness: .38, transparent: true, opacity: .77 }), this.panCut, [0, -.077, 0]);
    const pump = OIL_PUMP_GEOMETRY;
    this.pump = this.part('oil-pump', '오일 펌프', '크랭크축 앞쪽과 같은 축에 연결된 직접 구동형 대표 펌프입니다. 축의 키가 로터를 함께 돌립니다. 유량·유압·펌프 내부의 치합은 해석하지 않습니다.', '알루미늄 몸체 · 강철 로터', this.root, null, [.030, -.014, -.228], 8);
    this.ring(.029, pump.housingRadius, .012, m.cast, this.pump, pump.axis);
    this.ring(pump.innerRadius, pump.housingRadius, .0025, m.cast, this.pump, [0, 0, -.2228]);
    this.pumpRotor = new THREE.Group(); this.pumpRotor.position.set(...pump.axis); this.pump.add(this.pumpRotor);
    this.mesh(sprocketGeometry(8, pump.rotorRadius, .007, pump.innerRadius), m.bronze, this.pumpRotor);
    this.ring(.015, .019, .010, m.steel, this.pumpRotor, [0, 0, 0]);
    this.box([.002, .004, .011], m.polished, this.pumpRotor, [.0152, 0, 0]);
    for (let index = 0; index < 4; index++) { const a = (index + .5) / 4 * TAU; this.bolt(this.pump, [.031 * Math.cos(a), .031 * Math.sin(a), -.235], 'z', .7); }
    this.tube([[...pump.inlet], [.005, -.045, -.205], [.022, -.064, -.14], [0, -.070, -.06]], .004, m.steel, this.pump);
    this.cylinder(.015, .005, m.darkSteel, this.pump, [0, -.070, -.06]);
    for (let index = -2; index <= 2; index++) this.box([.020, .0007, .0007], m.steel, this.pump, [0, -.073, -.06 + index * .0035]);
    this.filter = this.part('oil-filter', '오일 필터', '펌프 이후 이물질을 거르는 대표 교환식 필터입니다. 절개에서 필터 안의 주름 여재를 볼 수 있습니다.', '강철 캔 · 여과지', this.root, null, [.094, .045, -.134], 13);
    this.filterShell = this.cylinder(.017, .047, m.darkSteel, this.filter, [.092, .047, -.14]);
    this.filterInside = new THREE.Group(); this.filter.add(this.filterInside);
    this.ring(.005, .017, .003, m.steel, this.filterInside, [.092, .069, -.14], 'y'); this.ring(.005, .017, .003, m.steel, this.filterInside, [.092, .024, -.14], 'y');
    for (let index = 0; index < 26; index++) { const a = index / 26 * TAU; const fold = this.box([.0038, .039, .0012], m.bronze, this.filterInside, [.092 + .012 * Math.cos(a), .047, -.14 + .012 * Math.sin(a)]); fold.rotation.y = -a; }
    this.oil = this.part('oil-gallery', '오일 공급 경로', '흡입망 → 동축 펌프 → 필터 → 메인 갤러리에서 베어링으로 분기합니다. 크랭크 안쪽 통로는 로드 큰 끝으로 이어집니다. 금색은 내부 통로를 투시한 대표 연결이며 외부 배관·실제 유량이 아닙니다.', '엔진 오일 · 가공된 통로', this.root, null, [-.05, .078, .12], 7);
    this.rebuildOilFlow(false, 1);
  }

  rebuildOilFlow(single, selectedCylinder) {
    const key = single ? `single-${selectedCylinder}` : 'all'; if (this.oilFlowKey === key) return;
    if (this.selectedId === 'oil-gallery') this.highlight(null);
    for (const child of [...this.oil.children]) { child.traverse(node => { if (node.geometry) { this.geometries.delete(node.geometry); node.geometry.dispose(); } }); this.oil.remove(child); }
    this.oilFlowKey = key; this.oilRoutes = []; this.oilParticles = [];
    const paths = oilCircuitPaths(single ? selectedCylinder - 1 : 0, single ? selectedCylinder : 4);
    this.oilCircuit = paths;
    for (const path of paths) {
      const item = this.tube(path.points, .00135, this.mat.oil, this.oil, !path.straight); item.mesh.renderOrder = 4; item.mesh.userData.partId = 'oil-gallery'; this.oilRoutes.push(item.curve);
      const count = item.curve.getLength() > .15 ? 2 : 1;
      for (let k = 0; k < count; k++) { const mesh = this.mesh(new THREE.SphereGeometry(.002, 8, 6), this.mat.oilMarker, this.oil); mesh.renderOrder = 5; mesh.userData.partId = 'oil-gallery'; this.oilParticles.push({ mesh, route: item.curve, phase: k / count }); }
    }
  }

  buildFlywheel() {
    const m = this.mat;
    this.flywheel = this.part('flywheel', '플라이휠', '크랭크축 끝의 회전 관성을 제공하는 대표 형상입니다. 이 앱은 지정 회전수로 움직이며 회전수 변동을 계산하지 않습니다.', '주철 · 강철', this.root, null, [0, 0, .262], 15);
    this.flywheelRotor = new THREE.Group(); this.flywheel.add(this.flywheelRotor);
    this.ring(.015, .065, .016, m.steel, this.flywheelRotor, [0, 0, .261]);
    this.ring(.052, .067, .009, m.darkSteel, this.flywheelRotor, [0, 0, .265]);
    const gear = this.mesh(sprocketGeometry(72, .068, .006), m.polished, this.flywheelRotor, [0, 0, .261]);
    for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; this.cylinder(.0035, .005, m.polished, this.flywheelRotor, [.029 * Math.cos(a), .029 * Math.sin(a), .272], 'z', 6); }
  }

  radialTexture(stops, size) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const context = canvas.getContext('2d'), midpoint = size / 2;
    const gradient = context.createRadialGradient(midpoint, midpoint, 0, midpoint, midpoint, midpoint);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    context.fillStyle = gradient; context.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.add(texture);
    return texture;
  }

  buildStage() {
    this.stage = new THREE.Group(); this.scene.add(this.stage);
    const floorY = -.133;
    const floorMap = this.radialTexture([[0, '#293945'], [.13, '#1c2a35'], [.31, '#101820'], [1, '#101820']], 512);
    const material = this.material({ map: floorMap, metalness: .04, roughness: .88 });
    this.floor = this.mesh(new THREE.PlaneGeometry(12, 12), material, this.stage, [0, floorY, 0]); this.floor.rotation.x = -Math.PI / 2; this.floor.castShadow = false;
    const shadowMap = this.radialTexture([[0, '#03070bde'], [.52, '#03070bc8'], [.7, '#03070b86'], [.85, '#03070b34'], [1, '#03070b00']], 256);
    const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowMap, transparent: true, depthWrite: false, toneMapped: false });
    this.materials.add(shadowMaterial);
    const contact = this.mesh(new THREE.PlaneGeometry(1.12, 1.12), shadowMaterial, this.stage, [0, floorY + .0005, 0]);
    contact.rotation.x = -Math.PI / 2;
    contact.receiveShadow = false;
    const platform = this.mesh(new THREE.CylinderGeometry(.37, .385, .017, 96), this.material({ color: '#2b3b45', metalness: .65, roughness: .47 }), this.stage, [0, -.122, 0]); platform.receiveShadow = true;
    this.ring(.361, .363, .0008, this.mat.darkSteel, this.stage, [0, -.113, 0], 'y');
    this.standFeet = [];
    for (const end of [-1, 1]) for (const x of [-.057, .057]) { const mesh = this.box([.027, .031, .033], this.mat.black, this.root, [x, -.106, end * .155]); this.standFeet.push({ mesh, end }); }
  }

  buildOverlay() {
    this.labelLayer = document.createElement('div'); this.labelLayer.className = 'engine-labels';
    this.leaders = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); this.leaders.classList.add('engine-leaders'); this.leaders.setAttribute('aria-hidden', 'true');
    this.labels = new Map();
    for (const component of this.components.values()) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'engine-part-label'; button.textContent = component.name; button.setAttribute('aria-label', `${component.name} 선택`); button.hidden = true;
      button.addEventListener('click', event => { event.stopPropagation(); this.onSelect(component.id); });
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); this.leaders.append(line); this.labelLayer.append(button); this.labels.set(component.id, { button, line });
    }
    this.status = document.createElement('div'); this.status.className = 'engine-scene-status';
    this.liftStatus = document.createElement('div'); this.liftStatus.className = 'engine-scene-lift';
    this.note = document.createElement('div'); this.note.className = 'engine-scene-note'; this.note.textContent = '드래그 회전 · 휠 확대 · 부품 클릭';
    this.container.append(this.leaders, this.labelLayer, this.status, this.liftStatus, this.note);
  }

  update(snapshot, view = {}, settings = {}) {
    if (this.disposed || !snapshot) return;
    this.restoreVisibilityMask();
    this.snapshot = snapshot; this.updateIntakeProfile(settings);
    this.view = { ...DEFAULT_VIEW, ...view, layers: { ...DEFAULT_VIEW.layers, ...view.layers } };
    const v = this.view, selectedCylinder = clamp(Number(v.selectedCylinder) || 1, 1, 4), single = v.cylinderMode === 'single', cut = v.mode !== 'assembled', exploded = v.mode === 'exploded' ? clamp(Number(v.explode) || 0, 0, 1) : 0;
    const selectedZ = (selectedCylinder - 2.5) * .104;
    const angle = snapshot.cycleAngleRad ?? 0;
    this.crankRotating.rotation.z = -angle; this.flywheelRotor.rotation.z = -angle;
    this.block.visible = Boolean(v.layers.block); this.head.visible = Boolean(v.layers.head); this.blockFull.visible = !cut; this.blockCut.visible = cut;
    this.headFull.visible = !cut; this.headCut.visible = cut; this.coverSolid.visible = !cut; this.coverGhost.visible = cut;
    this.block.position.x = -exploded * .09; this.head.position.y = exploded * .055; this.cover.position.y = exploded * .035;
    for (const shell of [this.blockFull, this.blockCut]) { shell.scale.z = single ? .27 : 1; shell.position.z = single ? selectedZ : 0; }
    for (const enclosure of [this.headFull, this.headCut]) for (const mesh of enclosure.children) if (!mesh.userData.cylinder) mesh.visible = !single;
    for (const mesh of [this.coverSolid, this.coverGhost]) { mesh.scale.z = single ? .27 : 1; mesh.position.z = single ? selectedZ : 0; }
    this.pan.scale.z = single ? .27 : 1; this.pan.position.z = single ? selectedZ : 0;
    // Display supports stay under the extracted pan instead of marking the hidden
    // full engine's corners when inspecting only one cylinder.
    for (const foot of this.standFeet) foot.mesh.position.z = single ? selectedZ + foot.end * .036 : foot.end * .155;
    const crankStart = single && !v.layers.timing ? selectedZ - .068 : -.247;
    const crankEnd = single ? selectedZ + .068 : .247;
    this.crankShaftMesh.scale.y = (crankEnd - crankStart) / .494; this.crankShaftMesh.position.z = (crankEnd + crankStart) / 2;
    this.crankJournals.forEach((mesh, index) => { mesh.visible = !single || index === selectedCylinder - 1 || index === selectedCylinder; });
    for (let index = 0; index < 5; index++) this.components.get(`main-bearing-${index + 1}`).node.visible = !single || index === selectedCylinder - 1 || index === selectedCylinder;
    for (const support of this.bearingSupports) { support.upperBody.visible = Boolean(v.layers.block); support.backWeb.visible = Boolean(v.layers.block); support.frontWeb.visible = Boolean(v.layers.block) && !cut; }
    this.flywheel.visible = !single;
    this.panFull.visible = !cut; this.panCut.visible = cut; this.pan.position.y = -exploded * .035; this.pan.visible = Boolean(v.layers.block);
    this.timing.visible = Boolean(v.layers.timing); this.guides.visible = Boolean(v.layers.timing); this.timing.position.z = -exploded * .055; this.guides.position.z = -exploded * .055;
    this.oil.visible = Boolean(v.layers.lubrication); this.pump.visible = Boolean(v.layers.lubrication); this.filter.visible = Boolean(v.layers.lubrication); this.filterShell.visible = !cut; this.filterInside.visible = cut;
    this.rebuildOilFlow(single, selectedCylinder);
    const samples = snapshot.cylinders || [];
    for (const cylinder of this.cylinders) {
      const sample = samples[cylinder.number - 1]; if (!sample) continue;
      cylinder.group.visible = !single || cylinder.number === selectedCylinder;
      cylinder.crankThrow.visible = cylinder.group.visible;
      cylinder.crankOil.visible = Boolean(v.layers.lubrication);
      const pin = sample.pistonPin; const crankPin = sample.crankPin;
      cylinder.piston.position.set(pin.x, pin.y, pin.z); cylinder.rod.position.set(crankPin.x, crankPin.y, crankPin.z);
      const delta = new THREE.Vector3(pin.x - crankPin.x, pin.y - crankPin.y, pin.z - crankPin.z); cylinder.rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
      cylinder.piston.position.x += exploded * .065; cylinder.rings.position.x = exploded * .035; cylinder.pin.position.z = -exploded * .05;
      cylinder.liner.visible = Boolean(v.layers.block); cylinder.linerFull.visible = !cut; cylinder.linerCut.visible = cut;
      cylinder.liner.position.x = -exploded * .04;
      cylinder.blockDeck.visible = cylinder.group.visible;
      cylinder.decks[0].visible = !cut; cylinder.decks[1].visible = cut;
      cylinder.headRingFull.visible = !single || cylinder.number === selectedCylinder; cylinder.headRingCut.visible = !single || cylinder.number === selectedCylinder;
      const showChamber = cut && exploded === 0;
      const isObserved = cylinder.number === selectedCylinder;
      for (const kind of ['intake', 'exhaust']) {
        const lift = sample.valveLifts[kind]; const valve = cylinder.valves[kind]; valve.group.position.y = exploded * .035;
        for (const instance of valve.instances) {
          instance.moving.position.copy(vec(instance.geometry.seat)).addScaledVector(vec(instance.geometry.n), -lift);
          instance.springMesh.position.y = SPRING_BOTTOM; instance.springMesh.scale.y = (SPRING_HEIGHT - lift) / SPRING_HEIGHT;
          const { gap, markers, route } = instance.flow;
          gap.visible = showChamber && isObserved && lift > 0;
          gap.position.y = -lift / 2;
          gap.scale.y = lift;
          const showRoute = gap.visible && sample.stroke === kind;
          for (let index = 0; index < markers.length; index++) {
            const marker = markers[index];
            marker.visible = showRoute;
            if (!showRoute) continue;
            const progress = (sample.phaseRad / Math.PI * 2 + index / markers.length) % 1;
            marker.position.copy(route.getPointAt(kind === 'intake' ? progress : 1 - progress));
            marker.material.opacity = .38 + .50 * Math.sqrt(clamp(lift / GEOMETRY.valveMaxLift, 0, 1));
          }
        }
      }
      cylinder.spark.position.y = exploded * .035;
      const stroke = STROKES[sample.stroke] || STROKES.power;
      const powerStroke = sample.stroke === 'power';
      cylinder.gas.material.color.setHex(stroke[1]);
      cylinder.gas.material.emissive.setHex(powerStroke ? 0xff862f : stroke[1]);
      const crown = pin.y + GEOMETRY.pinToCrown, height = CHAMBER_ROOF - crown;
      cylinder.gas.position.set(0, crown + height / 2, cylinder.z); cylinder.gas.scale.y = height; cylinder.gas.visible = showChamber;
      const heat = powerStroke ? Math.exp(-sample.phaseRad * 1.3) : 0;
      cylinder.gas.material.opacity = (isObserved ? .09 : .026) + heat * (isObserved ? .26 : .08);
      cylinder.gas.material.emissiveIntensity = .12 + heat * (isObserved ? 1.25 : .55);
      const spark = powerStroke ? Math.max(0, 1 - sample.phaseRad / .13) : 0;
      cylinder.flash.visible = showChamber && spark > 0;
      cylinder.flash.material.opacity = spark * .64;
      cylinder.flash.scale.setScalar(.45 + spark * .55);
    }
    for (const kind of ['intake', 'exhaust']) {
      const cam = this.cams[kind]; cam.group.position.y = exploded * .035;
      const shaftStart = single && !v.layers.timing ? selectedZ - .065 : -.243;
      const shaftEnd = single ? selectedZ + .065 : .243;
      cam.shaft.scale.y = (shaftEnd - shaftStart) / .486; cam.shaft.position.z = (shaftEnd + shaftStart) / 2;
      cam.supports.forEach((support, index) => { support.visible = !single || index === selectedCylinder - 1 || index === selectedCylinder; });
      for (const support of cam.supports) for (const mesh of support.children) if (mesh.userData.headSupport) mesh.visible = Boolean(v.layers.head);
      for (const lobe of cam.lobes) { lobe.mesh.rotation.z = lobe.alpha - snapshot.camAngles[kind] + FIRING_PHASES[lobe.index] / 2; lobe.mesh.visible = !single || lobe.index + 1 === selectedCylinder; }
    }
    for (const { kind, gear, hub } of this.sprockets) {
      gear.rotation.z = kind === 'crank' ? -angle : -angle / 2;
      if (kind === 'intake') hub.rotation.z = -snapshot.camAngles.intake - gear.rotation.z;
    }
    this.pumpRotor.rotation.z = -angle;
    // Inner and outer plates repeat every two pitches; 720° advances 36 pitches.
    const pitch = this.chainPath.total / this.chainCount, travel = -(angle / TAU * 18 % 2) * pitch;
    for (let index = 0; index < this.chainCount; index++) {
      const point = this.chainPath.sample(index * pitch + travel), next = this.chainPath.sample((index + 1) * pitch + travel);
      this.chainDummy.position.set(point.x, point.y, -.239); this.chainDummy.rotation.set(0, 0, 0); this.chainDummy.updateMatrix();
      this.chainPins.setMatrixAt(index, this.chainDummy.matrix); this.chainRollers.setMatrixAt(index, this.chainDummy.matrix);
      const platesZ = index % 2 === 0 ? .0038 : .0026;
      this.chainDummy.rotation.z = Math.atan2(next.y - point.y, next.x - point.x);
      this.chainDummy.position.set((point.x + next.x) / 2, (point.y + next.y) / 2, -.239);
      for (let side = 0; side < 2; side++) { this.chainDummy.position.z = -.239 + (side ? platesZ : -platesZ); this.chainDummy.updateMatrix(); this.chainLinks.setMatrixAt(index * 2 + side, this.chainDummy.matrix); }
    }
    this.chainLinks.instanceMatrix.needsUpdate = true; this.chainPins.instanceMatrix.needsUpdate = true; this.chainRollers.instanceMatrix.needsUpdate = true;
    for (const particle of this.oilParticles) particle.mesh.position.copy(particle.route.getPointAt((angle / (Math.PI * 4) + particle.phase) % 1));
    this.root.updateMatrixWorld(true);
    if (this.selectedId !== v.selectedPart) this.highlight(v.selectedPart);
    const current = samples[selectedCylinder - 1], phase = current?.phaseRad ?? 0;
    this.status.textContent = `${single ? `${selectedCylinder}번 확대` : '직렬 4기통'} · ${single ? '' : `${selectedCylinder}번 `}${STROKES[current?.stroke]?.[0] || ''} · ${Math.round(phase * 180 / Math.PI)}°`;
    this.liftStatus.textContent = current ? `밸브 리프트  흡기 ${(current.valveLifts.intake * 1000).toFixed(2)} · 배기 ${(current.valveLifts.exhaust * 1000).toFixed(2)} mm` : '';
    this.updateSceneNote();
    if (this.inspection) {
      const component = this.components.get(this.inspection.partId);
      // Explicit inspection can temporarily reveal a disabled layer. Subsequent
      // scope changes still honour the user's current cylinder/layer choices.
      if (this.inspection.scope !== this.inspectionScope() && !this.isVisible(component.node)) this.restoreInspection();
      else {
        this.inspection.scope = this.inspectionScope(); this.applyInspectionMask(component);
        const origin = component.node.getWorldPosition(new THREE.Vector3());
        if (this.inspection.origin) {
          const delta = origin.clone().sub(this.inspection.origin); this.camera.position.add(delta); this.controls.target.add(delta);
        }
        this.inspection.origin = origin;
      }
    }
    this.needsRender = true;
  }
  updateSceneNote() {
    const { mode, layers } = this.view;
    const notes = [];
    if (mode === 'exploded') notes.push('분해 간격은 관찰용');
    if (mode === 'cutaway') notes.push('연소실 색상은 행정 표시 · 흡·배기 점은 이동 방향 예시');
    if (layers.lubrication) notes.push('금색은 조립 상태 오일 경로 예시');
    this.note.hidden = notes.length === 0;
    this.note.textContent = notes.join(' / ');
  }

  inspectionScope() { return JSON.stringify([this.view.cylinderMode, this.view.selectedCylinder, this.view.layers]); }
  getInspectionState() { return { active: Boolean(this.inspection), partId: this.inspection?.partId ?? null }; }
  getProjectCameraState() { return this.inspection ? structuredClone(this.inspection.camera) : this.getCameraState(); }
  restoreVisibilityMask() {
    if (!this.visibilityMask) return;
    for (const [node, visible] of this.visibilityMask) node.visible = visible;
    this.visibilityMask = null;
  }
  applyInspectionMask(component) {
    this.restoreVisibilityMask(); this.visibilityMask = new Map();
    this.visibilityMask.set(this.stage, this.stage.visible); this.stage.visible = false;
    const ancestors = new Set(); for (let node = component.node; node; node = node.parent) ancestors.add(node);
    const descendants = new Set(); component.node.traverse(node => descendants.add(node));
    this.root.traverse(node => {
      this.visibilityMask.set(node, node.visible);
      node.visible = ancestors.has(node) || (descendants.has(node) && node.visible);
    });
    this.note.hidden = false;
    this.note.textContent = /-pin$/.test(component.id) ? '중공 피스톤 핀 · 핀 보스와 로드 작은 끝을 연결하는 대표 형상'
      : /-rings$/.test(component.id) ? '압축 링 2개·오일 링 1개 · 끝 간극과 링 홈의 대표 형상 · 밀봉 해석 아님'
      : /piston/.test(component.id) ? '대표 피스톤 구조 · 링 홈·중공 크라운·핀 보스 · 제작 도면 아님'
      : /-liner$/.test(component.id) ? `교차 호닝 무늬의 간격은 관찰용 · 실린더 내경은 ${D.bore * 1000} mm`
      : /rod|crankshaft|bearing/.test(component.id) ? '대표 가공 구조 · 중심 거리와 운동 치수 유지 · 응력·강도 계산 아님'
      : '선택 부품 확대 · 전체 구조 복귀 시 이전 시점과 현재 표시 설정 적용';
  }
  inspectPart(id) {
    const component = this.components.get(id); if (!component) return false;
    this.restoreVisibilityMask();
    if (!this.inspection) this.inspection = { camera: this.getCameraState(), preset: structuredClone(this.lastPresetFit), partId: id, scope: this.inspectionScope() };
    this.inspection.partId = id; this.inspection.scope = this.inspectionScope(); this.applyInspectionMask(component);
    this.inspection.origin = component.node.getWorldPosition(new THREE.Vector3());
    const damping = this.controls.enableDamping; this.controls.enableDamping = false; this.controls.update();
    const direction = /piston|rings|pin/.test(id) ? new THREE.Vector3(.85, -.48, -.95)
      : /rod/.test(id) ? new THREE.Vector3(.46, .16, -1) : new THREE.Vector3(.88, .54, -.91);
    const fit = fitEngineCamera(this.camera, this.root, { aspect: this.width / this.height, direction, fillX: .72, fillY: .7 });
    if (fit) {
      this.controls.target.copy(fit.target);
      // At the orbit distance floor, optical zoom lets small parts fill the view.
      const span = Math.max(fit.projectedBounds.right - fit.projectedBounds.left, fit.projectedBounds.top - fit.projectedBounds.bottom);
      if (span > 0 && span < 1.15) this.camera.zoom = Math.min(4, 1.15 / span);
      this.camera.updateProjectionMatrix(); this.lastPresetFit = { id: 'inspection', distance: fit.distance, projectedBounds: fit.projectedBounds };
    }
    this.controls.update(); this.controls.enableDamping = damping; this.needsRender = true; return true;
  }
  restoreInspection() {
    if (!this.inspection) return false;
    const saved = this.inspection; this.restoreVisibilityMask(); this.inspection = null;
    this.restoreCameraState(saved.camera); this.lastPresetFit = saved.preset;
    this.updateSceneNote();
    this.needsRender = true; return true;
  }

  highlight(id) {
    for (const { mesh, original, material } of this.highlighted) { mesh.material = original; for (const entry of material) entry.dispose(); }
    this.highlighted = []; this.selectedId = id;
    const component = this.components.get(id); if (!component) return;
    component.node.traverse(mesh => {
      if (!mesh.isMesh || mesh.userData.ignorePick) return; const original = mesh.material, list = Array.isArray(original) ? original : [original];
      const material = list.map(value => { const copy = value.clone(); copy.emissive.set('#477a72'); copy.emissiveIntensity = .20; return copy; });
      mesh.material = Array.isArray(original) ? material : material[0]; this.highlighted.push({ mesh, original, material });
    });
  }
  isVisible(node) { for (let current = node; current; current = current.parent) if (!current.visible) return false; return true; }
  renderLabels() {
    const { width, height, compactLabels } = this, candidates = [];
    for (const component of this.components.values()) {
      const selected = component.id === this.view.selectedPart;
      if (compactLabels && !selected) continue;
      if (!this.view.labels || !this.isVisible(component.node)) continue;
      if (this.inspection) {
        const inspected = this.components.get(this.inspection.partId).node;
        let ancestor = component.node; while (ancestor && ancestor !== inspected) ancestor = ancestor.parent;
        if (!ancestor) continue; // Transform-only parents do not label hidden parts.
      }
      if (component.cylinder && component.cylinder !== this.view.selectedCylinder && !selected) continue;
      if (!selected && component.priority > (width < 650 ? 4 : 8)) continue;
      const point = component.node.localToWorld(component.anchor.clone()).project(this.camera);
      if (point.z > 1 || point.z < -1 || Math.abs(point.x) > 1.25 || Math.abs(point.y) > 1.25) continue;
      candidates.push({ id: component.id, x: (point.x * .5 + .5) * width, y: (-point.y * .5 + .5) * height, priority: component.priority, selected });
    }
    const placements = new Map(layoutLabels(candidates, width, height, compactLabels).map(placement => [placement.id, placement]));
    for (const [id, { button, line }] of this.labels) {
      const placement = placements.get(id);
      button.hidden = !placement; line.style.display = placement ? '' : 'none';
      if (!placement) continue;
      button.style.left = `${placement.left}px`; button.style.top = `${placement.top}px`; button.style.width = `${placement.width}px`; button.setAttribute('aria-pressed', String(placement.selected));
      line.setAttribute('points', `${placement.edgeX},${placement.edgeY} ${placement.x},${placement.y}`); line.classList.toggle('selected', placement.selected);
    }
  }
  pick(event) {
    const down = this.down; this.down = null;
    if (!down || event.pointerId !== down.id || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    const rect = this.renderer.domElement.getBoundingClientRect(); this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    for (const hit of this.raycaster.intersectObject(this.root, true)) {
      if (!this.isVisible(hit.object) || hit.object.userData.ignorePick || !hit.object.userData.partId || hit.object.material?.transparent && hit.object.material.opacity < .2) continue;
      this.onSelect(hit.object.userData.partId); return;
    }
  }
  resize() {
    this.width = Math.max(1, this.container.clientWidth); this.height = Math.max(1, this.container.clientHeight || 500);
    this.compactLabels = this.width < COMPACT_SCENE_WIDTH;
    this.container.classList.toggle('compact-labels', this.compactLabels);
    this.renderer.setSize(this.width, this.height, false); this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix(); this.needsRender = true;
  }
  setCameraPreset(id = 'iso') {
    const direction = id === 'front' ? new THREE.Vector3(1, .13, -.015) : id === 'timing' ? new THREE.Vector3(.03, .17, -1) : new THREE.Vector3(.88, .54, -.91);
    // Flush the previous drag's damping before applying an explicit preset. Subsequent
    // model/view updates never fit the camera, so selecting a part keeps the viewpoint.
    const damping = this.controls.enableDamping; this.controls.enableDamping = false; this.controls.update();
    const fit = fitEngineCamera(this.camera, this.root, { aspect: this.width / this.height, direction });
    if (fit) { this.controls.target.copy(fit.target); this.lastPresetFit = { id, distance: fit.distance, projectedBounds: fit.projectedBounds }; }
    this.controls.update(); this.controls.enableDamping = damping; this.needsRender = true;
  }
  getCameraState() { return { position: this.camera.position.toArray(), target: this.controls.target.toArray(), zoom: this.camera.zoom }; }
  restoreCameraState(state) {
    if (!state || ![state.position, state.target].every(value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite))) return false;
    const position = vec(state.position), target = vec(state.target), distance = position.distanceTo(target);
    if (distance < .17 - 1e-10 || distance > 2.7 + 1e-10) return false;
    if (state.zoom != null && (!Number.isFinite(state.zoom) || state.zoom < .25 || state.zoom > 4)) return false;
    const damping = this.controls.enableDamping; this.controls.enableDamping = false; this.controls.update();
    this.camera.position.copy(position); this.controls.target.copy(target); this.camera.zoom = state.zoom ?? 1; this.camera.updateProjectionMatrix(); this.controls.update(); this.controls.enableDamping = damping; this.needsRender = true; return true;
  }
  getComponents() { return [...this.components.values()].map(({ id, name, description, material }) => ({ id, name, description, material })); }
  getDebug() {
    this.root.updateMatrixWorld(true);
    const contacts = [], point = new THREE.Vector3();
    for (const cylinder of this.cylinders) for (const kind of ['intake', 'exhaust']) {
      cylinder.valves[kind].instances.forEach((instance, pairIndex) => {
        const lobe = this.cams[kind].lobes[(cylinder.number - 1) * 2 + pairIndex].mesh;
        const plane = instance.moving.localToWorld(new THREE.Vector3(0, .034, 0));
        const m = vec(instance.geometry.n).negate(); let maximum = -Infinity;
        const positions = lobe.geometry.attributes.position;
        for (let index = 0; index < positions.count; index++) { point.fromBufferAttribute(positions, index).applyMatrix4(lobe.matrixWorld).sub(plane); maximum = Math.max(maximum, point.dot(m)); }
        contacts.push({ cylinder: cylinder.number, kind, pair: pairIndex, supportErrorM: maximum });
      });
    }
    const mechanical = this.cylinders.map(cylinder => {
      const small = cylinder.rodSmallEnd.getWorldPosition(new THREE.Vector3()), big = cylinder.rodBigEnd.getWorldPosition(new THREE.Vector3());
      const crown = cylinder.pistonBody.localToWorld(new THREE.Vector3(0, cylinder.pistonBody.geometry.boundingBox.max.y, 0));
      return { cylinder: cylinder.number, pistonPin: cylinder.pinMesh.getWorldPosition(new THREE.Vector3()).toArray(), pistonCrown: crown.toArray(), rodSmallEnd: small.toArray(), rodBigEnd: big.toArray(), crankPin: cylinder.crankPinMesh.getWorldPosition(new THREE.Vector3()).toArray(), centerDistance: small.distanceTo(big) };
    });
    return { selectedPart: this.selectedId, camera: this.getCameraState(), projectCamera: this.getProjectCameraState(), inspection: this.getInspectionState(), lastPresetFit: this.lastPresetFit, mechanical, pistonDetail: PISTON_DETAIL, visibleCylinderIds: this.cylinders.filter(cylinder => cylinder.group.visible).map(cylinder => cylinder.number), crankRotation: this.crankRotating.rotation.z, pumpDrive: { axis: this.pumpRotor.getWorldPosition(new THREE.Vector3()).toArray(), rotation: this.pumpRotor.rotation.z }, oilCircuitMode: this.oilFlowKey, oilCircuitPaths: this.oilCircuit.map(path => path.id), camContacts: contacts, maxCamSupportErrorM: Math.max(...contacts.map(contact => Math.abs(contact.supportErrorM))), drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, resources: { geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures } };
  }
  animate() {
    if (this.disposed) return; this.controls.update();
    if (this.needsRender) { this.renderer.render(this.scene, this.camera); this.renderLabels(); this.needsRender = false; }
    this.frame = requestAnimationFrame(() => this.animate());
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; cancelAnimationFrame(this.frame); this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown); this.renderer.domElement.removeEventListener('pointerup', this.pointerUp);
    this.renderer.domElement.removeEventListener('pointercancel', this.pointerCancel); this.controls.dispose();
    for (const { material } of this.highlighted) for (const entry of material) entry.dispose();
    this.root.traverse(node => { if (node.isInstancedMesh) node.dispose(); });
    for (const geometry of this.geometries) geometry.dispose(); for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.environment.dispose(); this.renderer.dispose(); this.renderer.domElement.remove(); this.labelLayer.remove(); this.leaders.remove(); this.status.remove(); this.liftStatus.remove(); this.note.remove();
  }
}
