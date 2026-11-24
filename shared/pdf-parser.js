/**
 * Spatial PDF text parser & Clinical Impression classifier for 1Life Statement of Account PDFs.
 * Pure ES module — runs cleanly in Chrome Extension pages and Node.js tests.
 */

export const DEFAULT_FILTER_OPTIONS = {
  treatBlankAsNoDiagnosis: true,
  noDiagnosisPhrases: ['no diagnosis'],
  includeNoneAndNA: false,
  excludeZeroTotalAmount: true,
};

const STOP_SECTION_REGEX =
  /^(?:medical\s+procedures?|procedures?|medicines?|medications?|pharmacy|laboratory|diagnostics?|services?|item\s+description|sub-?\s*total|discount|total\s+amount|grand\s+total|prepared\s+by|billing\s+staff|statement\s+of\s+account|patient\s+signature|received\s+by)\b/i;

const INLINE_STOP_REGEX =
  /\b(?:medical\s+procedures?|medicines?|sub-?\s*total|total\s+amount|prepared\s+by|billing\s+staff)\b/i;

const PRICE_END_REGEX = /\b\d{1,3}(?:,\d{3})*\.\d{2}\s*$/;

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanSpaces(str) {
  return String(str || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u00ad\u2010\u2011]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reconstruct visually ordered text lines from pdf.js getTextContent() items
 * using 2D (x, y) coordinates.
 */
export function groupItemsIntoLines(rawItems) {
  const items = [];
  for (const raw of rawItems || []) {
    if (!raw || typeof raw.str !== 'string') continue;
    const text = raw.str.replace(/\u00a0/g, ' ').replace(/[\u00ad\u2010\u2011]/g, '-');
    if (!text.trim()) continue;
    const tr = raw.transform || [1, 0, 0, 1, 0, 0];
    const x = Number(tr[4]) || 0;
    const y = Number(tr[5]) || 0;
    const height = Math.abs(Number(raw.height) || Number(tr[3]) || 10);
    const width = Math.abs(Number(raw.width) || 0);
    items.push({ str: text, x, y, width, height });
  }

  // Sort top-to-bottom (higher Y first in PDF coordinate space), then left-to-right
  items.sort((a, b) => {
    if (Math.abs(b.y - a.y) > 2.5) return b.y - a.y;
    return a.x - b.x;
  });

  const lines = [];
  for (const item of items) {
    let targetLine = null;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      const candidate = lines[i];
      const tol = Math.max(3.0, Math.min(item.height, candidate.height) * 0.45);
      if (Math.abs(candidate.y - item.y) <= tol) {
        targetLine = candidate;
        break;
      }
    }

    if (!targetLine) {
      lines.push({
        y: item.y,
        height: item.height,
        items: [item],
      });
    } else {
      targetLine.items.push(item);
      // Maintain average baseline Y
      targetLine.y =
        (targetLine.y * (targetLine.items.length - 1) + item.y) / targetLine.items.length;
    }
  }

  // Sort lines top-to-bottom and items within each line left-to-right
  lines.sort((a, b) => b.y - a.y);

  return lines.map((line) => {
    line.items.sort((a, b) => a.x - b.x);
    let combined = '';
    for (let i = 0; i < line.items.length; i++) {
      const curr = line.items[i];
      if (i === 0) {
        combined = curr.str;
      } else {
        const prev = line.items[i - 1];
        const prevRight = prev.x + prev.width;
        const gap = curr.x - prevRight;
        const needsSpace =
          gap > 2.0 && !combined.endsWith(' ') && !curr.str.startsWith(' ');
        combined += (needsSpace ? ' ' : '') + curr.str;
      }
    }
    return {
      y: line.y,
      height: line.height,
      xMin: line.items[0]?.x ?? 0,
      items: line.items,
      text: cleanSpaces(combined),
    };
  });
}

function joinItemsText(items) {
  if (!items || items.length === 0) return '';
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let out = '';
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i];
    if (i === 0) {
      out = curr.str;
    } else {
      const prev = sorted[i - 1];
      const gap = curr.x - (prev.x + prev.width);
      const needsSpace = gap > 2.0 && !out.endsWith(' ') && !curr.str.startsWith(' ');
      out += (needsSpace ? ' ' : '') + curr.str;
    }
  }
  return cleanSpaces(out);
}

/**
 * Extract structured Statement of Account fields from a single page's reconstructed lines.
 */
export function extractPageFields(lines, pageNumber) {
  const fullText = lines.map((l) => l.text).join('\n');

  const hasSoaHeader = /statement\s+of\s+account/i.test(fullText);
  const hasClinicalLabel = /clinical\s*impressions?/i.test(fullText);
  const hasNameAgeHeader =
    /\bname\b/i.test(fullText) && /\bage\s*\/?\s*sex\b/i.test(fullText);

  const isPatientStart = hasSoaHeader || hasClinicalLabel || hasNameAgeHeader;

  // 1. Date (ignore "Date of Birth")
  let statementDate = '';
  for (const line of lines) {
    if (/date\s+of\s+birth/i.test(line.text)) continue;
    const m = line.text.match(/\bDate\s*:\s*(.+)$/i);
    if (m && m[1]) {
      statementDate = cleanSpaces(m[1]);
      break;
    }
  }

  // 2. Patient Name & Age/Sex using column-aware X bounds
  let patientName = '';
  let ageSex = '';

  const nameHeaderIdx = lines.findIndex(
    (l) =>
      /\bname\b/i.test(l.text) &&
      (/\bage\b/i.test(l.text) || /\bcivil\s+status\b/i.test(l.text) || /^name\s*:?$/i.test(l.text))
  );

  if (nameHeaderIdx !== -1) {
    const headerLine = lines[nameHeaderIdx];

    // Check inline "Name: Foo Bar" first
    const inlineMatch = headerLine.text.match(
      /^Name\s*:\s*(.+?)(?:\s+(?:Age|Sex|Civil\s+Status)\b|$)/i
    );
    if (inlineMatch && inlineMatch[1] && cleanSpaces(inlineMatch[1])) {
      patientName = cleanSpaces(inlineMatch[1]);
    } else {
      // Find column X boundaries from the header line
      const ageItem = headerLine.items.find((it) => /\bage\b/i.test(it.str));
      const civilItem = headerLine.items.find((it) => /\bcivil\b/i.test(it.str));

      const nameMaxX = ageItem ? ageItem.x - 5 : civilItem ? civilItem.x - 5 : Infinity;
      const ageMinX = ageItem ? ageItem.x - 6 : Infinity;
      const ageMaxX = civilItem ? civilItem.x - 5 : Infinity;

      // Read value line(s) right below Name header until Address / Contact / Clinical Impression
      const nameParts = [];
      const ageParts = [];
      for (let i = nameHeaderIdx + 1; i < Math.min(lines.length, nameHeaderIdx + 4); i++) {
        const valLine = lines[i];
        if (
          /^(?:address|contact\s+number|date\s+of\s+birth|clinical\s*impression|medical\s+procedures)/i.test(
            valLine.text
          ) ||
          /\baddress\b/i.test(valLine.text) && /\bcontact\s+number\b/i.test(valLine.text)
        ) {
          break;
        }
        const leftItems = valLine.items.filter((it) => it.x < nameMaxX);
        const midItems = valLine.items.filter((it) => it.x >= ageMinX && it.x < ageMaxX);

        const leftText = joinItemsText(leftItems);
        const midText = joinItemsText(midItems);

        if (leftText) nameParts.push(leftText);
        if (midText) ageParts.push(midText);
        // Typically 1 row is enough unless long name wrapped
        if (nameParts.length > 0 && ageParts.length > 0) break;
      }

      patientName = cleanSpaces(nameParts.join(' '));
      ageSex = cleanSpaces(ageParts.join(' '));
    }
  }

  // Fallback inline "Patient Name:" or "Name:"
  if (!patientName) {
    for (const line of lines) {
      const m = line.text.match(/^(?:Patient\s+)?Name\s*:\s*(.+)$/i);
      if (m && m[1]) {
        patientName = cleanSpaces(m[1].replace(/\b(?:Age\s*\/?\s*Sex|Civil\s+Status)\b.*$/i, ''));
        break;
      }
    }
  }

  // 3. Clinical Impression extraction
  let clinicalImpression = '';
  const ciLineIdx = lines.findIndex((l) => /clinical\s*impressions?\s*:?/i.test(l.text));

  if (ciLineIdx !== -1) {
    const ciLine = lines[ciLineIdx];
    const parts = [];

    // Check text on the same line after "Clinical Impression:"
    const afterLabel = ciLine.text.replace(/^.*?clinical\s*impressions?\s*:?\s*/i, '');
    const cleanedInline = cleanSpaces(
      afterLabel.split(INLINE_STOP_REGEX)[0].trim()
    );
    if (cleanedInline) {
      parts.push(cleanedInline);
    }

    // Collect subsequent lines until billing section / boundary
    let prevY = ciLine.y;
    for (let i = ciLineIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.text) continue;

      // Hard stop at known billing/footer headers
      if (STOP_SECTION_REGEX.test(line.text) || INLINE_STOP_REGEX.test(line.text)) {
        break;
      }

      // Stop if line looks like another patient header label
      if (/^(?:name|address|age\s*\/?\s*sex|contact\s+number|date\s+of\s+birth)\b/i.test(line.text)) {
        break;
      }

      // Guard against jumping across a huge vertical gap into an unlabeled price row
      const verticalGap = prevY - line.y;
      if (verticalGap > 80 && PRICE_END_REGEX.test(line.text)) {
        break;
      }
      if (verticalGap > 140) {
        break;
      }

      parts.push(line.text);
      prevY = line.y;

      // Safety cap: clinical impression box won't span > 8 wrapped lines
      if (parts.length >= 8) break;
    }

    clinicalImpression = cleanSpaces(parts.join(' '));
  }

  // 4. Total Amount (supports 0, 0.0, 0.00, 2,525.60, ₱0.00, PHP 0, slight baseline offsets)
  const { totalAmount, totalAmountValue } = extractTotalAmount(lines);

  return {
    pageNumber,
    isPatientStart,
    hasClinicalLabel,
    patientName,
    ageSex,
    statementDate,
    clinicalImpression,
    totalAmount,
    totalAmountValue,
    textLength: fullText.length,
  };
}

/**
 * Parse a currency/numeric token from text (handles "0", "0.00", "2,525.60", "₱0.00", "PHP 0", "(0.00)").
 */
export function parseCurrencyAmount(rawText) {
  const text = cleanSpaces(rawText);
  if (!text) return null;

  const matches = Array.from(
    text.matchAll(
      /(?:₱|PHP|Php|P|\$)?\s*(\(?-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?)/g
    )
  );
  if (matches.length === 0) return null;

  const last = matches[matches.length - 1][1];
  const isParenNegative = last.startsWith('(') && last.endsWith(')');
  const numericStr = last.replace(/[(),]/g, '');
  let value = Number(numericStr);
  if (!Number.isFinite(value)) return null;
  if (isParenNegative && value > 0) value = -value;
  if (Object.is(value, -0)) value = 0;

  return {
    raw: last.replace(/[()]/g, ''),
    value,
  };
}

function extractTotalAmount(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!/\btotal\s+amount\b/i.test(line.text)) continue;

    // 1) Look for amount on the same line to the right of "TOTAL AMOUNT"
    const afterLabel = line.text.replace(/^.*?\btotal\s+amount\b\s*:?\s*/i, '');
    const inlineParsed = parseCurrencyAmount(afterLabel);
    if (inlineParsed) {
      return {
        totalAmount: inlineParsed.raw,
        totalAmountValue: inlineParsed.value,
      };
    }

    // 2) Fallback: right-aligned value slightly shifted vertically onto an adjacent line
    const labelItem = line.items.find((it) => /total|amount/i.test(it.str));
    const labelRightX = labelItem ? labelItem.x + labelItem.width : 0;

    for (const offset of [-1, 1]) {
      const adj = lines[i + offset];
      if (!adj) continue;
      if (Math.abs(adj.y - line.y) > 14) continue;
      const rightItems = adj.items.filter((it) => it.x > labelRightX);
      const rightText = joinItemsText(rightItems);
      if (
        rightText &&
        /^(?:₱|PHP|Php|P|\$)?\s*\(?-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?$/i.test(rightText)
      ) {
        const adjParsed = parseCurrencyAmount(rightText);
        if (adjParsed) {
          return {
            totalAmount: adjParsed.raw,
            totalAmountValue: adjParsed.value,
          };
        }
      }
    }
  }

  return { totalAmount: '', totalAmountValue: null };
}

/**
 * Classify a Clinical Impression string into:
 *  - 'no_diagnosis': matches "no diagnosis" (or configured phrases) or blank/empty
 *  - 'cleared': has a diagnosis or cleared status
 */
export function classifyImpression(rawImpression, options = DEFAULT_FILTER_OPTIONS) {
  const opts = { ...DEFAULT_FILTER_OPTIONS, ...(options || {}) };
  const text = cleanSpaces(rawImpression);
  const strippedPunct = text.replace(/^[\s\-–—_.:;/\\|]+|[\s\-–—_.:;/\\|]+$/g, '');

  // Case 1: Blank / empty / punctuation-only
  if (!strippedPunct) {
    if (opts.treatBlankAsNoDiagnosis) {
      return {
        category: 'no_diagnosis',
        reason: 'Blank / Empty',
      };
    }
    return {
      category: 'cleared',
      reason: 'Blank (not flagged)',
    };
  }

  // Case 2: Matches configured "No Diagnosis" phrases (default: ["no diagnosis"])
  const rawPhrases = Array.isArray(opts.noDiagnosisPhrases)
    ? opts.noDiagnosisPhrases
    : ['no diagnosis'];
  const phrases = rawPhrases
    .slice(0, 30)
    .map((p) => cleanSpaces(p).slice(0, 120))
    .filter(Boolean);

  for (const phrase of phrases) {
    const pattern = new RegExp(
      `\\b${escapeRegExp(phrase).replace(/\s+/g, '\\s+')}\\b`,
      'i'
    );
    if (pattern.test(text)) {
      return {
        category: 'no_diagnosis',
        reason: `Matched "${phrase}"`,
      };
    }
  }

  // Case 3: Optional N/A / None / Pending matching
  if (opts.includeNoneAndNA) {
    if (/^(?:n\/?a|none|nil|null|pending|tbd|unspecified|for\s+diagnosis)$/i.test(strippedPunct)) {
      return {
        category: 'no_diagnosis',
        reason: `Matched "${strippedPunct}"`,
      };
    }
  }

  // Case 4: Has diagnosis or cleared
  const isExplicitlyCleared = /\bcleared\b/i.test(text);
  return {
    category: 'cleared',
    reason: isExplicitlyCleared ? 'Cleared' : 'Has Diagnosis',
  };
}

/**
 * Full patient classification combining Clinical Impression and Total Amount.
 * Patients with No Diagnosis OR Total Amount = 0 are NOT included in Cleared.
 */
export function classifyPatient(patient, options = DEFAULT_FILTER_OPTIONS) {
  const opts = { ...DEFAULT_FILTER_OPTIONS, ...(options || {}) };
  const impResult = classifyImpression(patient.clinicalImpression, opts);

  const hasNoDiagnosis = impResult.category === 'no_diagnosis';
  const totalVal =
    typeof patient.totalAmountValue === 'number' && Number.isFinite(patient.totalAmountValue)
      ? patient.totalAmountValue
      : null;
  const hasZeroAmount =
    Boolean(opts.excludeZeroTotalAmount) &&
    totalVal !== null &&
    Math.abs(totalVal) < 0.0001;

  const isCleared = !hasNoDiagnosis && !hasZeroAmount;

  let category = 'cleared';
  let reason = impResult.reason;

  if (hasNoDiagnosis && hasZeroAmount) {
    category = 'both';
    reason = `${impResult.reason} & Total Amount is 0`;
  } else if (hasNoDiagnosis) {
    category = 'no_diagnosis';
    reason = impResult.reason;
  } else if (hasZeroAmount) {
    category = 'zero_amount';
    reason = 'Total Amount is 0';
  }

  return {
    hasNoDiagnosis,
    hasZeroAmount,
    isCleared,
    category,
    reason,
    impressionReason: impResult.reason,
  };
}

/**
 * Re-classify an existing list of parsed patients without re-parsing the PDF bytes.
 */
export function reclassifyPatients(patients, options = DEFAULT_FILTER_OPTIONS) {
  return patients.map((p) => {
    const classification = classifyPatient(p, options);
    return {
      ...p,
      ...classification,
    };
  });
}

/**
 * Parse all pages of a PDF Uint8Array and group into patient records.
 *
 * @param {Uint8Array} pdfBytes Raw PDF bytes (a fresh copy is sliced for pdf.js)
 * @param {object} pdfjsLib Imported pdfjs-dist module
 * @param {object} options Classification options
 * @param {function} [onProgress] Optional callback({ current, total })
 */
export async function parseSoaPdf(
  pdfBytes,
  pdfjsLib,
  options = DEFAULT_FILTER_OPTIONS,
  onProgress = null
) {
  // Always pass a fresh copy so pdf.js worker transfer never detaches caller's buffer!
  const bytesCopy = pdfBytes instanceof Uint8Array ? pdfBytes.slice() : new Uint8Array(pdfBytes);

  const loadingTask = pdfjsLib.getDocument({
    data: bytesCopy,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: pdfjsLib.VerbosityLevel ? pdfjsLib.VerbosityLevel.ERRORS : 0,
  });

  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;

  const pageResults = [];
  let totalTextChars = 0;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const lines = groupItemsIntoLines(textContent.items);
    const extracted = extractPageFields(lines, pageNum);
    totalTextChars += extracted.textLength;
    pageResults.push(extracted);

    if (typeof onProgress === 'function') {
      onProgress({ current: pageNum, total: numPages });
    }
  }

  try {
    await pdfDoc.destroy();
  } catch {
    // Ignore cleanup errors
  }

  // Step 1: Group pages into patient records first (so multi-page SOAs inherit TOTAL AMOUNT from final page)
  const rawPatients = [];
  for (const page of pageResults) {
    if (page.isPatientStart || rawPatients.length === 0) {
      rawPatients.push({
        index: rawPatients.length + 1,
        patientName: page.patientName || `Patient (Page ${page.pageNumber})`,
        ageSex: page.ageSex,
        statementDate: page.statementDate,
        clinicalImpression: page.clinicalImpression,
        hasClinicalLabel: page.hasClinicalLabel,
        totalAmount: page.totalAmount,
        totalAmountValue: page.totalAmountValue,
        pages: [page.pageNumber], // 1-based page numbers
      });
    } else {
      // Continuation page belonging to the previous patient
      const prev = rawPatients[rawPatients.length - 1];
      prev.pages.push(page.pageNumber);
      if (page.totalAmountValue !== null) {
        prev.totalAmount = page.totalAmount;
        prev.totalAmountValue = page.totalAmountValue;
      }
    }
  }

  // Step 2: Classify every merged patient (Clinical Impression + Total Amount)
  const patients = reclassifyPatients(rawPatients, options);

  const noDiagnosisCount = patients.filter((p) => p.hasNoDiagnosis).length;
  const zeroAmountCount = patients.filter((p) => p.hasZeroAmount).length;
  const bothIssuesCount = patients.filter((p) => p.hasNoDiagnosis && p.hasZeroAmount).length;
  const clearedCount = patients.filter((p) => p.isCleared).length;
  const excludedCount = patients.length - clearedCount;

  return {
    totalPages: numPages,
    totalPatients: patients.length,
    noDiagnosisCount,
    zeroAmountCount,
    bothIssuesCount,
    clearedCount,
    excludedCount,
    hasTextLayer: totalTextChars > 0,
    patients,
  };
}
