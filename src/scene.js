import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FIRING_PHASES } from './model.js';
import { SCENE_DIMENSIONS as D, OIL_PUMP_GEOMETRY, oilCircuitPaths, crankOilPassage, valveGeometry, createCamGeometry, annulus, sprocketGeometry, timingPath, layoutLabels, fitEngineCamera } from './scene-geometry.js';
import { PISTON_DETAIL, pistonCrownGeometry, pistonSkirtGeometry, beveledPlate, rodBeamGeometry, rodFlangeGeometry, crankCheekGeometry, metalFinishTexture } from './mechanical-geometry.js';
import './scene.css';

const TAU = Math.PI * 2;
const vec = values => new THREE.Vector3(...values);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const DEFAULT_VIEW = { cylinderMode: 'all', selectedCylinder: 1, mode: 'cutaway', explode: .35, labels: true, layers: { block: true, head: true, timing: true, lubrication: false }, selectedPart: 'c1-piston' };
const STROKES = { power: ['팽창', 0xefb56e], exhaust: ['배기', 0xd88073], intake: ['흡기', 0x63c6df], compression: ['압축', 0xb4a0dd] };

export class EngineScene {
  constructor(container, { onSelect = () => {} } = {}) {
    this.container = container; this.onSelect = onSelect; this.view = { ...DEFAULT_VIEW, layers: { ...DEFAULT_VIEW.layers } };
    this.components = new Map(); this.cylinders = []; this.staticMeshes = []; this.materials = new Set(); this.geometries = new Set(); this.textures = new Set(); this.highlighted = []; this.disposed = false;
    container.classList.add('engine-scene');
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#18242e'); this.scene.fog = new THREE.Fog('#18242e', 1.7, 4.5);
    this.camera = new THREE.PerspectiveCamera(37, 1, .005, 12);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label', '회전하고 부품을 선택할 수 있는 4행정 엔진 3D 구조');
    container.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = true; this.controls.dampingFactor = .11;
    this.controls.minDistance = .17; this.controls.maxDistance = 2.7; this.controls.maxPolarAngle = Math.PI; this.controls.zoomSpeed = .7; this.controls.panSpeed = .65;
    this.controls.addEventListener('change', () => { this.needsRender = true; });
    const environment = new RoomEnvironment(); const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(environment, .025); this.scene.environment = this.environment.texture; environment.dispose(); pmrem.dispose();
    this.scene.environmentIntensity = .85;
    this.scene.add(new THREE.HemisphereLight(0xc7e6ff, 0x263344, 1.2));
    const key = new THREE.DirectionalLight(0xffead1, 4.2); key.position.set(.6, 1.3, -.6); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -.65; key.shadow.camera.right = .65; key.shadow.camera.top = .65; key.shadow.camera.bottom = -.65;
    key.shadow.camera.near = .1; key.shadow.camera.far = 3; key.shadow.bias = -.0002; key.shadow.normalBias = .001;
    this.scene.add(key); const rim = new THREE.DirectionalLight(0x7ebcde, 2.7); rim.position.set(-.7, .5, .8); this.scene.add(rim);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.createMaterials(); this.buildEngine(); this.buildStage(); this.buildOverlay();
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.pointerDown = event => { this.down = { x: event.clientX, y: event.clientY }; };
    this.pointerUp = event => this.pick(event);
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown); this.renderer.domElement.addEventListener('pointerup', this.pointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container); this.resize(); this.setCameraPreset('iso');
    this.needsRender = true; this.frame = requestAnimationFrame(() => this.animate());
  }

  material(parameters) { const material = new THREE.MeshStandardMaterial(parameters); this.materials.add(material); return material; }
  createMaterials() {
    const finish = kind => { const texture = metalFinishTexture(kind); texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy()); this.textures.add(texture); return texture; };
    const turned = finish('turned'), linear = finish('linear'), cast = finish('cast');
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
      intake: this.material({ color: '#549cac', metalness: .65, roughness: .32 }),
      exhaust: this.material({ color: '#9c8070', metalness: .83, roughness: .4 }),
      oil: this.material({ color: '#ffb941', emissive: '#ac6711', emissiveIntensity: .5, metalness: .3, roughness: .24, transparent: true, opacity: .75, depthWrite: false, depthTest: false }),
      ceramic: this.material({ color: '#efebe0', metalness: .05, roughness: .27 }),
      transparent: this.material({ color: '#87aabc', metalness: .28, roughness: .36, transparent: true, opacity: .12, depthWrite: false, side: THREE.DoubleSide }),
    };
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
    const head = this.cylinder(.0031 * scale, .003 * scale, this.mat.polished, parent, position, axis, 6);
    return head;
  }
  buildEngine() {
    const m = this.mat;
    this.block = this.part('block', '실린더 블록', '4개 실린더와 크랭크 지지부를 연결하는 주조 몸체입니다. 절개에서는 관찰면의 벽을 제거합니다.', '알루미늄 합금 · 주철 라이너', this.root, null, [-.061, .15, 0], 8);
    this.blockFull = new THREE.Group(); this.blockCut = new THREE.Group(); this.block.add(this.blockFull, this.blockCut);
    this.box([.018, .12, .421], m.cast, this.blockCut, [-.06, .155, 0]);
    this.box([.018, .12, .421], m.cast, this.blockFull, [-.06, .155, 0]); this.box([.018, .12, .421], m.cast, this.blockFull, [.06, .155, 0]);
    for (let index = 0; index < 5; index++) {
      const z = -.208 + index * .104;
      this.box([.13, .008, .013], m.cast, this.blockCut, [0, .099, z]); this.box([.13, .008, .013], m.cast, this.blockFull, [0, .099, z]);
      this.box([.013, .106, .018], m.cast, this.blockCut, [-.059, .154, z]);
      for (const x of [-.058, .058]) { this.bolt(this.blockFull, [x, .219, z]); this.bolt(this.blockCut, [x, .105, z]); }
    }
    this.head = this.part('head', '실린더 헤드', '연소실 위에서 밸브 시트·가이드와 캠축 베어링을 지지합니다. 자체 제작한 대표 DOHC 형상입니다.', '알루미늄 합금', this.root, null, [-.056, .248, 0], 8);
    this.headFull = new THREE.Group(); this.headCut = new THREE.Group(); this.head.add(this.headFull, this.headCut);
    this.box([.014, .05, .431], m.cast, this.headCut, [-.072, .25, 0]); this.box([.014, .05, .431], m.cast, this.headFull, [-.072, .25, 0]); this.box([.014, .05, .431], m.cast, this.headFull, [.072, .25, 0]);
    for (const z of [-.219, .219]) { this.box([.153, .038, .012], m.cast, this.headFull, [0, .251, z]); this.box([.081, .025, .012], m.cast, this.headCut, [-.033, .248, z]); }
    this.cover = this.part('cam-cover', '캠 커버', '캠축 위를 덮어 오일을 가두는 커버입니다. 절개에서는 내부를 관찰할 수 있도록 투명하게 표시합니다.', '알루미늄 합금 · 고무 개스킷', this.head, null, [0, .338, 0], 20);
    this.coverSolid = this.box([.159, .024, .446], m.cast, this.cover, [0, .336, 0]);
    this.coverGhost = this.box([.159, .024, .446], m.transparent, this.cover, [0, .336, 0]);
    for (const x of [-.066, .066]) for (const z of [-.205, -.104, 0, .104, .205]) this.bolt(this.coverSolid, [x, .014, z]);
    this.crank = this.part('crankshaft', '크랭크축', '크랭크 핀의 원운동과 커넥팅로드가 피스톤 왕복운동을 연결합니다. 1·4번과 2·3번 핀은 180° 차이입니다.', '단조 강철', this.root, null, [0, 0, -.025], 1);
    this.crankRotating = new THREE.Group(); this.crank.add(this.crankRotating);
    this.crankShaftMesh = this.cylinder(.015, .494, m.polished, this.crankRotating, [0, 0, 0], 'z');
    this.crankJournals = []; this.bearingSupports = [];
    for (let index = 0; index < 5; index++) {
      const z = -.208 + index * .104;
      this.crankJournals.push(this.cylinder(.022, .027, m.polished, this.crankRotating, [0, 0, z], 'z'));
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
        this.mesh(annulus(.013, .018, .018, 0, Math.PI), m.cast, support, [c[0], c[1], z]);
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
    const crankPinMesh = this.cylinder(.0133, .026, m.polished, crankThrow, [0, .043, z], 'z');
    for (const zz of [z - .021, z + .021]) {
      this.mesh(crankCheekGeometry(), [m.steel, m.darkSteel], crankThrow, [0, 0, zz]);
    }
    const crankOil = this.tube(crankOilPassage(index), .00135, m.oil, crankThrow, false).mesh; crankOil.userData.partId = 'oil-gallery'; crankOil.renderOrder = 4;
    const liner = this.part(`c${number}-liner`, `${number}번 실린더 라이너`, '피스톤이 왕복하는 원통면입니다. 절개에서는 절반을 제거하고 절단면을 밝게 표시합니다.', '내마모 주철', group, number, [-.043, .168, z], 14);
    const linerFull = this.ring(.043, .0485, .116, [m.cut, m.polished], liner, [0, .157, z], 'y');
    const linerCut = this.ring(.043, .0485, .116, [m.cut, m.polished], liner, [0, .157, z], 'y', Math.PI / 2, Math.PI);
    const headRingFull = this.ring(.0415, .059, .012, [m.cut, m.cast], this.headFull, [0, .220, z], 'y');
    const headRingCut = this.ring(.0415, .059, .012, [m.cut, m.cast], this.headCut, [0, .220, z], 'y', Math.PI / 2, Math.PI);
    headRingFull.userData.cylinder = number; headRingCut.userData.cylinder = number;
    const valves = {};
    for (const kind of ['intake', 'exhaust']) {
      const valveGroup = this.part(`c${number}-${kind}-valves`, `${number}번 ${kind === 'intake' ? '흡기' : '배기'} 밸브`, '기울어진 두 밸브가 캠 리프트와 같은 거리로 축을 따라 열립니다. 캠·평면 팔로워·스프링을 한 연결로 볼 수 있습니다.', '내열 강철 · 스프링 강철', group, number, [kind === 'intake' ? -.027 : .027, .25, z], 3);
      const instances = [];
      for (const pair of [-1, 1]) {
        const geometry = valveGeometry(kind, z, pair), n = vec(geometry.n);
        const moving = new THREE.Group(); moving.position.copy(vec(geometry.seat)); moving.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n); valveGroup.add(moving);
        this.cylinder(.011, .0025, m.polished, moving, [0, .00125, 0]);
        this.mesh(new THREE.ConeGeometry(.009, .004, 32), m.steel, moving, [0, .004, 0]);
        this.cylinder(.0026, .030, m.polished, moving, [0, .018, 0]);
        this.cylinder(.011, .004, m.polished, moving, [0, .032, 0]);
        this.ring(.003, .008, .002, m.darkSteel, moving, [0, .027, 0], 'y');
        const guide = new THREE.Group(); guide.position.copy(vec(geometry.seat)); guide.quaternion.copy(moving.quaternion); valveGroup.add(guide);
        this.ring(.0027, .005, .015, m.bronze, guide, [0, .010, 0], 'y');
        this.ring(.0098, .0125, .002, m.bronze, guide, [0, 0, 0], 'y');
        const spring = new THREE.Group(); spring.position.copy(vec(geometry.seat)); spring.quaternion.copy(moving.quaternion); valveGroup.add(spring);
        const points = []; for (let step = 0; step <= 120; step++) { const angle = step / 120 * TAU * 5.5; points.push([Math.cos(angle) * .0068, step / 120 * .019, Math.sin(angle) * .0068]); }
        const springCurve = new THREE.CatmullRomCurve3(points.map(vec)); const springMesh = this.mesh(new THREE.TubeGeometry(springCurve, 120, .00075, 6, false), m.steel, spring);
        const cam = this.mesh(createCamGeometry(kind), m.polished, this.cams[kind].group, geometry.center); cam.userData.cylinder = number;
        this.cams[kind].lobes.push({ mesh: cam, alpha: geometry.alpha, index });
        instances.push({ geometry, moving, guide, spring, springMesh });
      }
      valves[kind] = { group: valveGroup, instances };
    }
    const spark = this.part(`c${number}-spark-plug`, `${number}번 점화 플러그`, '압축 상사점 근처의 점화 위치를 표시합니다. 불빛은 행정 안내이며 연소 압력 계산이 아닙니다.', '세라믹 · 니켈 합금', group, number, [0, .277, z], 12);
    this.cylinder(.0045, .026, m.ceramic, spark, [0, .263, z]); this.cylinder(.006, .012, m.steel, spark, [0, .243, z], 'y', 6); this.cylinder(.002, .011, m.polished, spark, [0, .231, z]);
    for (let k = 0; k < 4; k++) this.cylinder(.0052, .0015, m.ceramic, spark, [0, .259 + k * .0035, z]);
    const flashMaterial = this.material({ color: '#ffcb81', emissive: '#ff8e31', emissiveIntensity: 2, transparent: true, opacity: .36, depthWrite: false });
    const flash = this.mesh(new THREE.SphereGeometry(.008, 16, 12), flashMaterial, spark, [0, .218, z]);
    const gasMaterial = this.material({ color: '#69cbd5', emissive: '#69cbd5', emissiveIntensity: .08, transparent: true, opacity: .055, depthWrite: false, side: THREE.DoubleSide });
    const gas = this.mesh(new THREE.CylinderGeometry(.0405, .0405, 1, 40), gasMaterial, group, [0, .2, z]); gas.castShadow = false;
    this.cylinders.push({ number, z, group, piston, pistonBody, rings, pin, pinMesh, rod, rodSmallEnd, rodBigEnd, crankPinMesh, liner, linerFull, linerCut, valves, spark, flash, gas, headRingFull, headRingCut, crankThrow, crankOil });
  }

  buildTiming() {
    const m = this.mat, z = -.239;
    this.timing = this.part('timing-chain', '타이밍 체인 · 2:1 구동', '크랭크 스프로킷 18개와 캠 스프로킷 36개의 톱니를 대표합니다. 체인은 같은 방향으로 구동하고 캠축은 크랭크 속도의 절반으로 회전합니다.', '강철 링크 · 경화 스프로킷', this.root, null, [.065, .17, z], 4);
    this.sprockets = [];
    for (const [kind, center, radius, teeth] of [['crank', [0, 0, z], .02075, 18], ['intake', [...this.cams.intake.center.slice(0, 2), z], .0415, 36], ['exhaust', [...this.cams.exhaust.center.slice(0, 2), z], .0415, 36]]) {
      const gear = new THREE.Group(); gear.position.set(...center); this.timing.add(gear);
      this.mesh(sprocketGeometry(teeth, radius, .007), m.steel, gear);
      this.ring(radius * .28, radius * .63, .008, m.darkSteel, gear, [0, 0, 0]);
      for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; this.cylinder(radius * .072, .0085, m.black, gear, [Math.cos(a) * radius * .48, Math.sin(a) * radius * .48, -.001], 'z', 12); }
      this.cylinder(radius * .25, .015, m.polished, gear, [0, 0, 0], 'z', 6);
      this.box([radius * .09, radius * .16, .001], m.bronze, gear, [0, radius * .78, -.0048]);
      this.sprockets.push({ kind, gear });
    }
    this.chainPath = timingPath(); this.chainCount = Math.ceil(this.chainPath.total / .007);
    const linkGeometry = new THREE.BoxGeometry(.0062, .0027, .0014); this.geometries.add(linkGeometry);
    this.chainLinks = new THREE.InstancedMesh(linkGeometry, m.darkSteel, this.chainCount * 2); this.chainLinks.castShadow = true; this.chainLinks.userData.partId = 'timing-chain'; this.timing.add(this.chainLinks);
    const pinGeometry = new THREE.CylinderGeometry(.00155, .00155, .009, 8); pinGeometry.rotateX(Math.PI / 2); this.geometries.add(pinGeometry);
    this.chainPins = new THREE.InstancedMesh(pinGeometry, m.polished, this.chainCount); this.chainPins.userData.partId = 'timing-chain'; this.timing.add(this.chainPins);
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
      for (let k = 0; k < count; k++) { const mesh = this.mesh(new THREE.SphereGeometry(.0019, 8, 6), this.mat.oil, this.oil); mesh.renderOrder = 5; mesh.userData.partId = 'oil-gallery'; this.oilParticles.push({ mesh, route: item.curve, phase: k / count }); }
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

  buildStage() {
    this.stage = new THREE.Group(); this.scene.add(this.stage);
    const material = this.material({ color: '#1d2c36', metalness: .28, roughness: .68 });
    this.floor = this.mesh(new THREE.PlaneGeometry(12, 12), material, this.stage, [0, -.133, 0]); this.floor.rotation.x = -Math.PI / 2; this.floor.castShadow = false;
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
    this.note = document.createElement('div'); this.note.className = 'engine-scene-note'; this.note.textContent = '드래그 회전 · 휠 확대 · 부품 클릭';
    this.container.append(this.leaders, this.labelLayer, this.status, this.note);
  }

  update(snapshot, view = {}) {
    if (this.disposed || !snapshot) return;
    this.restoreVisibilityMask();
    this.snapshot = snapshot; const previousMode = this.view.cylinderMode;
    this.view = { ...DEFAULT_VIEW, ...view, layers: { ...DEFAULT_VIEW.layers, ...view.layers } };
    const v = this.view, selectedCylinder = clamp(Number(v.selectedCylinder) || 1, 1, 4), single = v.cylinderMode === 'single', cut = v.mode !== 'assembled', exploded = v.mode === 'exploded' ? clamp(Number(v.explode) || 0, 0, 1) : 0;
    const selectedZ = (selectedCylinder - 2.5) * .104;
    const angle = snapshot.cycleAngleRad ?? 0;
    this.crankRotating.rotation.z = -angle; this.flywheelRotor.rotation.z = -angle;
    this.block.visible = Boolean(v.layers.block); this.head.visible = Boolean(v.layers.head); this.blockFull.visible = !cut; this.blockCut.visible = cut;
    this.headFull.visible = !cut; this.headCut.visible = cut; this.coverSolid.visible = !cut; this.coverGhost.visible = cut;
    this.block.position.x = -exploded * .09; this.head.position.y = exploded * .055; this.cover.position.y = exploded * .035;
    this.block.scale.z = single ? .27 : 1; this.block.position.z = single ? selectedZ : 0;
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
      cylinder.headRingFull.visible = !single || cylinder.number === selectedCylinder; cylinder.headRingCut.visible = !single || cylinder.number === selectedCylinder;
      for (const kind of ['intake', 'exhaust']) {
        const lift = sample.valveLifts[kind]; const valve = cylinder.valves[kind]; valve.group.position.y = exploded * .035;
        for (const instance of valve.instances) {
          instance.moving.position.copy(vec(instance.geometry.seat)).addScaledVector(vec(instance.geometry.n), -lift);
          instance.springMesh.position.y = .008; instance.springMesh.scale.y = (.019 - lift) / .019;
        }
      }
      cylinder.spark.position.y = exploded * .035;
      const stroke = STROKES[sample.stroke] || STROKES.power; cylinder.gas.material.color.setHex(stroke[1]); cylinder.gas.material.emissive.setHex(stroke[1]);
      const crown = pin.y + .026, height = Math.max(.003, .217 - crown); cylinder.gas.position.set(0, crown + height / 2, cylinder.z); cylinder.gas.scale.y = height; cylinder.gas.visible = cut && exploded === 0;
      cylinder.flash.visible = sample.phaseRad < .13 && cut && exploded === 0;
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
    for (const { kind, gear } of this.sprockets) gear.rotation.z = kind === 'crank' ? -angle : -angle / 2;
    this.pumpRotor.rotation.z = -angle;
    // The chain loop is periodic in one link pitch, avoiding a seam when the 720° angle wraps.
    const pitch = this.chainPath.total / this.chainCount, travel = -(angle / TAU * 18 % 1) * pitch;
    for (let index = 0; index < this.chainCount; index++) {
      const point = this.chainPath.sample(index * pitch + travel); this.chainDummy.position.set(point.x, point.y, -.239); this.chainDummy.rotation.set(0, 0, point.angle); this.chainDummy.updateMatrix(); this.chainPins.setMatrixAt(index, this.chainDummy.matrix);
      for (let side = 0; side < 2; side++) { this.chainDummy.position.z = -.239 + (side ? .004 : -.004); this.chainDummy.updateMatrix(); this.chainLinks.setMatrixAt(index * 2 + side, this.chainDummy.matrix); }
    }
    this.chainLinks.instanceMatrix.needsUpdate = true; this.chainPins.instanceMatrix.needsUpdate = true;
    for (const particle of this.oilParticles) particle.mesh.position.copy(particle.route.getPointAt((angle / (Math.PI * 4) + particle.phase) % 1));
    this.root.updateMatrixWorld(true);
    if (this.selectedId !== v.selectedPart) this.highlight(v.selectedPart);
    const current = samples[selectedCylinder - 1], phase = current?.phaseRad ?? 0;
    this.status.textContent = `${single ? `${selectedCylinder}번 확대` : '직렬 4기통'} · ${selectedCylinder}번 ${STROKES[current?.stroke]?.[0] || ''} · ${Math.round(phase * 180 / Math.PI)}°`;
    this.note.hidden = !exploded && !v.layers.lubrication;
    this.note.textContent = exploded && v.layers.lubrication ? '분해 위치는 관찰용 · 금색은 조립 상태의 내부 오일 경로' : exploded ? '분해 위치는 관찰용 · 조립 상태에서 캠 접촉 확인' : '금색: 내부 오일 통로 투시 · 대표 연결 · 유량 계산 아님';
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
    this.note.hidden = this.view.mode !== 'exploded' && !this.view.layers.lubrication;
    this.needsRender = true; return true;
  }

  highlight(id) {
    for (const { mesh, original, material } of this.highlighted) { mesh.material = original; for (const entry of material) entry.dispose(); }
    this.highlighted = []; this.selectedId = id;
    const component = this.components.get(id); if (!component) return;
    component.node.traverse(mesh => {
      if (!mesh.isMesh) return; const original = mesh.material, list = Array.isArray(original) ? original : [original];
      const material = list.map(value => { const copy = value.clone(); copy.emissive.set('#477a72'); copy.emissiveIntensity = .20; return copy; });
      mesh.material = Array.isArray(original) ? material : material[0]; this.highlighted.push({ mesh, original, material });
    });
  }
  isVisible(node) { for (let current = node; current; current = current.parent) if (!current.visible) return false; return true; }
  renderLabels() {
    const width = this.width, height = this.height, candidates = [], single = this.view.cylinderMode === 'single';
    for (const component of this.components.values()) {
      const entry = this.labels.get(component.id); entry.button.hidden = true; entry.line.style.display = 'none';
      if (!this.view.labels || !this.isVisible(component.node)) continue;
      if (this.inspection) {
        const inspected = this.components.get(this.inspection.partId).node;
        let ancestor = component.node; while (ancestor && ancestor !== inspected) ancestor = ancestor.parent;
        if (!ancestor) continue; // Transform-only parents do not label hidden parts.
      }
      const selected = component.id === this.view.selectedPart;
      if (component.cylinder && component.cylinder !== this.view.selectedCylinder && !selected) continue;
      if (!selected && component.priority > (width < 650 ? 4 : 8)) continue;
      const point = component.node.localToWorld(component.anchor.clone()).project(this.camera);
      if (point.z > 1 || point.z < -1 || Math.abs(point.x) > 1.25 || Math.abs(point.y) > 1.25) continue;
      candidates.push({ id: component.id, x: (point.x * .5 + .5) * width, y: (-point.y * .5 + .5) * height, priority: component.priority, selected });
    }
    for (const placement of layoutLabels(candidates, width, height)) {
      const { button, line } = this.labels.get(placement.id); button.hidden = false; button.style.left = `${placement.left}px`; button.style.top = `${placement.top}px`; button.style.width = `${placement.width}px`; button.setAttribute('aria-pressed', String(placement.selected));
      line.style.display = ''; line.setAttribute('points', `${placement.edgeX},${placement.edgeY} ${placement.x},${placement.y}`); line.classList.toggle('selected', placement.selected);
    }
  }
  pick(event) {
    if (!this.down || Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 5) return;
    const rect = this.renderer.domElement.getBoundingClientRect(); this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    for (const hit of this.raycaster.intersectObject(this.root, true)) {
      if (!this.isVisible(hit.object) || !hit.object.userData.partId || hit.object.material?.transparent && hit.object.material.opacity < .2) continue;
      this.onSelect(hit.object.userData.partId); return;
    }
  }
  resize() {
    this.width = Math.max(1, this.container.clientWidth); this.height = Math.max(1, this.container.clientHeight || 500);
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
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown); this.renderer.domElement.removeEventListener('pointerup', this.pointerUp); this.controls.dispose();
    for (const { material } of this.highlighted) for (const entry of material) entry.dispose();
    this.root.traverse(node => { if (node.isInstancedMesh) node.dispose(); });
    for (const geometry of this.geometries) geometry.dispose(); for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.environment.dispose(); this.renderer.dispose(); this.renderer.domElement.remove(); this.labelLayer.remove(); this.leaders.remove(); this.status.remove(); this.note.remove();
  }
}
