// ==UserScript==
// @name         NTSC Exam Hall — Force Result Unlock
// @namespace    https://ntsc.narayanatalent.com/
// @version      1.4.0
// @description  Unlocks the Exam Hall "Result" button when NTSC leaves it disabled (result published but flag not updated / exam-hall glitch), forces the Leader Board tab on results that hide it, and kills the full-screen "Special Announcement" home page pop-up. One settings screen: click the badge, press Alt+N, type s.ntsc, or open /#ntsc-settings.
// @author       arena
// @license      MIT
// @icon         https://ntsc.narayanatalent.com/favicon.ico
// @updateURL    https://raw.githubusercontent.com/Evo690/tamper/main/ntsc-force-result.user.js
// @downloadURL  https://raw.githubusercontent.com/Evo690/tamper/main/ntsc-force-result.user.js
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
 HOME PAGE POP-UP BLOCKER  (added in 1.3.0)
 ---------------------------------------------------------------------------
 The full-screen "Special Announcement" overlay is a shared component.
 Decoded from chunk 5799.*.chunk.js of the live bundle (module 2379):

     const key = `hasSeenPopup_${props.storageKey || window.location.pathname}`;
     //                                  -> "hasSeenPopup_homePagePopup"
     useEffect(() => {
       if (!sessionStorage.getItem(key) && props.imageData) setShow(true);
       else setShow(false);
     }, [props.imageData, key]);
     ...
     return show && (
       <div className={"home-popup-overlay " + (canClose ? "can-close" : "")}>
         <div className="home-popup-content">
           {canClose ? <button className="close-btn">x</button>
                     : <div className="popup-countdown">{count}</div>}
           <img className="popup-image" src={...} onClick={open} />
           <button className="navigate-btn">Click Here</button>
         </div>
       </div>);

 The home page feeds it with:

     <Popup storageKey="homePagePopup"
            imageData={bannerList.find(b => b.bannerType === 6)} />

 where bannerList comes from
     GET /general-service/api/Banner/GetWebBanners   ->  { data: [...] }

 Two reasons it comes back on *every* visit:
   * the "seen" flag lives in **sessionStorage**, so a new tab = new session;
   * the banner is re-fetched from the API on every load.

 Three independent defences, all toggleable in the badge panel:

   A. API STRIP      - drop the bannerType 6 entry from the GetWebBanners
                       response, so `imageData` is undefined and React never
                       mounts the overlay at all. No flash, the 500x500
                       CloudFront image is never even requested.
   B. SEEN FLAG      - make sessionStorage.getItem("hasSeenPopup_*") answer
                       "true", so every other instance of the component
                       (any route / any future storageKey) stays shut too.
   C. DOM KILL       - a stylesheet + a sweep that hides
                       `.home-popup-overlay` if it somehow still renders
                       (cached Redux state, site refactor, ...).

 Nothing is written to the server, nothing is blocked for other banners.

 ---------------------------------------------------------------------------
 ONE SETTINGS SCREEN, FIVE DOORS  (1.4.0)
 ---------------------------------------------------------------------------
 Every option lives in a single full-page settings screen. Open it with any of:

     click the NTSC Tools badge      bottom-right pill
     Alt + N                         anywhere on the site (Esc closes)
     type  s.ntsc                    anywhere on the page, nothing to install
     go to /#ntsc-settings           or /s.ntsc - bookmarkable
     Tampermonkey menu -> Open settings

 A userscript cannot see what you type in the *omnibox*, so "s.ntsc" in the
 address bar needs a one-time Chrome setup (documented in the settings screen
 and the README): add a site-search keyword `s.ntsc` pointing at
 https://ntsc.narayanatalent.com/#ntsc-settings  ->  then the omnibox works too.

 The screen remembers nothing extra: it is rendered from `cfg` on every open and
 every switch writes straight back through GM_setValue / localStorage.
 ---------------------------------------------------------------------------
*/

(function () {
  'use strict';

  /* ======================================================================
   * 0. Config
   * ==================================================================== */
  const CFG_STORE_KEY = 'ntscForceResultConfig';
  const DEFAULTS = {
    autoUnlock: true,        // network layer: flip publish flags
    forceClick: true,        // force layer: unlock+route still-disabled buttons
    forceLeaderboard: true,  // add the Leader Board tab to results that hide it
    showBadge: true,         // floating badge
    debug: false,

    // ---- home page pop-up blocker (1.3.0) ----
    hidePopup: true,         // MASTER switch for the pop-up blocker
    popupBlockApi: true,     // A: strip bannerType 6 from GetWebBanners
    popupSeenFlag: true,     // B: pretend sessionStorage says "already seen"
    popupKillDom: true,      // C: hide any overlay that still renders

    // ---- settings screen (1.4.0) ----
    showBadge: true,         // (kept here so the Interface group reads in order)
    openOnType: true,        // type "s.ntsc" anywhere on the page to open
    openOnHotkey: true,      // Alt + N
    openOnUrl: true,         // /#ntsc-settings  or  /s.ntsc
    typePhrase: 's.ntsc'     // the phrase for openOnType
  };

  const cfg = Object.assign({}, DEFAULTS, loadCfg());

  // how many pop-ups each defence layer has stopped in this page load
  const POPUP_STATS = { api: 0, seen: 0, dom: 0 };
  // A and B both describe the same "never rendered" event, so they count once;
  // C counts every overlay it actually had to hide.
  const popupTotal = () =>
    ((POPUP_STATS.api > 0 || POPUP_STATS.seen > 0) ? 1 : 0) + POPUP_STATS.dom;
  const POPUP_KEYS = new Set(['hidePopup', 'popupBlockApi', 'popupSeenFlag', 'popupKillDom']);

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

  const SCORE_BOARD_KEY = 'ntscForceResultLeaderboards';

  const ENDPOINTS = {
    tests: [
      /\/exam-service\/api\/ExaminationHall\/GetTests(\?|$)/i,
      /\/exam-service\/api\/Course\/GetScheduleExam(\?|$)/i
    ],
    analysis: [
      /\/exam-service\/api\/ExaminationHall\/GetResultAnalysis\//i,
      /\/exam-service\/api\/GroupPaper\/GetStudentResult\//i
    ],
    leaderboard: [
      /\/exam-service\/api\/ExaminationHall\/GetLeaderboardScore(\?|$)/i
    ],
    banners: [
      /\/general-service\/api\/Banner\/GetWebBanners(\?|$)/i
    ]
  };

  /** 'tests' | 'analysis' | 'leaderboard' | null */
  function endpointKind(url) {
    if (!url) return null;
    const u = String(url);
    for (const kind of Object.keys(ENDPOINTS)) {
      if (ENDPOINTS[kind].some((rx) => rx.test(u))) return kind;
    }
    return null;
  }

  /* ---- what we know about leaderboards, per testPaperId -----------------
     ok   -> this test has a leaderboard, keep forcing it
     none -> the server said there is nothing, don't force it again (7 days)
  ---------------------------------------------------------------------- */
  const LB_KNOWN = loadLbKnown();

  function loadLbKnown() {
    const map = new Map();
    try {
      const raw = (typeof GM_getValue === 'function')
        ? GM_getValue(SCORE_BOARD_KEY, '{}')
        : localStorage.getItem(SCORE_BOARD_KEY) || '{}';
      const obj = JSON.parse(raw) || {};
      const now = Date.now();
      Object.keys(obj).forEach((id) => {
        const it = obj[id];
        if (it && it.state && now - (it.t || 0) < 7 * 864e5) map.set(id, it.state);
      });
    } catch (e) { /* ignore */ }
    return map;
  }

  function lbRemember(id, state) {
    if (id == null) return;
    if (LB_KNOWN.get(String(id)) === state) return;
    LB_KNOWN.set(String(id), state);
    try {
      const obj = {};
      LB_KNOWN.forEach((v, k) => { obj[k] = { state: v, t: Date.now() }; });
      const raw = JSON.stringify(obj);
      if (typeof GM_setValue === 'function') GM_setValue(SCORE_BOARD_KEY, raw);
      else localStorage.setItem(SCORE_BOARD_KEY, raw);
    } catch (e) { /* ignore */ }
  }

  // latest result view we have seen, used by the "Leaderboard" pill
  const LAST_ANALYSIS = { testPaperId: null, examId: null, subjects: [], testName: '', at: 0 };

  /**
   * Result-analysis responses (single paper + group paper).
   * Adds isLeaderboard so the site renders its own "Leader Board" tab and
   * fires GetLeaderboardScore by itself. Remembers the testPaperId either way.
   */
  function patchAnalysisPayload(json) {
    const d = json && json.data;
    if (!d || typeof d !== 'object') return false;

    if (d.testPaperId != null) LAST_ANALYSIS.testPaperId = d.testPaperId;
    if (d.examId != null) LAST_ANALYSIS.examId = d.examId;
    else if (d.studentExamId != null) LAST_ANALYSIS.examId = d.studentExamId;
    if (d.testName) LAST_ANALYSIS.testName = d.testName;
    const subjects = d.result && Array.isArray(d.result.subjectData) ? d.result.subjectData : null;
    if (subjects && subjects.length) {
      LAST_ANALYSIS.subjects = subjects.map((x) => (x && x.subjectName) || '').filter(Boolean);
    }
    LAST_ANALYSIS.at = Date.now();

    if (!cfg.forceLeaderboard) return false;
    if (d.isLeaderboard === true) return false;

    // Don't resurrect a tab we already know is empty for this paper.
    const id = d.testPaperId;
    if (id != null && LB_KNOWN.get(String(id)) === 'none') return false;

    d.isLeaderboard = true;
    log('forced leaderboard tab', id);
    return true;
  }

  /** Learn from the site's own GetLeaderboardScore answer. */
  function noteLeaderboardResult(json, requestBody) {
    let id = null;
    try {
      const body = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody;
      if (body && body.id != null) id = body.id;
    } catch (e) { /* ignore */ }
    if (id == null) return false;

    const rows = json && json.data && json.data.leaderboardScore;
    const failed = !json || json.statusCode >= 400 || !json.data;
    if (failed || !Array.isArray(rows) || !rows.length) lbRemember(id, 'none');
    else lbRemember(id, 'ok');
    return false;
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

    proto.send = function (body) {
      try {
        const kind = endpointKind(this.__ntscUrl);
        if (kind) {
          this.__ntscKind = kind;
          this.__ntscBody = typeof body === 'string' ? body : null;
          installLazyResponsePatch(this, XHR, kind);
        }
      } catch (e) { log('xhr hook error', e); }
      return origSend.apply(this, arguments);
    };
  }

  function applyPayloadPatcher(kind, json, requestBody) {
    if (kind === 'tests') return patchTestPayload(json);
    if (kind === 'analysis') return patchAnalysisPayload(json);
    if (kind === 'leaderboard') return noteLeaderboardResult(json, requestBody);
    if (kind === 'banners') return patchBannerPayload(json);
    return false;
  }

  /* ---- home pop-up: remove the HomePagePopupBanner from the banner list ---
     The home page does:
         imageData = bannerList.find(b => b.bannerType === 6)
     and only renders the overlay when that object exists. No object, no pop-up
     - and the banner image is never requested either.
  ---------------------------------------------------------------------- */
  const POPUP_BANNER_TYPE = 6; // BannerType.HomePagePopupBanner (main.js)

  function isPopupBanner(b) {
    if (!b || typeof b !== 'object') return false;
    // bannerType is always present - trust it when it is
    if (b.bannerType != null) return Number(b.bannerType) === POPUP_BANNER_TYPE;
    // otherwise fall back to the CMS title ("NTSC Home Pop-Up")
    return /pop\s*-?\s*up/i.test(String(b.title || ''));
  }

  function patchBannerPayload(json) {
    if (!cfg.hidePopup || !cfg.popupBlockApi) return false;
    if (!json || !Array.isArray(json.data)) return false;

    const before = json.data.length;
    const kept = json.data.filter((b) => !isPopupBanner(b));
    if (kept.length === before) return false;

    json.data = kept;
    POPUP_STATS.api += before - kept.length;
    log('popup: dropped', before - kept.length, 'home pop-up banner(s) from GetWebBanners');
    bumpPopupCounter();
    return true;
  }

  function installLazyResponsePatch(xhr, XHR, kind) {
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
        if (applyPayloadPatcher(kind, json, xhr.__ntscBody)) out = JSON.stringify(json);
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
              try { applyPayloadPatcher(kind, obj, xhr.__ntscBody); } catch (e) { /* ignore */ }
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
      const kind = endpointKind(url);
      const reqBody = init && typeof init.body === 'string' ? init.body : null;
      const p = origFetch.apply(this, arguments);
      if (!kind) return p;

      return p.then(async (res) => {
        try {
          const raw = await res.clone().text();
          const json = JSON.parse(raw);
          if (applyPayloadPatcher(kind, json, reqBody)) {
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
    courseExamId: '/exam-service/api/CourseResult/GetExamId/',
    leaderboard: '/exam-service/api/ExaminationHall/GetLeaderboardScore'
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

  /* ======================================================================
   * 6. LEADERBOARD — pill + table (uses the site's own endpoint)
   * ==================================================================== */
  let lbPill = null;
  let lbBusy = false;

  function resultViewMounted() {
    return !!(document.querySelector('.result-analysis') ||
              document.querySelector('.content.result-analysis') ||
              document.querySelector('.score-card-table'));
  }

  function nativeLeaderboardTab() {
    const links = document.querySelectorAll('.nav-link, .nav-item a, .nav-item p');
    for (const el of links) {
      const t = norm(el.textContent);
      if (t === 'leader board' || t === 'leaderboard') return el;
    }
    return null;
  }

  /** Show the pill when a result is open, we know the paper id, and the site
      did not render its own Leader Board tab. */
  function syncLeaderboardPill() {
    const known = LAST_ANALYSIS.testPaperId != null ? LB_KNOWN.get(String(LAST_ANALYSIS.testPaperId)) : null;
    const wanted = cfg.forceLeaderboard &&
      LAST_ANALYSIS.testPaperId != null &&
      known !== 'none' &&                       // server already said there is none
      Date.now() - LAST_ANALYSIS.at < 6 * 6e4 &&
      resultViewMounted() &&
      !nativeLeaderboardTab();

    if (!wanted) {
      if (lbPill && lbPill.parentNode) lbPill.parentNode.removeChild(lbPill);
      lbPill = null;
      return;
    }
    if (lbPill && document.body.contains(lbPill)) return;

    lbPill = document.createElement('button');
    lbPill.type = 'button';
    lbPill.className = 'ntsc-fr-lb-pill';
    lbPill.innerHTML = '<span>🏆</span> Leaderboard';
    lbPill.title = 'Load the leaderboard for this result';
    lbPill.addEventListener('click', openLeaderboard);
    document.body.appendChild(lbPill);
  }

  function renderLeaderboard(rows, subjects) {
    const yourId = LAST_ANALYSIS.examId;
    let youIndex = -1;
    if (yourId != null) {
      const hits = rows.filter((r) => String(r.examId) === String(yourId));
      if (hits.length === 1) youIndex = rows.indexOf(hits[0]);
    }

    // column headers: prefer subject names from the analysis, else from row data
    let names = subjects && subjects.length ? subjects.slice() : [];
    if (!names.length) {
      const first = rows.find((r) => Array.isArray(r.subjectPerformance) && r.subjectPerformance.length);
      if (first) names = first.subjectPerformance.map((x) => (x && x.subjectName) || '');
    }

    const head = '<tr><th>#</th><th>Student</th>' +
      names.map((n) => '<th>' + esc(n) + '</th>').join('') +
      '<th>Total</th><th>Rank</th></tr>';

    const body = rows.map((r, i) => {
      const perf = Array.isArray(r.subjectPerformance) ? r.subjectPerformance : [];
      const cells = names.map((_, si) => {
        const p = perf[si];
        const v = p && p.totalMarks != null ? p.totalMarks : '—';
        return '<td>' + esc(v) + '</td>';
      }).join('');
      const you = i === youIndex;
      return '<tr class="' + (you ? 'ntsc-fr-you' : '') + '">' +
        '<td>' + (i + 1) + '</td>' +
        '<td class="ntsc-fr-lb-name">' + esc(r.studentName || ('Student ' + (i + 1))) + (you ? ' <span class="ntsc-fr-you-tag">you</span>' : '') + '</td>' +
        cells +
        '<td><b>' + esc(r.totalMarks != null ? r.totalMarks : '—') + '</b></td>' +
        '<td>' + esc(r.ranks != null ? r.ranks : '—') + '</td>' +
        '</tr>';
    }).join('');

    modalSet('Leaderboard',
      '<div class="ntsc-fr-meta">' + esc(LAST_ANALYSIS.testName || 'Result') + ' · ' + rows.length + ' student(s)</div>' +
      '<div class="ntsc-fr-lb-wrap"><table class="ntsc-fr-table ntsc-fr-lb"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="ntsc-fr-note">Same data as the site\'s Leader Board tab (ExaminationHall/GetLeaderboardScore).</div>');
  }

  async function openLeaderboard() {
    if (lbBusy) return;
    const id = LAST_ANALYSIS.testPaperId;
    if (id == null) { toast('No leaderboard id for this result'); return; }

    lbBusy = true;
    modalLoading('Loading leaderboard…');
    try {
      const res = await apiFetch(API.leaderboard, { method: 'POST', body: { id } });
      const payload = res.json;
      const rows = payload && payload.data && Array.isArray(payload.data.leaderboardScore)
        ? payload.data.leaderboardScore
        : null;

      if (rows && rows.length) {
        lbRemember(id, 'ok');
        renderLeaderboard(rows, LAST_ANALYSIS.subjects);
      } else {
        lbRemember(id, 'none');
        modalMessage('Leaderboard', (payload && payload.message) || 'No leaderboard published for this result.');
      }
    } catch (e) {
      modalMessage('Leaderboard', 'Could not reach the leaderboard API.');
    } finally {
      lbBusy = false;
    }
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
   * 6b. HOME POP-UP BLOCKER
   * ==================================================================== */

  /* ---- B. SEEN FLAG ----------------------------------------------------
     sessionStorage.getItem('hasSeenPopup_homePagePopup') gates the overlay.
     We lie and say "already seen" for ANY key with that prefix, so every
     instance of the component stays shut - no matter the route or storageKey.
  ---------------------------------------------------------------------- */
  const POPUP_SEEN_PREFIX = 'hasSeenPopup_';

  function installSeenFlagPatch() {
    try {
      const proto = PAGE.Storage && PAGE.Storage.prototype;
      const ss = PAGE.sessionStorage;
      if (!proto || !ss || proto.__ntscSeenHooked) return false;
      proto.__ntscSeenHooked = true;

      const origGet = proto.getItem;
      proto.getItem = function (key) {
        try {
          if (this === ss && cfg.hidePopup && cfg.popupSeenFlag &&
              typeof key === 'string' && key.indexOf(POPUP_SEEN_PREFIX) === 0) {
            const real = origGet.call(this, key);
            if (!real) {
              POPUP_STATS.seen++;
              log('popup: faking seen flag for', key);
              return 'true';
            }
            return real;
          }
        } catch (e) { /* ignore */ }
        return origGet.apply(this, arguments);
      };
      log('popup: sessionStorage hook installed');
      return true;
    } catch (e) {
      log('popup: sessionStorage hook failed', e);
      return false;
    }
  }

  /* ---- C. DOM KILL -----------------------------------------------------
     Last line of defence. A stylesheet switch (applies from the very first
     paint, zero flash) plus a sweep that hides anything already in the DOM.
  ---------------------------------------------------------------------- */
  const POPUP_SEL = '.home-popup-overlay';
  const POPUP_CSS = `
  .home-popup-overlay{display:none!important;visibility:hidden!important;pointer-events:none!important}
  .home-popup-overlay .popup-image{content-visibility:hidden}
  `;
  const POPUP_HIDDEN = ['display', 'visibility', 'pointer-events'];

  let popupStyleEl = null;
  const popupKilled = new Set();

  /** Keep the settings screen's "pop-ups blocked" stat in sync. */
  function bumpPopupCounter() {
    if (statPopupEl) statPopupEl.textContent = String(popupTotal());
  }

  function injectPopupStyle() {
    if (popupStyleEl && popupStyleEl.isConnected) return popupStyleEl;
    try {
      const el = document.createElement('style');
      el.id = 'ntsc-fr-nopopup';
      el.textContent = POPUP_CSS;
      const host = document.head || document.documentElement || document.body;
      if (!host) return null;               // ran too early - caller retries
      host.appendChild(el);
      popupStyleEl = el;
      return el;
    } catch (e) {
      log('popup: style inject failed', e);
      return null;
    }
  }

  function syncPopupStyle() {
    try {
      const el = injectPopupStyle();
      if (el) el.disabled = !(cfg.hidePopup && cfg.popupKillDom);
    } catch (e) { log('popup: style sync failed', e); }
  }

  function restorePopups() {
    popupKilled.forEach((el) => {
      POPUP_HIDDEN.forEach((p) => el.style.removeProperty(p));
      el.removeAttribute('data-ntsc-fr-hidden');
    });
    popupKilled.clear();
    syncPopupStyle();
  }

  /** Hide any overlay that is already in the DOM. Returns how many it hid. */
  function sweepPopups() {
    if (!cfg.hidePopup || !cfg.popupKillDom) { if (popupKilled.size) restorePopups(); return 0; }
    if (!document.body) return 0;

    let n = 0;
    document.querySelectorAll(POPUP_SEL).forEach((el) => {
      if (popupKilled.has(el)) return;
      // Hide inline (React never re-renders this element's style, so it sticks)
      // rather than removing it - removing a React-owned node can throw.
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
      el.setAttribute('data-ntsc-fr-hidden', '1');
      popupKilled.add(el);
      n++;
      POPUP_STATS.dom++;
      log('popup: hid a rendered overlay');
    });

    if (n) bumpPopupCounter();
    return n;
  }

  let popupSweepQueued = false;

  function queuePopupSweep() {
    if (popupSweepQueued) return;
    popupSweepQueued = true;
    requestAnimationFrame(() => {
      popupSweepQueued = false;
      try { sweepPopups(); } catch (e) { log('popup sweep error', e); }
    });
  }

  /** Called whenever the pop-up settings change. */
  function applyPopupSettings() {
    syncPopupStyle();
    sweepPopups();
    bumpPopupCounter();
  }

  /* ======================================================================
   * 6c. UNIFIED SETTINGS SCREEN — every option in one place
   *     Full-page takeover. Opened by ANY of:
   *        · clicking the badge        · Alt + N
   *        · typing "s.ntsc"           · /#ntsc-settings   or   /s.ntsc
   *        · the Tampermonkey menu
   *     Esc (or the x) closes.
   * ==================================================================== */

  const VERSION = '1.4.0';
  const SETTINGS_HASH = '#ntsc-settings';
  const DEFAULT_PHRASE = 's.ntsc';

  /* ---- every option, in order, with the copy shown next to its switch ---- */
  const OPT_DEFS = {
    hidePopup: {
      label: 'Block the home pop-up',
      desc: 'Master switch. Kills the full-screen "Special Announcement" overlay on every visit.'
    },
    popupBlockApi: {
      label: 'A · Remove it from the banner API',
      desc: 'Drops the HomePagePopupBanner from GetWebBanners, so the overlay is never built and its image is never downloaded.',
      sub: 'hidePopup', reload: true
    },
    popupSeenFlag: {
      label: 'B · Pretend it was already seen',
      desc: 'Makes sessionStorage answer "true" for every hasSeenPopup_* key.',
      sub: 'hidePopup'
    },
    popupKillDom: {
      label: 'C · Hide anything that still renders',
      desc: 'CSS + sweep on .home-popup-overlay. Last line of defence if the site changes shape.',
      sub: 'hidePopup'
    },

    autoUnlock: {
      label: 'Auto-unlock result flags',
      desc: 'Flips isPublish / isResultAutoPublish in the GetTests response so the Result button is a normal, active button.',
      reload: true
    },
    forceClick: {
      label: 'Force-click locked buttons',
      desc: 'Any Result button still disabled gets unlocked and routed through the site\'s own result flow.',
      reload: true
    },
    forceLeaderboard: {
      label: 'Force leaderboard',
      desc: 'Adds the Leader Board tab to results that hide it. Skipped automatically for tests that have none.',
      reload: true
    },

    showBadge: {
      label: 'Show the floating badge',
      desc: 'The NTSC Tools pill in the bottom-right corner. Clicking it opens this screen.'
    },
    openOnType: {
      label: 'Open when I type s.ntsc',
      desc: 'Just start typing the phrase anywhere on the page — no navigation, nothing to set up.'
    },
    openOnHotkey: {
      label: 'Open with Alt + N',
      desc: 'Keyboard shortcut. Esc closes this screen again.'
    },
    openOnUrl: {
      label: 'Open from the address bar',
      desc: 'Going to /#ntsc-settings (or /s.ntsc) opens this screen. Bookmarkable.'
    },
    debug: {
      label: 'Debug logs',
      desc: 'Print what the script is doing to the browser console.'
    }
  };

  const OPT_GROUPS = [
    {
      title: 'Home page pop-up',
      hint: 'It returns every visit because the "seen" flag lives in sessionStorage (new tab = new session) and the banner is re-fetched on every load.',
      keys: ['hidePopup', 'popupBlockApi', 'popupSeenFlag', 'popupKillDom']
    },
    {
      title: 'Exam hall',
      hint: 'Forces the Result button and the hidden Leader Board tab. Changes here need a reload.',
      keys: ['autoUnlock', 'forceClick', 'forceLeaderboard']
    },
    {
      title: 'Interface & triggers',
      hint: 'How this settings screen can be reached, plus the badge and logging.',
      keys: ['showBadge', 'openOnType', 'openOnHotkey', 'openOnUrl', 'debug']
    }
  ];

  let settingsEl = null;
  let settingsOpen = false;
  let statPopupEl = null;
  let statUnlockEl = null;
  let statLbEl = null;
  const phraseBuf = { s: '', at: 0 };

  /* ---- rendering ------------------------------------------------------- */
  function optRow(k) {
    const d = OPT_DEFS[k] || { label: k, desc: '' };
    return '<label class="ntsc-fr-opt' + (d.sub ? ' ntsc-fr-sub' : '') + '" data-k="' + k + '" data-search="' +
      esc((d.label + ' ' + d.desc).toLowerCase()) + '">' +
      '<input type="checkbox" ' + (cfg[k] ? 'checked' : '') + '>' +
      '<span class="ntsc-fr-switch"></span>' +
      '<span class="ntsc-fr-txt"><b>' + esc(d.label) +
      (d.reload ? '<i class="ntsc-fr-reload">reload</i>' : '') + '</b>' +
      '<span>' + esc(d.desc) + '</span></span></label>';
  }

  function settingsHTML() {
    let groups = '';
    OPT_GROUPS.forEach((g) => {
      groups +=
        '<section class="ntsc-fr-card" data-search="' + esc(g.title.toLowerCase()) + '">' +
          '<header class="ntsc-fr-card-h"><h3>' + esc(g.title) + '</h3>' +
          (g.hint ? '<p>' + esc(g.hint) + '</p>' : '') + '</header>' +
          '<div class="ntsc-fr-card-b">' + g.keys.map(optRow).join('') + '</div>' +
        '</section>';
    });

    return '' +
      '<div class="ntsc-fr-top">' +
        '<div class="ntsc-fr-brand"><span class="ntsc-fr-logo">N</span>' +
          '<div><h2>NTSC Tools</h2><p>Result unlock &amp; pop-up blocker · v' + esc(VERSION) + '</p></div></div>' +
        '<input id="ntsc-fr-search" class="ntsc-fr-search" type="search" placeholder="Search settings…" autocomplete="off" spellcheck="false">' +
        '<button type="button" class="ntsc-fr-x" id="ntsc-fr-x" aria-label="Close settings">×</button>' +
      '</div>' +
      '<div class="ntsc-fr-scroll"><div class="ntsc-fr-wrap">' +
        '<div class="ntsc-fr-empty-search" id="ntsc-fr-noresult">No setting matches that.</div>' +
        groups +
        '<section class="ntsc-fr-card" data-search="phrase type open s.ntsc">' +
          '<header class="ntsc-fr-card-h"><h3>Type-to-open phrase</h3>' +
            '<p>Change what you type on the page to summon this screen.</p></header>' +
          '<div class="ntsc-fr-card-b"><div class="ntsc-fr-phrase">' +
            '<code>phrase</code>' +
            '<input id="ntsc-fr-phrase" type="text" value="' + esc(cfg.typePhrase || DEFAULT_PHRASE) + '" spellcheck="false" autocomplete="off">' +
            '<button type="button" class="ntsc-fr-btn" id="ntsc-fr-phrase-reset">Reset</button>' +
          '</div></div>' +
        '</section>' +
        '<section class="ntsc-fr-card" data-search="stats counters blocked">' +
          '<header class="ntsc-fr-card-h"><h3>This visit</h3></header>' +
          '<div class="ntsc-fr-card-b ntsc-fr-stats">' +
            '<div><span id="ntsc-fr-st-pop">0</span><b>pop-ups blocked</b></div>' +
            '<div><span id="ntsc-fr-st-unlock">0</span><b>results unlocked</b></div>' +
            '<div><span id="ntsc-fr-st-lb">0</span><b>leaderboards cached</b></div>' +
          '</div>' +
        '</section>' +
        '<section class="ntsc-fr-card" data-search="actions reset copy rescan">' +
          '<header class="ntsc-fr-card-h"><h3>Actions</h3></header>' +
          '<div class="ntsc-fr-card-b ntsc-fr-actions">' +
            '<button type="button" class="ntsc-fr-btn" id="ntsc-fr-rescan">Re-scan page</button>' +
            '<button type="button" class="ntsc-fr-btn" id="ntsc-fr-copy">Copy settings</button>' +
            '<button type="button" class="ntsc-fr-btn ntsc-fr-danger" id="ntsc-fr-reset">Reset to defaults</button>' +
          '</div>' +
        '</section>' +
        '<section class="ntsc-fr-card" data-search="how open trigger badge alt n hotkey address bar url">' +
          '<header class="ntsc-fr-card-h"><h3>How to open this screen</h3></header>' +
          '<div class="ntsc-fr-card-b"><ul class="ntsc-fr-how">' +
            '<li><b>Click the badge</b> — the NTSC Tools pill, bottom right.</li>' +
            '<li><b>Alt + N</b> — anywhere on the site. Esc closes.</li>' +
            '<li><b>Type</b> <code>s.ntsc</code> — start typing it anywhere on the page.</li>' +
            '<li><b>Address bar</b> — <code>ntsc.narayanatalent.com/#ntsc-settings</code> or <code>ntsc.narayanatalent.com/s.ntsc</code>.</li>' +
            '<li><b>Tampermonkey menu</b> → "Open settings".</li>' +
            '<li><b>Omnibox tip</b> — in <i>chrome://settings/searchEngines</i> add a site search named ' +
              '<code>s.ntsc</code> with keyword <code>s.ntsc</code> and URL ' +
              '<code>https://ntsc.narayanatalent.com/#ntsc-settings</code>. Then typing ' +
              '<code>s.ntsc</code> + Enter in the address bar lands straight here.</li>' +
          '</ul></div>' +
        '</section>' +
      '</div></div>';
  }

  function syncSettingsRows() {
    if (!settingsEl) return;
    settingsEl.querySelectorAll('.ntsc-fr-opt[data-k]').forEach((row) => {
      const k = row.getAttribute('data-k');
      const inp = row.querySelector('input');
      if (inp) inp.checked = !!cfg[k];
      const d = OPT_DEFS[k];
      if (d && d.sub) row.classList.toggle('ntsc-fr-dim', !cfg[d.sub]);
    });
    if (statPopupEl) statPopupEl.textContent = String(popupTotal());
    if (statUnlockEl) statUnlockEl.textContent = String(forcedCount);
    if (statLbEl) statLbEl.textContent = String(LB_KNOWN.size);
  }

  function wireSettings() {
    if (!settingsEl) return;

    settingsEl.querySelectorAll('.ntsc-fr-opt[data-k] input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const row = inp.closest('.ntsc-fr-opt');
        const k = row && row.getAttribute('data-k');
        if (!k) return;
        cfg[k] = inp.checked;
        saveCfg();
        onSettingChanged(k);
      });
    });

    const closeBtn = settingsEl.querySelector('#ntsc-fr-x');
    if (closeBtn) closeBtn.addEventListener('click', closeSettings);

    const search = settingsEl.querySelector('#ntsc-fr-search');
    const noResult = settingsEl.querySelector('#ntsc-fr-noresult');
    if (search) {
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        let hits = 0;
        settingsEl.querySelectorAll('.ntsc-fr-opt[data-k]').forEach((row) => {
          const hit = !q || (row.getAttribute('data-search') || '').indexOf(q) !== -1;
          row.style.display = hit ? '' : 'none';
          if (hit) hits++;
        });
        settingsEl.querySelectorAll('.ntsc-fr-card').forEach((card) => {
          const rows = card.querySelectorAll('.ntsc-fr-opt[data-k]');
          const any = rows.length === 0
            ? !q || (card.getAttribute('data-search') || '').indexOf(q) !== -1
            : Array.prototype.some.call(rows, (r) => r.style.display !== 'none');
          card.style.display = any ? '' : 'none';
        });
        if (noResult) noResult.style.display = hits ? 'none' : 'block';
      });
    }

    const phrase = settingsEl.querySelector('#ntsc-fr-phrase');
    if (phrase) {
      phrase.addEventListener('change', () => {
        cfg.typePhrase = String(phrase.value || '').trim() || DEFAULT_PHRASE;
        phrase.value = cfg.typePhrase;
        saveCfg();
        phraseBuf.s = '';
        toast('Phrase set to "' + cfg.typePhrase + '"');
      });
      // don't let the phrase field eat the Alt+N / Esc shortcuts
      phrase.addEventListener('keydown', (e) => { if (e.key === 'Escape') phrase.blur(); });
    }
    const phraseReset = settingsEl.querySelector('#ntsc-fr-phrase-reset');
    if (phraseReset) {
      phraseReset.addEventListener('click', () => {
        cfg.typePhrase = DEFAULT_PHRASE;
        saveCfg();
        if (phrase) phrase.value = DEFAULT_PHRASE;
        phraseBuf.s = '';
        toast('Phrase reset to "' + DEFAULT_PHRASE + '"');
      });
    }

    const rescan = settingsEl.querySelector('#ntsc-fr-rescan');
    if (rescan) rescan.addEventListener('click', () => { scan(); toast('Re-scanned the page'); });

    const copy = settingsEl.querySelector('#ntsc-fr-copy');
    if (copy) copy.addEventListener('click', () => {
      const text = JSON.stringify(cfg, null, 2);
      const done = () => toast('Settings copied to clipboard');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
        } else fallbackCopy(text, done);
      } catch (e) { fallbackCopy(text, done); }
    });

    const reset = settingsEl.querySelector('#ntsc-fr-reset');
    if (reset) reset.addEventListener('click', () => {
      Object.keys(DEFAULTS).forEach((k) => { cfg[k] = DEFAULTS[k]; });
      saveCfg();
      renderSettings();
      applyPopupSettings();
      if (badgeEl) badgeEl.style.display = cfg.showBadge ? '' : 'none';
      updateBadge();
      try { syncLeaderboardPill(); } catch (e) { /* ignore */ }
      toast('Settings reset to defaults');
    });

    statPopupEl = settingsEl.querySelector('#ntsc-fr-st-pop');
    statUnlockEl = settingsEl.querySelector('#ntsc-fr-st-unlock');
    statLbEl = settingsEl.querySelector('#ntsc-fr-st-lb');
  }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) { toast('Copy failed — see console'); console.log('[NTSC] settings:', text); }
  }

  function onSettingChanged(k) {
    if (k === 'showBadge' && badgeEl) badgeEl.style.display = cfg.showBadge ? '' : 'none';
    if (POPUP_KEYS.has(k)) applyPopupSettings();
    if (k === 'forceLeaderboard') { try { syncLeaderboardPill(); } catch (e) { /* ignore */ } }
    updateBadge();
    syncSettingsRows();

    if (POPUP_KEYS.has(k)) {
      toast(k === 'hidePopup'
        ? (cfg.hidePopup ? 'Pop-up blocker: ON' : 'Pop-up blocker: OFF')
        : 'Saved — ' + (cfg[k] ? 'layer ON' : 'layer OFF'));
    } else if (OPT_DEFS[k] && OPT_DEFS[k].reload) {
      toast('Saved — reload the page to apply');
    }
  }

  function renderSettings() {
    if (!settingsEl) return;
    settingsEl.innerHTML = settingsHTML();
    wireSettings();
    syncSettingsRows();
  }

  /* ---- open / close ---------------------------------------------------- */
  function openSettings() {
    if (settingsOpen) { renderSettings(); return; }
    settingsOpen = true;
    try { document.documentElement.classList.add('ntsc-fr-settings-open'); } catch (e) { /* ignore */ }

    settingsEl = document.createElement('div');
    settingsEl.className = 'ntsc-fr-settings';
    settingsEl.id = 'ntsc-fr-settings';
    renderSettings();
    (document.body || document.documentElement).appendChild(settingsEl);

    // reflect it in the URL so the address bar can be copied / bookmarked
    try {
      const path = (location.pathname || '/').replace(/\/+$/, '');
      const base = path.toLowerCase() === '/s.ntsc' ? '/' : (location.pathname || '/');
      history.replaceState(null, '', base + (location.search || '') + SETTINGS_HASH);
    } catch (e) { /* ignore */ }
    log('settings opened');
  }

  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    try { document.documentElement.classList.remove('ntsc-fr-settings-open'); } catch (e) { /* ignore */ }
    if (settingsEl && settingsEl.parentNode) settingsEl.parentNode.removeChild(settingsEl);
    settingsEl = null;
    statPopupEl = statUnlockEl = statLbEl = null;
    try {
      if (location.hash === SETTINGS_HASH) {
        history.replaceState(null, '', (location.pathname || '/') + (location.search || ''));
      }
    } catch (e) { /* ignore */ }
    log('settings closed');
  }

  function toggleSettings() {
    if (settingsOpen) closeSettings();
    else openSettings();
  }

  /* ---- triggers -------------------------------------------------------- */
  function urlWantsSettings() {
    if (!cfg.openOnUrl) return false;
    try {
      const u = new URL(location.href);
      if (u.hash === SETTINGS_HASH) return true;
      if (u.pathname.replace(/\/+$/, '').toLowerCase() === '/s.ntsc') return true;
      if (/(^|[?&])s\.ntsc([=&]|$)/i.test(u.search || '')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function onKeyDown(e) {
    if (settingsOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSettings();
      return;
    }

    // Alt + N
    if (cfg.openOnHotkey && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
        (e.code === 'KeyN' || (e.key && e.key.toLowerCase() === 'n'))) {
      e.preventDefault();
      e.stopPropagation();
      toggleSettings();
      return;
    }

    // typed phrase, e.g. "s.ntsc"
    if (!cfg.openOnType || settingsOpen) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!e.key || e.key.length !== 1) return;
    const t = e.target;
    if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;

    const now = Date.now();
    if (now - phraseBuf.at > 1500) phraseBuf.s = '';
    phraseBuf.at = now;
    phraseBuf.s = (phraseBuf.s + String(e.key).toLowerCase()).slice(-64);
    const phrase = String(cfg.typePhrase || DEFAULT_PHRASE).toLowerCase();
    if (phrase && phraseBuf.s.endsWith(phrase)) {
      phraseBuf.s = '';
      openSettings();
    }
  }

  function installSettingsTriggers() {
    document.addEventListener('keydown', onKeyDown, true);

    window.addEventListener('hashchange', () => { if (urlWantsSettings()) openSettings(); });
    window.addEventListener('popstate', () => {
      if (urlWantsSettings()) openSettings();
      else if (settingsOpen) closeSettings();
    });

    if (urlWantsSettings()) {
      // normalise the URL back onto a real route
      try {
        const path = (location.pathname || '/').replace(/\/+$/, '');
        if (path.toLowerCase() === '/s.ntsc') history.replaceState(null, '', '/' + (location.search || ''));
      } catch (e) { /* ignore */ }

      if (document.body) openSettings();
      else document.addEventListener('DOMContentLoaded', () => openSettings(), { once: true });
    }
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
  .btn-analysis-result.ntsc-fr-forced{border-color:#007fbe!important;color:#007fbe!important;background:#f3faff!important;position:relative}
  .btn-analysis-result.ntsc-fr-forced:hover{background:#e6f4ff!important}
  .btn-analysis-result.ntsc-fr-forced::after{content:"⚡";position:absolute;top:-7px;right:-6px;font-size:10px;line-height:1;background:#007fbe;color:#fff;border-radius:50%;width:15px;height:15px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,127,190,.45)}
  .ntsc-fr-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(10px);z-index:2147483647;background:#0f172a;color:#fff;padding:10px 16px;border-radius:10px;font:600 12.5px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 12px 30px rgba(15,23,42,.35);opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease;max-width:78vw;text-align:center}
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
  .ntsc-fr-lb-pill{position:fixed;left:14px;bottom:14px;z-index:2147483000;display:flex;align-items:center;gap:7px;padding:8px 13px;border-radius:999px;border:1px solid #bfdbfe;background:#eff6ff;color:#007fbe;font:600 12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 6px 20px rgba(0,60,120,.18);cursor:pointer;transition:transform .15s ease,background .15s ease}
  .ntsc-fr-lb-pill:hover{background:#dbeafe;transform:translateY(-1px)}
  .ntsc-fr-lb-pill span{font-size:13px;line-height:1}
  .ntsc-fr-lb-wrap{max-height:52vh;overflow:auto;border:1px solid #eef2f7;border-radius:10px}
  .ntsc-fr-lb th{position:sticky;top:0;z-index:1}
  .ntsc-fr-lb-name{white-space:nowrap;font-weight:600;color:#0b4f7a}
  .ntsc-fr-lb tr.ntsc-fr-you td{background:#eff6ff}
  .ntsc-fr-you-tag{font-size:9.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;background:#007fbe;color:#fff;border-radius:5px;padding:1px 5px;margin-left:4px}

  /* ---- settings screen (full-page takeover) ---- */
  html.ntsc-fr-settings-open,html.ntsc-fr-settings-open body{overflow:hidden!important}
  .ntsc-fr-settings{position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;background:#f1f5f9;color:#0f172a;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;animation:ntsc-fr-fade .16s ease}
  @keyframes ntsc-fr-fade{from{opacity:0}to{opacity:1}}
  .ntsc-fr-top{flex:0 0 auto;display:flex;align-items:center;gap:14px;padding:12px 18px;background:#fff;border-bottom:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(15,23,42,.05)}
  .ntsc-fr-brand{display:flex;align-items:center;gap:11px;min-width:0}
  .ntsc-fr-logo{width:34px;height:34px;flex:0 0 auto;border-radius:9px;background:#007fbe;color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:17px}
  .ntsc-fr-top h2{margin:0;font-size:16px;font-weight:700;color:#0b4f7a;white-space:nowrap}
  .ntsc-fr-top p{margin:1px 0 0;font-size:11.5px;color:#64748b;white-space:nowrap}
  .ntsc-fr-search{flex:1 1 auto;max-width:420px;margin-left:auto;padding:9px 13px;border:1px solid #cbd5e1;border-radius:9px;font-size:13.5px;background:#f8fafc;color:#0f172a;outline:none}
  .ntsc-fr-search:focus{border-color:#007fbe;background:#fff;box-shadow:0 0 0 3px rgba(0,127,190,.14)}
  .ntsc-fr-x{flex:0 0 auto;width:34px;height:34px;border:0;border-radius:9px;background:#f1f5f9;color:#475569;font-size:20px;line-height:1;cursor:pointer}
  .ntsc-fr-x:hover{background:#e2e8f0;color:#0f172a}
  .ntsc-fr-scroll{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:20px 18px 40px}
  .ntsc-fr-wrap{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
  .ntsc-fr-card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.04)}
  .ntsc-fr-card-h{padding:14px 18px 12px;border-bottom:1px solid #eef2f7;background:#f8fbff}
  .ntsc-fr-card-h h3{margin:0;font-size:12.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#0b4f7a}
  .ntsc-fr-card-h p{margin:5px 0 0;font-size:12.5px;color:#64748b}
  .ntsc-fr-opt{display:flex;align-items:flex-start;gap:15px;padding:15px 18px;cursor:pointer;user-select:none;border-bottom:1px solid #f1f5f9;transition:background .12s}
  .ntsc-fr-opt:last-child{border-bottom:0}
  .ntsc-fr-opt:hover{background:#f8fbff}
  .ntsc-fr-opt input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
  .ntsc-fr-switch{flex:0 0 auto;width:50px;height:29px;margin-top:1px;border-radius:999px;background:#cbd5e1;position:relative;transition:background .18s}
  .ntsc-fr-switch::after{content:"";position:absolute;top:3px;left:3px;width:23px;height:23px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.28);transition:transform .18s}
  .ntsc-fr-opt input:checked + .ntsc-fr-switch{background:#007fbe}
  .ntsc-fr-opt input:checked + .ntsc-fr-switch::after{transform:translateX(21px)}
  .ntsc-fr-opt input:focus-visible + .ntsc-fr-switch{box-shadow:0 0 0 3px rgba(0,127,190,.35)}
  .ntsc-fr-txt b{display:block;font-size:14.5px;font-weight:600;color:#0f172a}
  .ntsc-fr-reload{font-style:normal;font-size:9.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#b45309;background:#fef3c7;border-radius:5px;padding:2px 5px;margin-left:6px;vertical-align:2px}
  .ntsc-fr-txt span{display:block;color:#64748b;font-size:12.5px;margin-top:3px}
  .ntsc-fr-opt.ntsc-fr-sub{padding-left:34px;background:#fcfdff}
  .ntsc-fr-opt.ntsc-fr-dim{opacity:.45}
  .ntsc-fr-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;padding:16px 18px}
  .ntsc-fr-stats div{background:#f8fbff;border:1px solid #e6eef7;border-radius:11px;padding:12px 14px;text-align:center}
  .ntsc-fr-stats span{display:block;font-size:24px;font-weight:700;color:#007fbe}
  .ntsc-fr-stats b{display:block;margin-top:3px;font-size:11.5px;font-weight:500;color:#64748b}
  .ntsc-fr-actions{display:flex;flex-wrap:wrap;gap:10px;padding:16px 18px}
  .ntsc-fr-btn{border:1px solid #cbd5e1;background:#fff;border-radius:9px;padding:9px 15px;font-size:13px;font-weight:600;color:#0f172a;cursor:pointer}
  .ntsc-fr-btn:hover{background:#eff6ff;border-color:#bfdbfe}
  .ntsc-fr-btn.ntsc-fr-danger{color:#b91c1c;border-color:#fecaca}
  .ntsc-fr-btn.ntsc-fr-danger:hover{background:#fef2f2;border-color:#fca5a5}
  .ntsc-fr-phrase{display:flex;align-items:center;gap:10px;padding:15px 18px;flex-wrap:wrap}
  .ntsc-fr-phrase input{flex:1 1 170px;min-width:120px;padding:9px 12px;border:1px solid #cbd5e1;border-radius:9px;background:#f8fafc;color:#0f172a;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
  .ntsc-fr-phrase input:focus{outline:none;border-color:#007fbe;background:#fff;box-shadow:0 0 0 3px rgba(0,127,190,.14)}
  .ntsc-fr-how{margin:0;padding:14px 18px 16px 36px;color:#334155;font-size:13px}
  .ntsc-fr-how li{margin:5px 0}
  .ntsc-fr-how code,.ntsc-fr-phrase code{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:5px;padding:1px 6px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#0b4f7a}
  .ntsc-fr-empty-search{padding:22px 18px;color:#94a3b8;font-size:13px;text-align:center;display:none}
  @media (max-width:620px){
    .ntsc-fr-top{flex-wrap:wrap}
    .ntsc-fr-search{order:3;max-width:none;width:100%;margin-left:0}
    .ntsc-fr-opt{padding:14px}
    .ntsc-fr-opt.ntsc-fr-sub{padding-left:28px}
    .ntsc-fr-scroll{padding:14px 12px 32px}
  }
    `;

  let badgeEl = null;
  let panelEl = null;
  let toastEl = null;
  let toastTimer = null;

  function injectStyle() {
    if (document.getElementById('ntsc-fr-style')) return;
    const host = document.head || document.documentElement || document.body;
    if (!host) return;
    const st = document.createElement('style');
    st.id = 'ntsc-fr-style';
    st.textContent = CSS;
    host.appendChild(st);
  }

  function updateBadge() {
    if (!badgeEl) return;
    const on = cfg.autoUnlock || cfg.forceClick || cfg.hidePopup;
    badgeEl.classList.toggle('ntsc-fr-off', !on);
    badgeEl.querySelector('.ntsc-fr-text').textContent = on ? 'NTSC Tools' : 'NTSC Tools · off';
  }

  function buildBadge() {
    if (badgeEl) return;
    badgeEl = document.createElement('div');
    badgeEl.className = 'ntsc-fr-badge';
    badgeEl.innerHTML = '<span class="ntsc-fr-dot"></span><span class="ntsc-fr-text">NTSC Tools</span>';
    badgeEl.title = 'NTSC Tools — result unlock + pop-up blocker\nClick to open settings  ·  Alt+N  ·  or type s.ntsc';
    badgeEl.addEventListener('click', toggleSettings);
    document.body.appendChild(badgeEl);
    badgeEl.style.display = cfg.showBadge ? '' : 'none';
    updateBadge();
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
    try { syncLeaderboardPill(); } catch (e) { log('pill error', e); }
    try { sweepPopups(); } catch (e) { log('popup sweep error', e); }
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

    // dedicated observer for the pop-up overlay (rAF-debounced, it is cheap)
    if (cfg.hidePopup && cfg.popupKillDom) {
      const po = new MutationObserver(queuePopupSweep);
      po.observe(document.documentElement, { childList: true, subtree: true });
    }

    // safety net (countdown timers re-render rows every second)
    setInterval(scan, 1500);
  }

  function boot() {
    injectStyle();
    syncPopupStyle();
    buildBadge();
    scan();
    startObservers();
    installSettingsTriggers();
    log('booted · pop-ups blocked:', popupTotal());
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
    GM_registerMenuCommand('Toggle force leaderboard', () => {
      cfg.forceLeaderboard = !cfg.forceLeaderboard; saveCfg(); updateBadge();
      syncLeaderboardPill();
      toast('Force leaderboard: ' + (cfg.forceLeaderboard ? 'ON' : 'OFF') + ' (reload to apply)');
    });
    GM_registerMenuCommand('Toggle home pop-up blocker', () => {
      cfg.hidePopup = !cfg.hidePopup; saveCfg(); updateBadge();
      applyPopupSettings();
      toast('Home pop-up blocker: ' + (cfg.hidePopup ? 'ON' : 'OFF') +
            (cfg.hidePopup ? '' : ' (reload to let it through again)'));
    });
    GM_registerMenuCommand('Toggle debug logs', () => {
      cfg.debug = !cfg.debug; saveCfg(); toast('Debug: ' + (cfg.debug ? 'ON' : 'OFF'));
    });
    GM_registerMenuCommand('Open settings', () => { openSettings(); });
    GM_registerMenuCommand('Re-scan now', () => { scan(); toast('Re-scanned'); });
  }

  /* ---- start ---------------------------------------------------------- */
  // Network hooks must be installed before the app bundle runs.
  try { installXhrHook(); } catch (e) { console.warn('[NTSC·ResultUnlock] xhr hook failed', e); }
  try { installFetchHook(); } catch (e) { console.warn('[NTSC·ResultUnlock] fetch hook failed', e); }
  try { installSeenFlagPatch(); } catch (e) { console.warn('[NTSC·ResultUnlock] popup hook failed', e); }

  // CSS kill switch: get it in before the first paint if we possibly can.
  try { syncPopupStyle(); } catch (e) { /* retried in boot() */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
    // some managers fire us before <head> exists - keep trying until it does
    const earlyTry = setInterval(() => {
      if (popupStyleEl || document.readyState !== 'loading') { clearInterval(earlyTry); return; }
      try { syncPopupStyle(); } catch (e) { /* ignore */ }
    }, 10);
  } else {
    boot();
  }
  registerMenu();
})();
