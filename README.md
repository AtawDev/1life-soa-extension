# 1Life SOA Diagnosis Filter

A privacy-first Chrome extension (Manifest V3) that scans Statement of Account (SOA) PDFs from `1life.ph`—or local PDF files—to separate patients with **No Diagnosis** or **₱0 Total Amount** from **Cleared / Diagnosed** patients, export clean filtered PDFs directly into Chrome's native PDF viewer, and convert flagged statements 1:1 into editable Microsoft Word (`.docx`) files.

> **Disclaimer:** This is an independent, unofficial utility built to streamline clinic billing review. It is not affiliated with, endorsed by, or officially connected to 1Life (`1life.ph`).

## Key Features

- **Automatic Detection:** Separates patients into **No Diagnosis**, **Zero Total Amount (₱0)**, and **Cleared / Diagnosed** groups.
- **Customizable Rules:** Configure custom no-diagnosis phrases, blank-impression handling, `N/A` / `None` / `Pending` matching, and zero-amount exclusion—plus per-patient manual overrides.
- **Lossless Filtered PDF Export:** Extracts exact vector pages for any category and opens the raw PDF in a new tab ready for printing (`Ctrl+P`) or saving.
- **1:1 Offline Word (`.docx`) Conversion:** Converts No Diagnosis patient pages into editable Microsoft Word documents while preserving borders, layout, and an editable Clinical Impression box.
- **CSV & Clipboard Export:** Export filtered summaries to CSV (with spreadsheet formula-injection protection) or copy tab-separated rows directly to the clipboard.
- **Local File Support:** Drag and drop or browse any saved `.pdf` file directly inside the popup or full-tab workspace.

## Privacy & Security

- **100% Local Processing:** All PDF parsing, filtering, PDF assembly, and `.docx` conversion run entirely offline inside your browser. Zero document data is ever uploaded or sent to external servers.
- **Strict Domain Scope:** Host access is restricted exclusively to `https://1life.ph/*` and `https://*.1life.ph/*` (no `<all_urls>` permission).
- **Shared-Workstation Hygiene:**
  - Exported PDFs are deleted from temporary extension storage as soon as they open.
  - Temporarily cached PDFs expire automatically after 2 hours and are wiped automatically on browser startup.
  - Click **Detection Rules (⚙) → Clear cached PDFs** at any time to wipe all locally cached PDFs immediately.
- **Hardened Extension Architecture:** Strict Manifest V3 CSP (`script-src 'self'; object-src 'none'; base-uri 'none'`), validated same-origin messaging, CSV formula-injection neutralization, and zero `innerHTML` DOM sinks.

See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

## Installation (Unpacked / Development)

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this project folder.
5. Open a Statement of Account PDF on `1life.ph` and click the **1Life SOA Filter** toolbar icon (or the floating corner button).

## Packaging for Chrome Web Store

When building a release `.zip`, include **only** the runtime extension files:

- `manifest.json`
- `background.js`
- `content/`
- `icons/`
- `lib/`
- `popup/`
- `shared/`
- `viewer/`

Exclude `.git/`, `README.md`, `PRIVACY.md`, `CHROMEWEBSTORE.md`, test files, and any local `.pdf`/`.docx`/`.csv`/`.zip`/`.pem` files. See [CHROMEWEBSTORE.md](CHROMEWEBSTORE.md) for store listing metadata, permission justifications, and the pre-publish review checklist.

## Third-Party Libraries

All libraries are bundled locally in `lib/` (no remote scripts or CDNs):

- **[Mozilla PDF.js](https://mozilla.github.io/pdf.js/)** (`lib/pdf.min.mjs`, `lib/pdf.worker.min.mjs`) — Apache License 2.0
- **[pdf-lib](https://pdf-lib.js.org/)** (`lib/pdf-lib.min.js`) — MIT License
