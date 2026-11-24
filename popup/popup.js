/**
 * 1Life SOA Diagnosis Filter — Popup & Full-Tab Workspace Controller.
 */

import * as pdfjsLib from '../lib/pdf.min.mjs';
import {
  MAX_PDF_BYTES,
  buildExportFilename,
  escapeCsvCell,
  formatBytes,
  isOneLifeBlobUrl,
  isPdfBytes,
  randomId,
  shortBlobId,
} from '../shared/binary.js';
import {
  clearAllPdfs,
  getCapturedPdf,
  listCapturedPdfs,
  saveExportedPdf,
} from '../shared/db.js';
import {
  DEFAULT_FILTER_OPTIONS,
  parseSoaPdf,
  reclassifyPatients,
} from '../shared/pdf-parser.js';
import { buildFilteredPdf } from '../shared/pdf-exporter.js';
import { convertPdfToDocx } from '../shared/pdf-to-docx.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const STORAGE_SETTINGS_KEY = 'oneLifeFilterSettings';

const state = {
  isTabMode: false,
  sources: [], // { key, type: 'tab' | 'cache' | 'file', label, blobUrl, tabId }
  activeSource: null,
  pdfBytes: null, // Uint8Array (never detached!)
  totalPages: 0,
  hasTextLayer: true,
  patients: [],
  manualOverrides: new Map(), // patient.index -> 'no_diagnosis' | 'cleared'
  activeFilter: 'all', // 'all' | 'no_diagnosis' | 'zero_amount' | 'cleared'
  searchQuery: '',
  settings: { ...DEFAULT_FILTER_OPTIONS },
  busy: false,
};

const els = {
  sourceLabel: document.getElementById('source-label'),
  pdfSelector: document.getElementById('pdf-selector'),
  btnRescan: document.getElementById('btn-rescan'),
  btnUpload: document.getElementById('btn-upload'),
  btnSettings: document.getElementById('btn-settings'),
  btnPopout: document.getElementById('btn-popout'),
  fileInput: document.getElementById('file-input'),

  settingsPanel: document.getElementById('settings-panel'),
  optZeroTotal: document.getElementById('opt-zero-total'),
  optBlank: document.getElementById('opt-blank'),
  optNoneNa: document.getElementById('opt-none-na'),
  optPhrases: document.getElementById('opt-phrases'),
  btnResetSettings: document.getElementById('btn-reset-settings'),
  btnApplySettings: document.getElementById('btn-apply-settings'),
  btnClearCache: document.getElementById('btn-clear-cache'),

  loadingView: document.getElementById('loading-view'),
  loadingTitle: document.getElementById('loading-title'),
  loadingSub: document.getElementById('loading-sub'),
  progressTrack: document.getElementById('progress-track'),
  progressBar: document.getElementById('progress-bar'),

  emptyView: document.getElementById('empty-view'),
  emptyIcon: document.getElementById('empty-icon'),
  emptyTitle: document.getElementById('empty-title'),
  emptyMessage: document.getElementById('empty-message'),
  dropzone: document.getElementById('dropzone'),

  warningBanner: document.getElementById('warning-banner'),
  resultsView: document.getElementById('results-view'),

  noDiagCount: document.getElementById('no-diag-count'),
  noDiagPages: document.getElementById('no-diag-pages'),
  zeroAmtCount: document.getElementById('zero-amt-count'),
  zeroAmtPages: document.getElementById('zero-amt-pages'),
  clearedCount: document.getElementById('cleared-count'),
  clearedPages: document.getElementById('cleared-pages'),
  btnExportNoDiag: document.getElementById('btn-export-no-diag'),
  btnExportZeroAmt: document.getElementById('btn-export-zero-amt'),
  btnExportCleared: document.getElementById('btn-export-cleared'),
  overlapNote: document.getElementById('overlap-note'),

  filterTabs: Array.from(document.querySelectorAll('.filter-tab')),
  tabAllCount: document.getElementById('tab-all-count'),
  tabNoDiagCount: document.getElementById('tab-nodiag-count'),
  tabZeroCount: document.getElementById('tab-zero-count'),
  tabClearedCount: document.getElementById('tab-cleared-count'),
  searchInput: document.getElementById('search-input'),
  patientList: document.getElementById('patient-list'),

  footerMeta: document.getElementById('footer-meta'),
  btnNoDiagWord: document.getElementById('btn-nodiag-word'),
  btnCopyList: document.getElementById('btn-copy-list'),
  btnExportCsv: document.getElementById('btn-export-csv'),
  toast: document.getElementById('toast'),
};

let toastTimer = null;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.add('hidden');
  }, 2400);
}

function showView(viewName) {
  els.loadingView.classList.toggle('hidden', viewName !== 'loading');
  els.emptyView.classList.toggle('hidden', viewName !== 'empty');
  els.resultsView.classList.toggle('hidden', viewName !== 'results');
  if (viewName !== 'results') {
    els.warningBanner.classList.add('hidden');
  }
}

function showEmptyState({ title, message, isError = false }) {
  els.emptyIcon.textContent = isError ? '!' : 'PDF';
  els.emptyIcon.classList.toggle('error', isError);
  els.emptyTitle.textContent = title;
  els.emptyMessage.textContent = message;
  showView('empty');
}

function setLoading(title, sub, pct = 15) {
  const clamped = Math.max(5, Math.min(100, Math.round(pct)));
  els.loadingTitle.textContent = title;
  els.loadingSub.textContent = sub;
  els.progressBar.style.width = `${clamped}%`;
  if (els.progressTrack) {
    els.progressTrack.setAttribute('aria-valuenow', String(clamped));
  }
  showView('loading');
}

function setSettingsOpen(open) {
  els.settingsPanel.classList.toggle('hidden', !open);
  els.btnSettings.classList.toggle('active', open);
  els.btnSettings.setAttribute('aria-expanded', String(open));
}

function formatPagesLabel(pages) {
  if (!pages || pages.length === 0) return 'p. ?';
  if (pages.length === 1) return `p. ${pages[0]}`;
  return `p. ${pages[0]}–${pages[pages.length - 1]}`;
}

function countPagesForPatients(list) {
  const seen = new Set();
  for (const p of list) {
    for (const pg of p.pages || []) seen.add(pg);
  }
  return seen.size;
}

function getEffectivePatients() {
  return state.patients.map((p) => {
    const override = state.manualOverrides.get(p.index);
    if (!override) return p;
    if (override === 'cleared') {
      return {
        ...p,
        hasNoDiagnosis: false,
        hasZeroAmount: false,
        isCleared: true,
        category: 'cleared',
        reason: 'Manual (Cleared)',
        manual: true,
      };
    }
    return {
      ...p,
      hasNoDiagnosis: true,
      hasZeroAmount: false,
      isCleared: false,
      category: 'no_diagnosis',
      reason: 'Manual (Excluded)',
      manual: true,
    };
  });
}

function matchesFilter(patient, filterKey) {
  if (filterKey === 'all') return true;
  if (filterKey === 'no_diagnosis') return Boolean(patient.hasNoDiagnosis);
  if (filterKey === 'zero_amount') return Boolean(patient.hasZeroAmount);
  if (filterKey === 'cleared') return Boolean(patient.isCleared);
  return true;
}

function getStatusText(patient) {
  if (patient.isCleared) {
    return patient.impressionReason === 'Cleared' ? 'Cleared' : 'Cleared / Diagnosed';
  }
  if (patient.hasNoDiagnosis && patient.hasZeroAmount) {
    return 'No Diagnosis + Zero Total';
  }
  if (patient.hasZeroAmount) return 'Zero Total (0)';
  return 'No Diagnosis';
}

function getFilteredPatients() {
  const all = getEffectivePatients();
  const q = state.searchQuery.trim().toLowerCase();
  return all.filter((p) => {
    if (!matchesFilter(p, state.activeFilter)) {
      return false;
    }
    if (!q) return true;
    return (
      p.patientName.toLowerCase().includes(q) ||
      (p.clinicalImpression || '').toLowerCase().includes(q) ||
      (p.ageSex || '').toLowerCase().includes(q) ||
      (p.totalAmount || '').toLowerCase().includes(q) ||
      p.pages.some((pg) => String(pg) === q || `p.${pg}` === q)
    );
  });
}

function renderResults() {
  const effective = getEffectivePatients();
  const noDiag = effective.filter((p) => p.hasNoDiagnosis);
  const zeroAmt = effective.filter((p) => p.hasZeroAmount);
  const bothIssues = effective.filter((p) => p.hasNoDiagnosis && p.hasZeroAmount);
  const cleared = effective.filter((p) => p.isCleared);
  const excludedCount = effective.length - cleared.length;

  const noDiagPageCount = countPagesForPatients(noDiag);
  const zeroAmtPageCount = countPagesForPatients(zeroAmt);
  const clearedPageCount = countPagesForPatients(cleared);

  els.noDiagCount.textContent = String(noDiag.length);
  els.noDiagPages.textContent = `${noDiagPageCount} p`;
  els.zeroAmtCount.textContent = String(zeroAmt.length);
  els.zeroAmtPages.textContent = `${zeroAmtPageCount} p`;
  els.clearedCount.textContent = String(cleared.length);
  els.clearedPages.textContent = `${clearedPageCount} p`;

  els.btnExportNoDiag.disabled = noDiag.length === 0 || state.busy;
  els.btnExportZeroAmt.disabled = zeroAmt.length === 0 || state.busy;
  els.btnExportCleared.disabled = cleared.length === 0 || state.busy;
  els.btnNoDiagWord.disabled = noDiag.length === 0 || state.busy;

  if (bothIssues.length > 0) {
    els.overlapNote.textContent = `Note: ${bothIssues.length} ${
      bothIssues.length === 1 ? 'patient has' : 'patients have'
    } both No Diagnosis and ₱0 Total (excluded from Cleared).`;
    els.overlapNote.classList.remove('hidden');
  } else {
    els.overlapNote.classList.add('hidden');
  }

  els.tabAllCount.textContent = String(effective.length);
  els.tabNoDiagCount.textContent = String(noDiag.length);
  els.tabZeroCount.textContent = String(zeroAmt.length);
  els.tabClearedCount.textContent = String(cleared.length);

  // Update tab badge if we have a source PDF tab
  if (state.activeSource && state.activeSource.tabId != null && state.activeSource.blobUrl) {
    (async () => {
      try {
        await chrome.runtime.sendMessage({
          type: 'SET_TAB_BADGE',
          tabId: state.activeSource.tabId,
          blobUrl: state.activeSource.blobUrl,
          noDiagnosisCount: noDiag.length,
          excludedCount,
        });
      } catch {
        // Ignore if service worker restarted or tab closed
      }
    })();
  }

  // Warning if PDF had no selectable text layer
  if (!state.hasTextLayer) {
    els.warningBanner.textContent =
      'Warning: No selectable text was found in this PDF. It may be a scanned image PDF where Clinical Impression text cannot be read automatically.';
    els.warningBanner.classList.remove('hidden');
  } else {
    els.warningBanner.classList.add('hidden');
  }

  // Footer meta
  const sizeStr = state.pdfBytes ? formatBytes(state.pdfBytes.byteLength) : '';
  els.footerMeta.textContent = `${state.totalPages} ${
    state.totalPages === 1 ? 'page' : 'pages'
  } · ${effective.length} ${effective.length === 1 ? 'patient' : 'patients'}${
    sizeStr ? ` · ${sizeStr}` : ''
  }`;

  // Render patient rows safely with DOM nodes (no innerHTML XSS risk)
  const visible = getFilteredPatients();
  const frag = document.createDocumentFragment();

  if (visible.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-list-msg';
    emptyDiv.textContent = state.searchQuery
      ? 'No patients match your search filter.'
      : 'No patients in this category.';
    frag.appendChild(emptyDiv);
  } else {
    for (const p of visible) {
      const row = document.createElement('div');
      row.className = `patient-row cat-${p.category}`;

      const pagePill = document.createElement('span');
      pagePill.className = 'page-pill';
      pagePill.textContent = formatPagesLabel(p.pages);

      const main = document.createElement('div');
      main.className = 'patient-main';

      const nameRow = document.createElement('div');
      nameRow.className = 'patient-name-row';

      const nameEl = document.createElement('span');
      nameEl.className = 'patient-name';
      nameEl.textContent = p.patientName;
      nameRow.appendChild(nameEl);

      if (p.ageSex) {
        const ageEl = document.createElement('span');
        ageEl.className = 'patient-sub';
        ageEl.textContent = p.ageSex;
        nameRow.appendChild(ageEl);
      }

      if (p.totalAmount !== '') {
        const amtEl = document.createElement('span');
        amtEl.className = p.hasZeroAmount ? 'patient-amount-zero' : 'patient-sub';
        amtEl.textContent = `₱${p.totalAmount}`;
        amtEl.title = p.hasZeroAmount ? 'Total Amount is 0 (excluded from Cleared)' : 'Total Amount';
        nameRow.appendChild(amtEl);
      }

      const impEl = document.createElement('div');
      impEl.className = p.clinicalImpression
        ? 'patient-impression'
        : 'patient-impression empty';
      impEl.textContent = p.clinicalImpression
        ? p.clinicalImpression
        : p.hasClinicalLabel
          ? '(Blank Clinical Impression)'
          : '(No "Clinical Impression:" label found)';

      main.appendChild(nameRow);
      main.appendChild(impEl);

      const right = document.createElement('div');
      right.className = 'patient-right';

      const badgeStack = document.createElement('div');
      badgeStack.className = 'badge-stack';

      if (p.isCleared) {
        const badge = document.createElement('span');
        badge.className = 'status-pill cleared';
        badge.textContent = p.impressionReason === 'Cleared' ? 'Cleared' : 'Diagnosed';
        badge.title = p.reason;
        badgeStack.appendChild(badge);
      } else {
        if (p.hasNoDiagnosis) {
          const badge = document.createElement('span');
          badge.className = 'status-pill no_diagnosis';
          badge.textContent = 'No Diagnosis';
          badge.title = p.reason;
          badgeStack.appendChild(badge);
        }
        if (p.hasZeroAmount) {
          const badge = document.createElement('span');
          badge.className = 'status-pill zero_amount';
          badge.textContent = '₱0 Total';
          badge.title = 'Total Amount is 0 (excluded from Cleared)';
          badgeStack.appendChild(badge);
        }
      }

      const swapBtn = document.createElement('button');
      swapBtn.className = 'btn-swap';
      swapBtn.type = 'button';
      if (p.manual) {
        swapBtn.textContent = 'Reset ↺';
        swapBtn.title = 'Restore automatic detection';
        swapBtn.addEventListener('click', () => {
          state.manualOverrides.delete(p.index);
          renderResults();
        });
      } else {
        swapBtn.textContent = p.isCleared ? 'Exclude ⇄' : 'Move to Cleared ⇄';
        swapBtn.title = 'Manually override group for this patient';
        swapBtn.addEventListener('click', () => {
          const nextCat = p.isCleared ? 'no_diagnosis' : 'cleared';
          state.manualOverrides.set(p.index, nextCat);
          renderResults();
        });
      }

      right.appendChild(badgeStack);
      right.appendChild(swapBtn);

      row.appendChild(pagePill);
      row.appendChild(main);
      row.appendChild(right);
      frag.appendChild(row);
    }
  }

  els.patientList.replaceChildren(frag);
  showView('results');
}

async function loadSettings() {
  try {
    const data = await chrome.storage.local.get(STORAGE_SETTINGS_KEY);
    const saved = data[STORAGE_SETTINGS_KEY];
    if (saved && typeof saved === 'object') {
      state.settings = {
        ...DEFAULT_FILTER_OPTIONS,
        ...saved,
      };
    }
  } catch {
    state.settings = { ...DEFAULT_FILTER_OPTIONS };
  }
  syncSettingsInputs();
}

function syncSettingsInputs() {
  els.optZeroTotal.checked = Boolean(state.settings.excludeZeroTotalAmount);
  els.optBlank.checked = Boolean(state.settings.treatBlankAsNoDiagnosis);
  els.optNoneNa.checked = Boolean(state.settings.includeNoneAndNA);
  els.optPhrases.value = (state.settings.noDiagnosisPhrases || ['no diagnosis']).join(', ');
}

async function saveSettingsFromInputs() {
  const rawPhrases = els.optPhrases.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  state.settings = {
    excludeZeroTotalAmount: els.optZeroTotal.checked,
    treatBlankAsNoDiagnosis: els.optBlank.checked,
    includeNoneAndNA: els.optNoneNa.checked,
    noDiagnosisPhrases: rawPhrases.length > 0 ? rawPhrases : ['no diagnosis'],
  };

  try {
    await chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: state.settings });
  } catch {
    // Non-fatal
  }

  if (state.patients.length > 0) {
    state.manualOverrides.clear();
    state.patients = reclassifyPatients(state.patients, state.settings);
    renderResults();
    showToast('Updated detection rules');
  }
  setSettingsOpen(false);
}

function updateSourceHeader() {
  const src = state.activeSource;
  if (!src) {
    els.sourceLabel.textContent = 'No 1Life PDF tab active';
    els.sourceLabel.title = '';
    els.pdfSelector.classList.add('hidden');
    els.sourceLabel.classList.remove('hidden');
    return;
  }

  if (state.sources.length > 1) {
    els.pdfSelector.replaceChildren();
    for (const item of state.sources) {
      const opt = document.createElement('option');
      opt.value = item.key;
      opt.textContent = item.label;
      if (item.key === src.key) opt.selected = true;
      els.pdfSelector.appendChild(opt);
    }
    els.pdfSelector.classList.remove('hidden');
    els.sourceLabel.classList.add('hidden');
  } else {
    els.pdfSelector.classList.add('hidden');
    els.sourceLabel.classList.remove('hidden');
    els.sourceLabel.textContent = src.label;
    els.sourceLabel.title = src.blobUrl || src.label;
  }
}

async function analyzePdfBytes(bytes, sourceMeta) {
  if (!bytes || !isPdfBytes(bytes)) {
    showEmptyState({
      title: 'Invalid PDF Data',
      message: 'The selected file or tab did not contain valid PDF bytes.',
      isError: true,
    });
    return;
  }

  state.pdfBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  state.manualOverrides.clear();
  state.activeSource = sourceMeta;
  updateSourceHeader();

  setLoading('Scanning Statement of Account pages...', 'Extracting Clinical Impression fields', 15);

  try {
    const parsed = await parseSoaPdf(
      state.pdfBytes,
      pdfjsLib,
      state.settings,
      ({ current, total }) => {
        const pct = Math.round(15 + (current / Math.max(1, total)) * 85);
        setLoading(
          `Scanning page ${current} of ${total}...`,
          'Detecting No Diagnosis & Cleared patients',
          pct
        );
      }
    );

    state.totalPages = parsed.totalPages;
    state.hasTextLayer = parsed.hasTextLayer;
    state.patients = parsed.patients;

    // Default to "All" or keep current tab if valid
    renderResults();
  } catch (err) {
    console.error('[1Life SOA Filter] PDF parse error:', err);
    showEmptyState({
      title: 'Could Not Parse PDF',
      message: err && err.message ? err.message : 'An error occurred while reading the PDF.',
      isError: true,
    });
  }
}

async function loadBlobSource(source) {
  state.activeSource = source;
  updateSourceHeader();
  setLoading('Reading 1Life PDF...', shortBlobId(source.blobUrl), 10);

  // 1. Check shared IndexedDB cache first (instant!)
  try {
    const cached = await getCapturedPdf(source.blobUrl);
    if (cached && cached.bytes && isPdfBytes(cached.bytes)) {
      await analyzePdfBytes(cached.bytes, source);
      return;
    }
  } catch {
    // Continue to background acquisition
  }

  // 2. Ask background service worker to run 4-tier blob acquisition
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'ACQUIRE_BLOB_PDF',
      blobUrl: source.blobUrl,
      pdfTabId: source.tabId ?? null,
    });

    if (resp && resp.ok) {
      const cached = await getCapturedPdf(source.blobUrl);
      if (cached && cached.bytes && isPdfBytes(cached.bytes)) {
        await analyzePdfBytes(cached.bytes, source);
        return;
      }
    }

    // 3. Final direct fetch attempt from extension context
    try {
      const directRes = await fetch(source.blobUrl);
      if (directRes.ok) {
        const buf = await directRes.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (isPdfBytes(bytes)) {
          await analyzePdfBytes(bytes, source);
          return;
        }
      }
    } catch {
      // Expected if Chromium isolates cross-origin blob fetch
    }

    showEmptyState({
      title: 'Unable to Read Blob PDF Automatically',
      message:
        (resp && resp.error) ||
        'Keep your 1life.ph tab open and re-open the Statement of Account PDF, or drop the downloaded PDF file below.',
      isError: true,
    });
  } catch (err) {
    showEmptyState({
      title: 'Unable to Connect to PDF Tab',
      message: err && err.message ? err.message : 'Try reloading the 1life.ph PDF tab.',
      isError: true,
    });
  }
}

async function discoverAndLoadSources() {
  const urlParams = new URLSearchParams(window.location.search);
  const requestedBlobUrl = urlParams.get('blobUrl');
  const requestedTabId = urlParams.get('sourceTabId')
    ? Number(urlParams.get('sourceTabId'))
    : null;

  const sources = [];
  const seenUrls = new Set();

  // Active tab in current window first
  let activeTab = null;
  try {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = activeTabs[0] || null;
  } catch {
    // Ignore
  }

  if (requestedBlobUrl && isOneLifeBlobUrl(requestedBlobUrl)) {
    seenUrls.add(requestedBlobUrl);
    sources.push({
      key: `req:${requestedBlobUrl}`,
      type: 'tab',
      blobUrl: requestedBlobUrl,
      tabId: requestedTabId,
      label: `blob:https://1life.ph/${shortBlobId(requestedBlobUrl)}`,
    });
  }

  if (activeTab && isOneLifeBlobUrl(activeTab.url) && !seenUrls.has(activeTab.url)) {
    seenUrls.add(activeTab.url);
    sources.push({
      key: `tab:${activeTab.id}:${activeTab.url}`,
      type: 'tab',
      blobUrl: activeTab.url,
      tabId: activeTab.id,
      label: `Active Tab · ${shortBlobId(activeTab.url)}`,
    });
  }

  // Other open blob:https://1life.ph/* tabs across windows
  try {
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
      if (isOneLifeBlobUrl(tab.url) && !seenUrls.has(tab.url)) {
        seenUrls.add(tab.url);
        sources.push({
          key: `tab:${tab.id}:${tab.url}`,
          type: 'tab',
          blobUrl: tab.url,
          tabId: tab.id,
          label: `Open Tab · ${shortBlobId(tab.url)}`,
        });
      }
    }
  } catch {
    // Ignore
  }

  // Recently cached 1Life PDFs in IndexedDB (in case blob tab closed)
  try {
    const cachedList = await listCapturedPdfs();
    for (const rec of cachedList) {
      if (isOneLifeBlobUrl(rec.blobUrl) && !seenUrls.has(rec.blobUrl)) {
        seenUrls.add(rec.blobUrl);
        sources.push({
          key: `cache:${rec.blobUrl}`,
          type: 'cache',
          blobUrl: rec.blobUrl,
          tabId: rec.tabId ?? null,
          label: `Recent · ${shortBlobId(rec.blobUrl)} (${formatBytes(rec.size)})`,
        });
      }
    }
  } catch {
    // Ignore
  }

  state.sources = sources;

  if (sources.length === 0) {
    state.activeSource = null;
    updateSourceHeader();
    showEmptyState({
      title: 'No 1Life PDF Open',
      message:
        'Open a Statement of Account PDF from 1life.ph (blob:https://1life.ph/...) and click this extension again — or drop a saved PDF file below.',
      isError: false,
    });
    return;
  }

  await loadBlobSource(sources[0]);
}

async function handleExport(category) {
  if (state.busy || !state.pdfBytes) return;

  const effective = getEffectivePatients();
  const matching = effective.filter((p) => matchesFilter(p, category));
  if (matching.length === 0) {
    showToast('No patients in this group to export.');
    return;
  }

  state.busy = true;
  const btnMap = {
    no_diagnosis: els.btnExportNoDiag,
    zero_amount: els.btnExportZeroAmt,
    cleared: els.btnExportCleared,
  };
  const btn = btnMap[category] || els.btnExportCleared;
  const labelSpan = btn.querySelector('span');
  const originalLabel = labelSpan ? labelSpan.textContent : btn.textContent;
  els.btnExportNoDiag.disabled = true;
  els.btnExportZeroAmt.disabled = true;
  els.btnExportCleared.disabled = true;
  els.btnNoDiagWord.disabled = true;
  if (labelSpan) {
    labelSpan.textContent = 'Building PDF...';
  } else {
    btn.textContent = 'Building PDF...';
  }

  try {
    const labelMap = {
      no_diagnosis: 'No Diagnosis',
      zero_amount: 'Zero Total Amount (₱0)',
      cleared: 'Cleared / Diagnosed',
    };
    const prefixMap = {
      no_diagnosis: 'nodiag',
      zero_amount: 'zeroamt',
      cleared: 'cleared',
    };
    const label = labelMap[category] || 'Filtered';
    const filename = buildExportFilename(category, matching.length);
    const title = `1Life SOA — ${label} (${matching.length} ${
      matching.length === 1 ? 'Patient' : 'Patients'
    })`;

    const { bytes, pageCount, patientCount } = await buildFilteredPdf(
      state.pdfBytes,
      matching,
      { title }
    );

    const exportId = randomId(prefixMap[category] || 'exp');
    await saveExportedPdf({
      id: exportId,
      bytes,
      filename,
      createdAt: Date.now(),
    });

    const viewerUrl = chrome.runtime.getURL(
      `viewer/viewer.html?id=${encodeURIComponent(exportId)}`
    );
    await chrome.tabs.create({ url: viewerUrl });
    showToast(`Opened ${patientCount} patients (${pageCount} pages) in new tab`);
  } catch (err) {
    console.error('[1Life SOA Filter] Export error:', err);
    showToast(`Export failed: ${err && err.message ? err.message : err}`);
  } finally {
    state.busy = false;
    if (labelSpan) {
      labelSpan.textContent = originalLabel;
    } else {
      btn.textContent = originalLabel;
    }
    renderResults();
  }
}

async function handleLocalFile(file) {
  if (!file) return;
  if (file.size > MAX_PDF_BYTES) {
    showEmptyState({
      title: 'File Too Large',
      message: `The selected file exceeds the ${formatBytes(MAX_PDF_BYTES)} safety limit.`,
      isError: true,
    });
    return;
  }
  try {
    setLoading('Reading local PDF...', file.name, 10);
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const source = {
      key: `file:${file.name}:${Date.now()}`,
      type: 'file',
      blobUrl: null,
      tabId: null,
      label: `Local File · ${file.name}`,
    };
    state.sources = [source, ...state.sources.filter((s) => s.type !== 'file')];
    await analyzePdfBytes(bytes, source);
  } catch (err) {
    showEmptyState({
      title: 'Could Not Read File',
      message: err && err.message ? err.message : 'Unable to open the selected PDF file.',
      isError: true,
    });
  }
}

async function handleClearCache() {
  try {
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    } catch {
      await clearAllPdfs();
    }
    state.sources = [];
    state.activeSource = null;
    state.pdfBytes = null;
    state.totalPages = 0;
    state.patients = [];
    state.manualOverrides.clear();
    updateSourceHeader();
    setSettingsOpen(false);
    showEmptyState({
      title: 'Local Cache Cleared',
      message:
        'All locally cached PDFs have been deleted from this browser. Open a Statement of Account PDF or drop a local PDF file below to scan again.',
      isError: false,
    });
    showToast('Cleared all locally cached PDFs');
  } catch (err) {
    showToast(`Could not clear cache: ${err && err.message ? err.message : err}`);
  }
}

async function handleCopyList() {
  const visible = getFilteredPatients();
  if (visible.length === 0) {
    showToast('No patients to copy');
    return;
  }
  const lines = visible.map((p) => {
    const status = getStatusText(p);
    const imp = p.clinicalImpression || '(Blank)';
    const amt = p.totalAmount !== '' ? `₱${p.totalAmount}` : '';
    return `${formatPagesLabel(p.pages)}\t${p.patientName}\t${imp}\t${amt}\t${status}`;
  });
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    showToast(`Copied ${visible.length} patients to clipboard`);
  } catch {
    showToast('Could not copy to clipboard');
  }
}

function handleDownloadCsv() {
  const visible = getFilteredPatients();
  if (visible.length === 0) {
    showToast('No patients to export');
    return;
  }
  const header = ['Pages', 'Patient Name', 'Age / Sex', 'Clinical Impression', 'Status', 'Total Amount'];
  const rows = [header.map(escapeCsvCell).join(',')];
  for (const p of visible) {
    rows.push(
      [
        p.pages.join('; '),
        p.patientName,
        p.ageSex || '',
        p.clinicalImpression || '(Blank)',
        getStatusText(p),
        p.totalAmount || '',
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }
  const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `1Life_SOA_Patients_${state.activeFilter}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Downloaded CSV (${visible.length} rows)`);
}

async function handleExportWord(category = 'no_diagnosis') {
  if (state.busy || !state.pdfBytes) return;

  const effective = getEffectivePatients();
  const matching = effective.filter((p) => matchesFilter(p, category));
  if (matching.length === 0) {
    showToast('No patients in this group to convert.');
    return;
  }

  state.busy = true;
  const origLabel = els.btnNoDiagWord.textContent;
  els.btnExportNoDiag.disabled = true;
  els.btnExportZeroAmt.disabled = true;
  els.btnExportCleared.disabled = true;
  els.btnNoDiagWord.disabled = true;
  els.btnNoDiagWord.textContent = 'Converting...';

  try {
    const filename = buildExportFilename(category, matching.length).replace(/\.pdf$/i, '.docx');
    const { bytes: filteredPdfBytes } = await buildFilteredPdf(state.pdfBytes, matching, {
      title: `1Life SOA — No Diagnosis (${matching.length} Patients)`,
    });

    const { bytes: docxBytes, pageCount } = await convertPdfToDocx(filteredPdfBytes, pdfjsLib, {
      onProgress: ({ current, total }) => {
        els.btnNoDiagWord.textContent = `Word ${current}/${total}...`;
      },
    });

    const blob = new Blob([docxBytes], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast(`Downloaded ${pageCount}-page Word file (.docx)`);
  } catch (err) {
    console.error('[1Life SOA Filter] Word export error:', err);
    showToast(`Word conversion failed: ${err && err.message ? err.message : err}`);
  } finally {
    state.busy = false;
    els.btnNoDiagWord.textContent = origLabel;
    renderResults();
  }
}

function bindEvents() {
  els.btnExportNoDiag.addEventListener('click', () => handleExport('no_diagnosis'));
  els.btnExportZeroAmt.addEventListener('click', () => handleExport('zero_amount'));
  els.btnExportCleared.addEventListener('click', () => handleExport('cleared'));
  els.btnNoDiagWord.addEventListener('click', () => handleExportWord('no_diagnosis'));

  els.btnRescan.addEventListener('click', () => {
    if (state.activeSource && state.activeSource.type === 'file' && state.pdfBytes) {
      analyzePdfBytes(state.pdfBytes, state.activeSource);
    } else if (state.activeSource && state.activeSource.blobUrl) {
      loadBlobSource(state.activeSource);
    } else {
      discoverAndLoadSources();
    }
  });

  els.btnUpload.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) handleLocalFile(file);
  });

  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropzone.classList.add('drag-over');
  });
  els.dropzone.addEventListener('dragleave', () => {
    els.dropzone.classList.remove('drag-over');
  });
  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('drag-over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleLocalFile(file);
  });

  els.btnSettings.addEventListener('click', () => {
    const willOpen = els.settingsPanel.classList.contains('hidden');
    setSettingsOpen(willOpen);
  });

  els.btnApplySettings.addEventListener('click', saveSettingsFromInputs);
  els.btnResetSettings.addEventListener('click', () => {
    state.settings = { ...DEFAULT_FILTER_OPTIONS };
    syncSettingsInputs();
    saveSettingsFromInputs();
  });
  if (els.btnClearCache) {
    els.btnClearCache.addEventListener('click', handleClearCache);
  }

  els.btnPopout.addEventListener('click', () => {
    const params = new URLSearchParams({ mode: 'tab' });
    if (state.activeSource && state.activeSource.blobUrl) {
      params.set('blobUrl', state.activeSource.blobUrl);
    }
    if (state.activeSource && state.activeSource.tabId != null) {
      params.set('sourceTabId', String(state.activeSource.tabId));
    }
    chrome.tabs.create({
      url: chrome.runtime.getURL(`popup/popup.html?${params.toString()}`),
    });
  });

  els.pdfSelector.addEventListener('change', () => {
    const selected = state.sources.find((s) => s.key === els.pdfSelector.value);
    if (!selected) return;
    if (selected.blobUrl) {
      loadBlobSource(selected);
    }
  });

  function activateFilterTab(tabBtn, { focus = false } = {}) {
    state.activeFilter = tabBtn.dataset.filter;
    for (const b of els.filterTabs) {
      const isActive = b === tabBtn;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-selected', String(isActive));
      b.setAttribute('tabindex', isActive ? '0' : '-1');
    }
    if (focus) tabBtn.focus();
    renderResults();
  }

  for (let i = 0; i < els.filterTabs.length; i++) {
    const tabBtn = els.filterTabs[i];
    tabBtn.addEventListener('click', () => activateFilterTab(tabBtn));
    tabBtn.addEventListener('keydown', (e) => {
      let nextIdx = null;
      if (e.key === 'ArrowRight') nextIdx = (i + 1) % els.filterTabs.length;
      else if (e.key === 'ArrowLeft') nextIdx = (i - 1 + els.filterTabs.length) % els.filterTabs.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = els.filterTabs.length - 1;
      if (nextIdx !== null) {
        e.preventDefault();
        activateFilterTab(els.filterTabs[nextIdx], { focus: true });
      }
    });
  }

  els.searchInput.addEventListener('input', () => {
    state.searchQuery = els.searchInput.value;
    renderResults();
  });

  els.btnCopyList.addEventListener('click', handleCopyList);
  els.btnExportCsv.addEventListener('click', handleDownloadCsv);
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  state.isTabMode = params.get('mode') === 'tab';
  if (state.isTabMode) {
    document.body.classList.add('tab-mode');
    els.btnPopout.classList.add('hidden');
  }

  bindEvents();
  await loadSettings();
  await discoverAndLoadSources();
}

init();
