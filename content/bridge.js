/**
 * ISOLATED-world bridge script on https://1life.ph/* (document_start).
 * Bridges intercepted PDF Blobs from MAIN world to the extension service worker.
 */
(() => {
  if (window.__oneLifeSoaBridgeInstalled) return;
  window.__oneLifeSoaBridgeInstalled = true;

  const CHANNEL = '__1LIFE_SOA_EXT_V1__';
  const ONELIFE_REFERENCE_URL = 'https://1life.ph';
  const ONELIFE_DOMAIN = '1life.ph';
  const MAX_BLOB_BYTES = 60 * 1024 * 1024; // 60 MB safety cap
  const PROACTIVE_CACHE_LIMIT = 25 * 1024 * 1024; // 25 MB
  const pendingRequests = new Map();
  let reqSeq = 0;

  function isOneLifeOriginUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    try {
      if ('Origin' in globalThis && typeof globalThis.Origin?.from === 'function') {
        const candidateOrigin = globalThis.Origin.from(url);
        if (candidateOrigin.opaque) return false;
        return candidateOrigin.isSameSite(globalThis.Origin.from(ONELIFE_REFERENCE_URL));
      }
      const parsed = new URL(url);
      if (parsed.origin === 'null' || parsed.protocol !== 'https:') return false;
      const host = parsed.hostname.toLowerCase();
      return host === ONELIFE_DOMAIN || host.endsWith(`.${ONELIFE_DOMAIN}`);
    } catch {
      return false;
    }
  }

  function isOneLifeBlobUrl(url) {
    if (typeof url !== 'string' || !url.startsWith('blob:https://')) return false;
    return isOneLifeOriginUrl(url.slice('blob:'.length));
  }

  function isSameOriginMessage(event) {
    if (event.source !== window) return false;
    try {
      if ('Origin' in globalThis && typeof globalThis.Origin?.from === 'function') {
        const selfOrigin = globalThis.Origin.from(self);
        if (selfOrigin.opaque) return false;
        let senderOrigin;
        try {
          senderOrigin = globalThis.Origin.from(event);
        } catch {
          senderOrigin = globalThis.Origin.from(event.origin);
        }
        return !senderOrigin.opaque && senderOrigin.isSameOrigin(selfOrigin);
      }
      const selfUrl = new URL(window.location.href);
      const senderUrl = new URL(event.origin);
      return selfUrl.origin !== 'null' && senderUrl.origin === selfUrl.origin;
    } catch {
      return false;
    }
  }

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
      if (!window.location.origin || window.location.origin === 'null') {
        reject(new Error('Opaque page origin'));
        return;
      }
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
    if (!isOneLifeBlobUrl(blobUrl)) {
      throw new Error('Blocked non-1Life blob URL');
    }
    // 1. Ask MAIN world (uses preserved Blob reference first, then fetch)
    try {
      const buffer = await requestBufferFromMain(blobUrl);
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_BLOB_BYTES) {
        throw new Error('Invalid or oversized PDF buffer');
      }
      return arrayBufferToBase64(buffer);
    } catch {
      // 2. Fallback: fetch directly from isolated content script (same origin)
      const res = await fetch(blobUrl);
      if (!res.ok) throw new Error(`Failed to fetch blob: HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_BLOB_BYTES) {
        throw new Error('PDF exceeds maximum allowed size');
      }
      return arrayBufferToBase64(buffer);
    }
  }

  window.addEventListener('message', async (event) => {
    if (!isSameOriginMessage(event)) return;
    if (!isOneLifeOriginUrl(window.location.href)) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL) return;

    if (msg.type === 'PDF_BUFFER_RESPONSE') {
      const entry = pendingRequests.get(msg.requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pendingRequests.delete(msg.requestId);
      if (msg.ok && msg.buffer instanceof ArrayBuffer) {
        entry.resolve(msg.buffer);
      } else {
        entry.reject(new Error(msg.error || 'Failed to retrieve PDF buffer'));
      }
      return;
    }

    if (msg.type === 'PDF_BLOB_CAPTURED' && isOneLifeBlobUrl(msg.blobUrl)) {
      try {
        await chrome.runtime.sendMessage({
          type: 'REGISTER_BLOB_META',
          blobUrl: msg.blobUrl,
          size: Number(msg.size) || 0,
        });
      } catch {
        // Ignore if extension reloaded
      }

      // Proactively cache PDF bytes into IndexedDB so it stays accessible
      // even if the user closes the 1life.ph tab or the page revokes the blob URL.
      const size = Number(msg.size) || 0;
      if (size >= 0 && size <= PROACTIVE_CACHE_LIMIT) {
        try {
          const base64 = await fetchBlobBase64(msg.blobUrl);
          await chrome.runtime.sendMessage({
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (!message || message.type !== 'BRIDGE_FETCH_BLOB' || !isOneLifeBlobUrl(message.blobUrl)) {
      return false;
    }

    (async () => {
      try {
        const base64 = await fetchBlobBase64(message.blobUrl);
        sendResponse({ ok: true, base64 });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err && err.message ? err.message : String(err),
        });
      }
    })();
    return true; // Async response
  });
})();
