import './detail.css';
import { engineDetail } from './detail-model.js';
import { renderEngineDetails } from './detail-panel.js';
import { renderKinematicsChart, phaseFromChartClick } from './kinematics-chart.js';
import './style.css';
import { GEOMETRY, FIRING_PHASES, normalizeSettings, sampleEngine, advanceAngle, valveLift, valveTiming } from './model.js';
import { EngineScene } from './scene.js';
import { DEFAULT_VIEW, normalizeView, normalizePlaybackRate, createProject, parseProject, serializeProject } from './project.js';

const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
const TAU = Math.PI * 2, CYCLE = TAU * 2, RAD = Math.PI / 180;
const STORAGE_KEY = 'engine-lab-project-v1';
const desktop = window.engineDesktop;
const strokes = {
  power: { name: '팽창', description: '연소 후의 팽창을 표시합니다. 내려가는 피스톤과 크랭크의 연결을 살펴보세요.' },
  exhaust: { name: '배기', description: '피스톤이 올라가며 배기 밸브 쪽으로 가스를 내보내는 행정입니다.' },
  intake: { name: '흡기', description: '피스톤이 내려가며 흡기 밸브를 통해 새 혼합기를 받아들이는 행정입니다.' },
  compression: { name: '압축', description: '피스톤이 올라가 혼합기를 압축합니다. 밸브가 닫히는 시점은 행정 경계와 다릅니다.' },
};
let settings = normalizeSettings({}), view = normalizeView(DEFAULT_VIEW), angleRad = 0, playbackRate = .025;
let running = false, guidedRemaining = null, focused = false, recoveredRaw = null, scene, snapshot;
let saveTimer, toastTimer, lastFrame = performance.now(), lastReadout = 0, storageBlocked = false;
let previousExperiment = null, drawnAdvance = null, externalClock = false;

function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200);
}
function capture() {
  return createProject({ settings, angleRad, playbackRate, view, camera: scene?.getProjectCameraState?.() ?? scene?.getCameraState() ?? null });
}
function saveLocal() {
  clearTimeout(saveTimer);
  if (storageBlocked) return;
  try { localStorage.setItem(STORAGE_KEY, serializeProject(capture())); $('#save-status').textContent = '이 기기에 자동 저장됨'; }
  catch { $('#save-status').textContent = '자동 저장을 완료하지 못했습니다 · 실험 파일로 보관하세요'; }
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveLocal, 180); }
function protectOriginal(raw, futureVersion = false) {
  recoveredRaw = raw;
  try { localStorage.setItem(`${STORAGE_KEY}-original-${Date.now()}`, raw); }
  catch { storageBlocked = true; }
  if (futureVersion) {
    storageBlocked = true;
    $('#save-status').textContent = '새 버전의 자동 저장 원문을 유지합니다 · 현재 관찰은 파일로 보관하세요';
    $('#storage-recovery strong').textContent = '더 새로운 버전에서 저장한 실험입니다.';
    $('#storage-recovery p').textContent = '기존 자동 저장을 덮어쓰지 않습니다. 현재 관찰은 별도 실험 파일로 저장할 수 있습니다.';
  }
  $('#storage-recovery').hidden = false;
}
let initialCamera = null;
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const project = parseProject(raw);
      settings = project.settings; ({ angleRad, playbackRate, view } = project.observation); initialCamera = project.observation.camera;
    } catch (error) { protectOriginal(raw, error.futureVersion); }
  }
} catch { storageBlocked = true; $('#save-status').textContent = '자동 저장을 사용할 수 없습니다 · 실험 파일로 보관하세요'; }

function stop() { externalClock = false; running = false; guidedRemaining = null; syncPlayback(); scheduleSave(); }
function syncPlayback() {
  $('#play').textContent = running ? 'Ⅱ 일시정지' : '▶ 재생';
  $('#play').setAttribute('aria-label', running ? '일시정지' : '재생');
  $('#one-cycle').classList.toggle('active', guidedRemaining !== null);
}
function setAngle(value) { stop(); angleRad = ((value % CYCLE) + CYCLE) % CYCLE; refresh(true); scheduleSave(); }
function readProject(project) {
  // Validate the complete replacement before touching the current experiment.
  const validated = parseProject(serializeProject(project));
  stop(); scene?.restoreInspection?.(); settings = validated.settings;
  ({ angleRad, playbackRate, view } = validated.observation);
  syncControls(); refresh(true);
  if (validated.observation.camera) scene.restoreCameraState(validated.observation.camera);
  else scene.setCameraPreset('iso');
  saveLocal();
}
function reset() {
  previousExperiment = capture(); $('#undo-new').hidden = false;
  stop(); scene?.restoreInspection?.(); settings = normalizeSettings({}); view = normalizeView(DEFAULT_VIEW); angleRad = 0; playbackRate = .025;
  syncControls(); refresh(true); scene.setCameraPreset('iso'); saveLocal();
  toast('새 실험을 시작했습니다. 아래의 되돌리기로 이전 관찰을 복구할 수 있습니다.');
}
function selectPart(id) {
  view.selectedPart = id;
  const cylinderMatch = /^c([1-4])-/.exec(id);
  if (cylinderMatch) view.selectedCylinder = Number(cylinderMatch[1]);
  syncControls(); refresh(true); scheduleSave();
}
function focusView(value = !focused) {
  focused = value; document.body.classList.toggle('focus-mode', focused);
  if (focused) { clearTimeout(toastTimer); $('#toast').hidden = true; }
  $('#focus-view').textContent = focused ? '전체 화면 구성' : '크게 보기';
  requestAnimationFrame(() => { $('#scene').scrollIntoView({ block: 'nearest' }); $('#scene').focus({ preventScroll: true }); });
}
function begin() { externalClock = false; running = true; guidedRemaining = null; lastFrame = performance.now(); syncPlayback(); }
function toggle() { if (running) stop(); else begin(); }
function syncRange(selector, value, step) {
  const input = $(selector), grid = (value - Number(input.min)) / step;
  // Imported experiments may contain valid values between the normal slider ticks.
  input.step = Math.abs(grid - Math.round(grid)) < 1e-9 ? String(step) : 'any';
  input.value = value;
}
function syncControls() {
  syncRange('#rpm', settings.rpm, 100); $('#rpm-value').textContent = `${settings.rpm.toLocaleString('ko-KR')} rpm`;
  const advanceDegrees = settings.intakeAdvanceRad / RAD;
  syncRange('#cam-advance', advanceDegrees, 1);
  $('#cam-value').textContent = `${advanceDegrees > 0 ? '+' : ''}${advanceDegrees.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}°`;
  const rate = $('#playback-rate');
  rate.querySelector('[data-custom]')?.remove();
  if (![...rate.options].some(option => Math.abs(Number(option.value) - playbackRate) < 1e-10)) {
    const option = document.createElement('option'); option.dataset.custom = 'true'; option.value = String(playbackRate);
    option.textContent = `1/${(1 / playbackRate).toFixed(1)} · 안내 속도`; rate.append(option);
  }
  rate.value = String(playbackRate);
  $('#visible-speed').textContent = `화면에서는 ${(settings.rpm * playbackRate).toFixed(1)} rpm으로 움직입니다.`;
  $('#selected-cylinder').value = view.selectedCylinder;
  $('#explode').value = view.explode; $('#explode').disabled = view.mode !== 'exploded'; $('#labels').checked = view.labels;
  $$('[data-mode]').forEach(button => button.setAttribute('aria-pressed', button.dataset.mode === view.mode));
  $$('[data-cylinder-mode]').forEach(button => button.setAttribute('aria-pressed', button.dataset.cylinderMode === view.cylinderMode));
  $$('[data-layer]').forEach(input => { input.checked = view.layers[input.dataset.layer]; });
  if ($('#part-select').querySelector(`option[value="${CSS.escape(view.selectedPart)}"]`)) $('#part-select').value = view.selectedPart;
  syncPlayback();
}
function refresh(force = false) {
  snapshot = sampleEngine(angleRad, settings);
  scene.update(snapshot, view);
  const now = performance.now(); if (!force && now - lastReadout < 60) return;
  lastReadout = now;
  const cylinder = snapshot.cylinders[view.selectedCylinder - 1], stroke = strokes[cylinder.stroke];
  const angleDeg = snapshot.cycleAngleRad / RAD;
  $('#angle').value = angleDeg; $('#angle-value').textContent = `${angleDeg.toFixed(0)}°`;
  $('#cam-angle').textContent = `${(snapshot.camAngles.exhaust / RAD).toFixed(0)}°`;
  $('#scene-caption').textContent = `${view.selectedCylinder}번 실린더 · ${stroke.name} 행정${guidedRemaining !== null ? ' · 한 사이클 관찰 중' : ''}`;
  $('#cylinder-title').textContent = `${view.selectedCylinder}번 실린더`;
  $('#phase-reference').textContent = `${view.selectedCylinder}번 실린더 기준 행정으로 이동`;
  $('#stroke-name').textContent = stroke.name; $('#stroke-name').className = `stroke-badge ${cylinder.stroke}`;
  $('#stroke-description').textContent = stroke.description;
  $('#piston-travel').textContent = `${((GEOMETRY.stroke / 2 + GEOMETRY.rodLength - cylinder.pistonPin.y) * 1000).toFixed(1)} mm`;
  $('#intake-lift').textContent = `${(cylinder.valveLifts.intake * 1000).toFixed(2)} mm`;
  $('#exhaust-lift').textContent = `${(cylinder.valveLifts.exhaust * 1000).toFixed(2)} mm`;
  refreshValveChart(cylinder);
  renderEngineDetails(snapshot, settings, view, scene.getInspectionState?.());
  renderKinematicsChart(snapshot, settings, view.selectedCylinder);
  for (const c of snapshot.cylinders) {
    $(`#marker-${c.id}`).style.left = `calc(${(c.phaseRad / CYCLE * 100).toFixed(4)}% - 1.5px)`;
    $(`#stroke-${c.id}`).textContent = strokes[c.stroke].name; $(`#stroke-${c.id}`).className = c.stroke;
    $(`[data-cylinder-row="${c.id}"]`).setAttribute('aria-pressed', c.id === view.selectedCylinder);
  }
  const part = scene.getComponents().find(component => component.id === view.selectedPart);
  if (part) {
    $('#part-title').textContent = part.name; $('#part-material').textContent = part.material || '대표 기구';
    $('#part-description').textContent = part.description;
  }
  const overlap = cylinder.valveLifts.intake > 1e-7 && cylinder.valveLifts.exhaust > 1e-7;
  $('#cycle-explanation').textContent = overlap
    ? `${view.selectedCylinder}번은 밸브 오버랩 중입니다. 흡기와 배기가 동시에 열리는 순간을 관찰하세요.`
    : '같은 피스톤 높이라도 행정은 다릅니다. 1번과 4번을 번갈아 살펴보세요.';
}

function refreshValveChart(cylinder) {
  if (drawnAdvance !== settings.intakeAdvanceRad) {
    const curve = (kind, values) => Array.from({ length: 361 }, (_, i) => {
      const degrees = i * 2, y = 66 - valveLift(degrees * RAD, kind, values) / GEOMETRY.valveMaxLift * 42;
      return `${i ? 'L' : 'M'}${degrees} ${y.toFixed(3)}`;
    }).join(' ');
    $('#valve-baseline').setAttribute('d', curve('intake', { intakeAdvanceRad: 0 }));
    $('#valve-exhaust').setAttribute('d', curve('exhaust', settings));
    $('#valve-intake').setAttribute('d', curve('intake', settings));
    const timing = valveTiming(settings), degrees = value => (value / RAD).toFixed(0);
    $('#valve-events').textContent = `흡기 ${degrees(timing.intake.open)}–${degrees(timing.intake.close)}° · 배기 ${degrees(timing.exhaust.open)}–${degrees(timing.exhaust.close)}° · 오버랩 ${degrees(timing.overlapRad)}°`;
    drawnAdvance = settings.intakeAdvanceRad;
  }
  const phase = cylinder.phaseRad / RAD;
  $('#timing-cylinder').textContent = `${cylinder.id}번 실린더`;
  $('#valve-angle').value = phase; $('#valve-angle-value').textContent = `${phase.toFixed(0)}°`;
  for (const name of ['x1', 'x2']) $('#valve-cursor').setAttribute(name, phase);
  for (const kind of ['intake', 'exhaust']) {
    $(`#${kind}-dot`).setAttribute('cx', phase);
    $(`#${kind}-dot`).setAttribute('cy', 66 - cylinder.valveLifts[kind] / GEOMETRY.valveMaxLift * 42);
  }
}

async function downloadText(text, name) {
  if (desktop) return desktop.saveProject({ contents: text, name });
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { canceled: false };
}
async function saveFile() {
  try { const result = await downloadText(serializeProject(capture()), '엔진 관찰.engine.json'); if (!result.canceled) toast('현재 설정·각도·시점을 파일로 저장했습니다.'); }
  catch (error) { toast(`저장하지 못했습니다. ${error.message}`); }
}
function importText(text) {
  const candidate = parseProject(text); readProject(candidate); toast('저장한 엔진 관찰을 불러왔습니다.');
}
async function openFile() {
  try {
    if (desktop) { const result = await desktop.openProject(); if (!result.canceled) importText(result.content); }
    else { $('#file-input').value = ''; $('#file-input').click(); }
  } catch (error) { toast(`불러오지 못했습니다. 현재 관찰은 유지합니다. ${error.message}`); }
}
function stepSimulation(realSeconds) {
  if (!running) return;
  let simulatedSeconds = realSeconds * playbackRate;
  const increment = simulatedSeconds * settings.rpm * TAU / 60;
  if (guidedRemaining !== null && increment >= guidedRemaining) {
    simulatedSeconds = guidedRemaining * 60 / (settings.rpm * TAU);
    angleRad = advanceAngle(angleRad, simulatedSeconds, settings);
    angleRad = 0; stop(); toast('한 사이클 완료 · 크랭크 2회전, 캠 1회전');
  } else {
    angleRad = advanceAngle(angleRad, simulatedSeconds, settings);
    if (guidedRemaining !== null) guidedRemaining -= increment;
  }
}

try {
  scene = new EngineScene($('#scene'), { onSelect: selectPart });
  for (const part of scene.getComponents()) {
    const option = document.createElement('option'); option.value = part.id; option.textContent = part.name; $('#part-select').append(option); $('#focus-part-select').append(option.cloneNode(true));
  }
  $('#cylinder-timeline').innerHTML = [1, 2, 3, 4].map(id => `<div class="cylinder-row"><button data-cylinder-row="${id}">${id}번</button><div class="cycle-track"><i class="cycle-marker" id="marker-${id}"></i></div><span id="stroke-${id}"></span></div>`).join('');
  syncControls(); refresh(true);
  if (initialCamera) scene.restoreCameraState(initialCamera); else scene.setCameraPreset('iso');
  $('#play').addEventListener('click', toggle);
  $('#step').addEventListener('click', () => setAngle(angleRad + 10 * RAD));
  $('#reset-angle').addEventListener('click', () => setAngle(0));
  $('#angle').addEventListener('input', event => setAngle(Number(event.target.value) * RAD));
  $('#valve-angle').addEventListener('input', event => setAngle(Number(event.target.value) * RAD + FIRING_PHASES[view.selectedCylinder - 1]));
  $('#show-overlap').addEventListener('click', () => {
    const { intake, exhaust } = valveTiming(settings);
    setAngle((Math.max(intake.open, exhaust.open) + Math.min(intake.close, exhaust.close)) / 2 + FIRING_PHASES[view.selectedCylinder - 1]);
  });
  $('#one-cycle').addEventListener('click', () => {
    externalClock = false; scene.restoreInspection?.(); angleRad = 0; view.selectedCylinder = 1; view.selectedPart = 'c1-piston'; playbackRate = normalizePlaybackRate(15 / settings.rpm);
    guidedRemaining = CYCLE; running = true; lastFrame = performance.now(); syncControls(); refresh(true);
    if (view.cylinderMode === 'single') scene.setCameraPreset('iso');
    $('#scene').scrollIntoView({ block: 'nearest' }); $('#scene').focus({ preventScroll: true });
  });
  $('#rpm').addEventListener('input', event => { stop(); settings = normalizeSettings({ ...settings, rpm: Number(event.target.value) }); syncControls(); refresh(true); scheduleSave(); });
  $('#cam-advance').addEventListener('input', event => { settings = normalizeSettings({ ...settings, intakeAdvanceRad: Number(event.target.value) * RAD }); syncControls(); refresh(true); scheduleSave(); });
  $('#reset-timing').addEventListener('click', () => { settings = normalizeSettings({ ...settings, intakeAdvanceRad: 0 }); syncControls(); refresh(true); scheduleSave(); });
  $('#playback-rate').addEventListener('change', event => { guidedRemaining = null; playbackRate = normalizePlaybackRate(Number(event.target.value)); syncControls(); scheduleSave(); });
  $('#selected-cylinder').addEventListener('change', event => { view.selectedCylinder = Number(event.target.value); view.selectedPart = `c${view.selectedCylinder}-piston`; syncControls(); refresh(true); if (view.cylinderMode === 'single') scene.setCameraPreset('iso'); scheduleSave(); });
  $$('[data-cylinder-row]').forEach(button => button.addEventListener('click', () => selectPart(`c${button.dataset.cylinderRow}-piston`)));
  $$('[data-cylinder-mode]').forEach(button => button.addEventListener('click', () => { view.cylinderMode = button.dataset.cylinderMode; syncControls(); refresh(true); scene.setCameraPreset('iso'); scheduleSave(); }));
  $$('[data-mode]').forEach(button => button.addEventListener('click', () => { view.mode = button.dataset.mode; syncControls(); refresh(true); scheduleSave(); }));
  $$('[data-phase]').forEach(button => button.addEventListener('click', () => setAngle(Number(button.dataset.phase) * RAD + FIRING_PHASES[view.selectedCylinder - 1])));
  $$('[data-camera]').forEach(button => button.addEventListener('click', () => { scene.setCameraPreset(button.dataset.camera); scheduleSave(); }));
  $$('[data-layer]').forEach(input => input.addEventListener('change', () => { view.layers[input.dataset.layer] = input.checked; refresh(true); scheduleSave(); }));
  $('#explode').addEventListener('input', event => { view.explode = Number(event.target.value); refresh(true); scheduleSave(); });
  $('#labels').addEventListener('change', event => { view.labels = event.target.checked; refresh(true); scheduleSave(); });
  $('#part-select').addEventListener('change', event => selectPart(event.target.value));
  $('#focus-view').addEventListener('click', () => focusView());
  const inspectSelected = () => {
    const inspection = scene.getInspectionState?.();
    if (inspection?.active && inspection.partId === view.selectedPart) scene.restoreInspection();
    else if (!scene.inspectPart(view.selectedPart)) toast('이 부품을 현재 화면에서 확대할 수 없습니다. 관찰 범위와 구조 레이어를 확인해 주세요.');
    refresh(true);
  };
  $('#inspect-part').addEventListener('click', inspectSelected); $('#focus-inspect-part').addEventListener('click', inspectSelected);
  $('#restore-inspection').addEventListener('click', () => { scene.restoreInspection(); refresh(true); });
  $('#focus-part-select').addEventListener('change', event => selectPart(event.target.value));
  $('#piston-metric').addEventListener('change', () => refresh(true));
  $('#piston-chart').addEventListener('click', event => setAngle(phaseFromChartClick(event) + FIRING_PHASES[view.selectedCylinder - 1]));
  $('#save-project').addEventListener('click', saveFile); $('#open-project').addEventListener('click', openFile);
  $('#undo-new').addEventListener('click', () => {
    if (!previousExperiment) return;
    readProject(previousExperiment); previousExperiment = null; $('#undo-new').hidden = true;
    toast('새 실험을 시작하기 전의 설정·각도·시점을 복구했습니다.');
  });
  $('#help').addEventListener('click', () => $('#help-dialog').showModal()); $('#close-help').addEventListener('click', () => $('#help-dialog').close());
  $('#file-input').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try { if (file.size > 10 * 1024 * 1024) throw new Error('실험 파일은 10 MiB 이하여야 합니다.'); importText(await file.text()); }
    catch (error) { toast(`불러오지 못했습니다. 현재 관찰은 유지합니다. ${error.message}`); }
  });
  $('#recover-original').addEventListener('click', async () => {
    if (recoveredRaw === null) return;
    try {
      if (desktop) {
        // Native JSON validation deliberately rejects corrupt JSON. Preserve arbitrary
        // recovery text through the browser download path, whose filename remains local.
        const url = URL.createObjectURL(new Blob([recoveredRaw], { type: 'text/plain' }));
        const a = document.createElement('a'); a.href = url; a.download = '엔진-저장원문.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else await downloadText(recoveredRaw, '엔진-저장원문.txt');
    } catch (error) { toast(`원문을 보관하지 못했습니다. ${error.message}`); }
  });
  $('#dismiss-recovery').addEventListener('click', () => { $('#storage-recovery').hidden = true; });
  $('#scene').addEventListener('pointerup', scheduleSave); $('#scene').addEventListener('wheel', scheduleSave, { passive: true });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(event.target.tagName) || event.target.isContentEditable || $('#help-dialog').open) return;
    if (event.code === 'Space') { event.preventDefault(); toggle(); }
    else if (event.code === 'ArrowRight' || event.code === 'ArrowLeft') { event.preventDefault(); setAngle(angleRad + (event.code === 'ArrowRight' ? 10 : -10) * RAD); }
    else if (event.code === 'KeyF') { event.preventDefault(); focusView(); }
  });
  desktop?.onCommand(command => {
    if (command === 'new-project') reset(); else if (command === 'save-project') saveFile(); else if (command === 'open-project') openFile();
    else if (command === 'toggle-running') toggle(); else if (command === 'focus') focusView(); else if (command === 'help') $('#help-dialog').showModal();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); lastFrame = performance.now(); });
  window.addEventListener('beforeunload', saveLocal);
  window.engineLab = {
    getState: () => ({ settings: structuredClone(settings), view: structuredClone(view), angleRad, playbackRate, running, guidedRemaining, focused, snapshot: structuredClone(snapshot), detail: engineDetail(snapshot, settings, view.selectedCylinder), inspection: scene.getInspectionState?.() }),
    project: capture, loadProject: importText, reset, setAngle,
    step: seconds => { stepSimulation(seconds); refresh(true); },
    camera: () => scene.getCameraState(), components: () => scene.getComponents(), sceneDebug: () => scene.getDebug?.(),
  };
  const frame = now => { const dt = Math.max(0, (now - lastFrame) / 1000); lastFrame = now; if (running && !externalClock) { stepSimulation(dt); refresh(); } requestAnimationFrame(frame); };
  window.advanceTime = ms => {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60000) throw new RangeError('진행 시간은 0–60000 밀리초여야 합니다.');
    externalClock = true; stepSimulation(ms / 1000); refresh(true);
  };
  window.render_game_to_text = () => JSON.stringify({ coordinateSystem: 'm, s, rad; +Y up, +Z crank/cam axle; imposed constant rpm, no combustion dynamics', ...window.engineLab.getState() });
  requestAnimationFrame(frame);
} catch (error) {
  console.error(error); $('#scene').innerHTML = '<p class="fatal">3D 화면을 시작하지 못했습니다.<br>앱을 다시 실행해 주세요.</p>';
  $('#save-status').textContent = '화면 초기화 실패';
}
