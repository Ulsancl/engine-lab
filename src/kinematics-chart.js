import { sampleEngine, FIRING_PHASES } from './model.js';
import { engineDetail } from './detail-model.js';

const RAD = Math.PI / 180;
const metrics = {
  travel: { field: 'travelFromTdcM', scale: 1000, unit: 'mm', digits: 1, label: '피스톤 하강 거리', direction: '상사점에서 아래쪽으로 잰 거리입니다.' },
  velocity: { field: 'velocityYMps', scale: 1, unit: 'm/s', digits: 2, label: '피스톤 속도', direction: '+는 위쪽, −는 아래쪽 운동입니다.' },
  acceleration: { field: 'accelerationYMps2', scale: 1, unit: 'm/s²', digits: 1, label: '피스톤 가속도', direction: '+는 위쪽, −는 아래쪽 가속도입니다. 힘을 계산한 값은 아닙니다.' }
};
let cachedKey = '', bounds = [0, 1];
const x = degrees => 46 + degrees / 720 * 660;
const y = value => 126 - (value - bounds[0]) / (bounds[1] - bounds[0]) * 110;
const format = (value, digits) => (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function renderKinematicsChart(snapshot, settings, selectedCylinder) {
  const metricKey = document.getElementById('piston-metric').value, metric = metrics[metricKey] ?? metrics.travel;
  const key = `${metricKey}:${settings.rpm}:${selectedCylinder}`;
  if (key !== cachedKey) {
    const points = Array.from({ length: 361 }, (_, index) => {
      const degrees = index * 2;
      const state = sampleEngine(degrees * RAD + FIRING_PHASES[selectedCylinder - 1], settings);
      return [degrees, engineDetail(state, settings, selectedCylinder).cylinder.piston[metric.field] * metric.scale];
    });
    const values = points.map(point => point[1]), low = Math.min(0, ...values), high = Math.max(0, ...values), padding = Math.max(1e-6, (high - low) * .06);
    bounds = [low - padding, high + padding];
    const path = document.getElementById('piston-curve');
    path.setAttribute('d', points.map(([degree, value], index) => `${index ? 'L' : 'M'}${x(degree).toFixed(3)} ${y(value).toFixed(3)}`).join(' '));
    path.dataset.min = String(low); path.dataset.max = String(high); path.dataset.rpm = String(settings.rpm); path.dataset.metric = metricKey;
    const zero = document.getElementById('piston-zero'); zero.setAttribute('y1', y(0)); zero.setAttribute('y2', y(0));
    document.getElementById('piston-axis-top').textContent = format(high, metric.digits);
    document.getElementById('piston-axis-bottom').textContent = format(low, metric.digits);
    document.getElementById('piston-axis-top').setAttribute('y', y(high) + 3);
    document.getElementById('piston-axis-bottom').setAttribute('y', y(low) + 3);
    document.getElementById('piston-metric-unit').textContent = metric.unit;
    document.getElementById('piston-chart').setAttribute('aria-label', `${selectedCylinder}번 실린더의 720도 사이클에 따른 ${metric.label}, ${metric.unit}`);
    document.getElementById('piston-chart-note').textContent = `${metric.direction} 설정 ${settings.rpm.toLocaleString('ko-KR', { maximumFractionDigits: 3 })} rpm 기준이며, 화면 관찰 배율은 적용하지 않습니다.`;
    cachedKey = key;
  }
  const detail = engineDetail(snapshot, settings, selectedCylinder).cylinder;
  const degrees = detail.phaseRad / RAD, value = detail.piston[metric.field] * metric.scale;
  const cursor = document.getElementById('piston-cursor'), dot = document.getElementById('piston-dot');
  cursor.setAttribute('x1', x(degrees)); cursor.setAttribute('x2', x(degrees)); cursor.dataset.phaseDeg = String(degrees);
  dot.setAttribute('cx', x(degrees)); dot.setAttribute('cy', y(value)); dot.dataset.value = String(value);
  const readout = document.getElementById('piston-current-value');
  readout.textContent = `${format(value, metric.digits)} ${metric.unit}`; readout.dataset.value = String(value); readout.dataset.unit = metric.unit;
  document.getElementById('piston-chart-cylinder').textContent = `${selectedCylinder}번 실린더 · ${format(degrees, 0)}°`;
}

// Translate a click on the graph into the selected cylinder's phase. The
// dedicated slider remains the keyboard- and touch-accessible precise control.
export function phaseFromChartClick(event) {
  const svg = event.currentTarget, point = svg.createSVGPoint();
  point.x = event.clientX; point.y = event.clientY;
  const transform = svg.getScreenCTM();
  if (!transform) return 0;
  // Respect preserveAspectRatio letterboxing when a maximum graph height or
  // a narrow viewport makes the SVG content narrower than its DOM rectangle.
  const svgX = point.matrixTransform(transform.inverse()).x;
  return Math.min(720, Math.max(0, (svgX - 46) / 660 * 720)) * RAD;
}
