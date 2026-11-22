/**
 * New-Tab Exported PDF Viewer.
 * Reads the generated filtered PDF from IndexedDB, creates a long-lived blob URL
 * owned by this tab, and renders it inside Chrome's native PDF viewer iframe.
 */

import * as pdfjsLib from '../lib/pdf.min.mjs';
import { escapeCsvCell, formatBytes } from '../shared/binary.js';
import { getExportedPdf } from '../shared/db.js';
import { convertPdfToDocx } from '../shared/pdf-to-docx.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const els = {
  catBadge: document.getElementById('cat-badge'),
  summaryText: document.getElementById('summary-text'),
  btnToggleDrawer: document.getElementById('btn-toggle-drawer'),
  btnConvertWord: document.getElementById('btn-convert-word'),
  btnConvertWordLabel: document.getElementById('btn-convert-word-label'),
  btnDownload: document.getElementById('btn-download'),
  btnOpenRaw: document.getElementById('btn-open-raw'),
  errorState: document.getElementById('error-state'),
  errorTitle: document.getElementById('error-title'),
  errorMsg: document.getElementById('error-msg'),
  pdfFrame: document.getElementById('pdf-frame'),
  drawer: document.getElementById('drawer'),
  drawerTitle: document.getElementById('drawer-title'),
  drawerSub: document.getElementById('drawer-sub'),
  btnCloseDrawer: document.getElementById('btn-close-drawer'),
  btnCopyNames: document.getElementById('btn-copy-names'),
  btnCsv: document.getElementById('btn-csv'),
  drawerList: document.getElementById('drawer-list'),
  toast: document.getElementById('toast'),
};

let currentRecord = null;
let currentBlobUrl = null;
let cachedDocxBlobUrl = null;
let convertingWord = false;
let toastTimer = null;

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2400);
}

function showError(title, msg) {
  els.catBadge.textContent = 'Unavailable';
  els.errorTitle.textContent = title;
  els.errorMsg.textContent = msg;
  els.errorState.classList.remove('hidden');
  els.pdfFrame.classList.add('hidden');
}

function formatPages(pages) {
  if (!pages || pages.length === 0) return '';
  if (pages.length === 1) return `Orig p. ${pages[0]}`;
  return `Orig p. ${pages[0]}–${pages[pages.length - 1]}`;
}

function getCategoryLabel(category) {
  if (category === 'no_diagnosis') return 'No Diagnosis';
  if (category === 'zero_amount') return 'Zero Total (₱0)';
  return 'Cleared / Diagnosed';
}

function getCategorySubtitle(category) {
  if (category === 'no_diagnosis') return 'Patients flagged with No Diagnosis';
  if (category === 'zero_amount') return 'Patients with TOTAL AMOUNT = 0 (excluded from Cleared)';
  return 'Patients cleared/diagnosed with Total Amount > 0';
}

function renderDrawer(record) {
  const patients = record.patients || [];
  els.drawerTitle.textContent = `Exported Patients (${patients.length})`;
  els.drawerSub.textContent = getCategorySubtitle(record.category);

  const frag = document.createDocumentFragment();
  patients.forEach((p, idx) => {
    const item = document.createElement('div');
    item.className = 'drawer-item';

    const top = document.createElement('div');
    top.className = 'drawer-item-top';

    const name = document.createElement('span');
    name.className = 'drawer-name';
    name.textContent = `${idx + 1}. ${p.patientName}`;

    const pages = document.createElement('span');
    pages.className = 'drawer-pages';
    pages.textContent = formatPages(p.pages);

    top.appendChild(name);
    top.appendChild(pages);

    const imp = document.createElement('div');
    imp.className = p.clinicalImpression ? 'drawer-imp' : 'drawer-imp empty';
    imp.textContent = p.clinicalImpression || '(Blank Clinical Impression)';

    item.appendChild(top);
    item.appendChild(imp);

    if (p.totalAmount !== undefined && p.totalAmount !== '') {
      const amt = document.createElement('div');
      amt.className = p.hasZeroAmount ? 'drawer-amt zero' : 'drawer-amt';
      amt.textContent = `Total Amount: ₱${p.totalAmount}`;
      item.appendChild(amt);
    }

    frag.appendChild(item);
  });

  els.drawerList.replaceChildren(frag);
}

function downloadPdf() {
  if (!currentRecord || !currentBlobUrl) return;
  const a = document.createElement('a');
  a.href = currentBlobUrl;
  a.download = currentRecord.filename || '1Life_SOA_Filtered.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast(`Downloading ${a.download}`);
}

function copyNames() {
  if (!currentRecord) return;
  const patients = currentRecord.patients || [];
  const lines = patients.map((p, idx) => {
    const amt = p.totalAmount !== undefined && p.totalAmount !== '' ? `₱${p.totalAmount}` : '';
    return `${idx + 1}. ${p.patientName}\t${p.clinicalImpression || '(Blank)'}\t${amt}\t${formatPages(p.pages)}`;
  });
  navigator.clipboard
    .writeText(lines.join('\n'))
    .then(() => showToast(`Copied ${patients.length} patients`))
    .catch(() => showToast('Could not copy to clipboard'));
}

function downloadCsv() {
  if (!currentRecord) return;
  const patients = currentRecord.patients || [];
  const header = ['#', 'Original Page(s)', 'Patient Name', 'Age / Sex', 'Clinical Impression', 'Status', 'Total Amount'];
  const rows = [header.map(escapeCsvCell).join(',')];
  const fallbackStatus = getCategoryLabel(currentRecord.category);
  patients.forEach((p, idx) => {
    const status =
      p.hasNoDiagnosis && p.hasZeroAmount
        ? 'No Diagnosis + Zero Total'
        : p.hasZeroAmount
          ? 'Zero Total (0)'
          : p.hasNoDiagnosis
            ? 'No Diagnosis'
            : fallbackStatus;
    rows.push(
      [
        idx + 1,
        (p.pages || []).join('; '),
        p.patientName,
        p.ageSex || '',
        p.clinicalImpression || '(Blank)',
        status,
        p.totalAmount || '',
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  });

  const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (currentRecord.filename || '1Life_SOA_Filtered.pdf').replace(/\.pdf$/i, '.csv');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Downloaded CSV (${patients.length} patients)`);
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');

  if (!id) {
    showError('Missing Export ID', 'Open this viewer from the 1Life SOA Diagnosis Filter extension.');
    return;
  }

  try {
    const record = await getExportedPdf(id);
    if (!record || !record.bytes || record.bytes.byteLength === 0) {
      showError(
        'Export Expired or Not Found',
        'Please re-export from the 1Life SOA Diagnosis Filter extension on the original PDF tab.'
      );
      return;
    }

    currentRecord = record;
    const catLabel = getCategoryLabel(record.category);

    document.title = record.title || `1Life SOA — ${catLabel}`;
    els.catBadge.textContent = catLabel;
    els.catBadge.className = `cat-badge ${record.category}`;
    els.summaryText.textContent = `${record.patientCount} ${
      record.patientCount === 1 ? 'patient' : 'patients'
    } · ${record.pageCount} ${record.pageCount === 1 ? 'page' : 'pages'} · ${formatBytes(
      record.bytes.byteLength
    )}`;

    const pdfBlob = new Blob([record.bytes], { type: 'application/pdf' });
    currentBlobUrl = URL.createObjectURL(pdfBlob);

    els.pdfFrame.src = currentBlobUrl;
    els.pdfFrame.classList.remove('hidden');

    renderDrawer(record);

    els.btnToggleDrawer.disabled = false;
    els.btnToggleDrawer.textContent = `Patients (${record.patientCount})`;
    els.btnConvertWord.disabled = false;
    els.btnDownload.disabled = false;
    els.btnOpenRaw.disabled = false;
  } catch (err) {
    console.error('[1Life SOA Viewer] Error loading export:', err);
    showError('Failed to Load Exported PDF', err && err.message ? err.message : String(err));
  }
}

async function convertToWord() {
  if (!currentRecord || !currentRecord.bytes || convertingWord) return;

  const docxName = (currentRecord.filename || '1Life_SOA_Filtered.pdf').replace(/\.pdf$/i, '.docx');

  // If already converted in this tab, download instantly
  if (cachedDocxBlobUrl) {
    const a = document.createElement('a');
    a.href = cachedDocxBlobUrl;
    a.download = docxName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(`Downloaded ${docxName}`);
    return;
  }

  convertingWord = true;
  els.btnConvertWord.disabled = true;
  els.btnConvertWordLabel.textContent = 'Converting to Word...';

  try {
    const { bytes, pageCount } = await convertPdfToDocx(currentRecord.bytes, pdfjsLib, {
      onProgress: ({ current, total }) => {
        els.btnConvertWordLabel.textContent = `Converting ${current}/${total}...`;
      },
    });

    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    cachedDocxBlobUrl = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = cachedDocxBlobUrl;
    a.download = docxName;
    document.body.appendChild(a);
    a.click();
    a.remove();

    els.btnConvertWordLabel.textContent = 'Download Word (.docx)';
    showToast(`Converted ${pageCount} ${pageCount === 1 ? 'page' : 'pages'} to Word (.docx)`);
  } catch (err) {
    console.error('[1Life SOA Viewer] Word conversion failed:', err);
    els.btnConvertWordLabel.textContent = 'Convert to Word (.docx)';
    showToast(`Word conversion failed: ${err && err.message ? err.message : err}`);
  } finally {
    convertingWord = false;
    els.btnConvertWord.disabled = false;
  }
}

els.btnToggleDrawer.addEventListener('click', () => {
  els.drawer.classList.toggle('hidden');
});
els.btnCloseDrawer.addEventListener('click', () => {
  els.drawer.classList.add('hidden');
});
els.btnConvertWord.addEventListener('click', convertToWord);
els.btnDownload.addEventListener('click', downloadPdf);
els.btnOpenRaw.addEventListener('click', () => {
  if (currentBlobUrl) {
    window.open(currentBlobUrl, '_blank', 'noopener');
  }
});
els.btnCopyNames.addEventListener('click', copyNames);
els.btnCsv.addEventListener('click', downloadCsv);

init();
