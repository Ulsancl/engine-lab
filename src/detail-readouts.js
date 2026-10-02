import { engineDetail } from './detail-model.js';
export { engineDetail } from './detail-model.js';

const DEG = 180 / Math.PI;
const strokes = { power: '팽창', exhaust: '배기', intake: '흡기', compression: '압축' };
const speedNote = '속도·가속도는 설정 회전수로 일정하게 회전할 때의 값입니다. 일시정지와 화면 재생 배율은 이 값을 바꾸지 않습니다.';
const valveNote = '리프트 증가가 열리는 방향입니다. 열림·닫힘 끝점에서 속도는 연속이지만 가속도는 불연속이며 끝점의 한 값으로 정해지지 않습니다. 밸브 하중·바운스는 계산하지 않습니다.';

export function describeEngineDetail(partId, snapshot, settings, selectedCylinder = 1) {
  const match = /^c([1-4])-(.+)$/.exec(partId ?? '');
  const d = engineDetail(snapshot, settings, match ? Number(match[1]) : selectedCylinder);
  if (!d) return { facts: [], note: '계산 상태를 확인할 수 없습니다.' };
  const c = d.cylinder, p = c.piston, g = d.geometry, type = match ? match[2] : partId;
  const facts = [], add = (label, value, unit = '', digits = 1) => facts.push({ label, value, unit, digits });
  const acceleration = v => add('밸브 가속도', v.accelerationDefined ? v.accelerationMps2 : '끝점에서 불연속', v.accelerationDefined ? 'm/s²' : '', 1);
  let note;
  if (['piston', 'rings', 'pin'].includes(type)) {
    add('상사점에서 내려온 거리', p.travelFromTdcM * 1000, 'mm', 2);
    add('피스톤 속도 · 위쪽 +', p.velocityYMps, 'm/s', 2);
    add('피스톤 가속도 · 위쪽 +', p.accelerationYMps2, 'm/s²');
    add('평균 피스톤 속력', p.meanSpeedMps, 'm/s', 2);
    add('상사점 기준 쓸린 체적', p.sweptVolumeFromTdcM3 * 1e6, 'cm³');
    note = `${c.id}번 실린더. ${speedNote} 쓸린 체적은 연소실 총체적이 아니며, 핀 하중·링 마찰·가스 압력은 계산하지 않습니다.`;
  } else if (type === 'rod') {
    add('로드 기울기', c.rod.angleRad * DEG, '°', 2);
    add('로드 각속도 · +Z 기준', c.rod.angularVelocityRadPerS, 'rad/s', 2);
    add('로드 각가속도 · +Z 기준', c.rod.angularAccelerationRadPerS2, 'rad/s²');
    add('로드 중심 거리', g.rodLengthM * 1000, 'mm');
    add('로드 길이 / 크랭크 반경', g.rodLengthM / (g.strokeM / 2), '', 3);
    note = `${c.id}번 실린더의 로드가 +Y에서 +Z축 주위로 기울어진 각도입니다. ${speedNote} 질량·관성력·베어링 하중은 계산하지 않습니다.`;
  } else if (type === 'intake-valves' || type === 'exhaust-valves') {
    const kind = type === 'intake-valves' ? 'intake' : 'exhaust', v = c.valves[kind], event = d.timing[kind];
    add('밸브 리프트', v.liftM * 1000, 'mm', 2);
    add('밸브 속도 · 열림 +', v.velocityMps, 'm/s', 3);
    acceleration(v);
    add('열림–닫힘 · 실린더 위상', `${(event.openRad * DEG).toFixed(1)}–${(event.closeRad * DEG).toFixed(1)}`, '°');
    add('열림 구간 시간', event.durationSeconds * 1000, 'ms', 2);
    note = `${c.id}번 실린더의 같은 종류 밸브 두 개에 같은 리프트가 적용됩니다. ${speedNote} ${valveNote}`;
  } else if (type === 'intake-camshaft' || type === 'exhaust-camshaft') {
    const kind = type === 'intake-camshaft' ? 'intake' : 'exhaust', v = c.valves[kind], event = d.timing[kind];
    add('캠 회전수', d.cam.rpm, 'rpm', 0);
    add('선택 실린더', c.id, '번', 0);
    add('해당 밸브 리프트', v.liftM * 1000, 'mm', 2);
    add('밸브 속도 · 열림 +', v.velocityMps, 'm/s', 3);
    acceleration(v);
    add('열림–닫힘 · 실린더 위상', `${(event.openRad * DEG).toFixed(1)}–${(event.closeRad * DEG).toFixed(1)}`, '°');
    note = `캠은 크랭크의 절반 속도로 회전합니다. ${speedNote} ${valveNote}`;
  } else if (type === 'crankshaft' || type === 'flywheel' || /^main-bearing-[1-5]$/.test(type)) {
    add('크랭크 회전수', d.crank.rpm, 'rpm', 0);
    add('크랭크 각속력', d.crank.omegaRadPerS, 'rad/s', 2);
    add('캠 회전수', d.cam.rpm, 'rpm', 0);
    add('크랭크 핀 구심가속도', d.crank.pinCentripetalAccelerationMps2, 'm/s²');
    add('4행정 사이클 시간', d.timing.cycleSeconds * 1000, 'ms', 2);
    note = `${speedNote} 회전수는 크기이며 형상의 +Z 회전 부호는 음수입니다. 구심가속도는 크랭크 핀 위치의 값이고, 토크·출력·플라이휠 관성·베어링 하중은 계산하지 않습니다.`;
  } else if (type === 'timing-chain' || type === 'timing-guide') {
    add('크랭크 회전수', d.crank.rpm, 'rpm', 0);
    add('캠 회전수', d.cam.rpm, 'rpm', 0);
    add('크랭크 : 캠 회전비', '2 : 1');
    add('오버랩 크랭크각', d.timing.overlapRad * DEG, '°');
    add('오버랩 시간', d.timing.overlapSeconds * 1000, 'ms', 2);
    note = `${speedNote} 두 밸브가 함께 열린 시간은 선택한 흡기 위상 설정의 결과입니다. 체인 장력·마찰·진동·윤활 유량은 계산하지 않습니다.`;
  } else if (type === 'spark-plug') {
    add('실린더', c.id, '번', 0);
    add('실린더 사이클 위상', c.phaseRad * DEG, '°');
    add('현재 행정', strokes[c.stroke] ?? c.stroke);
    add('4행정 사이클 시간', d.timing.cycleSeconds * 1000, 'ms', 2);
    add('실제 점화 시기·에너지', '계산하지 않음');
    note = '불꽃 표시는 팽창 시작을 구분하는 관찰 표시입니다. 실제 점화 진각·연소 지속시간·압력·출력을 뜻하지 않습니다. ' + speedNote;
  } else if (['oil-pump', 'oil-filter', 'oil-gallery', 'oil-pan'].includes(type)) {
    add('설정 크랭크 회전수', d.crank.rpm, 'rpm', 0);
    add('윤활 압력·유량', '계산하지 않음');
    add('오일 온도·유막 두께', '계산하지 않음');
    note = '윤활 경로와 움직이는 입자는 구조 설명입니다. 펌프의 회전 표현에서 유량·소비 동력·압력이나 유막 상태를 추정하지 않습니다. ' + speedNote;
  } else {
    add('보어', g.boreM * 1000, 'mm');
    add('행정 길이', g.strokeM * 1000, 'mm');
    add('실린더당 행정 체적', g.sweptVolumePerCylinderM3 * 1e6, 'cm³', 2);
    add('4기통 총 배기량', g.totalSweptVolumeM3 * 1000, 'L', 3);
    add('선택 실린더 상사점 이동량', p.travelFromTdcM * 1000, 'mm', 2);
    note = `${c.id}번 실린더의 위치와 공통 대표 치수입니다. 배기량은 보어 면적 × 행정 × 실린더 수이며 연소실 총체적·압축비·가스 유량은 계산하지 않습니다.`;
  }
  return { facts, note };
}
