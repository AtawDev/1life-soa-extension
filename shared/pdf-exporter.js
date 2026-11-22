/**
 * Filtered PDF builder powered by pdf-lib.
 * Copies exact pages for selected patients without re-rendering or losing vector quality.
 */

export async function buildFilteredPdf(
  sourcePdfBytes,
  selectedPatients,
  { title = '1Life Filtered Statement of Account', PDFLib = globalThis.PDFLib } = {}
) {
  if (!PDFLib || !PDFLib.PDFDocument) {
    throw new Error('pdf-lib is not loaded.');
  }
  if (!selectedPatients || selectedPatients.length === 0) {
    throw new Error('No patients selected for export.');
  }

  const srcDoc = await PDFLib.PDFDocument.load(sourcePdfBytes, {
    ignoreEncryption: true,
  });
  const totalSrcPages = srcDoc.getPageCount();

  // Collect 0-based unique page indices in original document order
  const seen = new Set();
  const pageIndices = [];
  for (const patient of selectedPatients) {
    for (const p of patient.pages || []) {
      const idx = p - 1;
      if (idx >= 0 && idx < totalSrcPages && !seen.has(idx)) {
        seen.add(idx);
        pageIndices.push(idx);
      }
    }
  }

  if (pageIndices.length === 0) {
    throw new Error('No valid pages found for the selected patients.');
  }

  const outDoc = await PDFLib.PDFDocument.create();
  outDoc.setTitle(title);
  outDoc.setProducer('1Life SOA Diagnosis Filter');
  outDoc.setCreator('1Life SOA Diagnosis Filter');

  const copiedPages = await outDoc.copyPages(srcDoc, pageIndices);
  for (const page of copiedPages) {
    outDoc.addPage(page);
  }

  const bytes = await outDoc.save();
  return {
    bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    pageCount: pageIndices.length,
    patientCount: selectedPatients.length,
  };
}
