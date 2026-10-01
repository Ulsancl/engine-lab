import { MODEL_VERSION, normalizeSettings } from './model.js';

export const projectType = 'engine-lab-project';
export const projectVersion = 1;
export const projectModelVersion = MODEL_VERSION;
const MAX_BYTES = 10 * 1024 * 1024;
const CYCLE = 4 * Math.PI;
const DEFAULT_RATE = .025;
const CAMERA_DISTANCE_EPSILON = 1e-10;
const modes = ['assembled', 'cutaway', 'exploded'];
const cylinderModes = ['all', 'single'];
const layerKeys = ['block', 'head', 'timing', 'lubrication'];
const partIds = new Set([
  'block', 'head', 'cam-cover', 'crankshaft', 'intake-camshaft', 'exhaust-camshaft',
  'timing-chain', 'timing-guide', 'oil-pump', 'oil-filter', 'oil-gallery', 'oil-pan', 'flywheel',
  ...Array.from({ length: 5 }, (_, i) => `main-bearing-${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => ['piston', 'rings', 'pin', 'rod', 'liner',
    'intake-valves', 'exhaust-valves', 'spark-plug'].map(part => `c${i + 1}-${part}`)).flat(),
]);
export const DEFAULT_VIEW = Object.freeze({
  cylinderMode: 'all', selectedCylinder: 1, mode: 'cutaway', explode: .35, labels: true,
  layers: Object.freeze({ block: true, head: true, timing: true, lubrication: false }),
  selectedPart: 'c1-piston',
});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export class ProjectError extends Error {
  constructor(message, code = 'INVALID_PROJECT') {
    super(`${message} 원본 파일은 변경하지 않습니다.`);
    this.name = 'ProjectError';
    this.code = code;
    this.preserveOriginal = true;
    this.futureVersion = code === 'FUTURE_SCHEMA' || code === 'FUTURE_MODEL';
  }
}
const fail = (message, code) => { throw new ProjectError(message, code); };
function shape(value, required, label, optional = []) {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    fail(`${label}에 누락되거나 지원하지 않는 항목이 있습니다.`);
  }
}
function numeric(value, label, low, high) {
  if (!finite(value) || value < low || value > high) fail(`${label} 수치가 올바르지 않습니다.`);
}

export function normalizePlaybackRate(value) {
  return finite(value) ? clamp(value, .001, 1) : DEFAULT_RATE;
}

export function normalizeView(input) {
  const value = record(input) ? input : {};
  const layers = record(value.layers) ? value.layers : {};
  return {
    cylinderMode: cylinderModes.includes(value.cylinderMode) ? value.cylinderMode : DEFAULT_VIEW.cylinderMode,
    selectedCylinder: finite(value.selectedCylinder) ? clamp(Math.round(value.selectedCylinder), 1, 4) : DEFAULT_VIEW.selectedCylinder,
    mode: modes.includes(value.mode) ? value.mode : DEFAULT_VIEW.mode,
    explode: finite(value.explode) ? clamp(value.explode, 0, 1) : DEFAULT_VIEW.explode,
    labels: typeof value.labels === 'boolean' ? value.labels : DEFAULT_VIEW.labels,
    layers: Object.fromEntries(layerKeys.map(key => [key, typeof layers[key] === 'boolean' ? layers[key] : DEFAULT_VIEW.layers[key]])),
    selectedPart: partIds.has(value.selectedPart) ? value.selectedPart : DEFAULT_VIEW.selectedPart,
  };
}

function savedView(value) {
  shape(value, ['cylinderMode', 'selectedCylinder', 'mode', 'explode', 'labels', 'layers', 'selectedPart'], '관찰 화면');
  if (!cylinderModes.includes(value.cylinderMode) || !modes.includes(value.mode)
    || !partIds.has(value.selectedPart)) fail('지원하지 않는 관찰 방식 또는 부품입니다.');
  numeric(value.selectedCylinder, '선택 실린더', 1, 4);
  if (!Number.isInteger(value.selectedCylinder)) fail('선택 실린더는 1부터 4까지의 정수여야 합니다.');
  numeric(value.explode, '분해 간격', 0, 1);
  if (typeof value.labels !== 'boolean') fail('이름표 표시가 올바르지 않습니다.');
  shape(value.layers, layerKeys, '부품 표시');
  if (layerKeys.some(key => typeof value.layers[key] !== 'boolean')) fail('부품 표시 상태가 올바르지 않습니다.');
  return normalizeView(value);
}

function savedCamera(value) {
  if (value === null) return null;
  shape(value, ['position', 'target'], '카메라', ['zoom']);
  for (const key of ['position', 'target']) {
    if (!Array.isArray(value[key]) || value[key].length !== 3) fail('카메라 좌표는 세 개의 수치여야 합니다.');
    for (const coordinate of value[key]) numeric(coordinate, '카메라 좌표', -100, 100);
  }
  const distance = Math.hypot(...value.position.map((coordinate, index) => coordinate - value.target[index]));
  // Match the scene's restore contract; unsupported cameras must not be silently
  // replaced with a different view when reading an original experiment file.
  numeric(distance, '카메라 거리', .17 - CAMERA_DISTANCE_EPSILON, 2.7 + CAMERA_DISTANCE_EPSILON);
  if (Object.hasOwn(value, 'zoom')) numeric(value.zoom, '카메라 확대', .25, 4);
  return { position: [...value.position], target: [...value.target],
    ...(Object.hasOwn(value, 'zoom') ? { zoom: value.zoom } : {}) };
}

function savedSettings(value) {
  shape(value, ['rpm', 'intakeAdvanceRad'], '운동 조건');
  for (const key of ['rpm', 'intakeAdvanceRad']) if (!finite(value[key])) fail('운동 조건은 유한한 수치여야 합니다.');
  const normalized = normalizeSettings(value);
  if (normalized.rpm !== value.rpm || normalized.intakeAdvanceRad !== value.intakeAdvanceRad) {
    fail('운동 조건이 지원 범위를 벗어났습니다. 각도 단위는 라디안입니다.');
  }
  return { rpm: normalized.rpm, intakeAdvanceRad: normalized.intakeAdvanceRad };
}

function validateProject(value) {
  if (!record(value) || value.type !== projectType) fail('지원하지 않는 엔진 실험 파일입니다.', 'UNSUPPORTED_FORMAT');
  if (Number.isInteger(value.schemaVersion) && value.schemaVersion > projectVersion) fail('새로운 저장 형식을 보호합니다.', 'FUTURE_SCHEMA');
  if (value.schemaVersion !== projectVersion) fail('지원하지 않는 저장 형식 버전입니다.', 'UNSUPPORTED_SCHEMA');
  if (value.modelVersion !== projectModelVersion) {
    const candidate = typeof value.modelVersion === 'string' ? /^engine-kinematics-(\d+)$/.exec(value.modelVersion) : null;
    fail('이 운동 모형 버전의 원래 기록을 보호합니다.', candidate && Number(candidate[1]) > 1 ? 'FUTURE_MODEL' : 'UNSUPPORTED_MODEL');
  }
  shape(value, ['type', 'schemaVersion', 'modelVersion', 'settings', 'observation'], '엔진 실험 파일');
  const settings = savedSettings(value.settings);
  shape(value.observation, ['angleRad', 'playbackRate', 'view', 'camera'], '관찰 기록');
  const observed = value.observation;
  numeric(observed.angleRad, '크랭크 각도', 0, CYCLE);
  if (observed.angleRad === CYCLE) fail('크랭크 각도는 4π 라디안 미만이어야 합니다.');
  numeric(observed.playbackRate, '관찰 재생 속도', .001, 1);
  return { type: projectType, schemaVersion: projectVersion, modelVersion: projectModelVersion,
    settings, observation: { angleRad: observed.angleRad, playbackRate: observed.playbackRate,
      view: savedView(observed.view), camera: savedCamera(observed.camera) } };
}

export function createProject(input = {}) {
  const value = record(input) ? input : {};
  const settings = normalizeSettings(record(value.settings) ? value.settings : {});
  const angle = finite(value.angleRad) ? value.angleRad : 0;
  const remainder = angle % CYCLE;
  const wrapped = remainder < 0 ? remainder + CYCLE : remainder;
  // Tiny negative inputs can round to exactly CYCLE when the period is added.
  const angleRad = wrapped === 0 || wrapped === CYCLE ? 0 : wrapped;
  let camera = null;
  if (value.camera !== undefined && value.camera !== null) {
    try { camera = savedCamera(value.camera); } catch (error) { if (!(error instanceof ProjectError)) throw error; }
  }
  return { type: projectType, schemaVersion: projectVersion, modelVersion: projectModelVersion,
    settings: { rpm: settings.rpm, intakeAdvanceRad: settings.intakeAdvanceRad },
    observation: { angleRad, playbackRate: normalizePlaybackRate(value.playbackRate), view: normalizeView(value.view), camera } };
}

export function parseProject(text) {
  if (typeof text !== 'string') fail('실험 파일은 JSON 텍스트여야 합니다.', 'INVALID_JSON');
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) fail('실험 파일은 10 MiB 이하여야 합니다.', 'PROJECT_TOO_LARGE');
  let value;
  // Windows text editors may prefix UTF-8 JSON with one byte-order mark.
  // Ignore it for parsing only; callers keep the untouched original for recovery.
  try { value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); }
  catch { fail('JSON 실험 파일을 읽을 수 없습니다.', 'INVALID_JSON'); }
  return validateProject(value);
}

export function serializeProject(project) {
  return JSON.stringify(validateProject(project), null, 2);
}
