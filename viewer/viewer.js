/**
 * Raw Exported PDF Opener.
 * Reads the generated filtered PDF from IndexedDB, creates a raw PDF blob URL,
 * and replaces this tab directly with the raw PDF in Chrome's native PDF viewer
 * (no extension wrapper, toolbar, or iframe) so printing (Ctrl+P) prints the raw PDF cleanly.
 */

import { deleteExportedPdf, getExportedPdf } from '../shared/db.js';

const errorState = document.getElementById('error-state');
const errorTitle = document.getElementById('error-title');
const errorMsg = document.getElementById('error-msg');

function showError(title, msg) {
  document.title = title;
  errorTitle.textContent = title;
  errorMsg.textContent = msg;
  errorState.classList.remove('hidden');
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');

  if (!id) {
    showError('Missing Export ID', 'Open this export from the 1Life SOA Diagnosis Filter extension.');
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

    const pdfBlob = new Blob([record.bytes], { type: 'application/pdf' });
    const blobUrl = URL.createObjectURL(pdfBlob);
    // Delete temporary export from IndexedDB immediately so patient PDFs do not linger on disk
    await deleteExportedPdf(id);
    window.location.replace(blobUrl);
  } catch (err) {
    console.error('[1Life SOA Viewer] Error loading export:', err);
    showError('Failed to Load Exported PDF', err && err.message ? err.message : String(err));
  }
}

init();
