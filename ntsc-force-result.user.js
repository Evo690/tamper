// ==UserScript==
// @name         NTSC Exam Hall — Force Result Unlock
// @namespace    https://ntsc.narayanatalent.com/
// @version      1.1.0
// @description  Unlocks the Exam Hall "Result" button when NTSC leaves it disabled (result published but flag not updated / exam-hall glitch). Opens the result using the site's own code path and APIs, exactly like a normal non-glitched test.
// @author       arena
// @icon         https://ntsc.narayanatalent.com/favicon.ico
// @match        https://ntsc.narayanatalent.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

/*
 ---------------------------------------------------------------------------
 HOW IT WORKS (short version)
 ---------------------------------------------------------------------------
 The Exam Hall renders every test row with this gate. Decoded from chunk
 209.*.chunk.js of the live bundle (h = isResultAutoPublish, x = isPublish,
 p = isReattemptAllow, n = isLive, v = isAttendExam, f = isSubmitedExam):

     const canSeeResult = (h || x) && p && !n && v
                       || (h || x) && !p && !n && f
                       || x && n;

     <button className={"btn-analysis-result " + (canSeeResult ? "active" : "disabled")}
             disabled={!canSeeResult}
             onClick={() => canSeeResult && openResult(test)}>
       Result
     </button>

 So if the API sends isPublish=false (or isSubmitedExam/isAttendExam=false) the
 button is dead, even though the very same test opens fine from
 My Courses -> Results (that page calls the same GetAppearedResult endpoint).

 This script fixes that. It patches the *page's* XHR/fetch (via unsafeWindow, so
 axios actually sees it) and falls back to the Redux store when needed:

   1. NETWORK LAYER (silent, preferred)
      Hooks XHR/fetch and, for
        POST /exam-service/api/ExaminationHall/GetTests
        POST /exam-service/api/Course/GetScheduleExam
      flips isPublish / isResultAutoPublish to true on non-live tests before
      React sees them. The app then renders the button as a normal, active
      button and its own onClick handler runs -> 100% the stock flow
      (GetAppearedResult -> GetResultAnalysis), same UI, same requests.
      These two flags are only used for that one check, so nothing else on the
      page (Start Test / Retake / status pill) is affected.

   2. FORCE LAYER (click-time)
      Any Result button that is STILL disabled (e.g. server says
      isSubmitedExam=false) is visually unlocked and a capture-phase click
      handler is attached. On click it temporarily patches that single row in
      the Redux store (isPublish/isResultAutoPublish/isSubmitedExam/
      isAttendExam = true), lets React re-render, then performs a real click on
      the now-active button - so again the site's own handler and APIs run.
      The store is restored a few seconds later (the result view is already
      open by then).

   3. EMERGENCY FALLBACK
      If the Redux store cannot be reached (site refactor), the script calls
      the same endpoints directly and shows a compact score-sheet modal.

 Nothing is written to the server. No exam data is modified - it only changes
 what the page thinks about the publish flags.
 ---------------------------------------------------------------------------
*/

(function () {
  'use strict';

  /* ======================================================================
   * 0. Config
   * ==================================================================== */
  const CFG_STORE_KEY = 'ntscForceResultConfig';
  const DEFAULTS = {
    autoUnlock: true,   // network layer: flip publish flags
    forceClick: true,   // force layer: unlock+route still-disabled buttons
    showBadge: true,    // floating badge
    debug: false
  };

  const cfg = Object.assign({}, DEFAULTS, loadCfg());

  function loadCfg() {
    try {
      if (typeof GM_getValue === 'function') return JSON.parse(GM_getValue(CFG_STORE_KEY, '{}')) || {};
      return JSON.parse(localStorage.getItem(CFG_STORE_KEY) || '{}') || {};
    } catch (e) { return {}; }
  }
  function saveCfg() {
    try {
      const raw = JSON.stringify(cfg);
      if (typeof GM_setValue === 'function') GM_setValue(CFG_STORE_KEY, raw);
      else localStorage.setItem(CFG_STORE_KEY, raw);
    } catch (e) { /* ignore */ }
  }
  function log(...args) {
    if (cfg.debug) console.log('%c[NTSC·ResultUnlock]', 'color:#007fbe;font-weight:600', ...args);
  }

  /* ======================================================================
   * 1. Page context + small helpers
   * ==================================================================== */
  // Tampermonkey runs userscripts in a sandbox. XHR/fetch must be patched on the
  // real page window or axios (which lives in page context) never sees it.
  const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function clone(obj) {
    try { return structuredClone(obj); } catch (e) { /* fall through */ }
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
  }

  /* ======================================================================
   * 2. NETWORK LAYER — flip the publish flags before React reads them
   * ==================================================================== */

  // Tests we have seen in API responses: name -> { id, isExamCourse, courseId, ... }
  // Used by the emergency fallback.
  const SEEN_TESTS = new Map();

  const TARGET_ENDPOINTS = [
    /\/exam-service\/api\/ExaminationHall\/GetTests(\?|$)/i,
    /\/exam-service\/api\/Course\/GetScheduleExam(\?|$)/i
  ];

  function isTargetUrl(url) {
    if (!url) return false;
    const u = String(url);
    return TARGET_ENDPOINTS.some((rx) => rx.test(u));
  }

  /**
   * Mutates the parsed response in place.
   * @returns {boolean} true if something changed
   */
  function patchTestPayload(json) {
    if (!json || typeof json !== 'object') return false;
    const list = json.data && Array.isArray(json.data.result) ? json.data.result : null;
    if (!list) return false;

    let changed = false;
    for (const t of list) {
      if (!t || typeof t !== 'object') continue;

      // remember for the fallback path
      if (t.testName && t.id != null) {
        SEEN_TESTS.set(norm(t.testName), {
          id: t.id,
          testName: t.testName,
          isExamCourse: !!t.isExamCourse,
          courseId: t.courseId,
          isLive: !!t.isLive,
          isQuizX: !!t.isQuizX
        });
      }

      if (!cfg.autoUnlock) continue;
      if (t.isLive === true) continue; // don't auto-open live tests, the force layer handles them on demand

      // These two flags are consumed by exactly one check in the exam hall
      // (the Result button gate), so forcing them cannot affect Start/Retake.
      if (t.isPublish !== true) { t.isPublish = true; changed = true; }
      if (t.isResultAutoPublish !== true) { t.isResultAutoPublish = true; changed = true; }
    }
    if (changed) log('patched GetTests/GetScheduleExam payload', list.length, 'row(s)');
    return changed;
  }

  /* ---- XMLHttpRequest hook (axios uses XHR) --------------------------- */
  function installXhrHook() {
    const XHR = PAGE.XMLHttpRequest || XMLHttpRequest;
    const proto = XHR.prototype;
    if (proto.__ntscFrHooked) return;
    proto.__ntscFrHooked = true;

    const origOpen = proto.open;
    const origSend = proto.send;

    proto.open = function (method, url) {
      try { this.__ntscUrl = typeof url === 'string' ? url : String(url); } catch (e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };

    proto.send = function () {
      try {
        if (isTargetUrl(this.__ntscUrl)) installLazyResponsePatch(this, XHR);
      } catch (e) { log('xhr hook error', e); }
      return origSend.apply(this, arguments);
    };
  }

  function installLazyResponsePatch(xhr, XHR) {
    const textDesc = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
    const respDesc = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');
    if (!textDesc || !textDesc.get) return;

    let lastRaw = null;
    let lastOut = null;
    let jsonHandled = false;

    const patchedText = (raw) => {
      if (typeof raw !== 'string' || !raw) return raw;
      if (raw === lastRaw) return lastOut;
      let out = raw;
      try {
        const json = JSON.parse(raw);
        if (patchTestPayload(json)) out = JSON.stringify(json);
      } catch (e) { /* not JSON, leave it */ }
      lastRaw = raw;
      lastOut = out;
      return out;
    };

    try {
      Object.defineProperty(xhr, 'responseText', {
        configurable: true,
        enumerable: true,
        get() { return patchedText(textDesc.get.call(xhr)); }
      });
    } catch (e) { log('cannot patch responseText', e); }

    try {
      Object.defineProperty(xhr, 'response', {
        configurable: true,
        enumerable: true,
        get() {
          // responseType 'json' -> object, everything else mirrors responseText
          if (xhr.responseType === 'json') {
            const obj = respDesc && respDesc.get ? respDesc.get.call(xhr) : null;
            if (!jsonHandled && obj && typeof obj === 'object') {
              try { patchTestPayload(obj); } catch (e) { /* ignore */ }
              jsonHandled = true;
            }
            return obj;
          }
          if (xhr.responseType === '' || xhr.responseType === 'text') {
            return patchedText(textDesc.get.call(xhr));
          }
          return respDesc && respDesc.get ? respDesc.get.call(xhr) : null;
        }
      });
    } catch (e) { log('cannot patch response', e); }
  }

  /* ---- fetch hook (belt & braces) ------------------------------------ */
  function installFetchHook() {
    if (typeof PAGE.fetch !== 'function') return;
    if (PAGE.fetch.__ntscFrHooked) return;
    const origFetch = PAGE.fetch;

    const patchedFetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = origFetch.apply(this, arguments);
      if (!isTargetUrl(url)) return p;

      return p.then(async (res) => {
        try {
          const raw = await res.clone().text();
          const json = JSON.parse(raw);
          if (patchTestPayload(json)) {
            const body = JSON.stringify(json);
            const headers = new Headers(res.headers);
            headers.delete('content-length');
            return new Response(body, { status: res.status, statusText: res.statusText, headers });
          }
        } catch (e) { /* ignore */ }
        return res;
      });
    };

    patchedFetch.__ntscFrHooked = true;
    PAGE.fetch = patchedFetch;
  }

  /* ======================================================================
   * 3. REDUX STORE ACCESS (for the force layer)
   * ==================================================================== */
  let cachedStore = null;

  function findStore() {
    if (cachedStore && typeof cachedStore.getState === 'function') return cachedStore;
    cachedStore = null;

    const rootEl = document.getElementById('root');
    if (!rootEl) return null;

    const key = Object.keys(rootEl).find((k) => k.startsWith('__reactContainer$'));
    if (!key) return null;

    const start = rootEl[key];
    if (!start) return null;

    const stack = [start];
    let visited = 0;

    while (stack.length && visited < 60000) {
      const fiber = stack.pop();
      visited++;
      if (!fiber) continue;

      let props = null;
      try { props = fiber.memoizedProps || (fiber.stateNode && fiber.stateNode.props) || null; } catch (e) { props = null; }

      if (props && typeof props === 'object') {
        const candidate =
          (props.store && typeof props.store.getState === 'function' && props.store) ||
          (props.value && props.value.store && typeof props.value.store.getState === 'function' && props.value.store) ||
          (props.value && typeof props.value.getState === 'function' && props.value) ||
          null;
        if (candidate && typeof candidate.dispatch === 'function') {
          cachedStore = candidate;
          log('redux store found', visited);
          return candidate;
        }
      }

      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return null;
  }

  // Known shapes of the exam-hall slice in this app.
  const STATE_CANDIDATES = [
    { get: (s) => s && s.examHallReducer && s.examHallReducer.data, type: 'examHall/getAllTest/fulfilled' },
    { get: (s) => s && s.examHallReducer && s.examHallReducer.courseTestData, type: 'examHall/getCourseTest/fulfilled' },
    { get: (s) => s && s.examHallReducer && s.examHallReducer.liveTestdata, type: 'examHall/getLiveTest/fulfilled' }
  ];

  function locateTest(state, name) {
    const wanted = norm(name);
    for (const cand of STATE_CANDIDATES) {
      let payload;
      try { payload = cand.get(state); } catch (e) { payload = null; }
      const list = payload && payload.data && Array.isArray(payload.data.result) ? payload.data.result : null;
      if (!list) continue;

      let idx = list.findIndex((t) => t && norm(t.testName) === wanted);
      if (idx < 0) idx = list.findIndex((t) => t && norm(t.testName).includes(wanted) && wanted.length > 3);
      if (idx >= 0) return { payload, list, index: idx, type: cand.type, test: list[idx] };
    }
    return null;
  }

  /* ======================================================================
   * 4. FORCE LAYER — buttons, store patch, native click
   * ==================================================================== */
  const BTN_CLASS = 'btn-analysis-result';
  let forcedCount = 0;

  // Buttons we unlocked ourselves (DOM state alone is not trustworthy: once we
  // flip `btn.disabled = false` React keeps rendering disabled=true but does not
  // touch the DOM property again until its own value changes).
  const FORCED = new WeakSet();

  function resultButtons() {
    const set = new Set();
    document.querySelectorAll('button.' + BTN_CLASS).forEach((b) => set.add(b));
    // defensive fallback in case the class is renamed
    document.querySelectorAll('.exam-row-card button, .col-analysis button, .exam-table-body button').forEach((b) => {
      if ((b.textContent || '').trim().toLowerCase() === 'result') set.add(b);
    });
    return Array.from(set);
  }

  function isDisabled(btn) {
    return !!btn.disabled || btn.classList.contains('disabled') || btn.getAttribute('aria-disabled') === 'true';
  }

  /** React keeps the live props object on the DOM node as __reactProps$xxxx. */
  function reactProps(el) {
    if (!el) return null;
    try {
      const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
      return key ? el[key] : null;
    } catch (e) { return null; }
  }

  /**
   * The truth about what React currently renders.
   * @returns {boolean|null} null when the internal key is not available
   */
  function reactDisabled(btn) {
    const p = reactProps(btn);
    if (p && typeof p.disabled === 'boolean') return p.disabled;
    return null;
  }

  // For pages/components where React internals are not reachable we freeze the
  // state we saw first, otherwise our own repaint would look like "the app
  // enabled it" on the next scan.
  const BASELINE = new WeakMap();

  function effectivelyDisabled(btn) {
    const r = reactDisabled(btn);
    if (r !== null) return r;
    if (BASELINE.has(btn)) return BASELINE.get(btn);
    const d = isDisabled(btn);
    BASELINE.set(btn, d);
    return d;
  }

  function rowInfo(btn) {
    const row = btn.closest('.exam-row-card') || btn.closest('tr') || btn.parentElement;
    let name = '';
    if (row) {
      const el = row.querySelector('.exam-title-text, .test-name, [data-test-name], td');
      if (el) name = el.getAttribute('title') || el.getAttribute('data-test-name') || el.textContent || '';
      if (!name) {
        const titled = row.querySelector('[title]');
        if (titled) name = titled.getAttribute('title');
      }
    }
    return { row, name: name.trim() };
  }

  function findButtonByName(name) {
    const wanted = norm(name);
    if (!wanted) return null;
    for (const b of resultButtons()) {
      const info = rowInfo(b);
      if (norm(info.name) === wanted) return b;
    }
    return null;
  }

  function paintUnlocked(btn) {
    btn.disabled = false;
    btn.removeAttribute('disabled');
    btn.classList.remove('disabled');
    btn.classList.add('active', 'ntsc-fr-forced');
    btn.setAttribute('data-ntsc-forced', '1');
    if (!btn.getAttribute('title') || btn.getAttribute('title') === 'Result') {
      btn.setAttribute('title', 'Result · unlocked by NTSC Result Unlock');
    }
  }

  function unlockVisually(btn) {
    try {
      paintUnlocked(btn);
      forcedCount++;
      updateBadge();
      log('unlocked button', rowInfo(btn).name);
    } catch (e) { log('unlockVisually failed', e); }
  }

  function clearForced(btn) {
    FORCED.delete(btn);
    btn.classList.remove('ntsc-fr-forced');
    btn.removeAttribute('data-ntsc-forced');
  }

  function processButton(btn) {
    const disabled = effectivelyDisabled(btn);

    if (disabled) {
      if (!cfg.forceClick) return;
      if (!FORCED.has(btn)) {
        FORCED.add(btn);
        unlockVisually(btn);
      } else {
        // React re-rendered the row and reset the class/attribute: repaint.
        paintUnlocked(btn);
      }
    } else if (FORCED.has(btn)) {
      // React itself now says enabled — drop the marker so the stock handler runs.
      clearForced(btn);
      updateBadge();
    }

    if (!btn.__ntscFrBound) {
      btn.__ntscFrBound = true;
      btn.addEventListener('click', onResultClick, true);
    }
  }

  function onResultClick(ev) {
    const btn = ev.currentTarget;
    // Programmatic click performed by us -> let React handle it.
    if (btn.getAttribute('data-ntsc-internal') === '1') return;
    // A button the app itself enabled -> stock behaviour.
    if (!FORCED.has(btn) && !btn.hasAttribute('data-ntsc-forced')) return;

    ev.preventDefault();
    ev.stopPropagation();
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();

    forceOpen(btn);
  }

  async function forceOpen(btn) {
    if (btn.getAttribute('data-ntsc-busy') === '1') return;
    btn.setAttribute('data-ntsc-busy', '1');

    const info = rowInfo(btn);
    log('force open', info.name);
    toast('Unlocking result' + (info.name ? ': ' + info.name : '') + '…');

    let ok = false;
    try {
      ok = await forceViaStore(info, btn);
    } catch (e) {
      log('forceViaStore error', e);
    }

    if (!ok) {
      try { ok = await openFallback(info); } catch (e) { log('fallback error', e); }
    }

    if (!ok) toast('Could not open the result — the server returned no result data.');
    setTimeout(() => btn.removeAttribute('data-ntsc-busy'), 1500);
  }

  async function forceViaStore(info, btn) {
    const store = findStore();
    if (!store) { log('no store'); return false; }

    let state;
    try { state = store.getState(); } catch (e) { return false; }

    const loc = locateTest(state, info.name);
    if (!loc) { log('test not found in store', info.name); return false; }

    const original = loc.payload;
    const patched = clone(original);
    const target = patched.data.result[loc.index];

    Object.assign(target, {
      isPublish: true,
      isResultAutoPublish: true,
      isSubmitedExam: true,
      isAttendExam: true
    });

    log('dispatching patched exam-hall data', loc.type, target.testName);
    store.dispatch({ type: loc.type, payload: patched, meta: {} });

    const enabledBtn = await waitForEnabled(info.name, 1500);
    if (!enabledBtn) {
      log('button never became enabled');
      restoreIfSame(store, patched, original, loc.type);
      return false;
    }

    clickNatively(enabledBtn);

    // The result view is now mounted; put the original data back so the exam
    // list (and its Start/Retake buttons) keep their true state.
    setTimeout(() => restoreIfSame(store, patched, original, loc.type), 4000);
    return true;
  }

  function restoreIfSame(store, patchedRef, original, type) {
    try {
      const st = store.getState();
      const stillOurs = STATE_CANDIDATES.some((c) => {
        try { return c.type === type && c.get(st) === patchedRef; } catch (e) { return false; }
      });
      if (stillOurs) {
        log('restoring original exam-hall data');
        store.dispatch({ type, payload: original, meta: {} });
      }
    } catch (e) { log('restore failed', e); }
  }

  async function waitForEnabled(name, timeout) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      const btn = findButtonByName(name);
      // must be enabled according to React itself, not just because we repainted it
      if (btn && !effectivelyDisabled(btn)) return btn;
      await sleep(35);
    }
    return null;
  }

  function clickNatively(btn) {
    log('clicking result button natively');
    try {
      clearForced(btn);
      btn.disabled = false;
      btn.removeAttribute('disabled');
      btn.classList.remove('disabled');
      btn.classList.add('active');
      btn.setAttribute('data-ntsc-internal', '1');
      btn.click();
    } catch (e) {
      log('native click failed', e);
    }
    setTimeout(() => btn.removeAttribute('data-ntsc-internal'), 1200);
  }

  /* ======================================================================
   * 5. EMERGENCY FALLBACK — direct API + compact score sheet
   * ==================================================================== */
  const API = {
    appearedResult: '/exam-service/api/ExaminationHall/GetAppearedResult',
    resultAnalysis: '/exam-service/api/ExaminationHall/GetResultAnalysis/',
    courseExamId: '/exam-service/api/CourseResult/GetExamId/'
  };

  function getToken() {
    try {
      const raw = localStorage.getItem('user-detail');
      if (!raw) return '';
      const o = JSON.parse(raw);
      return (o && o.token) || '';
    } catch (e) { return ''; }
  }

  async function apiFetch(path, opts) {
    const options = opts || {};
    const headers = { Accept: 'application/json, text/plain, */*' };
    const token = getToken();
    if (token) headers.Authorization = 'bearer ' + token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: 'include'
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json };
  }

  function testFromPage(name) {
    const known = SEEN_TESTS.get(norm(name));
    if (known) return known;

    // last resort: scrape the Redux state
    const store = findStore();
    if (store) {
      try {
        const loc = locateTest(store.getState(), name);
        if (loc && loc.test) {
          return {
            id: loc.test.id,
            testName: loc.test.testName,
            isExamCourse: !!loc.test.isExamCourse,
            courseId: loc.test.courseId
          };
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  async function openFallback(info) {
    const test = testFromPage(info.name);
    if (!test || test.id == null) return false;

    modalLoading('Fetching result via the exam-service API…');

    const attemptsRes = await apiFetch(API.appearedResult, {
      method: 'POST',
      body: { id: test.id, pageNumber: 1, pageSize: 25 }
    });

    const payload = attemptsRes.json;
    const attempts = payload && payload.data && Array.isArray(payload.data.result) ? payload.data.result : [];

    if (attempts.length) {
      renderAttempts(test, attempts, payload.data.totalSubjectMarks);
      return true;
    }

    // Course-exam tests expose the result through CourseResult/GetExamId
    if (test.isExamCourse) {
      const idRes = await apiFetch(API.courseExamId + encodeURIComponent(test.id));
      const examId = idRes.json && idRes.json.data && idRes.json.data.examId;
      if (examId) {
        const detail = await apiFetch(API.resultAnalysis + encodeURIComponent(examId));
        if (detail.json && detail.json.data) {
          renderScoreSheet(test, detail.json.data);
          return true;
        }
      }
    }

    const msg = (payload && payload.message) || 'No result data returned for this test.';
    modalMessage('Result not available', msg);
    return false;
  }

  async function openAttemptAnalysis(test, attempt) {
    modalLoading('Loading analysis…');
    const res = await apiFetch(API.resultAnalysis + encodeURIComponent(attempt.examId));
    if (res.json && res.json.data) renderScoreSheet(test, res.json.data, attempt);
    else modalMessage('Analysis unavailable', (res.json && res.json.message) || 'The server did not return an analysis for this attempt.');
  }

  /* ---- fallback UI ---------------------------------------------------- */
  let modalEl = null;

  function ensureModal() {
    if (modalEl && document.body.contains(modalEl)) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'ntsc-fr-modal-root';
    modalEl.innerHTML = '<div class="ntsc-fr-modal-backdrop"></div><div class="ntsc-fr-modal" role="dialog" aria-modal="true"><div class="ntsc-fr-modal-head"><span class="ntsc-fr-modal-title">Result</span><button type="button" class="ntsc-fr-modal-x" aria-label="Close">&times;</button></div><div class="ntsc-fr-modal-body"></div></div>';
    modalEl.querySelector('.ntsc-fr-modal-backdrop').addEventListener('click', closeModal);
    modalEl.querySelector('.ntsc-fr-modal-x').addEventListener('click', closeModal);
    document.body.appendChild(modalEl);
    return modalEl;
  }

  function closeModal() {
    if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
    modalEl = null;
  }

  function modalSet(title, html) {
    const m = ensureModal();
    m.querySelector('.ntsc-fr-modal-title').textContent = title;
    m.querySelector('.ntsc-fr-modal-body').innerHTML = html;
  }

  function modalLoading(text) {
    modalSet('Result', '<div class="ntsc-fr-loading"><span class="ntsc-fr-spinner"></span>' + esc(text) + '</div>');
  }

  function modalMessage(title, text) {
    modalSet(title, '<div class="ntsc-fr-empty">' + esc(text) + '</div>');
  }

  function renderAttempts(test, attempts, totalSubjectMarks) {
    const rows = attempts.map((a) => {
      const pct = totalSubjectMarks ? ((a.totalMarks / totalSubjectMarks) * 100).toFixed(2) + '%' : '—';
      return (
        '<tr><td>' + esc(a.attemptDate || '—') + '</td>' +
        '<td>' + esc(a.totalMarks) + ' / ' + esc(totalSubjectMarks) + '</td>' +
        '<td>' + esc(pct) + '</td>' +
        '<td><button type="button" class="ntsc-fr-link" data-examid="' + esc(a.examId) + '">Analysis</button></td></tr>'
      );
    }).join('');

    modalSet(
      test.testName || 'Result',
      '<table class="ntsc-fr-table"><thead><tr><th>Attempted</th><th>Score</th><th>Percent</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
    );

    modalEl.querySelectorAll('.ntsc-fr-link').forEach((b) => {
      b.addEventListener('click', () => {
        const examId = b.getAttribute('data-examid');
        openAttemptAnalysis(test, { examId });
      });
    });
  }

  function renderScoreSheet(test, data, attempt) {
    const r = (data && data.result) || {};
    const subjects = Array.isArray(r.subjectData) ? r.subjectData : [];
    const pct = r.percentage != null ? r.percentage : (r.totalSubjectMarks ? ((r.totalMarks / r.totalSubjectMarks) * 100).toFixed(2) : '—');

    const cards = [
      ['Marks', esc(r.totalMarks) + ' / ' + esc(r.totalSubjectMarks)],
      ['Average', esc(r.totalAvg)],
      ['Percentage', esc(pct) + (pct === '—' ? '' : '%')],
      ['Rank', data.rank != null ? esc(data.rank) : '—']
    ].map((c) => '<div class="ntsc-fr-kpi"><span>' + c[0] + '</span><b>' + c[1] + '</b></div>').join('');

    const rows = subjects.map((s) => (
      '<tr><td>' + esc(s.subjectName) + '</td>' +
      '<td>' + esc(s.totalMarks) + ' / ' + esc(s.totalSubjectMarks) + '</td>' +
      '<td>' + esc(s.totalCorrect != null ? s.totalCorrect : '—') + '</td>' +
      '<td>' + esc(s.totalIncorrect != null ? s.totalIncorrect : '—') + '</td>' +
      '<td>' + esc(s.totalUnattempted != null ? s.totalUnattempted : '—') + '</td></tr>'
    )).join('');

    const meta = [];
    if (data.testName || test.testName) meta.push(esc(data.testName || test.testName));
    if (attempt && attempt.attemptDate) meta.push('Attempted ' + esc(attempt.attemptDate));
    else if (data.attemptDate) meta.push('Attempted ' + esc(data.attemptDate));

    modalSet(
      (data.testName || test.testName || 'Result'),
      (meta.length ? '<div class="ntsc-fr-meta">' + meta.join(' · ') + '</div>' : '') +
      '<div class="ntsc-fr-kpis">' + cards + '</div>' +
      (rows
        ? '<table class="ntsc-fr-table"><thead><tr><th>Subject</th><th>Marks</th><th>Correct</th><th>Wrong</th><th>Skipped</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '') +
      '<div class="ntsc-fr-note">Shown by NTSC Result Unlock because the Exam Hall button was locked. Data comes from the site\'s own result APIs.</div>'
    );
  }

  /* ======================================================================
   * 6. UI — badge, settings panel, toast
   * ==================================================================== */
  const CSS = `
  .ntsc-fr-badge{position:fixed;right:14px;bottom:14px;z-index:2147483000;display:flex;align-items:center;gap:7px;padding:7px 12px;border-radius:999px;background:#007fbe;color:#fff;font:600 12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 6px 20px rgba(0,60,120,.28);cursor:pointer;user-select:none;opacity:.92;transition:transform .15s ease,opacity .15s ease}
  .ntsc-fr-badge:hover{opacity:1;transform:translateY(-1px)}
  .ntsc-fr-badge .ntsc-fr-dot{width:7px;height:7px;border-radius:50%;background:#8ef0b0;box-shadow:0 0 0 3px rgba(142,240,176,.25)}
  .ntsc-fr-badge.ntsc-fr-off{background:#64748b}
  .ntsc-fr-badge.ntsc-fr-off .ntsc-fr-dot{background:#cbd5e1;box-shadow:none}
  .ntsc-fr-panel{position:fixed;right:14px;bottom:56px;z-index:2147483001;width:296px;background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 18px 44px rgba(15,23,42,.22);font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow:hidden}
  .ntsc-fr-panel h4{margin:0;padding:13px 15px;font-size:13px;letter-spacing:.2px;border-bottom:1px solid #eef2f7;background:#f8fbff;color:#0b4f7a;display:flex;justify-content:space-between;align-items:center}
  .ntsc-fr-panel h4 small{font-weight:500;color:#64748b;font-size:11px}
  .ntsc-fr-panel .ntsc-fr-row{display:flex;align-items:flex-start;gap:10px;padding:11px 15px;border-bottom:1px solid #f1f5f9;cursor:pointer}
  .ntsc-fr-panel .ntsc-fr-row:hover{background:#f8fbff}
  .ntsc-fr-panel .ntsc-fr-row input{margin-top:2px;accent-color:#007fbe}
  .ntsc-fr-panel .ntsc-fr-row b{display:block;font-size:12.5px;font-weight:600}
  .ntsc-fr-panel .ntsc-fr-row span{color:#64748b;font-size:11.5px}
  .ntsc-fr-foot{padding:10px 15px;display:flex;justify-content:space-between;align-items:center;color:#64748b;font-size:11.5px;background:#f8fbff}
  .ntsc-fr-foot button{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:5px 10px;font-size:11.5px;color:#0f172a;cursor:pointer}
  .ntsc-fr-foot button:hover{background:#eff6ff;border-color:#bfdbfe}
  .btn-analysis-result.ntsc-fr-forced{border-color:#007fbe!important;color:#007fbe!important;background:#f3faff!important;position:relative}
  .btn-analysis-result.ntsc-fr-forced:hover{background:#e6f4ff!important}
  .btn-analysis-result.ntsc-fr-forced::after{content:"⚡";position:absolute;top:-7px;right:-6px;font-size:10px;line-height:1;background:#007fbe;color:#fff;border-radius:50%;width:15px;height:15px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,127,190,.45)}
  .ntsc-fr-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(10px);z-index:2147483100;background:#0f172a;color:#fff;padding:10px 16px;border-radius:10px;font:600 12.5px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 12px 30px rgba(15,23,42,.35);opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease;max-width:78vw;text-align:center}
  .ntsc-fr-toast.ntsc-fr-show{opacity:1;transform:translateX(-50%) translateY(0)}
  .ntsc-fr-modal-root{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;padding:18px}
  .ntsc-fr-modal-backdrop{position:absolute;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(2px)}
  .ntsc-fr-modal{position:relative;width:min(720px,96vw);max-height:86vh;display:flex;flex-direction:column;background:#fff;color:#0f172a;border-radius:14px;box-shadow:0 24px 60px rgba(15,23,42,.35);font:13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow:hidden}
  .ntsc-fr-modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #eef2f7;background:#f8fbff}
  .ntsc-fr-modal-title{font-weight:700;font-size:14px;color:#0b4f7a}
  .ntsc-fr-modal-x{border:0;background:transparent;font-size:22px;line-height:1;color:#64748b;cursor:pointer}
  .ntsc-fr-modal-x:hover{color:#0f172a}
  .ntsc-fr-modal-body{padding:16px;overflow:auto}
  .ntsc-fr-loading{display:flex;align-items:center;gap:10px;color:#475569;padding:12px 2px}
  .ntsc-fr-spinner{width:16px;height:16px;border:2px solid #cbd5e1;border-top-color:#007fbe;border-radius:50%;animation:ntsc-fr-spin .7s linear infinite}
  @keyframes ntsc-fr-spin{to{transform:rotate(360deg)}}
  .ntsc-fr-empty{color:#475569;padding:10px 2px}
  .ntsc-fr-meta{color:#64748b;font-size:12px;margin-bottom:12px}
  .ntsc-fr-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px}
  .ntsc-fr-kpi{background:#f8fbff;border:1px solid #e6eef7;border-radius:10px;padding:9px 12px}
  .ntsc-fr-kpi span{display:block;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.4px}
  .ntsc-fr-kpi b{font-size:16px;color:#0b4f7a}
  .ntsc-fr-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .ntsc-fr-table th{text-align:left;background:#f1f5f9;color:#475569;font-weight:600;padding:8px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap}
  .ntsc-fr-table td{padding:8px 10px;border-bottom:1px solid #f1f5f9}
  .ntsc-fr-link{border:1px solid #bfdbfe;background:#eff6ff;color:#007fbe;border-radius:8px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer}
  .ntsc-fr-link:hover{background:#dbeafe}
  .ntsc-fr-note{margin-top:14px;color:#94a3b8;font-size:11px}
  `;

  let badgeEl = null;
  let panelEl = null;
  let toastEl = null;
  let toastTimer = null;

  function injectStyle() {
    if (document.getElementById('ntsc-fr-style')) return;
    const st = document.createElement('style');
    st.id = 'ntsc-fr-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function updateBadge() {
    if (!badgeEl) return;
    const on = cfg.autoUnlock || cfg.forceClick;
    badgeEl.classList.toggle('ntsc-fr-off', !on);
    badgeEl.querySelector('.ntsc-fr-text').textContent = on ? 'Result Unlock' : 'Result Unlock · off';
  }

  function buildBadge() {
    if (badgeEl) return;
    badgeEl = document.createElement('div');
    badgeEl.className = 'ntsc-fr-badge';
    badgeEl.innerHTML = '<span class="ntsc-fr-dot"></span><span class="ntsc-fr-text">Result Unlock</span>';
    badgeEl.title = 'NTSC Exam Hall Result Unlock — click to configure';
    badgeEl.addEventListener('click', togglePanel);
    document.body.appendChild(badgeEl);
    badgeEl.style.display = cfg.showBadge ? '' : 'none';
    updateBadge();
  }

  function togglePanel() {
    if (panelEl) { removePanel(); return; }

    panelEl = document.createElement('div');
    panelEl.className = 'ntsc-fr-panel';
    panelEl.innerHTML = `
      <h4>Result Unlock <small>exam hall fix</small></h4>
      <label class="ntsc-fr-row"><input type="checkbox" data-k="autoUnlock" ${cfg.autoUnlock ? 'checked' : ''}>
        <div><b>Auto-unlock result flags</b><span>Flips isPublish / isResultAutoPublish in the GetTests response so the button is active like a normal test.</span></div></label>
      <label class="ntsc-fr-row"><input type="checkbox" data-k="forceClick" ${cfg.forceClick ? 'checked' : ''}>
        <div><b>Force-click locked buttons</b><span>Any Result button still disabled gets unlocked and routed through the site's own result flow.</span></div></label>
      <label class="ntsc-fr-row"><input type="checkbox" data-k="showBadge" ${cfg.showBadge ? 'checked' : ''}>
        <div><b>Show this badge</b><span>Hide it if you want a clean exam hall.</span></div></label>
      <label class="ntsc-fr-row"><input type="checkbox" data-k="debug" ${cfg.debug ? 'checked' : ''}>
        <div><b>Debug logs</b><span>Print what the script does to the browser console.</span></div></label>
      <div class="ntsc-fr-foot"><span>v1.0 · <span id="ntsc-fr-count">${forcedCount}</span> unlocked</span><button type="button" id="ntsc-fr-rescan">Re-scan now</button></div>
    `;
    document.body.appendChild(panelEl);

    panelEl.querySelectorAll('input[data-k]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const k = inp.getAttribute('data-k');
        cfg[k] = inp.checked;
        saveCfg();
        if (k === 'showBadge' && badgeEl) badgeEl.style.display = cfg.showBadge ? '' : 'none';
        updateBadge();
        if (k === 'autoUnlock' || k === 'forceClick') {
          toast('Saved — reload the page for network-level changes');
        }
      });
    });

    panelEl.querySelector('#ntsc-fr-rescan').addEventListener('click', () => {
      scan();
      toast('Re-scanned the page');
    });
  }

  function removePanel() {
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    panelEl = null;
  }

  function toast(msg) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'ntsc-fr-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    // force reflow so the transition replays
    void toastEl.offsetWidth;
    toastEl.classList.add('ntsc-fr-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('ntsc-fr-show'), 2600);
  }

  /* ======================================================================
   * 7. Scanning / lifecycle
   * ==================================================================== */
  let scanQueued = false;

  function scan() {
    try {
      resultButtons().forEach(processButton);
    } catch (e) { log('scan error', e); }
    const counter = document.getElementById('ntsc-fr-count');
    if (counter) counter.textContent = String(forcedCount);
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan();
    });
  }

  function startObservers() {
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') {
          const t = m.target;
          if (t && t.classList && t.classList.contains(BTN_CLASS)) { queueScan(); return; }
          if (t && t.closest && t.closest('.exam-row-card, .exam-table-body')) { queueScan(); return; }
        } else if (m.addedNodes && m.addedNodes.length) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && (n.classList.contains(BTN_CLASS) || n.querySelector('.btn-analysis-result, .exam-row-card, .exam-table-body'))) {
              queueScan();
              return;
            }
          }
        }
      }
    });
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'class', 'aria-disabled']
    });

    // safety net (countdown timers re-render rows every second)
    setInterval(scan, 1500);
  }

  function boot() {
    injectStyle();
    buildBadge();
    scan();
    startObservers();
    log('booted');
  }

  /* ---- menu commands -------------------------------------------------- */
  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('Toggle auto-unlock (network)', () => {
      cfg.autoUnlock = !cfg.autoUnlock; saveCfg(); updateBadge(); toast('Auto-unlock: ' + (cfg.autoUnlock ? 'ON' : 'OFF') + ' (reload to apply)');
    });
    GM_registerMenuCommand('Toggle force-click', () => {
      cfg.forceClick = !cfg.forceClick; saveCfg(); updateBadge(); toast('Force-click: ' + (cfg.forceClick ? 'ON' : 'OFF'));
    });
    GM_registerMenuCommand('Toggle debug logs', () => {
      cfg.debug = !cfg.debug; saveCfg(); toast('Debug: ' + (cfg.debug ? 'ON' : 'OFF'));
    });
    GM_registerMenuCommand('Re-scan now', () => { scan(); toast('Re-scanned'); });
  }

  /* ---- start ---------------------------------------------------------- */
  // Network hooks must be installed before the app bundle runs.
  try { installXhrHook(); } catch (e) { console.warn('[NTSC·ResultUnlock] xhr hook failed', e); }
  try { installFetchHook(); } catch (e) { console.warn('[NTSC·ResultUnlock] fetch hook failed', e); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
  registerMenu();
})();
