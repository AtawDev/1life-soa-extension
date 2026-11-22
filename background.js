/**
 * 1Life SOA Diagnosis Filter — Manifest V3 Background Service Worker.
 * Coordinates PDF blob caching, multi-tier blob acquisition, tab badges, and scanner tabs.
 */

import {
  base64ToUint8,
  isOneLifeBlobUrl,
  isOneLifeOriginUrl,
  isPdfBytes,
} from './shared/binary.js';
import { getCapturedPdf, saveCapturedPdf } from './shared/db.js';

const SESSION_META_KEY = 'blobMetaRegistry';
const scannedTabs = new Map(); // tabId -> { blobUrl, noDiagnosisCount }

async function getBlobMetaRegistry() {
  try {
    const data = await chrome.storage.session.get(SESSION_META_KEY);
    return data[SESSION_META_KEY] || {};
  } catch {
    return {};
  }
}

async function saveBlobMeta(blobUrl, meta) {
  try {
    const registry = await getBlobMetaRegistry();
    registry[blobUrl] = meta;
    // Keep registry bounded to latest 30 entries
    const keys = Object.keys(registry);
    if (keys.length > 30) {
      keys
        .sort((a, b) => (registry[a].capturedAt || 0) - (registry[b].capturedAt || 0))
        .slice(0, keys.length - 30)
        .forEach((k) => delete registry[k]);
    }
    await chrome.storage.session.set({ [SESSION_META_KEY]: registry });
  } catch {
    // Non-fatal
  }
}

function sendTabMessage(tabId, message, options = undefined) {
  return new Promise((resolve) => {
    try {
      const cb = (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(resp || null);
        }
      };
      if (options) {
        chrome.tabs.sendMessage(tabId, message, options, cb);
      } else {
        chrome.tabs.sendMessage(tabId, message, cb);
      }
    } catch {
      resolve(null);
    }
  });
}

/**
 * Injected into an open https://1life.ph/* tab as a fallback when bridge.js
 * was not yet loaded (e.g., tab opened before extension installation/reload).
 */
async function injectedFetchBlobAsBase64(targetBlobUrl) {
  try {
    const res = await fetch(targetBlobUrl);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const chunkSize = 0x8000;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return { ok: true, base64: btoa(chunks.join('')) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * 4-tier acquisition pipeline for blob:https://1life.ph/* PDFs.
 * Persists bytes directly into shared IndexedDB so the popup can read them instantaneously.
 */
async function acquireBlobPdf(blobUrl, pdfTabId = null) {
  if (!isOneLifeBlobUrl(blobUrl)) {
    return { ok: false, error: 'URL is not a blob:https://1life.ph PDF.' };
  }

  // Tier 1: Already cached in IndexedDB
  try {
    const existing = await getCapturedPdf(blobUrl);
    if (existing && existing.bytes && isPdfBytes(existing.bytes)) {
      return { ok: true, method: 'cache', size: existing.bytes.byteLength };
    }
  } catch {
    // Continue to live fetch tiers
  }

  // Tier 2: Ask pdf-overlay.js inside the blob:https://1life.ph/* tab directly
  if (pdfTabId != null) {
    const overlayResp = await sendTabMessage(pdfTabId, {
      type: 'OVERLAY_FETCH_CURRENT_BLOB',
    });
    if (overlayResp && overlayResp.ok && overlayResp.base64) {
      const bytes = base64ToUint8(overlayResp.base64);
      if (isPdfBytes(bytes)) {
        await saveCapturedPdf({ blobUrl, bytes, tabId: pdfTabId });
        return { ok: true, method: 'blob-tab-overlay', size: bytes.byteLength };
      }
    }
  }

  // Tier 3: Fetch from an open https://1life.ph/* tab (shares exact blob storage origin)
  const candidateTabIds = [];
  const seenTabs = new Set();
  const addCandidate = (id) => {
    if (typeof id === 'number' && id >= 0 && !seenTabs.has(id)) {
      seenTabs.add(id);
      candidateTabIds.push(id);
    }
  };

  const registry = await getBlobMetaRegistry();
  const meta = registry[blobUrl];
  if (meta && typeof meta.sourceTabId === 'number') {
    addCandidate(meta.sourceTabId);
  }

  if (pdfTabId != null) {
    try {
      const pdfTab = await chrome.tabs.get(pdfTabId);
      if (pdfTab && typeof pdfTab.openerTabId === 'number') {
        addCandidate(pdfTab.openerTabId);
      }
    } catch {
      // Tab may no longer exist
    }
  }

  const allTabs = await chrome.tabs.query({});
  for (const t of allTabs) {
    if (t.id != null && isOneLifeOriginUrl(t.url)) {
      addCandidate(t.id);
    }
  }

  const attemptErrors = [];

  for (const tabId of candidateTabIds) {
    // 3a. Try bridge.js (checks MAIN-world preserved Blob Map first, survives revokeObjectURL!)
    const bridgeResp = await sendTabMessage(tabId, {
      type: 'BRIDGE_FETCH_BLOB',
      blobUrl,
    });
    if (bridgeResp && bridgeResp.ok && bridgeResp.base64) {
      const bytes = base64ToUint8(bridgeResp.base64);
      if (isPdfBytes(bytes)) {
        await saveCapturedPdf({ blobUrl, bytes, tabId });
        return { ok: true, method: '1life-bridge', size: bytes.byteLength };
      }
    }

    // 3b. Try programmatic executeScript on the https://1life.ph/* tab
    try {
      const execResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: injectedFetchBlobAsBase64,
        args: [blobUrl],
      });
      const first = execResults && execResults[0] && execResults[0].result;
      if (first && first.ok && first.base64) {
        const bytes = base64ToUint8(first.base64);
        if (isPdfBytes(bytes)) {
          await saveCapturedPdf({ blobUrl, bytes, tabId });
          return { ok: true, method: '1life-scripting', size: bytes.byteLength };
        }
      } else if (first && first.error) {
        attemptErrors.push(`Tab ${tabId}: ${first.error}`);
      }
    } catch (err) {
      attemptErrors.push(`Tab ${tabId}: ${err.message}`);
    }
  }

  // Tier 4: Last-resort executeScript directly on pdfTabId (supported on some Chromium configs)
  if (pdfTabId != null) {
    try {
      const execResults = await chrome.scripting.executeScript({
        target: { tabId: pdfTabId },
        func: injectedFetchBlobAsBase64,
        args: [blobUrl],
      });
      const first = execResults && execResults[0] && execResults[0].result;
      if (first && first.ok && first.base64) {
        const bytes = base64ToUint8(first.base64);
        if (isPdfBytes(bytes)) {
          await saveCapturedPdf({ blobUrl, bytes, tabId: pdfTabId });
          return { ok: true, method: 'pdf-tab-scripting', size: bytes.byteLength };
        }
      }
    } catch (err) {
      attemptErrors.push(`PDF tab: ${err.message}`);
    }
  }

  const noOneLifeTabs = candidateTabIds.length === 0;
  const friendlyMessage = noOneLifeTabs
    ? 'Could not read this blob PDF because no https://1life.ph tab is open and the PDF was opened before the extension was loaded. Keep your 1life.ph tab open, re-open the PDF from 1life.ph, or load the downloaded PDF file below.'
    : 'Could not fetch this blob PDF from 1life.ph (the temporary blob URL may have been revoked before the extension was installed). Re-open the Statement of Account PDF from 1life.ph so the extension can capture it automatically, or load the saved PDF file below.';

  return {
    ok: false,
    error: friendlyMessage,
    details: attemptErrors.join(' | '),
  };
}

async function updateTabBadgeForUrl(tabId, url) {
  if (tabId == null) return;
  if (isOneLifeBlobUrl(url)) {
    const prev = scannedTabs.get(tabId);
    if (prev && prev.blobUrl === url) return; // Preserve exact scan count badge
    try {
      await chrome.action.setBadgeText({ tabId, text: 'SOA' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0f766e' });
    } catch {
      // Tab may have closed
    }
  } else {
    scannedTabs.delete(tabId);
    try {
      await chrome.action.setBadgeText({ tabId, text: '' });
    } catch {
      // Ignore
    }
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (tab && tab.url);
  if (changeInfo.url || changeInfo.status === 'complete') {
    updateTabBadgeForUrl(tabId, url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab) {
      updateTabBadgeForUrl(tabId, tab.url);
    }
  } catch {
    // Ignore
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  scannedTabs.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'REGISTER_BLOB_META': {
      if (message.blobUrl && isOneLifeBlobUrl(message.blobUrl)) {
        saveBlobMeta(message.blobUrl, {
          sourceTabId: sender.tab ? sender.tab.id : null,
          sourceFrameId: sender.frameId ?? 0,
          size: message.size || 0,
          capturedAt: Date.now(),
        });
      }
      sendResponse({ ok: true });
      return false;
    }

    case 'CACHE_BLOB_PDF': {
      (async () => {
        try {
          if (!message.blobUrl || !message.base64 || !isOneLifeBlobUrl(message.blobUrl)) {
            sendResponse({ ok: false, error: 'Invalid cache payload' });
            return;
          }
          const bytes = base64ToUint8(message.base64);
          if (!isPdfBytes(bytes)) {
            sendResponse({ ok: false, error: 'Not a valid PDF binary' });
            return;
          }
          await saveCapturedPdf({
            blobUrl: message.blobUrl,
            bytes,
            tabId: sender.tab ? sender.tab.id : null,
          });
          sendResponse({ ok: true, size: bytes.byteLength });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case 'ACQUIRE_BLOB_PDF': {
      acquireBlobPdf(message.blobUrl, message.pdfTabId ?? null)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    case 'SET_TAB_BADGE': {
      (async () => {
        const { tabId, blobUrl } = message;
        const flaggedCount =
          typeof message.excludedCount === 'number'
            ? message.excludedCount
            : Number(message.noDiagnosisCount) || 0;
        if (tabId == null) {
          sendResponse({ ok: false });
          return;
        }
        scannedTabs.set(tabId, { blobUrl, flaggedCount });
        try {
          const text = flaggedCount > 0 ? String(flaggedCount) : 'OK';
          const color = flaggedCount > 0 ? '#d97706' : '#059669';
          await chrome.action.setBadgeText({ tabId, text });
          await chrome.action.setBadgeBackgroundColor({ tabId, color });
        } catch {
          // Ignore if tab closed
        }
        sendResponse({ ok: true });
      })();
      return true;
    }

    case 'OPEN_SCANNER_TAB': {
      (async () => {
        const params = new URLSearchParams({ mode: 'tab' });
        if (message.blobUrl) params.set('blobUrl', message.blobUrl);
        if (sender.tab && sender.tab.id != null) {
          params.set('sourceTabId', String(sender.tab.id));
        }
        const url = chrome.runtime.getURL(`popup/popup.html?${params.toString()}`);
        await chrome.tabs.create({ url });
        sendResponse({ ok: true });
      })();
      return true;
    }

    default:
      return false;
  }
});
