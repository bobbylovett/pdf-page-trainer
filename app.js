const PDFJS_VERSION = '4.10.38';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`;
const PDFJS_URL = `${PDFJS_BASE}build/pdf.min.mjs`;
const PDFJS_WORKER_URL = `${PDFJS_BASE}build/pdf.worker.min.mjs`;
const PDFJS_CMAP_URL = `${PDFJS_BASE}cmaps/`;
const PDFJS_STANDARD_FONT_URL = `${PDFJS_BASE}standard_fonts/`;

const pdfjsLib = await import(PDFJS_URL);
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

const $ = (id) => document.getElementById(id);
const els = {
  openBtn: $('openBtn'), fileInput: $('fileInput'), docSelect: $('docSelect'),
  searchBtn: $('searchBtn'), settingsBtn: $('settingsBtn'),
  groupBar: $('groupBar'), viewer: $('viewer'), canvas: $('pdfCanvas'), nameMask: $('nameMask'),
  emptyState: $('emptyState'), loading: $('loading'), pageInfo: $('pageInfo'),
  modeInfo: $('modeInfo'), prevBtn: $('prevBtn'), nextBtn: $('nextBtn'),
  playBtn: $('playBtn'), pauseBtn: $('pauseBtn'), intervalInput: $('intervalInput'),
  searchDialog: $('searchDialog'), searchInput: $('searchInput'), searchResults: $('searchResults'),
  settingsDialog: $('settingsDialog'), playModeSelect: $('playModeSelect'),
  displayModeSelect: $('displayModeSelect'),
  settingsIntervalInput: $('settingsIntervalInput'), thinkTimeInput: $('thinkTimeInput'),
  afterSpeakInput: $('afterSpeakInput'), randomToggle: $('randomToggle'),
  settingsDoneBtn: $('settingsDoneBtn')
};

const state = {
  docs: [],
  currentDocIndex: -1,
  currentGroup: null,
  currentPageIndex: 0,
  playing: false,
  playRunId: 0,
  timer: null,
  renderToken: 0,
  renderTask: null,
  touchStart: null,
  preloaded: new Map(),
  randomQueue: [],
  randomCursor: -1,
  chromeTimer: null,
  quizNameRevealed: true,
  lastViewport: null,
  lastDpr: 1
};

const mobileQuery = window.matchMedia('(max-width: 760px)');

function clampTenths(value, min, max, fallback) {
  let v = Number(value);
  if (!Number.isFinite(v)) v = fallback;
  return Math.min(max, Math.max(min, Math.round(v * 10) / 10));
}

function restoreSettings() {
  const interval = clampTenths(localStorage.getItem('pdfTrainerInterval'), 0.2, 60, 1.0);
  const think = clampTenths(localStorage.getItem('pdfTrainerThinkTime'), 0, 60, 2.0);
  const after = clampTenths(localStorage.getItem('pdfTrainerAfterSpeak'), 0, 60, 1.0);
  const mode = localStorage.getItem('pdfTrainerPlayMode') === 'quiz' ? 'quiz' : 'normal';
  const displayMode = localStorage.getItem('pdfTrainerDisplayMode') === 'photo' ? 'photo' : 'page';
  const random = localStorage.getItem('pdfTrainerRandom') === '1';

  els.intervalInput.value = interval.toFixed(1);
  els.settingsIntervalInput.value = interval.toFixed(1);
  els.thinkTimeInput.value = think.toFixed(1);
  els.afterSpeakInput.value = after.toFixed(1);
  els.playModeSelect.value = mode;
  els.displayModeSelect.value = displayMode;
  els.randomToggle.checked = random;
  updateSettingsVisibility();
}

function saveIntervalFrom(value) {
  const v = clampTenths(value, 0.2, 60, 1.0);
  els.intervalInput.value = v.toFixed(1);
  els.settingsIntervalInput.value = v.toFixed(1);
  localStorage.setItem('pdfTrainerInterval', String(v));
  return v;
}

function saveQuizSettings() {
  const think = clampTenths(els.thinkTimeInput.value, 0, 60, 2.0);
  const after = clampTenths(els.afterSpeakInput.value, 0, 60, 1.0);
  els.thinkTimeInput.value = think.toFixed(1);
  els.afterSpeakInput.value = after.toFixed(1);
  localStorage.setItem('pdfTrainerThinkTime', String(think));
  localStorage.setItem('pdfTrainerAfterSpeak', String(after));
  localStorage.setItem('pdfTrainerPlayMode', els.playModeSelect.value);
  localStorage.setItem('pdfTrainerDisplayMode', els.displayModeSelect.value);
  localStorage.setItem('pdfTrainerRandom', els.randomToggle.checked ? '1' : '0');
  updateSettingsVisibility();
  updateModeInfo();
}

function updateSettingsVisibility() {
  const quiz = els.playModeSelect.value === 'quiz';
  document.querySelectorAll('.quiz-setting').forEach(el => el.classList.toggle('mode-hidden', !quiz));
  document.querySelectorAll('.normal-setting').forEach(el => el.classList.toggle('mode-hidden', quiz));
}

restoreSettings();

els.intervalInput.addEventListener('change', () => saveIntervalFrom(els.intervalInput.value));
els.settingsIntervalInput.addEventListener('change', () => saveIntervalFrom(els.settingsIntervalInput.value));
els.thinkTimeInput.addEventListener('change', saveQuizSettings);
els.afterSpeakInput.addEventListener('change', saveQuizSettings);
els.playModeSelect.addEventListener('change', saveQuizSettings);
els.displayModeSelect.addEventListener('change', async () => {
  saveQuizSettings();
  if (currentDoc()) await renderCurrentPage();
});
els.randomToggle.addEventListener('change', saveQuizSettings);

els.openBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', async (e) => {
  const files = [...e.target.files].filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (!files.length) return;
  stopAutoPlay();
  await loadFiles(files);
  els.fileInput.value = '';
});

els.docSelect.addEventListener('change', () => switchDocument(Number(els.docSelect.value)));
els.prevBtn.addEventListener('click', () => movePerson(-1));
els.nextBtn.addEventListener('click', () => movePerson(1));
els.playBtn.addEventListener('click', startAutoPlay);
els.pauseBtn.addEventListener('click', stopAutoPlay);
els.searchBtn.addEventListener('click', openSearch);
els.searchInput.addEventListener('input', updateSearchResults);
els.settingsBtn.addEventListener('click', () => {
  syncSettingsInputs();
  els.settingsDialog.showModal();
});
els.settingsDoneBtn.addEventListener('click', () => {
  saveIntervalFrom(els.settingsIntervalInput.value);
  saveQuizSettings();
});

function syncSettingsInputs() {
  els.settingsIntervalInput.value = els.intervalInput.value;
  updateSettingsVisibility();
}

async function loadFiles(files) {
  showLoading(true, `PDFを解析中… 0/${files.length}`);
  const loaded = [];
  for (let i = 0; i < files.length; i++) {
    showLoading(true, `PDFを解析中… ${i + 1}/${files.length}`);
    try {
      loaded.push(await buildDocModel(files[i]));
    } catch (err) {
      console.error(err);
      alert(`${files[i].name} の読み込みに失敗しました。`);
    }
  }
  state.docs = loaded;
  state.currentDocIndex = loaded.length ? 0 : -1;
  state.randomQueue = [];
  state.randomCursor = -1;
  rebuildDocSelect();
  if (loaded.length) await switchDocument(0);
  showLoading(false);
  showMobileChrome(true);
}

async function buildDocModel(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({
    data: bytes,
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONT_URL,
    useSystemFonts: true
  }).promise;

  const pages = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const tc = await page.getTextContent({
      includeMarkedContent: true,
      disableNormalization: false
    });
    const rawTextItems = tc.items
      .filter(x => typeof x?.str === 'string');
    const textItems = rawTextItems.map(x => x.str);
    const raw = textItems.join(' ');
    const meta = parsePageMeta(raw, i);
    meta.nameItems = findNameTextItems(rawTextItems, meta.name);
    pages.push(meta);

    if ((i + 1) % 20 === 0) {
      showLoading(true, `${file.name}\n文字情報を解析中… ${i + 1}/${pdf.numPages}`);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  await applyOutlineFallback(pdf, pages);
  const groups = [...new Set(pages.map(p => p.group).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b));

  return { file, pdf, pages, groups };
}

function parsePageMeta(raw, pageIndex) {
  const normalized = String(raw || '')
    .normalize('NFKC')
    .replace(/[\u00A0\u2000-\u200B\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const compact = normalized.replace(/\s+/g, '');

  const m = compact.match(/(\d{1,2})年(\d{1,2})組(\d{1,2})番(.+)?/);
  if (m) {
    return {
      pageIndex,
      grade: String(Number(m[1])).padStart(2, '0'),
      group: String(Number(m[2])),
      number: String(Number(m[3])),
      name: cleanupName(m[4] || ''),
      rawText: normalized
    };
  }

  return {
    pageIndex,
    grade: '',
    group: '',
    number: '',
    name: '',
    rawText: normalized
  };
}

function cleanupName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u00A0\u2000-\u200B\u3000\s]+/g, '')
    .replace(/^[\-–—・:：|｜]+|[\-–—・:：|｜]+$/g, '')
    .trim();
}

function findNameTextItems(items, parsedName) {
  const wanted = cleanupName(parsedName);
  if (!wanted) return [];

  const candidates = items
    .map((item, index) => ({
      index,
      str: String(item.str || ''),
      clean: cleanupName(item.str || ''),
      width: Number(item.width || 0),
      height: Number(item.height || 0),
      transform: Array.isArray(item.transform) ? item.transform.slice(0, 6) : null
    }))
    .filter(item => {
      if (!item.clean || !item.transform) return false;

      // Never allow class / number headings into the mask candidates.
      if (/[年月組番]/.test(item.clean)) return false;
      if (/^[0-9０-９]+$/.test(item.clean)) return false;

      return true;
    });

  // 1. Best case: one PDF text item contains the complete name.
  const exactItem = candidates.find(item => item.clean === wanted);
  if (exactItem) return [exactItem];

  const containingItem = candidates.find(item => item.clean.includes(wanted));
  if (containingItem) return [containingItem];

  // 2. The name may be split into multiple consecutive PDF text items.
  // Only accept a contiguous sequence that reconstructs the full parsed name.
  // If we cannot prove the sequence is the name, return [] instead of masking
  // unrelated text such as the class/number heading.
  for (let start = 0; start < candidates.length; start++) {
    let joined = '';
    const seq = [];

    for (let i = start; i < candidates.length; i++) {
      const item = candidates[i];

      // Require consecutive source text items. This prevents unrelated text
      // elsewhere on the page from being joined into a false name match.
      if (seq.length && item.index !== seq[seq.length - 1].index + 1) break;

      joined += item.clean;
      seq.push(item);

      if (joined === wanted) return seq;
      if (!wanted.startsWith(joined)) break;
      if (joined.length >= wanted.length) break;
    }
  }

  // Safety first: if the name position cannot be identified confidently,
  // do not draw a mask.
  return [];
}

async function applyOutlineFallback(pdf, pages) {
  if (pages.every(p => p.group)) return;
  const outline = await pdf.getOutline().catch(() => null);
  if (!outline?.length) return;

  const starts = [];
  for (const item of outline) {
    const gm = (item.title || '').match(/(\d{1,2})組/);
    if (!gm || !item.dest) continue;
    try {
      const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
      if (!dest) continue;
      const pageIndex = await pdf.getPageIndex(dest[0]);
      starts.push({ group: String(Number(gm[1])), pageIndex });
    } catch {}
  }

  starts.sort((a, b) => a.pageIndex - b.pageIndex);
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s].pageIndex;
    const to = s + 1 < starts.length ? starts[s + 1].pageIndex : pages.length;
    for (let i = from; i < to; i++) {
      if (!pages[i].group) pages[i].group = starts[s].group;
    }
  }
}

function rebuildDocSelect() {
  els.docSelect.innerHTML = '';
  state.docs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = d.file.name.replace(/\.pdf$/i, '');
    els.docSelect.appendChild(o);
  });
  els.docSelect.disabled = !state.docs.length;
  els.searchBtn.disabled = !state.docs.length;
}

async function switchDocument(index) {
  stopAutoPlay();
  if (!state.docs[index]) return;
  state.currentDocIndex = index;
  els.docSelect.value = String(index);
  const doc = state.docs[index];
  state.currentGroup = doc.groups[0] || null;
  state.currentPageIndex = firstPageInGroup(doc, state.currentGroup) ?? 0;
  rebuildGroupBar();
  updateControls();
  await renderCurrentPage();
}

function rebuildGroupBar() {
  els.groupBar.innerHTML = '';
  const doc = currentDoc();
  if (!doc) return;

  doc.groups.forEach(group => {
    const b = document.createElement('button');
    b.className = 'group-chip' + (group === state.currentGroup ? ' active' : '');
    b.textContent = `${group}組`;
    b.addEventListener('click', () => setGroup(group));
    els.groupBar.appendChild(b);
  });

  requestAnimationFrame(() => {
    els.groupBar.querySelector('.active')?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest'
    });
  });
}

async function setGroup(group) {
  stopAutoPlay();
  const doc = currentDoc();
  const first = firstPageInGroup(doc, group);
  if (first == null) return;
  state.currentGroup = group;
  state.currentPageIndex = first;
  rebuildGroupBar();
  updateControls();
  await renderCurrentPage();
}

function currentDoc() {
  return state.docs[state.currentDocIndex] || null;
}

function currentMeta() {
  return currentDoc()?.pages[state.currentPageIndex] || null;
}

function groupPages(doc = currentDoc(), group = state.currentGroup) {
  if (!doc || !group) return [];
  return doc.pages.filter(p => p.group === group).map(p => p.pageIndex);
}

function firstPageInGroup(doc, group) {
  return groupPages(doc, group)[0];
}

async function movePerson(delta) {
  stopAutoPlay();
  const pages = groupPages();
  const pos = pages.indexOf(state.currentPageIndex);
  if (pos < 0) return;
  const nextPos = pos + delta;
  if (nextPos < 0 || nextPos >= pages.length) return;
  state.currentPageIndex = pages[nextPos];
  updateControls();
  await renderCurrentPage();
}

async function changeGroup(delta) {
  stopAutoPlay();
  const doc = currentDoc();
  if (!doc) return;
  const pos = doc.groups.indexOf(state.currentGroup);
  const next = pos + delta;
  if (next < 0 || next >= doc.groups.length) return;
  await setGroup(doc.groups[next]);
}

async function goToLocation(docIndex, pageIndex, stopPlayback = false) {
  if (stopPlayback) stopAutoPlay();
  const doc = state.docs[docIndex];
  if (!doc || !doc.pages[pageIndex]) return false;

  state.currentDocIndex = docIndex;
  state.currentPageIndex = pageIndex;
  state.currentGroup = doc.pages[pageIndex].group || doc.groups[0] || null;
  els.docSelect.value = String(docIndex);
  rebuildGroupBar();
  updateControls();
  await renderCurrentPage();
  return true;
}

function updateControls() {
  const pages = groupPages();
  const pos = pages.indexOf(state.currentPageIndex);
  const ready = pages.length > 0;

  els.prevBtn.disabled = state.playing || !ready || pos <= 0;
  els.nextBtn.disabled = state.playing || !ready || pos < 0 || pos >= pages.length - 1;

  let canPlay = state.docs.length > 0;
  if (!els.randomToggle.checked) {
    canPlay = ready && pos >= 0 && pos < pages.length - 1;
  } else {
    canPlay = totalNamedPages() > 0;
  }

  els.playBtn.disabled = state.playing || !canPlay;
  els.pauseBtn.disabled = !state.playing;
}

function totalNamedPages() {
  return state.docs.reduce((sum, doc) => sum + doc.pages.filter(p => p.name || p.rawText).length, 0);
}

function isPhotoPriorityActive() {
  return isMobile() && els.displayModeSelect.value === 'photo';
}

function getPhotoCrop(baseViewport) {
  // The graduation-album pages use a highly consistent layout:
  // class/number at the top, portrait centered below it.
  // Keep a slightly generous crop so small layout differences do not cut faces.
  const left = baseViewport.width * 0.14;
  const top = baseViewport.height * 0.17;
  const width = baseViewport.width * 0.72;
  const height = baseViewport.height * 0.73;

  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height
  };
}

async function renderCurrentPage() {
  const doc = currentDoc();
  if (!doc) return;

  const token = ++state.renderToken;
  showLoading(true, '表示中…');

  try {
    const page = await doc.pdf.getPage(state.currentPageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const rect = els.viewer.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const photoPriority = isPhotoPriorityActive();

    const canvas = els.canvas;
    const ctx = canvas.getContext('2d', { alpha: false });

    if (state.renderTask) {
      try { state.renderTask.cancel(); } catch {}
      state.renderTask = null;
    }

    if (!photoPriority) {
      const cssScale = Math.min(rect.width / base.width, rect.height / base.height);
      const renderScale = Math.max(0.5, cssScale * dpr);
      const viewport = page.getViewport({ scale: renderScale });

      if (token !== state.renderToken) return;

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

      const task = page.render({ canvasContext: ctx, viewport });
      state.renderTask = task;

      try {
        await task.promise;
      } catch (err) {
        if (err?.name === 'RenderingCancelledException') return;
        throw err;
      } finally {
        if (state.renderTask === task) state.renderTask = null;
      }

      if (token !== state.renderToken) return;

      state.lastViewport = viewport;
      state.lastDpr = dpr;
    } else {
      const crop = getPhotoCrop(base);
      const cssScale = Math.min(rect.width / crop.width, rect.height / crop.height);
      const renderScale = Math.max(0.5, cssScale * dpr);
      const fullViewport = page.getViewport({ scale: renderScale });

      if (token !== state.renderToken) return;

      const cropLeft = crop.left * renderScale;
      const cropTop = crop.top * renderScale;
      const cropWidth = crop.width * renderScale;
      const cropHeight = crop.height * renderScale;

      const offscreen = document.createElement('canvas');
      offscreen.width = Math.ceil(fullViewport.width);
      offscreen.height = Math.ceil(fullViewport.height);
      const offctx = offscreen.getContext('2d', { alpha: false });

      const task = page.render({ canvasContext: offctx, viewport: fullViewport });
      state.renderTask = task;

      try {
        await task.promise;
      } catch (err) {
        if (err?.name === 'RenderingCancelledException') return;
        throw err;
      } finally {
        if (state.renderTask === task) state.renderTask = null;
      }

      if (token !== state.renderToken) return;

      canvas.width = Math.max(1, Math.floor(cropWidth));
      canvas.height = Math.max(1, Math.floor(cropHeight));
      canvas.style.width = `${Math.max(1, Math.floor(cropWidth / dpr))}px`;
      canvas.style.height = `${Math.max(1, Math.floor(cropHeight / dpr))}px`;

      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        offscreen,
        cropLeft, cropTop, cropWidth, cropHeight,
        0, 0, canvas.width, canvas.height
      );

      // The printed name is outside the photo-focused crop, so no PDF-name
      // mask geometry is required in this mode. The app's page-info line still
      // follows quiz reveal timing.
      state.lastViewport = null;
      state.lastDpr = dpr;
    }

    canvas.classList.add('visible');
    els.emptyState.classList.add('hidden');

    updatePageInfo();
    updateNameMask();
    updateModeInfo();
    preloadNeighbors();

    if (mobileQuery.matches && state.playing) {
      hideMobileChrome();
    }
  } catch (err) {
    console.error(err);
    alert('ページ表示に失敗しました。');
  } finally {
    if (token === state.renderToken) showLoading(false);
  }
}

function shouldHideQuizName() {
  return state.playing &&
         els.playModeSelect.value === 'quiz' &&
         !state.quizNameRevealed;
}

function updatePageInfo() {
  const doc = currentDoc();
  const meta = currentMeta();
  if (!doc || !meta) {
    els.pageInfo.classList.add('hidden');
    return;
  }

  const pages = groupPages();
  const pos = pages.indexOf(state.currentPageIndex) + 1;
  const showName = !shouldHideQuizName();
  const namePart = showName && meta.name ? ` / ${meta.name}` : '';

  els.pageInfo.textContent =
    `${doc.file.name} / ${meta.group || '?'}組 / ${pos}/${pages.length}${namePart}`;
  els.pageInfo.classList.remove('hidden');
}

function updateNameMask() {
  const meta = currentMeta();
  const viewport = state.lastViewport;
  const dpr = state.lastDpr || 1;

  if (isPhotoPriorityActive() ||
      !meta || !viewport || !shouldHideQuizName() || !meta.nameItems?.length) {
    els.nameMask.classList.add('hidden');
    return;
  }

  const rects = [];
  for (const item of meta.nameItems) {
    if (!Array.isArray(item.transform) || item.transform.length < 6) continue;

    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.max(
      Math.hypot(tx[2], tx[3]),
      Number(item.height || 0) * viewport.scale,
      1
    );

    const width = Math.max(Number(item.width || 0) * viewport.scale, fontHeight);
    rects.push({
      left: tx[4],
      // Keep the mask tight around the name glyphs so the class/number
      // line immediately above is not covered.
      top: tx[5] - fontHeight * 0.93,
      right: tx[4] + width,
      bottom: tx[5] + fontHeight * 0.10
    });
  }

  if (!rects.length) {
    els.nameMask.classList.add('hidden');
    return;
  }

  let left = Math.min(...rects.map(r => r.left));
  let top = Math.min(...rects.map(r => r.top));
  let right = Math.max(...rects.map(r => r.right));
  let bottom = Math.max(...rects.map(r => r.bottom));

  // A little extra white margin prevents anti-aliased glyph edges from peeking out.
  const padX = 8 * dpr;
  const padY = 2 * dpr;
  left -= padX;
  right += padX;
  top -= padY;
  bottom += padY;

  const canvasRect = els.canvas.getBoundingClientRect();
  const viewerRect = els.viewer.getBoundingClientRect();

  const cssLeft = (canvasRect.left - viewerRect.left) + left / dpr;
  const cssTop = (canvasRect.top - viewerRect.top) + top / dpr;
  const cssWidth = Math.max(1, (right - left) / dpr);
  const cssHeight = Math.max(1, (bottom - top) / dpr);

  els.nameMask.style.left = `${cssLeft}px`;
  els.nameMask.style.top = `${cssTop}px`;
  els.nameMask.style.width = `${cssWidth}px`;
  els.nameMask.style.height = `${cssHeight}px`;
  els.nameMask.classList.remove('hidden');
}

function refreshQuizNameVisibility() {
  updatePageInfo();
  updateNameMask();
}

function updateModeInfo() {
  if (!currentDoc()) {
    els.modeInfo.classList.add('hidden');
    return;
  }

  // Quiz mode is intentionally distraction-free:
  // do not show "名前クイズ" or "ランダム" above the page.
  if (state.playing && els.playModeSelect.value === 'quiz') {
    els.modeInfo.classList.add('hidden');
    return;
  }

  const bits = [];
  if (state.playing) {
    bits.push('自動再生');
    if (els.randomToggle.checked) bits.push('ランダム');
  }
  if (!bits.length) {
    els.modeInfo.classList.add('hidden');
    return;
  }
  els.modeInfo.textContent = bits.join(' / ');
  els.modeInfo.classList.remove('hidden');
}

async function preloadNeighbors() {
  const doc = currentDoc();
  if (!doc) return;
  const pages = groupPages();
  const pos = pages.indexOf(state.currentPageIndex);

  for (const p of [pages[pos + 1], pages[pos - 1]]) {
    if (p == null) continue;
    const key = `${state.currentDocIndex}:${p}`;
    if (state.preloaded.has(key)) continue;
    state.preloaded.set(key, true);
    doc.pdf.getPage(p + 1).catch(() => state.preloaded.delete(key));
  }
}

function waitMs(ms, runId) {
  return new Promise(resolve => {
    if (runId !== state.playRunId || !state.playing) {
      resolve(false);
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      resolve(runId === state.playRunId && state.playing);
    }, Math.max(0, ms));
  });
}

function prepareRandomQueue() {
  const pool = [];
  state.docs.forEach((doc, di) => {
    doc.pages.forEach(meta => {
      if (meta.name || meta.rawText) {
        pool.push({ docIndex: di, pageIndex: meta.pageIndex });
      }
    });
  });

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const currentIndex = pool.findIndex(
    item => item.docIndex === state.currentDocIndex && item.pageIndex === state.currentPageIndex
  );
  if (currentIndex === 0 && pool.length > 1) {
    [pool[0], pool[1]] = [pool[1], pool[0]];
  }

  state.randomQueue = pool;
  state.randomCursor = -1;
}

async function advancePlayback(first = false) {
  if (els.randomToggle.checked) {
    if (first && state.randomCursor < 0) state.randomCursor = 0;
    else state.randomCursor += 1;

    const item = state.randomQueue[state.randomCursor];
    if (!item) return false;
    return goToLocation(item.docIndex, item.pageIndex, false);
  }

  if (first) return true;

  const pages = groupPages();
  const pos = pages.indexOf(state.currentPageIndex);
  if (pos < 0 || pos >= pages.length - 1) return false;

  state.currentPageIndex = pages[pos + 1];
  updateControls();
  await renderCurrentPage();
  return true;
}

async function startAutoPlay() {
  if (state.playing || !state.docs.length) return;

  saveIntervalFrom(els.intervalInput.value);
  saveQuizSettings();

  if (els.randomToggle.checked) {
    prepareRandomQueue();
    if (!state.randomQueue.length) return;
  }

  state.playing = true;
  state.quizNameRevealed = els.playModeSelect.value !== 'quiz';
  const runId = ++state.playRunId;
  refreshQuizNameVisibility();
  updateControls();
  updateModeInfo();

  if (els.randomToggle.checked) {
    const ok = await advancePlayback(true);
    if (!ok || runId !== state.playRunId || !state.playing) {
      stopAutoPlay();
      return;
    }
  }

  if (mobileQuery.matches) {
    setTimeout(() => {
      if (state.playing && runId === state.playRunId) hideMobileChrome();
    }, 450);
  }

  if (els.playModeSelect.value === 'quiz') {
    await runQuizLoop(runId);
  } else {
    await runNormalLoop(runId);
  }
}

async function runNormalLoop(runId) {
  const sec = saveIntervalFrom(els.intervalInput.value);

  while (state.playing && runId === state.playRunId) {
    const alive = await waitMs(sec * 1000, runId);
    if (!alive) return;

    const moved = await advancePlayback(false);
    if (!moved) {
      stopAutoPlay();
      return;
    }
  }
}

async function runQuizLoop(runId) {
  const thinkSec = clampTenths(els.thinkTimeInput.value, 0, 60, 2.0);
  const afterSec = clampTenths(els.afterSpeakInput.value, 0, 60, 1.0);

  while (state.playing && runId === state.playRunId) {
    state.quizNameRevealed = false;
    refreshQuizNameVisibility();

    const thought = await waitMs(thinkSec * 1000, runId);
    if (!thought) return;

    await speakCurrentName(runId);
    if (!state.playing || runId !== state.playRunId) return;

    const waited = await waitMs(afterSec * 1000, runId);
    if (!waited) return;

    state.quizNameRevealed = false;
    refreshQuizNameVisibility();

    const moved = await advancePlayback(false);
    if (!moved) {
      stopAutoPlay();
      return;
    }
  }
}

function chooseJapaneseVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  return voices.find(v => /^ja(-|_)/i.test(v.lang)) ||
         voices.find(v => /Japanese|日本/i.test(v.name)) ||
         null;
}

function speakCurrentName(runId) {
  return new Promise(resolve => {
    if (!state.playing || runId !== state.playRunId) {
      resolve();
      return;
    }

    // Reveal the printed name and the info-line name at the same moment
    // the answer phase starts.
    state.quizNameRevealed = true;
    refreshQuizNameVisibility();

    const name = currentMeta()?.name?.trim();
    if (!name || !('speechSynthesis' in window)) {
      resolve();
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(name);
    utterance.lang = 'ja-JP';
    utterance.rate = 0.9;
    utterance.pitch = 1.0;
    const voice = chooseJapaneseVoice();
    if (voice) utterance.voice = voice;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      resolve();
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    const safety = setTimeout(finish, Math.max(3500, name.length * 900));
    window.speechSynthesis.speak(utterance);
  });
}

function stopAutoPlay() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.playing = false;
  state.quizNameRevealed = true;
  state.playRunId += 1;
  state.randomQueue = [];
  state.randomCursor = -1;

  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch {}
  }

  refreshQuizNameVisibility();
  updateControls();
  updateModeInfo();
  showMobileChrome(true);
}

function showLoading(on, text = '読み込み中…') {
  els.loading.textContent = text;
  els.loading.classList.toggle('hidden', !on);
}

function openSearch() {
  els.searchInput.value = '';
  els.searchResults.innerHTML =
    '<div class="empty-note" style="padding:8px 6px">名前の一部を入力してください。</div>';
  els.searchDialog.showModal();
  setTimeout(() => els.searchInput.focus(), 50);
}

function updateSearchResults() {
  const q = els.searchInput.value.trim().replace(/\s+/g, '');
  els.searchResults.innerHTML = '';
  if (!q) return;

  const hits = [];
  const query = q.normalize('NFKC').replace(/\s+/g, '');

  state.docs.forEach((doc, di) => {
    doc.pages.forEach(meta => {
      const name = (meta.name || '').normalize('NFKC').replace(/\s+/g, '');
      const rawText = (meta.rawText || '').normalize('NFKC').replace(/\s+/g, '');
      if (name.includes(query) || rawText.includes(query)) {
        hits.push({ doc, di, meta });
      }
    });
  });

  if (!hits.length) {
    els.searchResults.innerHTML =
      '<div class="empty-note" style="padding:8px 6px">該当する名前がありません。</div>';
    return;
  }

  hits.slice(0, 200).forEach(hit => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'search-item';
    b.innerHTML =
      `<span><strong>${escapeHtml(hit.meta.name || '名称不明')}</strong>` +
      `<div class="meta">${escapeHtml(hit.doc.file.name)} / ` +
      `${hit.meta.group || '?'}組 ${hit.meta.number || '?'}番</div></span><span>›</span>`;

    b.addEventListener('click', async () => {
      els.searchDialog.close();
      stopAutoPlay();
      await goToLocation(hit.di, hit.meta.pageIndex, false);
    });

    els.searchResults.appendChild(b);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}

function isMobile() {
  return mobileQuery.matches;
}

function showMobileChrome(autoHide = true) {
  if (!isMobile()) return;
  document.body.classList.remove('mobile-ui-hidden');
  if (state.chromeTimer) clearTimeout(state.chromeTimer);
  state.chromeTimer = null;

  if (autoHide && currentDoc() && !state.playing &&
      !els.searchDialog.open && !els.settingsDialog.open) {
    state.chromeTimer = setTimeout(() => hideMobileChrome(), 3200);
  }
}

function hideMobileChrome() {
  if (!isMobile() || !currentDoc() || els.searchDialog.open || els.settingsDialog.open) return;
  document.body.classList.add('mobile-ui-hidden');
  if (state.chromeTimer) clearTimeout(state.chromeTimer);
  state.chromeTimer = null;
}

function toggleMobileChrome() {
  if (!isMobile()) return;
  if (document.body.classList.contains('mobile-ui-hidden')) {
    showMobileChrome(true);
  } else {
    hideMobileChrome();
  }
}

els.viewer.addEventListener('pointerdown', (e) => {
  state.touchStart = { x: e.clientX, y: e.clientY, id: e.pointerId };
  try { els.viewer.setPointerCapture(e.pointerId); } catch {}
});

els.viewer.addEventListener('pointerup', async (e) => {
  if (!state.touchStart || e.pointerId !== state.touchStart.id) return;

  const dx = e.clientX - state.touchStart.x;
  const dy = e.clientY - state.touchStart.y;
  state.touchStart = null;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  if (Math.max(ax, ay) < 38) {
    toggleMobileChrome();
    return;
  }

  if (state.playing) return;

  if (ax > ay) {
    if (dx < 0) await changeGroup(1);
    else await changeGroup(-1);
  } else {
    if (dy < 0) await movePerson(1);
    else await movePerson(-1);
  }

  showMobileChrome(true);
});

els.viewer.addEventListener('pointercancel', () => {
  state.touchStart = null;
});

els.searchDialog.addEventListener('close', () => showMobileChrome(true));
els.settingsDialog.addEventListener('close', async () => {
  saveIntervalFrom(els.settingsIntervalInput.value);
  saveQuizSettings();
  updateControls();
  if (currentDoc()) await renderCurrentPage();
  showMobileChrome(true);
});

window.addEventListener('resize', () => {
  if (currentDoc()) renderCurrentPage();
  if (!isMobile()) document.body.classList.remove('mobile-ui-hidden');
});

mobileQuery.addEventListener?.('change', () => {
  if (!isMobile()) document.body.classList.remove('mobile-ui-hidden');
  else showMobileChrome(true);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAutoPlay();
});

if ('speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', () => {
    window.speechSynthesis.getVoices();
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  });
}
