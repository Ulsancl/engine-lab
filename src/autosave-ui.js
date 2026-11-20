import { clearTabDraft, createBrowserAutosave, readTabDraft, supportsAutosaveLock, writeTabDraft } from './browser-autosave.js';

const draftStorage = () => sessionStorage;
const notices = {
  conflict: ['다른 탭에서 저장한 실험을 보호했어요.', '이 탭의 변경은 자동 저장하지 않습니다. 실험을 내려받은 뒤 새로고침하면 최신 자동 저장을 열 수 있습니다.', '다른 창에서 자동 저장이 변경됨 · 이 탭의 실험은 파일로 보관하세요'],
  unavailable: ['이 환경에서는 안전한 자동 저장을 사용할 수 없어요.', '기존 자동 저장 기록은 덮어쓰지 않습니다. 이 탭의 변경은 파일로 내려받으세요.', '안전한 자동 저장을 사용할 수 없음 · 파일로 보관하세요'],
  failed: ['자동 저장을 완료하지 못했어요.', '현재 실험을 잃지 않으려면 파일로 내려받으세요.', '자동 저장을 완료하지 못했습니다 · 파일로 보관하세요'],
};

export function getBrowserLocks() {
  try { return navigator.locks; } catch { return undefined; }
}

// Inspect only this tab's temporary data. A detached draft must not obscure a
// newer shared copy, even if that copy later changes back to the same bytes.
export function readBrowserDraft({ key, locks, expected, allowResume, decode }) {
  const draft = readTabDraft(draftStorage, key);
  const empty = { restored: null, interrupted: null };
  if (!draft) return empty;
  if (draft.contents === expected) {
    clearTabDraft(draftStorage, key, draft.contents);
    return empty;
  }
  try {
    const restored = decode(draft.contents);
    const reload = performance.getEntriesByType('navigation')[0]?.type === 'reload';
    if (reload && allowResume && !draft.interrupted && draft.expected === expected && supportsAutosaveLock(locks)) {
      return { ...empty, restored };
    }
    writeTabDraft(draftStorage, key, { ...draft, interrupted: true });
    return { ...empty, interrupted: draft.contents };
  } catch {
    clearTabDraft(draftStorage, key, draft.contents);
    return empty;
  }
}

export function createAutosaveUI({ key, locks, expected, baseline, capture, status, maySave, interruptedDraft = null, downloadDraft, saved = '이 기기에 자동 저장됨' }) {
  const panel = document.querySelector('#autosave-recovery');
  const title = document.querySelector('#autosave-title');
  const hint = document.querySelector('#autosave-hint');
  const archive = document.querySelector('#tab-draft-recovery');
  let guardArmed = false, protectedDraft = interruptedDraft;
  const autosave = createBrowserAutosave({ key, locks, expected, baseline, capture, storage: () => localStorage, onStatus: report });

  function rememberDraft() {
    try {
      const draft = autosave.unsavedDraft();
      if (draft && protectedDraft === null) writeTabDraft(draftStorage, key, { ...draft, interrupted: draft.interrupted || !maySave() });
      return Boolean(draft);
    } catch { return true; } // Warn if a snapshot could not be checked.
  }
  function warnOnUnsavedExit(event) {
    if (!rememberDraft()) return;
    event.preventDefault();
    event.returnValue = true;
  }
  function markDirty() {
    if (guardArmed) return;
    guardArmed = true;
    window.addEventListener('beforeunload', warnOnUnsavedExit);
  }
  function disarm() {
    guardArmed = false;
    window.removeEventListener('beforeunload', warnOnUnsavedExit);
  }
  function report(result, contents) {
    if (result === 'saved' || result === 'unchanged') {
      if (protectedDraft === null && contents !== undefined) clearTabDraft(draftStorage, key, contents);
      disarm();
      panel.hidden = true;
      status.textContent = (typeof saved === 'function' ? saved() : saved);
      return;
    }
    [title.textContent, hint.textContent, status.textContent] = notices[result];
    panel.hidden = false;
  }
  function flush() {
    if (!maySave() || !autosave.canSave()) return;
    status.textContent = '자동 저장 확인 중';
    void autosave.flush();
  }
  if (protectedDraft !== null) {
    archive.hidden = false;
    document.querySelector('#export-interrupted-draft').addEventListener('click', async () => {
      if (protectedDraft === null) return;
      try {
        const contents = protectedDraft;
        await downloadDraft(contents);
        clearTabDraft(draftStorage, key, contents);
        protectedDraft = null;
        archive.hidden = true;
        if (guardArmed) rememberDraft();
      } catch { report('failed'); }
    });
  }
  return {
    canSave: autosave.canSave,
    markDirty,
    flush,
    onHide() {
      if (!guardArmed) return;
      // Closing or reloading a page can interrupt the asynchronous shared
      // write. Session storage survives an ordinary reload of this tab.
      rememberDraft();
      flush();
    },
    flushIfDirty() { if (guardArmed) flush(); },
    markExported(contents) {
      // Track the experiment snapshot offered to the browser; download may be canceled.
      autosave.markExported(contents);
      if (protectedDraft === null) clearTabDraft(draftStorage, key);
      disarm();
    },
    report,
  };
}
