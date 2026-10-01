import { describeEngineDetail } from './detail-readouts.js';

const format = (value, digits = 1) => Number.isFinite(value)
  ? (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : typeof value === 'string' ? value : '—';

function renderFacts(list, facts) {
  const signature = facts.map(fact => fact.label).join('|');
  if (list.dataset.signature !== signature) {
    list.replaceChildren(...facts.map(fact => {
      const row = document.createElement('div'); row.className = 'detail-fact'; row.dataset.label = fact.label;
      const label = document.createElement('dt'); label.textContent = fact.label;
      row.append(label, document.createElement('dd')); return row;
    }));
    list.dataset.signature = signature;
  }
  facts.forEach((fact, index) => {
    const row = list.children[index], value = `${format(fact.value, fact.digits ?? 1)}${fact.unit ? ' ' + fact.unit : ''}`;
    row.dataset.value = String(fact.value); row.dataset.unit = fact.unit ?? '';
    if (row.lastElementChild.textContent !== value) row.lastElementChild.textContent = value;
  });
}

export function renderEngineDetails(snapshot, settings, view, inspection) {
  const detail = describeEngineDetail(view.selectedPart, snapshot, settings, view.selectedCylinder);
  for (const prefix of ['part', 'focus']) {
    renderFacts(document.getElementById(`${prefix}-detail-facts`), detail.facts);
    const note = document.getElementById(`${prefix}-detail-note`);
    if (note.textContent !== detail.note) note.textContent = detail.note;
  }
  const cylinder = /^c([1-4])-/.exec(view.selectedPart)?.[1] ?? view.selectedCylinder;
  document.getElementById('detail-reference').textContent = `${cylinder}번 기준 · 설정 ${settings.rpm.toLocaleString('ko-KR', { maximumFractionDigits: 3 })} rpm`;
  document.getElementById('focus-detail-reference').textContent = document.getElementById('detail-reference').textContent;
  for (const id of ['inspect-part', 'focus-inspect-part']) {
    const button = document.getElementById(id), active = inspection?.active && inspection.partId === view.selectedPart;
    button.textContent = active ? '전체 구조로 돌아가기' : '선택 부품 자세히 보기';
    button.setAttribute('aria-pressed', String(!!active));
  }
  document.getElementById('restore-inspection').hidden = !inspection?.active;
  document.getElementById('focus-part-select').value = view.selectedPart;
}
