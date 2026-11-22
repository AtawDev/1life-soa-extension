/**
 * 1:1 Exact-Geometry PDF -> Microsoft Word (.docx) Converter.
 * Runs 100% offline inside the Chrome Extension (and Node.js tests) using pdf.js + OOXML.
 *
 * Preserves 1:1 layout of 1Life Statement of Account PDFs:
 *  - Exact page dimensions & strict 1-to-1 page breaks (no extra blank pages)
 *  - Exact vector borders, inset TOTAL AMOUNT box, Sub-Total rules, and solid signature lines
 *  - Exact embedded images (logos / e-signatures) when present
 *  - Natural, un-squished Arial typography (no horizontal glyph distortion)
 *  - Automatic natural font-size fit when a long Address approaches its cell border (zero overflow)
 *  - Soft-hyphen normalization (keeps "Sub-Total" hyphen visible in Word)
 *  - Smart full-width editable textbox for "Clinical Impression:" (even when blank!)
 */

import { createZip } from './zip.js';

const PT_TO_EMU = 12700;
const PT_TO_TWIP = 20;
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ptToEmu(pt) {
  return Math.round((Number(pt) || 0) * PT_TO_EMU);
}

function ptToTwip(pt) {
  return Math.max(1, Math.round((Number(pt) || 0) * PT_TO_TWIP));
}

function clampByte(v) {
  const n = Math.round(Number(v) || 0);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

function rgbToHex(r, g, b) {
  return (
    clampByte(r).toString(16).padStart(2, '0') +
    clampByte(g).toString(16).padStart(2, '0') +
    clampByte(b).toString(16).padStart(2, '0')
  ).toUpperCase();
}

function parsePdfRgbArg(args) {
  if (!args) return '000000';
  if (typeof args[0] === 'string' && /^#[0-9a-f]{6}$/i.test(args[0])) {
    return args[0].slice(1).toUpperCase();
  }
  const src =
    args.length === 1 && args[0] && typeof args[0] === 'object' && '0' in args[0]
      ? args[0]
      : args;
  let r = Number(src[0] ?? 0);
  let g = Number(src[1] ?? 0);
  let b = Number(src[2] ?? 0);
  if (r <= 1 && g <= 1 && b <= 1 && (r % 1 !== 0 || g % 1 !== 0 || b % 1 !== 0)) {
    r *= 255;
    g *= 255;
    b *= 255;
  }
  return rgbToHex(r, g, b);
}

function parsePdfGrayArg(args) {
  if (!args) return '000000';
  let g = Number(args[0] ?? 0);
  if (g <= 1) g *= 255;
  return rgbToHex(g, g, g);
}

function parsePdfCmykArg(args) {
  if (!args || args.length < 4) return '000000';
  const c = Number(args[0] || 0);
  const m = Number(args[1] || 0);
  const y = Number(args[2] || 0);
  const k = Number(args[3] || 0);
  return rgbToHex(
    255 * (1 - c) * (1 - k),
    255 * (1 - m) * (1 - k),
    255 * (1 - y) * (1 - k)
  );
}

function multiplyMatrices(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function matrixScale(m) {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  return (sx + sy) / 2 || 1;
}

function mapFontFamily(rawName, fallbackFamily) {
  const name = String(rawName || '').toLowerCase();
  if (name.includes('calibri')) return 'Calibri';
  if (name.includes('cambria')) return 'Cambria';
  if (name.includes('times') || name.includes('georgia') || name.includes('serif')) {
    if (!name.includes('sans')) return 'Times New Roman';
  }
  if (name.includes('courier') || name.includes('mono') || name.includes('consolas')) {
    return 'Courier New';
  }
  if (name.includes('tahoma')) return 'Tahoma';
  if (name.includes('verdana')) return 'Verdana';
  if (name.includes('segoe')) return 'Segoe UI';

  const fb = String(fallbackFamily || '').toLowerCase();
  if (fb.includes('monospace')) return 'Courier New';
  if (fb.includes('serif') && !fb.includes('sans')) return 'Times New Roman';
  return 'Arial';
}

function detectFontStyle(fontObj, styleInfo) {
  const rawName = String(fontObj?.name || fontObj?.loadedName || '');
  const bold =
    Boolean(fontObj?.bold) ||
    /(?:^|[-_,+])(?:bold|bd|black|heavy|semibold|demibold|demi|medi)(?:$|[-_,+]|mt|ps)/i.test(
      rawName
    ) ||
    /bold/i.test(rawName);
  const italic = Boolean(fontObj?.italic) || /italic|oblique/i.test(rawName);
  const fontFamily = mapFontFamily(rawName, styleInfo?.fontFamily);
  const ascent =
    styleInfo && Number(styleInfo.ascent) > 0.4 && Number(styleInfo.ascent) < 1.3
      ? Number(styleInfo.ascent)
      : 0.78;
  return { fontFamily, bold, italic, ascent };
}

function getObjSync(pool, name) {
  try {
    if (pool && typeof pool.has === 'function' && pool.has(name)) {
      return pool.get(name);
    }
  } catch {
    // Ignore unresolved object
  }
  return null;
}

async function pdfImageToPng(imgObj) {
  if (!imgObj || !imgObj.width || !imgObj.height) return null;
  const w = imgObj.width;
  const h = imgObj.height;

  let canvas = null;
  let ctx = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d');
  } else if (typeof document !== 'undefined' && document.createElement) {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    ctx = canvas.getContext('2d');
  } else {
    return null;
  }
  if (!ctx) return null;

  try {
    if (imgObj.bitmap) {
      ctx.drawImage(imgObj.bitmap, 0, 0, w, h);
    } else if (imgObj.data) {
      const rgba = new Uint8ClampedArray(w * h * 4);
      const src = imgObj.data;
      if (src.length === w * h * 4) {
        rgba.set(src);
      } else if (src.length === w * h * 3) {
        for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
          rgba[j] = src[i];
          rgba[j + 1] = src[i + 1];
          rgba[j + 2] = src[i + 2];
          rgba[j + 3] = 255;
        }
      } else if (src.length === w * h) {
        for (let i = 0, j = 0; i < src.length; i++, j += 4) {
          rgba[j] = src[i];
          rgba[j + 1] = src[i];
          rgba[j + 2] = src[i];
          rgba[j + 3] = 255;
        }
      } else {
        return null;
      }
      ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    } else {
      return null;
    }

    if (typeof canvas.convertToBlob === 'function') {
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return new Uint8Array(await blob.arrayBuffer());
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Extract vector rectangles, horizontal/vertical/diagonal lines, text fill colors,
 * and embedded images from a pdf.js page operator list.
 */
async function extractPageGraphics(page, viewport, OPS) {
  const opList = await page.getOperatorList();
  const pageW = viewport.width;
  const pageH = viewport.height;
  const vpTransform = viewport.transform;

  const shapes = [];
  const images = [];
  const textColors = [];

  const stateStack = [];
  let state = {
    ctm: [1, 0, 0, 1, 0, 0],
    lineWidth: 1,
    strokeColor: '000000',
    fillColor: '000000',
    strokeTransparent: false,
    fillTransparent: false,
  };

  let textMatrix = [1, 0, 0, 1, 0, 0];
  let textLineMatrix = [1, 0, 0, 1, 0, 0];
  let textLeading = 0;
  let currentPaths = [];

  function cloneState(s) {
    return {
      ctm: [...s.ctm],
      lineWidth: s.lineWidth,
      strokeColor: s.strokeColor,
      fillColor: s.fillColor,
      strokeTransparent: s.strokeTransparent,
      fillTransparent: s.fillTransparent,
    };
  }

  function toPagePt(x, y) {
    return applyMatrix(multiplyMatrices(vpTransform, state.ctm), x, y);
  }

  function isAxisAlignedRectPoints(pts, closed) {
    const clean = [...pts];
    if (
      clean.length >= 2 &&
      Math.abs(clean[0][0] - clean[clean.length - 1][0]) < 0.25 &&
      Math.abs(clean[0][1] - clean[clean.length - 1][1]) < 0.25
    ) {
      clean.pop();
    }
    if (clean.length !== 4 || !closed) return null;

    const xs = clean.map((p) => p[0]);
    const ys = clean.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    for (const [px, py] of clean) {
      const onX = Math.abs(px - minX) < 0.5 || Math.abs(px - maxX) < 0.5;
      const onY = Math.abs(py - minY) < 0.5 || Math.abs(py - maxY) < 0.5;
      if (!onX || !onY) return null;
    }

    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function commitPaths(rawStroke, rawFill, forceClose = false) {
    if (currentPaths.length === 0) return;

    const doStroke = Boolean(rawStroke && !state.strokeTransparent);
    const doFill = Boolean(rawFill && !state.fillTransparent);
    if (!doStroke && !doFill) {
      currentPaths = [];
      return;
    }

    // Ensure crisp 0.75pt minimum thickness on box borders and 1.0pt on thin rules
    const sw = Math.max(0.75, state.lineWidth * matrixScale(state.ctm));

    for (const sub of currentPaths) {
      const closed = sub.closed || forceClose;
      const pts = sub.points;
      if (!pts || pts.length < 2) continue;

      const rect = sub.rectBounds || isAxisAlignedRectPoints(pts, closed);
      if (rect) {
        if (rect.w < 0.1 && rect.h < 0.1) continue;

        // Skip stroke-less pure-white background fills (e.g., CSS background:#fff divs/cells
        // that would otherwise cover thin border lines on a white Word page!)
        if (doFill && !doStroke && state.fillColor === 'FFFFFF') continue;

        // Convert thin filled horizontal/vertical rules (e.g., HTML borders / <hr>) into
        // true DrawingML vector strokes (prst="line") so Word NEVER drops them at any zoom!
        if (doFill && !doStroke && rect.w >= 8 && rect.h <= 2.2) {
          shapes.push({
            kind: 'hline',
            x: rect.x,
            y: rect.y + rect.h / 2,
            w: rect.w,
            h: 0,
            strokeColor: state.fillColor,
            strokeWidth: Math.max(1.0, rect.h),
            fillColor: null,
          });
          continue;
        }
        if (doFill && !doStroke && rect.h >= 8 && rect.w <= 2.2) {
          shapes.push({
            kind: 'vline',
            x: rect.x + rect.w / 2,
            y: rect.y,
            w: 0,
            h: rect.h,
            strokeColor: state.fillColor,
            strokeWidth: Math.max(1.0, rect.w),
            fillColor: null,
          });
          continue;
        }

        // Convert thin stroked 1-2pt boxes (like HTML <hr> borders) into a single crisp line
        if (doStroke && rect.w >= 12 && rect.h <= 2.2) {
          shapes.push({
            kind: 'hline',
            x: rect.x,
            y: rect.y + rect.h / 2,
            w: rect.w,
            h: 0,
            strokeColor: state.strokeColor,
            strokeWidth: Math.max(1.0, sw),
            fillColor: null,
          });
          continue;
        }

        shapes.push({
          kind: 'rect',
          x: rect.x,
          y: rect.y,
          w: Math.max(rect.w, 0.75),
          h: Math.max(rect.h, 0.75),
          strokeColor: doStroke ? state.strokeColor : null,
          strokeWidth: doStroke ? sw : 0,
          fillColor: doFill && state.fillColor !== 'FFFFFF' ? state.fillColor : null,
        });
        continue;
      }

      if (doStroke) {
        const segCount = closed ? pts.length : pts.length - 1;
        for (let k = 0; k < segCount; k++) {
          const p1 = pts[k];
          const p2 = pts[(k + 1) % pts.length];
          const dx = p2[0] - p1[0];
          const dy = p2[1] - p1[1];
          const len = Math.hypot(dx, dy);
          if (len < 0.5) continue;

          if (Math.abs(dy) < 0.5) {
            shapes.push({
              kind: 'hline',
              x: Math.min(p1[0], p2[0]),
              y: (p1[1] + p2[1]) / 2,
              w: Math.abs(dx),
              h: 0,
              strokeColor: state.strokeColor,
              strokeWidth: Math.max(1.0, sw),
              fillColor: null,
            });
          } else if (Math.abs(dx) < 0.5) {
            shapes.push({
              kind: 'vline',
              x: (p1[0] + p2[0]) / 2,
              y: Math.min(p1[1], p2[1]),
              w: 0,
              h: Math.abs(dy),
              strokeColor: state.strokeColor,
              strokeWidth: Math.max(1.0, sw),
              fillColor: null,
            });
          } else {
            shapes.push({
              kind: 'line',
              x: Math.min(p1[0], p2[0]),
              y: Math.min(p1[1], p2[1]),
              w: Math.max(Math.abs(dx), 0.75),
              h: Math.max(Math.abs(dy), 0.75),
              flipH: p2[0] < p1[0],
              flipV: p2[1] < p1[1],
              strokeColor: state.strokeColor,
              strokeWidth: Math.max(1.0, sw),
              fillColor: null,
            });
          }
        }
      } else if (doFill && pts.length >= 3) {
        if (state.fillColor === 'FFFFFF') continue;
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const w = maxX - minX;
        const h = maxY - minY;
        if (w >= 8 && h <= 2.2) {
          shapes.push({
            kind: 'hline',
            x: minX,
            y: minY + h / 2,
            w,
            h: 0,
            strokeColor: state.fillColor,
            strokeWidth: Math.max(1.0, h),
            fillColor: null,
          });
        } else if (h >= 8 && w <= 2.2) {
          shapes.push({
            kind: 'vline',
            x: minX + w / 2,
            y: minY,
            w: 0,
            h,
            strokeColor: state.fillColor,
            strokeWidth: Math.max(1.0, w),
            fillColor: null,
          });
        } else if (w >= 0.4 || h >= 0.4) {
          shapes.push({
            kind: 'rect',
            x: minX,
            y: minY,
            w: Math.max(w, 0.75),
            h: Math.max(h, 0.75),
            strokeColor: null,
            strokeWidth: 0,
            fillColor: state.fillColor,
          });
        }
      }
    }

    currentPaths = [];
  }

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    switch (fn) {
      case OPS.save:
        stateStack.push(cloneState(state));
        break;
      case OPS.restore:
        if (stateStack.length > 0) state = stateStack.pop();
        break;
      case OPS.transform:
        if (args && args.length === 6) state.ctm = multiplyMatrices(state.ctm, args);
        break;
      case OPS.setLineWidth:
        if (args && args.length >= 1) state.lineWidth = Number(args[0]) || 1;
        break;
      case OPS.setStrokeRGBColor:
        state.strokeColor = parsePdfRgbArg(args);
        state.strokeTransparent = false;
        break;
      case OPS.setFillRGBColor:
        state.fillColor = parsePdfRgbArg(args);
        state.fillTransparent = false;
        break;
      case OPS.setStrokeGray:
        state.strokeColor = parsePdfGrayArg(args);
        state.strokeTransparent = false;
        break;
      case OPS.setFillGray:
        state.fillColor = parsePdfGrayArg(args);
        state.fillTransparent = false;
        break;
      case OPS.setStrokeCMYKColor:
        state.strokeColor = parsePdfCmykArg(args);
        state.strokeTransparent = false;
        break;
      case OPS.setFillCMYKColor:
        state.fillColor = parsePdfCmykArg(args);
        state.fillTransparent = false;
        break;
      case OPS.setStrokeTransparent:
        state.strokeTransparent = true;
        break;
      case OPS.setFillTransparent:
        state.fillTransparent = true;
        break;

      case OPS.constructPath: {
        const subOps = args[0] || [];
        const coords = args[1] || [];
        let ci = 0;
        let active = null;

        for (let s = 0; s < subOps.length; s++) {
          const sop = subOps[s];
          if (sop === OPS.moveTo) {
            active = { points: [toPagePt(coords[ci++], coords[ci++])], closed: false, rectBounds: null };
            currentPaths.push(active);
          } else if (sop === OPS.lineTo) {
            const pt = toPagePt(coords[ci++], coords[ci++]);
            if (!active) {
              active = { points: [pt], closed: false, rectBounds: null };
              currentPaths.push(active);
            } else {
              active.points.push(pt);
            }
          } else if (sop === OPS.curveTo) {
            ci += 4;
            const pt = toPagePt(coords[ci++], coords[ci++]);
            if (active) active.points.push(pt);
          } else if (sop === OPS.curveTo2 || sop === OPS.curveTo3) {
            ci += 2;
            const pt = toPagePt(coords[ci++], coords[ci++]);
            if (active) active.points.push(pt);
          } else if (sop === OPS.closePath) {
            if (active) active.closed = true;
          } else if (sop === OPS.rectangle) {
            const rx = coords[ci++];
            const ry = coords[ci++];
            const rw = coords[ci++];
            const rh = coords[ci++];
            const p1 = toPagePt(rx, ry);
            const p2 = toPagePt(rx + rw, ry);
            const p3 = toPagePt(rx + rw, ry + rh);
            const p4 = toPagePt(rx, ry + rh);
            const xs = [p1[0], p2[0], p3[0], p4[0]];
            const ys = [p1[1], p2[1], p3[1], p4[1]];
            active = {
              points: [p1, p2, p3, p4],
              closed: true,
              rectBounds: {
                x: Math.min(...xs),
                y: Math.min(...ys),
                w: Math.max(...xs) - Math.min(...xs),
                h: Math.max(...ys) - Math.min(...ys),
              },
            };
            currentPaths.push(active);
          }
        }
        break;
      }

      case OPS.stroke:
        commitPaths(true, false, false);
        break;
      case OPS.closeStroke:
        commitPaths(true, false, true);
        break;
      case OPS.fill:
      case OPS.eoFill:
        commitPaths(false, true, true);
        break;
      case OPS.fillStroke:
      case OPS.eoFillStroke:
        commitPaths(true, true, false);
        break;
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        commitPaths(true, true, true);
        break;
      case OPS.endPath:
        currentPaths = [];
        break;

      case OPS.beginText:
        textMatrix = [1, 0, 0, 1, 0, 0];
        textLineMatrix = [1, 0, 0, 1, 0, 0];
        break;
      case OPS.setLeading:
        textLeading = Number(args?.[0]) || 0;
        break;
      case OPS.setTextMatrix:
        if (args && args.length === 6) {
          textMatrix = [...args];
          textLineMatrix = [...args];
        }
        break;
      case OPS.moveText:
        if (args && args.length >= 2) {
          textLineMatrix = multiplyMatrices(textLineMatrix, [1, 0, 0, 1, args[0], args[1]]);
          textMatrix = [...textLineMatrix];
        }
        break;
      case OPS.nextLine:
        textLineMatrix = multiplyMatrices(textLineMatrix, [1, 0, 0, 1, 0, -textLeading]);
        textMatrix = [...textLineMatrix];
        break;
      case OPS.showText:
      case OPS.showSpacedText: {
        const combined = multiplyMatrices(vpTransform, multiplyMatrices(state.ctm, textMatrix));
        textColors.push({ x: combined[4], y: combined[5], color: state.fillColor });
        break;
      }

      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject: {
        try {
          const imgObj =
            fn === OPS.paintInlineImageXObject
              ? args?.[0]
              : getObjSync(page.objs, args?.[0]) || getObjSync(page.commonObjs, args?.[0]);
          if (imgObj) {
            const p0 = toPagePt(0, 0);
            const p1 = toPagePt(1, 0);
            const p2 = toPagePt(1, 1);
            const p3 = toPagePt(0, 1);
            const xs = [p0[0], p1[0], p2[0], p3[0]];
            const ys = [p0[1], p1[1], p2[1], p3[1]];
            const w = Math.max(...xs) - Math.min(...xs);
            const h = Math.max(...ys) - Math.min(...ys);
            if (w >= 4 && h >= 4) {
              const pngBytes = await pdfImageToPng(imgObj);
              if (pngBytes) {
                images.push({ x: Math.min(...xs), y: Math.min(...ys), w, h, pngBytes });
              }
            }
          }
        } catch {
          // Non-fatal
        }
        break;
      }

      default:
        break;
    }
  }

  const dedupedShapes = [];
  const seenKeys = new Set();
  for (const s of shapes) {
    const key = [
      s.kind,
      Math.round(s.x * 2),
      Math.round(s.y * 2),
      Math.round(s.w * 2),
      Math.round(s.h * 2),
      s.strokeColor || '',
      s.fillColor || '',
    ].join('|');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    dedupedShapes.push(s);
  }

  return { shapes: dedupedShapes, images, textColors };
}

function findColorForText(x, baselineY, textColors) {
  let best = '000000';
  let bestDist = 12;
  for (const tc of textColors) {
    const d = Math.hypot(tc.x - x, tc.y - baselineY);
    if (d < bestDist) {
      bestDist = d;
      best = tc.color;
    }
  }
  return best;
}

let cachedMeasureCtx = null;
function getMeasureContext() {
  if (cachedMeasureCtx !== null) return cachedMeasureCtx;
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      cachedMeasureCtx = new OffscreenCanvas(1, 1).getContext('2d') || false;
    } else if (typeof document !== 'undefined' && document.createElement) {
      cachedMeasureCtx = document.createElement('canvas').getContext('2d') || false;
    } else {
      cachedMeasureCtx = false;
    }
  } catch {
    cachedMeasureCtx = false;
  }
  return cachedMeasureCtx;
}

/**
 * Measure rendered text width (in PDF points) in the target Word font at natural 100% proportions.
 */
function measureRunWidthPt(str, fontFamily, fontSizePt, bold, italic) {
  if (!str) return 0;
  const ctx = getMeasureContext();
  if (ctx) {
    const scale = 10;
    const fam = fontFamily || 'Arial';
    ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSizePt * scale}px "${fam}", Arial, sans-serif`;
    return ctx.measureText(str).width / scale;
  }

  const isMono = /courier|mono|consolas/i.test(fontFamily || '');
  if (isMono) return str.length * fontSizePt * 0.6;

  let units = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === ' ') units += 0.28;
    else if ('ilIjtfr.,:;!|\'`-'.includes(ch)) units += 0.28;
    else if ('mwMW@%'.includes(ch)) units += 0.86;
    else if (ch >= 'A' && ch <= 'Z') units += 0.68;
    else if (ch >= '0' && ch <= '9') units += 0.56;
    else units += 0.54;
  }
  return units * fontSizePt * (bold ? 1.06 : 1.0);
}

function measureRunsAtDeltaHalfPt(runs, deltaHalfPt = 0) {
  let total = 0;
  for (const r of runs || []) {
    const baseHalf = Math.max(8, Math.round((r.fontSize || 9) * 2));
    const szHalf = Math.max(10, baseHalf + deltaHalfPt); // never smaller than 5pt
    total += measureRunWidthPt(r.str, r.fontFamily, szHalf / 2, r.bold, r.italic);
  }
  return total;
}

/**
 * Find the nearest vertical table border / cell right edge strictly to the right of a text block.
 */
function findRightCellBorder(x, topY, bottomY, shapes) {
  let nearest = Infinity;
  const midY = (topY + bottomY) / 2;

  for (const s of shapes || []) {
    if (s.kind === 'vline' && s.h >= 10) {
      if (s.y <= midY + 4 && s.y + s.h >= midY - 4 && s.x > x + 8) {
        if (s.x < nearest) nearest = s.x;
      }
      continue;
    }
    if (s.kind !== 'rect') continue;
    if (s.w <= 3.5 && s.h >= 10) {
      if (s.y <= midY + 4 && s.y + s.h >= midY - 4 && s.x > x + 8) {
        if (s.x < nearest) nearest = s.x;
      }
    } else if (s.w >= 20 && s.h >= 12) {
      if (s.x <= x + 8 && s.y <= midY + 4 && s.y + s.h >= midY - 4) {
        const rightEdge = s.x + s.w;
        if (rightEdge > x + 8 && rightEdge < nearest) {
          nearest = rightEdge;
        }
      }
    }
  }
  return nearest;
}

/**
 * Extract positioned, styled, editable text blocks from pdf.js getTextContent().
 * Preserves 1:1 v1 layout while fixing:
 *  - Soft hyphen (U+00AD) -> visible "-" (so "Sub-Total" never becomes "SubTotal")
 *  - Narrow alpha-to-digit gap (so "Consultation 500.00" keeps its clean space)
 *  - Natural 0.5pt font step-down ONLY when a long line (e.g. Address) would exceed its cell border
 *    (zero horizontal glyph squishing, zero wrap onto Clinical Impression!)
 */
async function extractPageTextBlocks(page, viewport, shapes, textColors) {
  const textContent = await page.getTextContent();
  const styles = textContent.styles || {};
  const vpTransform = viewport.transform;
  const pageW = viewport.width;
  const pageH = viewport.height;

  const rawItems = [];
  for (const item of textContent.items || []) {
    if (!item || typeof item.str !== 'string') continue;
    // Normalize non-breaking spaces, soft/non-breaking hyphens, and missing-hyphen "SubTotal"
    const str = item.str
      .replace(/\u00a0/g, ' ')
      .replace(/[\u00ad\u2010\u2011]/g, '-')
      .replace(/\bSubTotal\b/g, 'Sub-Total');
    if (!str.trim()) continue;

    const tr = item.transform || [1, 0, 0, 1, 0, 0];
    const fontSize = Math.hypot(tr[2], tr[3]) || Math.hypot(tr[0], tr[1]) || Number(item.height) || 9;
    const tx = multiplyMatrices(vpTransform, tr);
    const x = tx[4];
    const baselineY = tx[5];
    const width = Number(item.width) > 0 ? Number(item.width) : str.length * fontSize * 0.52;

    const fontObj = getObjSync(page.commonObjs, item.fontName);
    const styleInfo = styles[item.fontName];
    const { fontFamily, bold, italic, ascent } = detectFontStyle(fontObj, styleInfo);
    const color = findColorForText(x, baselineY, textColors);
    const topY = Math.max(0, baselineY - fontSize * Math.max(0.86, ascent + 0.14));

    rawItems.push({
      str,
      x,
      baselineY,
      topY,
      width,
      fontSize,
      fontFamily,
      bold,
      italic,
      color,
    });
  }

  rawItems.sort((a, b) => {
    if (Math.abs(a.baselineY - b.baselineY) > 2.2) return a.baselineY - b.baselineY;
    return a.x - b.x;
  });

  const rows = [];
  for (const it of rawItems) {
    let row = null;
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 5); i--) {
      const cand = rows[i];
      const tol = Math.max(2.4, Math.min(it.fontSize, cand.fontSize) * 0.32);
      if (Math.abs(cand.baselineY - it.baselineY) <= tol) {
        row = cand;
        break;
      }
    }
    if (!row) {
      rows.push({ baselineY: it.baselineY, fontSize: it.fontSize, items: [it] });
    } else {
      row.items.push(it);
    }
  }

  const blocks = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    const rowBlocks = [];

    for (const it of row.items) {
      const prevBlock = rowBlocks[rowBlocks.length - 1];
      if (!prevBlock) {
        rowBlocks.push({
          x: it.x,
          rightX: it.x + it.width,
          baselineY: it.baselineY,
          topY: it.topY,
          fontSize: it.fontSize,
          runs: [it],
        });
        continue;
      }

      const gap = it.x - prevBlock.rightX;
      const mergeLimit = Math.max(Math.max(prevBlock.fontSize, it.fontSize) * 1.15, 9.0);

      if (gap >= -3.0 && gap <= mergeLimit) {
        const lastRun = prevBlock.runs[prevBlock.runs.length - 1];
        const noEdgeSpace = !lastRun.str.endsWith(' ') && !it.str.startsWith(' ');
        // Keep space between words AND narrow label->amount gaps (e.g. "Consultation 500.00")
        // without ever splitting tight tokens like "U601" or "500mg" (gap <= 0.4pt).
        const isAlphaToAmount =
          /[A-Za-z)]$/.test(lastRun.str) && /^\d+(?:,\d{3})*\.\d{2}/.test(it.str.trim());
        const needsSpace =
          noEdgeSpace &&
          (gap > Math.max(1.2, it.fontSize * 0.14) || (isAlphaToAmount && gap > 0.35));

        prevBlock.runs.push(needsSpace ? { ...it, str: ' ' + it.str } : it);
        prevBlock.rightX = Math.max(prevBlock.rightX, it.x + it.width);
        prevBlock.topY = Math.min(prevBlock.topY, it.topY);
        prevBlock.fontSize = Math.max(prevBlock.fontSize, it.fontSize);
      } else {
        rowBlocks.push({
          x: it.x,
          rightX: it.x + it.width,
          baselineY: it.baselineY,
          topY: it.topY,
          fontSize: it.fontSize,
          runs: [it],
        });
      }
    }

    for (let b = 0; b < rowBlocks.length; b++) {
      const blk = rowBlocks[b];
      const nextBlk = rowBlocks[b + 1];
      const naturalW = Math.max(blk.rightX - blk.x, 8);
      const cellRightX = findRightCellBorder(
        blk.x,
        blk.topY,
        blk.topY + Math.max(blk.fontSize, 8),
        shapes
      );
      const nextColRight = nextBlk ? nextBlk.x - 2 : pageW - 8;
      const cellLimitRight = Math.min(nextColRight, cellRightX - 2.5, pageW - 8);
      const cellMaxW = Math.max(naturalW + 2, cellLimitRight - blk.x);

      // Natural un-squished fit: if a tight long line (like Address) in Windows Arial would exceed
      // its cell right border, step down natural font size by 0.5pt increments (NO horizontal squishing!).
      let fontDeltaHalfPt = 0;
      const measuredBase = measureRunsAtDeltaHalfPt(blk.runs, 0);
      if (measuredBase > cellLimitRight - blk.x - 1) {
        for (let step = -1; step >= -4; step--) {
          fontDeltaHalfPt = step;
          if (measureRunsAtDeltaHalfPt(blk.runs, step) <= cellLimitRight - blk.x - 1.5) {
            break;
          }
        }
      }

      const fittedW = measureRunsAtDeltaHalfPt(blk.runs, fontDeltaHalfPt);
      const extraPad = Math.max(14, blk.fontSize * 1.8);
      blk.width = Math.min(cellMaxW, Math.max(naturalW, fittedW) + extraPad);
      blk.height = Math.max(blk.fontSize * 1.45, 12);
      blk.fontDeltaHalfPt = fontDeltaHalfPt;
      blk.paragraphs = [blk.runs];
      blk.plainText = blk.runs.map((r) => r.str).join('').trim();
      blocks.push(blk);
    }
  }

  enhanceClinicalImpressionBox(blocks, shapes, pageW, pageH);
  ensureFooterSignatureLine(shapes, blocks);
  return blocks;
}

function enhanceClinicalImpressionBox(blocks, shapes, pageW, pageH) {
  const ciIdx = blocks.findIndex((b) => /clinical\s*impressions?\s*:?/i.test(b.plainText));
  if (ciIdx === -1) return;

  const ciLabel = blocks[ciIdx];
  const afterInline = ciLabel.plainText.replace(/^.*?clinical\s*impressions?\s*:?\s*/i, '').trim();

  const enclosingRects = shapes.filter(
    (s) =>
      s.kind === 'rect' &&
      s.w > pageW * 0.45 &&
      s.h > 20 &&
      s.x <= ciLabel.x + 8 &&
      s.x + s.w >= ciLabel.x + 120 &&
      s.y <= ciLabel.topY + 6 &&
      s.y + s.h >= ciLabel.topY + 12
  );
  enclosingRects.sort((a, b) => a.w * a.h - b.w * b.h);
  const enclosingBox = enclosingRects[0] || null;

  const stopBlock = blocks.find(
    (b) =>
      b.topY > ciLabel.topY + 4 &&
      /\b(?:medical\s+procedures?|medicines?|sub-?\s*total|total\s+amount)\b/i.test(b.plainText)
  );

  const boxRight = enclosingBox ? enclosingBox.x + enclosingBox.w - 6 : pageW - ciLabel.x;
  let boxBottom = enclosingBox ? enclosingBox.y + enclosingBox.h - 2 : ciLabel.topY + 46;
  if (stopBlock) {
    boxBottom = Math.min(boxBottom, stopBlock.topY - 6);
  }
  boxBottom = Math.min(boxBottom, pageH - 20);

  if (afterInline) {
    ciLabel.width = Math.max(ciLabel.width, boxRight - ciLabel.x);
    ciLabel.fontDeltaHalfPt = 0;
    ciLabel.isClinicalImpressionBox = true;
    return;
  }

  const valueIndices = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i === ciIdx) continue;
    const blk = blocks[i];
    if (blk.topY > ciLabel.topY + 3 && blk.topY < boxBottom - 2) {
      if (/\b(?:medical\s+procedures?|medicines?|sub-?\s*total|total\s+amount)\b/i.test(blk.plainText)) {
        continue;
      }
      valueIndices.push(i);
    }
  }

  if (valueIndices.length > 0) {
    valueIndices.sort((a, b) => blocks[a].topY - blocks[b].topY);
    const primary = blocks[valueIndices[0]];
    primary.paragraphs = valueIndices.map((idx) => blocks[idx].runs);
    primary.width = Math.max(primary.width, boxRight - primary.x);
    primary.height = Math.max(primary.height, boxBottom - primary.topY);
    primary.fontDeltaHalfPt = 0;
    primary.isClinicalImpressionBox = true;

    const toRemove = valueIndices.slice(1).sort((a, b) => b - a);
    for (const idx of toRemove) {
      blocks.splice(idx, 1);
    }
  } else {
    const bodyFont = ciLabel.runs[0]?.fontFamily || 'Arial';
    const bodySize = Math.max(8, ciLabel.fontSize || 8.5);
    const topY = ciLabel.topY + bodySize * 1.65;
    if (topY < boxBottom - 2) {
      blocks.push({
        x: ciLabel.x,
        topY,
        width: Math.max(180, boxRight - ciLabel.x),
        height: Math.max(16, boxBottom - topY),
        fontSize: bodySize,
        fontDeltaHalfPt: 0,
        paragraphs: [
          [
            {
              str: '',
              fontFamily: bodyFont,
              fontSize: bodySize,
              bold: false,
              italic: false,
              color: '000000',
            },
          ],
        ],
        plainText: '',
        isClinicalImpressionBox: true,
      });
    }
  }
}

/**
 * Guarantee the signature divider line below "Billing Staff" and above "Prepared by"
 * renders as a crisp, solid black 1.0pt vector line at every Word zoom level.
 */
function ensureFooterSignatureLine(shapes, blocks) {
  const preparedBlk = blocks.find((b) => /^prepared\s+by\b/i.test(b.plainText));
  if (!preparedBlk) return;

  const prepCenterX = preparedBlk.x + (preparedBlk.rightX - preparedBlk.x) / 2;
  // Find the staff title / name lines directly above "Prepared by" (within ~55pt above & aligned horizontally)
  const aboveBlks = blocks
    .filter(
      (b) =>
        b !== preparedBlk &&
        b.baselineY < preparedBlk.topY - 2 &&
        b.baselineY >= preparedBlk.topY - 55 &&
        Math.abs((b.x + b.rightX) / 2 - prepCenterX) < 75
    )
    .sort((a, b) => a.baselineY - b.baselineY);

  if (aboveBlks.length === 0) return;

  const lowestAbove = aboveBlks[aboveBlks.length - 1];
  const gapTop = lowestAbove.baselineY;
  const gapBot = preparedBlk.topY;

  // Find any existing horizontal divider shape(s) inside this footer signature gap
  const footerLineIndices = [];
  let existingX = null;
  let existingW = null;
  let existingY = null;

  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    const isHoriz =
      s.kind === 'hline' || (s.kind === 'rect' && s.w >= 40 && s.h <= 4);
    if (!isHoriz) continue;
    const sy = s.kind === 'hline' ? s.y : s.y + s.h / 2;
    const sxCenter = s.x + s.w / 2;
    if (
      sy >= gapTop - 4 &&
      sy <= gapBot + 6 &&
      Math.abs(sxCenter - prepCenterX) < 85 &&
      s.w < 260
    ) {
      footerLineIndices.push(i);
      if (existingW === null || s.w > existingW) {
        existingX = s.x;
        existingW = s.w;
        existingY = sy;
      }
    }
  }

  // Remove any faint/duplicate gray <hr> shapes in that gap
  for (let k = footerLineIndices.length - 1; k >= 0; k--) {
    shapes.splice(footerLineIndices[k], 1);
  }

  // Compute crisp centered solid black line matching the PDF signature width
  const nameMinX = Math.min(...aboveBlks.map((b) => b.x), preparedBlk.x);
  const nameMaxX = Math.max(...aboveBlks.map((b) => b.rightX), preparedBlk.rightX);
  const defaultW = Math.max(125, nameMaxX - nameMinX + 44);
  const finalW = existingW !== null ? existingW : defaultW;
  const finalX = existingX !== null ? existingX : Math.max(20, prepCenterX - finalW / 2);
  const finalY = existingY !== null ? existingY : (gapTop + gapBot) / 2 + 1;

  shapes.push({
    kind: 'hline',
    x: finalX,
    y: finalY,
    w: finalW,
    h: 0,
    strokeColor: '000000',
    strokeWidth: 1.0,
    fillColor: null,
  });
}

function buildVectorShapeRunXml(shape, id, zIndex) {
  const x = ptToEmu(shape.x);
  const y = ptToEmu(shape.y);
  const isLine = shape.kind === 'hline' || shape.kind === 'vline' || shape.kind === 'line';

  // True DrawingML vector strokes (prst="line") snap crisply to solid pixels at EVERY Word zoom level!
  const cx =
    shape.kind === 'vline' ? 0 : Math.max(9525, ptToEmu(shape.w));
  const cy =
    shape.kind === 'hline' ? 0 : Math.max(9525, ptToEmu(shape.h));

  const fillXml =
    !isLine && shape.fillColor
      ? `<a:solidFill><a:srgbClr val="${shape.fillColor}"/></a:solidFill>`
      : '<a:noFill/>';

  const strokeMinEmu = isLine ? 12700 : 9525; // 1.0pt crisp stroke on lines, >=0.75pt on box borders
  const strokeColor = shape.strokeColor || shape.fillColor || '000000';
  const lnXml =
    isLine || shape.strokeColor
      ? `<a:ln w="${Math.max(strokeMinEmu, ptToEmu(shape.strokeWidth || 1.0))}"><a:solidFill><a:srgbClr val="${strokeColor}"/></a:solidFill></a:ln>`
      : '<a:ln><a:noFill/></a:ln>';

  const prst = isLine ? 'line' : 'rect';
  const flipAttrs =
    shape.kind === 'line'
      ? `${shape.flipH ? ' flipH="1"' : ''}${shape.flipV ? ' flipV="1"' : ''}`
      : '';

  return (
    `<w:r><w:drawing>` +
    `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${zIndex}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:wrapNone/>` +
    `<wp:docPr id="${id}" name="Shape ${id}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">` +
    `<wps:wsp>` +
    `<wps:cNvPr id="${id}" name="Shape ${id}"/>` +
    `<wps:cNvSpPr/>` +
    `<wps:spPr>` +
    `<a:xfrm${flipAttrs}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>` +
    fillXml +
    lnXml +
    `</wps:spPr>` +
    `<wps:bodyPr/>` +
    `</wps:wsp>` +
    `</a:graphicData>` +
    `</a:graphic>` +
    `</wp:anchor>` +
    `</w:drawing></w:r>`
  );
}

function buildImageRunXml(img, rId, id, zIndex) {
  const x = ptToEmu(img.x);
  const y = ptToEmu(img.y);
  const cx = Math.max(12700, ptToEmu(img.w));
  const cy = Math.max(12700, ptToEmu(img.h));

  return (
    `<w:r><w:drawing>` +
    `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${zIndex}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:wrapNone/>` +
    `<wp:docPr id="${id}" name="Image ${id}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Image ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic>` +
    `</a:graphicData>` +
    `</a:graphic>` +
    `</wp:anchor>` +
    `</w:drawing></w:r>`
  );
}

function buildTextBoxRunXml(block, id, zIndex) {
  const x = ptToEmu(block.x);
  const y = ptToEmu(block.topY);
  const cx = Math.max(25400, ptToEmu(block.width));
  const cy = Math.max(25400, ptToEmu(block.height));
  const deltaHalf = block.fontDeltaHalfPt || 0;

  const paragraphsXml = (block.paragraphs || [block.runs])
    .map((runs) => {
      const maxSize = Math.max(...runs.map((r) => r.fontSize || 9), 6);
      const lineTwips = Math.round(maxSize * 1.18 * PT_TO_TWIP);

      const coalesced = [];
      for (const run of runs) {
        const prev = coalesced[coalesced.length - 1];
        if (
          prev &&
          prev.fontFamily === run.fontFamily &&
          Math.round(prev.fontSize * 2) === Math.round(run.fontSize * 2) &&
          prev.bold === run.bold &&
          prev.italic === run.italic &&
          prev.color === run.color
        ) {
          prev.str += run.str;
        } else {
          coalesced.push({ ...run });
        }
      }

      const runsXml = coalesced
        .map((r) => {
          const baseHalf = Math.max(8, Math.round((r.fontSize || 9) * 2));
          const sz = Math.max(10, baseHalf + deltaHalf);
          const font = escapeXml(r.fontFamily || 'Arial');
          const color = r.color || '000000';
          const rPr =
            `<w:rPr>` +
            `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>` +
            (r.bold ? '<w:b/><w:bCs/>' : '') +
            (r.italic ? '<w:i/><w:iCs/>' : '') +
            `<w:color w:val="${color}"/>` +
            `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` +
            `</w:rPr>`;
          const cleanText = r.str.replace(/\bSubTotal\b/g, 'Sub-Total');
          return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(cleanText)}</w:t></w:r>`;
        })
        .join('');

      return (
        `<w:p>` +
        `<w:pPr><w:spacing w:before="0" w:after="0" w:line="${lineTwips}" w:lineRule="atLeast"/></w:pPr>` +
        runsXml +
        `</w:p>`
      );
    })
    .join('');

  // Fixed single-line PDF rows use wrap="none" so long addresses NEVER wrap over Clinical Impression:;
  // the editable Clinical Impression box keeps wrap="square" so newly typed diagnoses wrap cleanly.
  const wrapMode = block.isClinicalImpressionBox ? 'square' : 'none';

  return (
    `<w:r><w:drawing>` +
    `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${zIndex}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:wrapNone/>` +
    `<wp:docPr id="${id}" name="TextBox ${id}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">` +
    `<wps:wsp>` +
    `<wps:cNvPr id="${id}" name="TextBox ${id}"/>` +
    `<wps:cNvSpPr txBox="1"/>` +
    `<wps:spPr>` +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:noFill/>` +
    `<a:ln><a:noFill/></a:ln>` +
    `</wps:spPr>` +
    `<wps:txbx><w:txbxContent>${paragraphsXml}</w:txbxContent></wps:txbx>` +
    `<wps:bodyPr rot="0" vert="horz" wrap="${wrapMode}" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:spAutoFit/></wps:bodyPr>` +
    `</wps:wsp>` +
    `</a:graphicData>` +
    `</a:graphic>` +
    `</wp:anchor>` +
    `</w:drawing></w:r>`
  );
}

function buildSectionPrXml(widthPt, heightPt) {
  const wTwips = ptToTwip(widthPt);
  const hTwips = ptToTwip(heightPt);
  const orient = widthPt > heightPt ? ' w:orient="landscape"' : '';
  return (
    `<w:sectPr>` +
    `<w:pgSz w:w="${wTwips}" w:h="${hTwips}"${orient}/>` +
    `<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/>` +
    `</w:sectPr>`
  );
}

function buildContentTypesXml(hasPng) {
  return (
    XML_HEADER +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    (hasPng ? `<Default Extension="png" ContentType="image/png"/>` : '') +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `</Types>`
  );
}

function buildRootRelsXml() {
  return (
    XML_HEADER +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`
  );
}

function buildDocumentRelsXml(mediaEntries) {
  const imgRels = mediaEntries
    .map(
      (m) =>
        `<Relationship Id="${m.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.fileName}"/>`
    )
    .join('');

  return (
    XML_HEADER +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    imgRels +
    `</Relationships>`
  );
}

function buildStylesXml() {
  return (
    XML_HEADER +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults>` +
    `<w:rPrDefault><w:rPr>` +
    `<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>` +
    `<w:sz w:val="18"/><w:szCs w:val="18"/>` +
    `</w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>` +
    `</w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal">` +
    `<w:name w:val="Normal"/>` +
    `</w:style>` +
    `</w:styles>`
  );
}

/**
 * Convert a PDF Uint8Array into a 1:1 editable Microsoft Word (.docx) Uint8Array.
 */
export async function convertPdfToDocx(pdfBytes, pdfjsLib, { onProgress = null } = {}) {
  const bytesCopy = pdfBytes instanceof Uint8Array ? pdfBytes.slice() : new Uint8Array(pdfBytes);

  const loadingTask = pdfjsLib.getDocument({
    data: bytesCopy,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: pdfjsLib.VerbosityLevel ? pdfjsLib.VerbosityLevel.ERRORS : 0,
  });

  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;

  let nextId = 1;
  let nextImgIndex = 1;
  const mediaEntries = [];
  const pageModels = [];
  let totalShapes = 0;
  let totalTextBoxes = 0;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });

    const { shapes, images, textColors } = await extractPageGraphics(
      page,
      viewport,
      pdfjsLib.OPS
    );
    const textBlocks = await extractPageTextBlocks(page, viewport, shapes, textColors);

    const runFragments = [];
    let zIndex = 251658240;

    for (const shape of shapes) {
      runFragments.push(buildVectorShapeRunXml(shape, nextId++, zIndex++));
      totalShapes++;
    }

    for (const img of images) {
      const fileName = `image${nextImgIndex}.png`;
      const rId = `rIdImg${nextImgIndex}`;
      nextImgIndex++;
      mediaEntries.push({ rId, fileName, bytes: img.pngBytes });
      runFragments.push(buildImageRunXml(img, rId, nextId++, zIndex++));
    }

    for (const blk of textBlocks) {
      runFragments.push(buildTextBoxRunXml(blk, nextId++, zIndex++));
      totalTextBoxes++;
    }

    pageModels.push({
      widthPt: viewport.width,
      heightPt: viewport.height,
      runsXml: runFragments.join(''),
    });

    if (typeof onProgress === 'function') {
      onProgress({ current: pageNum, total: numPages });
    }
  }

  try {
    await pdfDoc.destroy();
  } catch {
    // Ignore
  }

  const bodyParagraphs = [];
  for (let i = 0; i < pageModels.length; i++) {
    const curr = pageModels[i];
    const next = pageModels[i + 1];
    const isDifferentNextSize =
      next &&
      (Math.abs(curr.widthPt - next.widthPt) > 2 ||
        Math.abs(curr.heightPt - next.heightPt) > 2);

    const pPrParts = ['<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>'];
    if (i > 0) {
      const prev = pageModels[i - 1];
      const prevHadSectBreak =
        Math.abs(prev.widthPt - curr.widthPt) > 2 ||
        Math.abs(prev.heightPt - curr.heightPt) > 2;
      if (!prevHadSectBreak) {
        pPrParts.push('<w:pageBreakBefore/>');
      }
    }
    if (isDifferentNextSize) {
      pPrParts.push(buildSectionPrXml(curr.widthPt, curr.heightPt));
    }

    bodyParagraphs.push(`<w:p><w:pPr>${pPrParts.join('')}</w:pPr>${curr.runsXml}</w:p>`);
  }

  const lastPage = pageModels[pageModels.length - 1] || { widthPt: 612, heightPt: 792 };
  const finalSectPr = buildSectionPrXml(lastPage.widthPt, lastPage.heightPt);

  const documentXml =
    XML_HEADER +
    `<w:document ` +
    `xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" ` +
    `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
    `xmlns:o="urn:schemas-microsoft-com:office:office" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ` +
    `xmlns:v="urn:schemas-microsoft-com:vml" ` +
    `xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" ` +
    `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
    `xmlns:w10="urn:schemas-microsoft-com:office:word" ` +
    `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:w14="http://schemas.microsoft.com/office/2010/wordml" ` +
    `xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ` +
    `mc:Ignorable="w14 wp14">` +
    `<w:body>` +
    bodyParagraphs.join('') +
    finalSectPr +
    `</w:body>` +
    `</w:document>`;

  const zipEntries = [
    { name: '[Content_Types].xml', data: buildContentTypesXml(mediaEntries.length > 0) },
    { name: '_rels/.rels', data: buildRootRelsXml() },
    { name: 'word/_rels/document.xml.rels', data: buildDocumentRelsXml(mediaEntries) },
    { name: 'word/styles.xml', data: buildStylesXml() },
    { name: 'word/document.xml', data: documentXml },
    ...mediaEntries.map((m) => ({
      name: `word/media/${m.fileName}`,
      data: m.bytes,
    })),
  ];

  const docxBytes = await createZip(zipEntries);
  return {
    bytes: docxBytes,
    pageCount: numPages,
    stats: {
      shapes: totalShapes,
      textBoxes: totalTextBoxes,
      images: mediaEntries.length,
    },
  };
}
