import { GEOMETRY, sampleEngine, valveLift, valveTiming } from './model.js';
import { engineDetail } from './detail-model.js';

const RAD = Math.PI / 180;
const CYCLE_DEG = 720;
const LEFT = 46, RIGHT = 706;
const VALVE_ROW = { top: 30, bottom: 111 };
const PISTON_ROWS = [
  { top: 160, bottom: 229 },
  { top: 270, bottom: 339 },
  { top: 380, bottom: 449 },
];
const metrics = {
  travel: { field: 'travelFromTdcM', scale: 1000, unit: 'mm', digits: 1, label: '피스톤 하강 거리', direction: '상사점에서 아래쪽으로 잰 거리입니다.' },
  velocity: { field: 'velocityYMps', scale: 1, unit: 'm/s', digits: 2, label: '피스톤 속도', direction: '+는 위쪽, −는 아래쪽 운동입니다.' },
  acceleration: { field: 'accelerationYMps2', scale: 1, unit: 'm/s²', digits: 1, label: '피스톤 가속도', direction: '+는 위쪽, −는 아래쪽 가속도입니다. 힘을 계산한 값은 아닙니다.' },
};
const valveKinds = ['intake', 'exhaust'];
const phases = Array.from({ length: 361 }, (_, index) => index * 2);
const anchors = [0, 180, 360, 540, CYCLE_DEG];
const strokeNames = ['팽창', '배기', '흡기', '압축'];
const strokeClasses = ['power', 'exhaust', 'intake', 'compression'];
const x = degrees => LEFT + degrees / CYCLE_DEG * (RIGHT - LEFT);
const y = (value, [low, high], row) => row.bottom - (value - low) / (high - low) * (row.bottom - row.top);
const numberFormats = [1, 2].map(digits => new Intl.NumberFormat('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const angleFormat = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 3 });
const degreesLabel = radians => `${angleFormat.format(radians / RAD)}°`;
const axisLabel = value => Math.abs(value) >= 1000 ? `${value / 1000}k` : Number(value.toFixed(2));
const valueFor = (detail, { field, scale }) => detail.piston[field] * scale;
const valveBounds = [0, GEOMETRY.valveMaxLift * 1000];

let nodes, pistonSeries, activeMetric, currentRpm, valveKey, layoutKey;
let activePlots = [];

function plotGrid(row) {
  return `<rect class="condition-grid-bg" x="${LEFT}" y="${row.top}" width="${RIGHT - LEFT}" height="${row.bottom - row.top}"/>
    <path class="kinematic-grid" d="M${LEFT} ${row.top}H${RIGHT} M${LEFT} ${row.bottom}H${RIGHT} ${anchors.map(degrees => `M${x(degrees)} ${row.top}V${row.bottom}`).join(' ')}"/>`;
}

function mountChart() {
  const get = id => document.getElementById(id);
  const chart = get('piston-chart'), header = get('piston-chart-cylinder');
  const current = get('piston-current-value'), controls = current.parentElement;
  header.previousSibling.textContent = '밸브와 피스톤의 움직임 ';
  controls.insertAdjacentHTML('beforebegin', `<dl class="condition-readouts" aria-label="같은 순간의 계산값">
    <div><dt>크랭크 · 1번 기준</dt><dd id="condition-crank"></dd></div>
    <div class="intake"><dt>흡기 리프트</dt><dd id="condition-intake"></dd></div>
    <div class="exhaust"><dt>배기 리프트</dt><dd id="condition-exhaust"></dd></div>
    <div><dt>피스톤 하강 거리</dt><dd id="condition-travel"></dd></div>
    <div><dt>피스톤 속도 · 위쪽 +</dt><dd id="condition-velocity"></dd></div>
  </dl>`);
  chart.insertAdjacentHTML('afterend', `<p id="condition-axis-note" class="hint">선택 실린더의 팽창 시작이 0°, 배기에서 흡기로 넘어가는 상사점이 360°입니다.</p>
    <dl class="condition-events" aria-label="밸브 열림과 닫힘 각도">
      <div class="intake"><dt>흡기</dt><dd id="condition-intake-event"></dd></div>
      <div class="exhaust"><dt>배기</dt><dd id="condition-exhaust-event"></dd></div>
      <div><dt>오버랩</dt><dd id="condition-overlap"></dd></div>
    </dl>`);
  const chartInstructions = get('piston-chart-note').nextElementSibling;
  chartInstructions.id = 'condition-chart-interaction';
  chartInstructions.textContent = '그래프를 누르거나 방향키 ←/→로 10°씩 이동하세요. 1°씩 조정하려면 선택 실린더 각도 막대를 사용하세요.';
  chart.setAttribute('aria-describedby', 'condition-axis-note condition-chart-interaction');
  chart.setAttribute('tabindex', '0');
  chart.innerHTML = `<title>밸브 리프트와 피스톤 운동의 크랭크각 비교</title>
    <rect id="condition-overlap-band" y="${VALVE_ROW.top}"/>
    <g>
      ${plotGrid(VALVE_ROW)}
      <text class="condition-plot-label" x="${LEFT}" y="18">밸브 리프트 · mm</text>
      <text class="condition-baseline-label" x="${RIGHT}" y="18" text-anchor="end">┄ 기본 흡기</text>
      <text class="condition-axis-value" x="40" y="${VALVE_ROW.top + 5}">${valveBounds[1]}</text>
      <text class="condition-axis-value" x="40" y="${VALVE_ROW.bottom + 5}">0</text>
      <path id="condition-baseline-curve" class="condition-baseline-curve"/>
      ${valveKinds.map(kind => `<path id="condition-${kind}-curve" class="condition-${kind}-curve"/>
        <path id="condition-${kind}-window" class="condition-${kind}-window"/>`).join('')}
    </g>
    ${PISTON_ROWS.map((row, index) => {
      const prefix = index === 0 ? 'piston' : `condition-piston-${index}`;
      return `<g id="condition-piston-row-${index}">
        ${plotGrid(row)}
        <text id="${prefix}-label" class="condition-plot-label" x="${LEFT}" y="${row.top - 12}"></text>
        <text id="${prefix}-metric-unit" class="condition-axis-unit" x="${RIGHT}" y="${row.top - 12}" text-anchor="end"></text>
        <text id="${prefix}-axis-top" class="condition-axis-value" x="40" y="${row.top + 5}"></text>
        <text id="${prefix}-axis-bottom" class="condition-axis-value" x="40" y="${row.bottom + 5}"></text>
        <line id="${prefix}-zero" class="condition-zero" x1="${LEFT}" x2="${RIGHT}"/>
        <path id="${prefix}-curve" class="condition-piston-curve"/>
      </g>`;
    }).join('')}
    <g id="condition-anchors">
      ${anchors.slice(0, -1).map((degrees, index) => `<rect x="${x(degrees)}" y="2" width="${x(180) - LEFT}" height="23" class="condition-stroke ${strokeClasses[index]}"/>
        <text class="condition-stroke-label ${strokeClasses[index]}" x="${x(degrees + 90)}" y="19" text-anchor="middle">${strokeNames[index]}</text>`).join('')}
      ${anchors.map((degrees, index) => `<text class="condition-anchor" x="${x(degrees)}" y="43" text-anchor="${index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}">${degrees}°</text>
        <text class="condition-dead-center" x="${x(degrees)}" y="64" text-anchor="${index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}">${index % 2 ? '하사점' : '상사점'}</text>`).join('')}
    </g>
    <line id="piston-cursor" y1="${VALVE_ROW.top}"/>
    ${valveKinds.map(kind => `<circle id="condition-${kind}-dot" class="condition-${kind}-dot" r="3.8"/>`).join('')}
    <circle id="piston-dot" class="condition-piston-dot" r="4"/>
    <circle id="condition-piston-1-dot" class="condition-piston-dot" r="4"/>
    <circle id="condition-piston-2-dot" class="condition-piston-dot" r="4"/>`;

  const valves = Object.fromEntries(valveKinds.map(kind => [kind, {
    curve: get(`condition-${kind}-curve`), window: get(`condition-${kind}-window`),
    dot: get(`condition-${kind}-dot`), event: get(`condition-${kind}-event`), readout: get(`condition-${kind}`),
  }]));
  const piston = PISTON_ROWS.map((position, index) => {
    const prefix = index === 0 ? 'piston' : `condition-piston-${index}`;
    return { position, group: get(`condition-piston-row-${index}`), label: get(`${prefix}-label`),
      unit: get(`${prefix}-metric-unit`), high: get(`${prefix}-axis-top`), low: get(`${prefix}-axis-bottom`),
      zero: get(`${prefix}-zero`), curve: get(`${prefix}-curve`), dot: get(`${prefix}-dot`) };
  });
  get('condition-baseline-curve').setAttribute('d', valveCurve('intake', {}));
  return { chart, header, valves, piston, cursor: get('piston-cursor'), anchors: get('condition-anchors'),
    band: get('condition-overlap-band'), overlap: get('condition-overlap'), metric: get('piston-metric'),
    note: get('piston-chart-note'), current, controls, crank: get('condition-crank'),
    travel: get('condition-travel'), velocity: get('condition-velocity') };
}

function curvePath(values, bounds, row, degrees = phases) {
  return values.map((value, index) => `${index ? 'L' : 'M'}${x(degrees[index]).toFixed(3)} ${y(value, bounds, row).toFixed(3)}`).join(' ');
}

function valveCurve(kind, settings, { open, close } = valveTiming(settings)[kind]) {
  const divisions = 128;
  const radians = Array.from({ length: divisions + 1 }, (_, index) => open + (close - open) * index / divisions);
  return curvePath(radians.map(phase => valveLift(phase, kind, settings) * 1000), valveBounds, VALVE_ROW, radians.map(phase => phase / RAD));
}

function updateValves(settings) {
  const key = `${settings.intakeAdvanceRad}:${settings.intakeDurationRad}:${settings.intakeMaxLiftM}`;
  if (key === valveKey) return;
  valveKey = key;
  const timing = valveTiming(settings);
  const overlapStart = Math.max(timing.exhaust.open, timing.intake.open);
  const overlapEnd = Math.min(timing.exhaust.close, timing.intake.close);
  nodes.band.setAttribute('x', x(overlapStart / RAD));
  nodes.band.setAttribute('width', Math.max(0, x(overlapEnd / RAD) - x(overlapStart / RAD)));
  nodes.overlap.textContent = timing.overlapRad > 0
    ? `${degreesLabel(overlapStart)}–${degreesLabel(overlapEnd)} · ${degreesLabel(timing.overlapRad)}`
    : '0° · 동시에 열리지 않음';
  valveKinds.forEach((kind, index) => {
    const { open, close } = timing[kind], { curve, window, event } = nodes.valves[kind];
    const start = x(open / RAD), end = x(close / RAD), railY = VALVE_ROW.bottom + 6 + index * 8;
    curve.setAttribute('d', valveCurve(kind, settings, timing[kind]));
    window.setAttribute('d', `M${start} ${railY - 3}v6 m0 -3 H${end} m0 -3v6`);
    event.textContent = `${degreesLabel(open)} 열림 · ${degreesLabel(close)} 닫힘`;
  });
}

function samplePiston(settings) {
  // Every cylinder follows the same local phase; a cylinder change only moves the cursor.
  const samples = phases.map(degrees => engineDetail(sampleEngine(degrees * RAD, settings), settings).cylinder);
  return Object.fromEntries(Object.entries(metrics).map(([key, metric]) => {
    const values = samples.map(sample => valueFor(sample, metric));
    return [key, { values, low: Math.min(...values), high: Math.max(...values) }];
  }));
}

function plotBounds(metricKey, low, high) {
  if (metricKey === 'travel') return [0, GEOMETRY.stroke * 1000];
  const peak = Math.max(-low, high);
  const step = 10 ** Math.floor(Math.log10(peak)) / 2;
  const end = Math.ceil(peak / step) * step;
  return [-end, end];
}

function updatePistonPlots(metricKey, settings) {
  if (settings.rpm !== currentRpm) {
    pistonSeries = samplePiston(settings);
    currentRpm = settings.rpm;
  }
  const metricKeys = [metricKey, ...['travel', 'velocity'].filter(key => key !== metricKey)];
  activePlots = metricKeys.map((key, index) => {
    const plot = nodes.piston[index], metric = metrics[key], { low, high, values } = pistonSeries[key];
    const bounds = plotBounds(key, low, high);
    plot.label.textContent = metric.label;
    plot.unit.textContent = metric.unit;
    plot.high.textContent = axisLabel(bounds[1]);
    plot.low.textContent = axisLabel(bounds[0]);
    plot.group.dataset.metric = key;
    plot.dot.dataset.metric = key;
    const zero = y(0, bounds, plot.position);
    plot.zero.setAttribute('y1', zero);
    plot.zero.setAttribute('y2', zero);
    plot.curve.setAttribute('d', curvePath(values, bounds, plot.position));
    plot.curve.dataset.min = String(Math.min(0, low));
    plot.curve.dataset.max = String(Math.max(0, high));
    plot.curve.dataset.rpm = String(settings.rpm);
    plot.curve.dataset.metric = key;
    return { ...plot, bounds, metric };
  });
  const extra = nodes.piston[2];
  extra.group.classList.toggle('condition-hidden', metricKeys.length < 3);
  extra.dot.classList.toggle('condition-hidden', metricKeys.length < 3);
  const bottom = activePlots.at(-1).position.bottom;
  nodes.anchors.setAttribute('transform', `translate(0 ${bottom + 6})`);
  nodes.chart.setAttribute('viewBox', `0 0 720 ${bottom + 78}`);
  nodes.cursor.setAttribute('y2', bottom + 31);
  nodes.band.setAttribute('height', bottom - VALVE_ROW.top);
  if (metricKey !== activeMetric) {
    if (metricKey === 'acceleration') nodes.controls.append(nodes.current);
    else nodes[metricKey].replaceChildren(nodes.current);
  }
  activeMetric = metricKey;
}

function showValue(node, value, digits, unit) {
  const output = node.firstElementChild;
  if (output) showValue(output, value, digits, unit);
  else {
    const display = Math.abs(value) < .5 * 10 ** -digits ? 0 : value;
    const label = `${numberFormats[digits - 1].format(display)} ${unit}`;
    if (node.textContent !== label) node.textContent = label;
  }
  node.dataset.value = String(value);
  node.dataset.unit = unit;
}

export function renderKinematicsChart(snapshot, settings, selectedCylinder) {
  nodes ??= mountChart();
  const metricKey = Object.hasOwn(metrics, nodes.metric.value) ? nodes.metric.value : 'travel';
  const metric = metrics[metricKey];
  if (metricKey !== activeMetric || settings.rpm !== currentRpm) updatePistonPlots(metricKey, settings);
  updateValves(settings);

  const key = `${metricKey}:${settings.rpm}:${selectedCylinder}`;
  if (key !== layoutKey) {
    nodes.chart.setAttribute('aria-label', `${selectedCylinder}번 실린더의 720도 사이클에 따른 흡기·배기 리프트(mm), ${activePlots.map(plot => `${plot.metric.label}(${plot.metric.unit})`).join(', ')}`);
    nodes.note.textContent = `${metric.direction} 설정 ${settings.rpm.toLocaleString('ko-KR', { maximumFractionDigits: 3 })} rpm 기준이며, 화면 관찰 배율은 적용하지 않습니다.`;
    layoutKey = key;
  }

  const detail = engineDetail(snapshot, settings, selectedCylinder).cylinder;
  const degrees = detail.phaseRad / RAD, currentX = x(degrees);
  nodes.cursor.setAttribute('x1', currentX);
  nodes.cursor.setAttribute('x2', currentX);
  nodes.cursor.dataset.phaseDeg = String(degrees);
  for (const kind of valveKinds) {
    const { dot, readout } = nodes.valves[kind], lift = detail.valves[kind].liftM * 1000;
    dot.setAttribute('cx', currentX);
    dot.setAttribute('cy', y(lift, valveBounds, VALVE_ROW));
    showValue(readout, lift, 2, 'mm');
  }
  for (const { dot, position, bounds, metric } of activePlots) {
    const value = valueFor(detail, metric);
    dot.setAttribute('cx', currentX);
    dot.setAttribute('cy', y(value, bounds, position));
    dot.dataset.value = String(value);
  }
  showValue(nodes.travel, valueFor(detail, metrics.travel), metrics.travel.digits, metrics.travel.unit);
  showValue(nodes.velocity, valueFor(detail, metrics.velocity), metrics.velocity.digits, metrics.velocity.unit);
  if (metricKey === 'acceleration') showValue(nodes.current, valueFor(detail, metric), metric.digits, metric.unit);
  nodes.crank.textContent = degreesLabel(snapshot.cycleAngleRad);
  nodes.header.textContent = `${selectedCylinder}번 실린더 · ${degreesLabel(detail.phaseRad)}`;
}

// Translate a click on any trace into the selected cylinder's phase.
// The selected-cylinder slider remains the keyboard-accessible precise control.
export function phaseFromChartClick(event) {
  const svg = event.currentTarget, point = svg.createSVGPoint();
  point.x = event.clientX; point.y = event.clientY;
  const transform = svg.getScreenCTM();
  if (!transform) return 0;
  const svgX = point.matrixTransform(transform.inverse()).x;
  return Math.min(CYCLE_DEG, Math.max(0, (svgX - LEFT) / (RIGHT - LEFT) * CYCLE_DEG)) * RAD;
}
