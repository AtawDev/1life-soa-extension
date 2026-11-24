/**
 * MAIN-world script on https://1life.ph/* (document_start).
 * Passively tracks PDF Blobs passed to URL.createObjectURL so the extension can
 * always read blob:https://1life.ph/... PDFs even if the page revokes them.
 */
(() => {
  if (window.__oneLifeSoaBlobHookInstalled) return;
  window.__oneLifeSoaBlobHookInstalled = true;

  const CHANNEL = '__1LIFE_SOA_EXT_V1__';
  const MAX_BLOBS = 8;
  const MAX_BLOB_BYTES = 60 * 1024 * 1024; // 60 MB safety cap
  const trackedBlobs = new Map(); // blobUrl -> { blob, size, createdAt }

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

  function isSameOriginBlobUrl(url) {
    if (typeof url !== 'string' || !url.startsWith('blob:https://')) return false;
    try {
      const inner = url.slice('blob:'.length);
      if ('Origin' in globalThis && typeof globalThis.Origin?.from === 'function') {
        const selfOrigin = globalThis.Origin.from(self);
        const blobOrigin = globalThis.Origin.from(inner);
        return !selfOrigin.opaque && !blobOrigin.opaque && blobOrigin.isSameOrigin(selfOrigin);
      }
      const selfUrl = new URL(window.location.href);
      const innerUrl = new URL(inner);
      return selfUrl.origin !== 'null' && innerUrl.origin === selfUrl.origin;
    } catch {
      return false;
    }
  }

  function pruneMap() {
    while (trackedBlobs.size > MAX_BLOBS) {
      const oldestKey = trackedBlobs.keys().next().value;
      if (oldestKey !== undefined) {
        trackedBlobs.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  async function inspectAndTrack(url, blob) {
    try {
      if (!blob || !(blob instanceof Blob)) return;
      if (!isSameOriginBlobUrl(url)) return;
      if (blob.size < 5 || blob.size > MAX_BLOB_BYTES) return;
      if (!window.location.origin || window.location.origin === 'null') return;

      const mime = (blob.type || '').toLowerCase();
      let isPdf = mime.includes('pdf');

      if (!isPdf) {
        // Check PDF magic bytes (%PDF-) within the first 1024 bytes
        const headBuf = await blob.slice(0, Math.min(1024, blob.size)).arrayBuffer();
        const bytes = new Uint8Array(headBuf);
        for (let i = 0; i <= bytes.length - 5; i++) {
          if (
            bytes[i] === 0x25 &&
            bytes[i + 1] === 0x50 &&
            bytes[i + 2] === 0x44 &&
            bytes[i + 3] === 0x46 &&
            bytes[i + 4] === 0x2d
          ) {
            isPdf = true;
            break;
          }
        }
      }

      if (!isPdf) return;

      trackedBlobs.set(url, {
        blob,
        size: blob.size,
        createdAt: Date.now(),
      });
      pruneMap();

      window.postMessage(
        {
          channel: CHANNEL,
          type: 'PDF_BLOB_CAPTURED',
          blobUrl: url,
          size: blob.size,
        },
        window.location.origin
      );
    } catch {
      // Never interfere with the host site
    }
  }

  const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function wrappedCreateObjectURL(obj) {
    const url = nativeCreateObjectURL(obj);
    try {
      if (obj instanceof Blob && typeof url === 'string' && url.startsWith('blob:')) {
        inspectAndTrack(url, obj);
      }
    } catch {
      // Ignore
    }
    return url;
  };

  // Respond to isolated bridge requests for PDF binary buffers
  window.addEventListener('message', async (event) => {
    if (!isSameOriginMessage(event)) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.type !== 'REQUEST_PDF_BUFFER') return;
    if (!window.location.origin || window.location.origin === 'null') return;

    const { requestId, blobUrl } = msg;
    if (typeof requestId !== 'string' || !isSameOriginBlobUrl(blobUrl)) return;

    try {
      let buffer = null;
      const cached = trackedBlobs.get(blobUrl);
      if (cached && cached.blob) {
        if (cached.blob.size > MAX_BLOB_BYTES) {
          throw new Error('PDF exceeds maximum allowed size');
        }
        buffer = await cached.blob.arrayBuffer();
      } else {
        const res = await fetch(blobUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buffer = await res.arrayBuffer();
      }

      if (!buffer || buffer.byteLength > MAX_BLOB_BYTES) {
        throw new Error('PDF exceeds maximum allowed size');
      }

      window.postMessage(
        {
          channel: CHANNEL,
          type: 'PDF_BUFFER_RESPONSE',
          requestId,
          ok: true,
          buffer,
        },
        window.location.origin,
        [buffer]
      );
    } catch (err) {
      window.postMessage(
        {
          channel: CHANNEL,
          type: 'PDF_BUFFER_RESPONSE',
          requestId,
          ok: false,
          error: err && err.message ? err.message : String(err),
        },
        window.location.origin
      );
    }
  });
})();
