/**
 * ISOLATED-world bridge script on https://1life.ph/* (document_start).
 * Bridges intercepted PDF Blobs from MAIN world to the extension service worker.
 */
(() => {
  if (window.__oneLifeSoaBridgeInstalled) return;
  window.__oneLifeSoaBridgeInstalled = true;

  const CHANNEL = '__1LIFE_SOA_EXT_V1__';
  const PROACTIVE_CACHE_LIMIT = 25 * 1024 * 1024; // 25 MB
  const pendingRequests = new Map();
  let reqSeq = 0;

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(chunks.join(''));
  }

  function requestBufferFromMain(blobUrl, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const requestId = `req_${++reqSeq}_${Date.now()}`;
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error('Timed out waiting for MAIN-world blob response'));
      }, timeoutMs);

      pendingRequests.set(requestId, { resolve, reject, timer });

      window.postMessage(
        {
          channel: CHANNEL,
          type: 'REQUEST_PDF_BUFFER',
          requestId,
          blobUrl,
        },
        window.location.origin
      );
    });
  }

  async function fetchBlobBase64(blobUrl) {
    // 1. Ask MAIN world (uses preserved Blob reference first, then fetch)
    try {
      const buffer = await requestBufferFromMain(blobUrl);
      return arrayBufferToBase64(buffer);
    } catch {
      // 2. Fallback: fetch directly from isolated content script (same origin)
      const res = await fetch(blobUrl);
      if (!res.ok) throw new Error(`Failed to fetch blob: HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      return arrayBufferToBase64(buffer);
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL) return;

    if (msg.type === 'PDF_BUFFER_RESPONSE') {
      const entry = pendingRequests.get(msg.requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pendingRequests.delete(msg.requestId);
      if (msg.ok && msg.buffer) {
        entry.resolve(msg.buffer);
      } else {
        entry.reject(new Error(msg.error || 'Failed to retrieve PDF buffer'));
      }
      return;
    }

    if (msg.type === 'PDF_BLOB_CAPTURED' && msg.blobUrl) {
      try {
        chrome.runtime.sendMessage({
          type: 'REGISTER_BLOB_META',
          blobUrl: msg.blobUrl,
          size: msg.size || 0,
        });
      } catch {
        // Ignore if extension reloaded
      }

      // Proactively cache PDF bytes into IndexedDB so it stays accessible
      // even if the user closes the 1life.ph tab or the page revokes the blob URL.
      if (!msg.size || msg.size <= PROACTIVE_CACHE_LIMIT) {
        try {
          const base64 = await fetchBlobBase64(msg.blobUrl);
          chrome.runtime.sendMessage({
            type: 'CACHE_BLOB_PDF',
            blobUrl: msg.blobUrl,
            base64,
          });
        } catch {
          // Non-fatal; on-demand fetch remains available
        }
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'BRIDGE_FETCH_BLOB' || !message.blobUrl) {
      return false;
    }

    fetchBlobBase64(message.blobUrl)
      .then((base64) => sendResponse({ ok: true, base64 }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err && err.message ? err.message : String(err),
        })
      );
    return true; // Async response
  });
})();
