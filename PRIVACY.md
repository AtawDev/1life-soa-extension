# Privacy Policy — 1Life SOA Diagnosis Filter

**Last updated:** 2026-11-24

1Life SOA Diagnosis Filter is designed to run **100% locally inside your browser**. Because Statement of Account (SOA) documents may contain sensitive patient and billing information, this extension never transmits, uploads, logs, or shares any document contents or personal data off your device.

## What Data Is Processed Locally

When you open a Statement of Account PDF on `https://1life.ph` (or load a local `.pdf` file into the extension), the extension reads the PDF locally in your browser to:

1. Extract patient names, age/sex, clinical impressions, and total amounts for on-screen filtering.
2. Build filtered PDFs, CSV exports, or Word (`.docx`) conversions on your device when you click an export button.
3. Save your Detection Rules preferences (e.g., whether to exclude zero-amount patients, treat blank impressions as No Diagnosis, and custom keyword phrases) in local browser storage (`chrome.storage.local`).

## Network Requests & Off-Device Transmission

- **None.** This extension makes **zero** external network requests.
- No analytics, telemetry, crash reporting, tracking pixels, or third-party APIs are used.
- Your preferences are stored in local-only storage (`chrome.storage.local`), not synced to cloud servers (`chrome.storage.sync` is not used).

## Temporary Local Caching & Automatic Deletion

To let you scan an open `blob:https://1life.ph/...` PDF even if the originating portal tab is closed or its temporary URL expires, the extension temporarily caches captured PDF bytes inside your browser's local extension storage (IndexedDB):

- **Captured PDFs** are capped at 8 recent files and expire automatically after **2 hours**.
- **Exported PDFs** are deleted from local storage immediately after opening in Chrome's PDF viewer (or expire after **15 minutes**).
- **Automatic startup cleanup:** All cached PDFs are automatically cleared whenever Chrome starts up.
- **One-click manual wipe:** You can immediately delete all cached PDFs at any time by opening the extension's **Detection Rules** (gear icon) and clicking **Clear cached PDFs**.

## Third-Party Services & Data Sharing

- This extension does not use any third-party services.
- No data is sold, transferred, or shared with any third party.

## Disclaimer

1Life SOA Diagnosis Filter is an independent utility and is not affiliated with, endorsed by, or officially connected to 1Life.

## Changes to This Policy

If the extension's data handling practices ever change, this policy will be updated with a new effective date before the corresponding extension update is published.

## Contact

For privacy questions or security reports, please open an issue at:
https://github.com/AtawDev/1life-soa-extension/issues
