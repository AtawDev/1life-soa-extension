# Chrome Web Store Listing — 1Life SOA Diagnosis Filter

> Last Updated: 2026-11-24

## Store Listing

**Extension Name** [REQUIRED]
1Life SOA Diagnosis Filter

> **Trademark Note:** Before submitting publicly to the Chrome Web Store, confirm whether you have authorization to lead the title with "1Life". If publishing independently, consider renaming both `manifest.json` `"name"` and this listing to **SOA Diagnosis Filter for 1Life** to avoid trademark rejection under CWS impersonation policies.

**Short Description** [REQUIRED]
Filter 1Life Statement of Account PDFs by missing diagnosis or zero total amount, export clean PDFs, or convert to Word (.docx).

**Detailed Description** [REQUIRED]
Review 1Life Statement of Account PDFs in seconds by automatically separating patients with missing diagnoses or zero billing totals from cleared records, exporting filtered PDFs for printing, or converting flagged pages into editable Microsoft Word documents.

Key Features:
Automatically detects patients with No Diagnosis, blank Clinical Impression fields, or ₱0 Total Amount versus Cleared / Diagnosed records
Exports any group as a clean, print-ready PDF in a new browser tab without losing document quality
Converts No Diagnosis patient pages into editable Microsoft Word (.docx) files with preserved layout and an editable Clinical Impression area
Lets you customize detection phrases, toggle zero-amount or blank-field rules, and manually override individual patients
Supports searching by patient name, diagnosis, amount, or page number, plus copying lists or downloading CSV summaries
Also works with local Statement of Account PDF files via drag-and-drop

How to Use:
1. Open a Statement of Account PDF from 1life.ph in Chrome (or drop a saved PDF file into the extension).
2. Click the extension toolbar icon or the quick-launch button in the bottom-right corner of the PDF.
3. Review the detected No Diagnosis, Zero Amount, and Cleared counts and patient list.
4. Click an Export button to open a clean filtered PDF in a new tab, or click "No Diag → Word" to download an editable .docx file.

Privacy & Security:
All PDF scanning, filtering, and document conversion happens 100% locally on your device. No patient documents, billing figures, or personal information are ever uploaded, logged, or shared with external servers. Temporary browser cache clears automatically on restart, and you can wipe cached files anytime from Detection Rules.

Independent Utility Notice:
This extension is an independent productivity tool and is not affiliated with or endorsed by 1Life.

Support & Feedback:
Report issues or request improvements at https://github.com/AtawDev/1life-soa-extension/issues

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Filter 1Life Statement of Account PDFs by diagnosis status and total amount, and export filtered PDFs or editable Word documents locally.

**Primary Language** [REQUIRED]
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |

### Screenshot Notes
> **IMPORTANT — PHI Safety:** NEVER use real patient names, addresses, ages, or diagnoses in Chrome Web Store screenshots! Generate a synthetic sample Statement of Account PDF with clearly fictional names (e.g., "Juan Dela Cruz", "Maria Santos") before capturing screenshots.
- Screenshot 1: Extension popup showing synthetic patient counts (No Diagnosis, Zero Amount, Cleared) and filtered patient list.
- Screenshot 2: Full-tab workspace view with search filter and customizable Detection Rules drawer open.
- Screenshot 3: Exported filtered PDF opened cleanly in Chrome's PDF viewer alongside a converted Word document preview.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `tabs` | permissions | Required to detect open `blob:https://1life.ph/*` Statement of Account PDF tabs, display per-tab summary badges, allow switching between multiple open 1Life PDFs, and open exported filtered PDFs or the full-tab workspace in a new browser tab. |
| `scripting` | permissions | Required as a fallback to read a `blob:https://1life.ph/*` PDF from an already-open `https://1life.ph/*` tab if that tab was opened before the extension was installed or reloaded. Never executes remote code and only runs on `1life.ph` origins. |
| `storage` | permissions | Required to save the user's local Detection Rules preferences (custom no-diagnosis keywords, blank-field toggle, zero-amount toggle) on-device (`chrome.storage.local`) and track temporary tab badge metadata during the active browser session (`chrome.storage.session`). |
| `https://1life.ph/*`, `https://*.1life.ph/*` | host_permissions | Strictly scoped to `1life.ph` and its subdomains so the extension can capture Statement of Account PDF blobs generated by the 1Life portal and show a quick-launch filter button on 1Life PDF tabs. The extension never accesses any other website. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No (zero data is collected by the developer or transmitted off the user's device; all Statement of Account PDFs are processed exclusively locally in the user's browser).

> **Reviewer Clarification:** Because the extension locally reads Statement of Account PDFs containing patient names, clinical impressions, and billing totals strictly on the user's device without transmitting any data to external servers, verify the CWS Dashboard "Limited Use" and "No off-device collection" disclosures align with [PRIVACY.md](PRIVACY.md).

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | Processed locally only | No | Displaying patient names inside the popup for local filtering | No |
| Health info | Processed locally only | No | Reading Clinical Impression text locally to filter No Diagnosis vs Cleared | No |
| Financial info | Processed locally only | No | Reading Total Amount locally to detect ₱0 Total records | No |
| Authentication info | No | No | N/A | No |
| Personal communications | No | No | N/A | No |
| Location | No | No | N/A | No |
| Web history | No | No | N/A | No |
| User activity | No | No | N/A | No |
| Website content | Processed locally only (1life.ph PDFs only) | No | Filtering and converting Statement of Account PDFs locally | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
`https://github.com/AtawDev/1life-soa-extension/blob/main/PRIVACY.md`
*(Confirm the repository is public or publish `PRIVACY.md` via GitHub Pages so the Chrome Web Store review team can load the URL without signing in.)*

## Distribution

**Visibility**: Public
**Regions**: All regions (or Philippines if restricting distribution)

## Developer Info

**Publisher Name** [REQUIRED]
AtawDev

**Contact Email** [REQUIRED]
*(Fill in a monitored developer email in the Chrome Web Store Developer Dashboard before submitting.)*

**Support URL / Email** [RECOMMENDED]
https://github.com/AtawDev/1life-soa-extension/issues

**Homepage URL** [RECOMMENDED]
https://github.com/AtawDev/1life-soa-extension

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.4.2 | 2026-11-24 | Hardened origin and message validation, added CSV formula-injection protection and XML 1.0 sanitization, persisted service worker tab state, added automatic startup cache cleanup and 1-click "Clear cached PDFs" control, removed all `innerHTML` usage, improved keyboard/screen-reader accessibility, shortened manifest description to <= 132 chars, and added public release docs. | Draft |
| 1.4.1 | 2026-11-22 | Initial public repository commit with PDF filtering, raw PDF export, and 1:1 Word (.docx) conversion. | Draft |

## Review Notes

### Known Issues / Limitations
- Only works on PDFs containing a selectable text layer; image-only scanned PDFs show a warning banner.
- Requires Chrome 119+ for `match_origin_as_fallback` support on `blob:https://1life.ph/*` tabs.
- When packaging the submission ZIP, exclude `.git/`, `README.md`, `PRIVACY.md`, `CHROMEWEBSTORE.md`, and any local test/document files.

### Pre-Publish Checklist
- [x] `manifest_version: 3`, description <= 132 characters (128 chars)
- [x] All icon files exist with exact pixel dimensions (`16x16`, `32x32`, `48x48`, `128x128`)
- [x] Zero `eval()`, `new Function()`, remote scripts, or `innerHTML` sinks
- [x] `host_permissions` tightly scoped to `1life.ph` (no `<all_urls>`)
- [ ] Add at least 1 screenshot (1280×800 or 640×400) using **synthetic/fictional** patient data only
- [ ] Verify public Privacy Policy URL returns HTTP 200 without login
- [ ] Fill in monitored Contact Email in Chrome Developer Dashboard
