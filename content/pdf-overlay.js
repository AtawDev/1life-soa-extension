/**
 * Runs only inside blob:https://1life.ph/* (and *.1life.ph) documents via match_origin_as_fallback.
 * 1) Provides direct same-origin blob fetch to the extension.
 * 2) Proactively caches the PDF bytes into extension IndexedDB.
 * 3) Renders a sleek, dismissible floating quick-launch pill in the corner.
 */
(() => {
  const ONELIFE_REFERENCE_URL = 'https://1life.ph';
  const ONELIFE_DOMAIN = '1life.ph';
  const MAX_BLOB_BYTES = 60 * 1024 * 1024; // 60 MB safety cap

  const href = String(window.location.href || '');
  if (!href.startsWith('blob:https://')) return;

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

  if (!isOneLifeOriginUrl(href.slice('blob:'.length))) return;
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
    if (buf.byteLength > MAX_BLOB_BYTES) {
      throw new Error('PDF exceeds maximum allowed size (60 MB)');
    }
    return arrayBufferToBase64(buf);
  }

  // Listen for direct fetch requests from background/popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (!msg || msg.type !== 'OVERLAY_FETCH_CURRENT_BLOB') return false;
    (async () => {
      try {
        const base64 = await fetchCurrentBlobBase64();
        sendResponse({ ok: true, base64 });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  });

  // Proactively cache the PDF so opening the popup is instant
  (async () => {
    try {
      const base64 = await fetchCurrentBlobBase64();
      await chrome.runtime.sendMessage({
        type: 'CACHE_BLOB_PDF',
        blobUrl: href,
        base64,
      });
    } catch {
      // Fallback mechanisms remain available
    }
  })();

  // Mount unobtrusive Shadow DOM quick-action pill (constructed safely without innerHTML)
  function mountPill() {
    if (!document.documentElement) return;
    if (document.getElementById('onelife-soa-pill-host')) return;

    const host = document.createElement('div');
    host.id = 'onelife-soa-pill-host';
    host.style.cssText =
      'position:fixed;right:20px;bottom:20px;z-index:2147483647;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;';

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: linear-gradient(135deg, #0f766e, #0d5c63);
        color: #ffffff;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 999px;
        padding: 6px 10px 6px 14px;
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
        min-height: 24px;
        background: transparent;
        border: none;
        border-radius: 999px;
        color: inherit;
        font: inherit;
        cursor: pointer;
        padding: 2px 4px;
      }
      .open-btn:hover {
        opacity: 0.92;
      }
      .open-btn:focus-visible,
      .close-btn:focus-visible {
        outline: 2px solid #ffffff;
        outline-offset: 2px;
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
        min-width: 24px;
        min-height: 24px;
        border-radius: 50%;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        line-height: 1;
        padding: 0;
        margin-left: 2px;
      }
      .close-btn:hover {
        background: rgba(255, 255, 255, 0.26);
        color: #ffffff;
      }
      @media print {
        :host,
        .pill {
          display: none !important;
        }
      }
    `;

    const pill = document.createElement('div');
    pill.className = 'pill';
    pill.setAttribute('role', 'region');
    pill.setAttribute('aria-label', '1Life SOA Diagnosis Filter');

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'open-btn';
    openBtn.id = 'open-scanner';
    openBtn.title = 'Open 1Life SOA Diagnosis Filter';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');

    const openLabel = document.createElement('span');
    openLabel.textContent = '1Life SOA Filter';

    openBtn.append(dot, openLabel);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'close-btn';
    closeBtn.id = 'dismiss-pill';
    closeBtn.title = 'Hide button';
    closeBtn.setAttribute('aria-label', 'Hide 1Life SOA Filter button');
    closeBtn.textContent = '\u00d7';

    pill.append(openBtn, closeBtn);
    shadow.append(style, pill);

    openBtn.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({
          type: 'OPEN_SCANNER_TAB',
          blobUrl: href,
        });
      } catch {
        // Ignore if extension context was reloaded
      }
    });

    closeBtn.addEventListener('click', () => {
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
