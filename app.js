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
  openBtn: $('openBtn'), fileInput: $('fileInput'), docSelect: $('docSelect'), searchBtn: $('searchBtn'),
  groupBar: $('groupBar'), viewer: $('viewer'), canvas: $('pdfCanvas'), emptyState: $('emptyState'),
  loading: $('loading'), pageInfo: $('pageInfo'), prevBtn: $('prevBtn'), nextBtn: $('nextBtn'),
  playBtn: $('playBtn'), pauseBtn: $('pauseBtn'), intervalInput: $('intervalInput'),
  searchDialog: $('searchDialog'), searchInput: $('searchInput'), searchResults: $('searchResults')
};

const state = {
  docs: [], currentDocIndex: -1, currentGroup: null, currentPageIndex: 0,
  timer: null, renderToken: 0, renderTask: null, touchStart: null, preloaded: new Map()
};

const savedInterval = Number(localStorage.getItem('pdfTrainerInterval'));
if (Number.isFinite(savedInterval) && savedInterval >= 0.2 && savedInterval <= 60) {
  els.intervalInput.value = savedInterval.toFixed(1);
}

els.intervalInput.addEventListener('change', () => {
  let v = Number(els.intervalInput.value);
  if (!Number.isFinite(v)) v = 1.0;
  v = Math.min(60, Math.max(0.2, Math.round(v * 10) / 10));
  els.intervalInput.value = v.toFixed(1);
  localStorage.setItem('pdfTrainerInterval', String(v));
  if (state.timer) { stopAutoPlay(); startAutoPlay(); }
});

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
  rebuildDocSelect();
  if (loaded.length) await switchDocument(0);
  showLoading(false);
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
    const textItems = tc.items
      .filter(x => typeof x?.str === 'string')
      .map(x => x.str);
    const raw = textItems.join(' ');
    pages.push(parsePageMeta(raw, i));
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

  // Typical page text: 03年01組 01番 氏名
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

  // Keep extracted text for search even if the heading could not be parsed.
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
    for (let i = from; i < to; i++) if (!pages[i].group) pages[i].group = starts[s].group;
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
  requestAnimationFrame(() => els.groupBar.querySelector('.active')?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }));
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

function currentDoc() { return state.docs[state.currentDocIndex] || null; }
function groupPages(doc = currentDoc(), group = state.currentGroup) {
  if (!doc || !group) return [];
  return doc.pages.filter(p => p.group === group).map(p => p.pageIndex);
}
function firstPageInGroup(doc, group) { return groupPages(doc, group)[0]; }

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

function updateControls() {
  const pages = groupPages();
  const pos = pages.indexOf(state.currentPageIndex);
  const ready = pages.length > 0;
  els.prevBtn.disabled = !ready || pos <= 0;
  els.nextBtn.disabled = !ready || pos < 0 || pos >= pages.length - 1;
  els.playBtn.disabled = !ready || pos < 0 || pos >= pages.length - 1 || !!state.timer;
  els.pauseBtn.disabled = !state.timer;
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
    const cssScale = Math.min(rect.width / base.width, rect.height / base.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const renderScale = Math.max(0.5, cssScale * dpr);
    const viewport = page.getViewport({ scale: renderScale });

    if (token !== state.renderToken) return;
    const canvas = els.canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
    if (state.renderTask) {
      try { state.renderTask.cancel(); } catch {}
      state.renderTask = null;
    }
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

    canvas.classList.add('visible');
    els.emptyState.classList.add('hidden');
    const meta = doc.pages[state.currentPageIndex];
    const pages = groupPages();
    const pos = pages.indexOf(state.currentPageIndex) + 1;
    els.pageInfo.textContent = `${doc.file.name} / ${meta.group || '?'}組 / ${pos}/${pages.length}${meta.name ? ` / ${meta.name}` : ''}`;
    els.pageInfo.classList.remove('hidden');
    preloadNeighbors();
  } catch (err) {
    console.error(err);
    alert('ページ表示に失敗しました。');
  } finally {
    if (token === state.renderToken) showLoading(false);
  }
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

function startAutoPlay() {
  if (state.timer) return;
  let sec = Number(els.intervalInput.value);
  if (!Number.isFinite(sec)) sec = 1.0;
  sec = Math.min(60, Math.max(0.2, Math.round(sec * 10) / 10));
  els.intervalInput.value = sec.toFixed(1);
  localStorage.setItem('pdfTrainerInterval', String(sec));

  state.timer = setInterval(async () => {
    const pages = groupPages();
    const pos = pages.indexOf(state.currentPageIndex);
    if (pos < 0 || pos >= pages.length - 1) { stopAutoPlay(); return; }
    state.currentPageIndex = pages[pos + 1];
    updateControls();
    await renderCurrentPage();
  }, Math.round(sec * 1000));
  updateControls();
}

function stopAutoPlay() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  updateControls();
}

function showLoading(on, text = '読み込み中…') {
  els.loading.textContent = text;
  els.loading.classList.toggle('hidden', !on);
}

function openSearch() {
  els.searchInput.value = '';
  els.searchResults.innerHTML = '<div class="empty-note" style="padding:8px 6px">名前の一部を入力してください。</div>';
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
    els.searchResults.innerHTML = '<div class="empty-note" style="padding:8px 6px">該当する名前がありません。</div>';
    return;
  }

  hits.slice(0, 200).forEach(hit => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'search-item';
    b.innerHTML = `<span><strong>${escapeHtml(hit.meta.name || '名称不明')}</strong><div class="meta">${escapeHtml(hit.doc.file.name)} / ${hit.meta.group || '?'}組 ${hit.meta.number || '?'}番</div></span><span>›</span>`;
    b.addEventListener('click', async () => {
      els.searchDialog.close();
      stopAutoPlay();
      state.currentDocIndex = hit.di;
      els.docSelect.value = String(hit.di);
      state.currentGroup = hit.meta.group || hit.doc.groups[0] || null;
      state.currentPageIndex = hit.meta.pageIndex;
      rebuildGroupBar();
      updateControls();
      await renderCurrentPage();
    });
    els.searchResults.appendChild(b);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
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
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < 45) return;
  if (ax > ay) {
    if (dx < 0) await changeGroup(1); else await changeGroup(-1);
  } else {
    if (dy < 0) await movePerson(1); else await movePerson(-1);
  }
});
els.viewer.addEventListener('pointercancel', () => { state.touchStart = null; });

window.addEventListener('resize', () => {
  if (currentDoc()) renderCurrentPage();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAutoPlay();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.warn));
}
