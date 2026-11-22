/**
 * Runs only inside blob:https://1life.ph/* (and *.1life.ph) documents via match_origin_as_fallback.
 * 1) Provides direct same-origin blob fetch to the extension.
 * 2) Proactively caches the PDF bytes into extension IndexedDB.
 * 3) Renders a sleek, dismissible floating quick-launch pill in the corner.
 */
(() => {
  const href = String(window.location.href || '');
  if (!href.startsWith('blob:https://')) return;

  let isOneLife = false;
  try {
    const inner = new URL(href.slice('blob:'.length));
    const host = inner.hostname.toLowerCase();
    isOneLife = host === '1life.ph' || host.endsWith('.1life.ph');
  } catch {
    return;
  }
  if (!isOneLife) return;
  if (window.__oneLifePdfOverlayInstalled) return;
  window.__oneLifePdfOverlayInstalled = true;

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(chunks.join(''));
  }

  async function fetchCurrentBlobBase64() {
    const res = await fetch(href);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return arrayBufferToBase64(buf);
  }

  // Listen for direct fetch requests from background/popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'OVERLAY_FETCH_CURRENT_BLOB') return false;
    fetchCurrentBlobBase64()
      .then((base64) => sendResponse({ ok: true, base64 }))
      .catch((err) =>
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) })
      );
    return true;
  });

  // Proactively cache the PDF so opening the popup is instant
  (async () => {
    try {
      const base64 = await fetchCurrentBlobBase64();
      chrome.runtime.sendMessage({
        type: 'CACHE_BLOB_PDF',
        blobUrl: href,
        base64,
      });
    } catch {
      // Fallback mechanisms remain available
    }
  })();

  // Mount unobtrusive Shadow DOM quick-action pill
  function mountPill() {
    if (!document.documentElement) return;
    if (document.getElementById('onelife-soa-pill-host')) return;

    const host = document.createElement('div');
    host.id = 'onelife-soa-pill-host';
    host.style.cssText =
      'position:fixed;right:20px;bottom:20px;z-index:2147483647;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: linear-gradient(135deg, #0f766e, #0d5c63);
          color: #ffffff;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 999px;
          padding: 8px 12px 8px 14px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.01em;
          user-select: none;
        }
        .open-btn {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          background: transparent;
          border: none;
          color: inherit;
          font: inherit;
          cursor: pointer;
          padding: 0;
        }
        .open-btn:hover {
          opacity: 0.92;
        }
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #34d399;
          box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.25);
        }
        .close-btn {
          background: rgba(255, 255, 255, 0.14);
          border: none;
          color: #e2e8f0;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          line-height: 1;
          padding: 0;
          margin-left: 2px;
        }
        .close-btn:hover {
          background: rgba(255, 255, 255, 0.26);
          color: #ffffff;
        }
      </style>
      <div class="pill" role="region" aria-label="1Life SOA Diagnosis Filter">
        <button class="open-btn" id="open-scanner" title="Open 1Life SOA Diagnosis Filter">
          <span class="dot"></span>
          <span>1Life SOA Filter</span>
        </button>
        <button class="close-btn" id="dismiss-pill" title="Hide button">&times;</button>
      </div>
    `;

    shadow.getElementById('open-scanner').addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'OPEN_SCANNER_TAB',
        blobUrl: href,
      });
    });

    shadow.getElementById('dismiss-pill').addEventListener('click', () => {
      host.remove();
    });

    document.documentElement.appendChild(host);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountPill, { once: true });
  } else {
    mountPill();
  }
})();
