'use strict';
// Adapted from Corpocore/sfrip 2bb0b75, lib/orm.js. See LICENSE.
function baseName(filename) {
  return String(filename || "")
    .split("/")
    .pop()
    .split("?")[0];
}

/** @param {string} filename */
function stemOf(filename) {
  return baseName(filename)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
}

/**
 * True when a filename denotes an already-packed ORM/MRAO texture, as opposed
 * to a single-channel `*_metallic` / `*_roughness` map.
 *
 * classifyTextureName() answers 'metalrough' for both, which is why binding on
 * that alone is not safe.
 *
 * @param {string} filename
 * @returns {boolean}
 */
function isPackedOrmName(filename) {
  const stem = stemOf(filename);
  if (!stem) return false;
  const packed = stem.replace(/[^a-z0-9]+/g, "");
  if (/metallicroughness|metalroughness|metalrough|mrao|occlusionroughnessmetallic/.test(packed)) {
    return true;
  }
  // "arm" (AO/Roughness/Metallic) is a real packing convention, but it is also
  // a body part, and a false positive here rebinds a metal-only map as if it
  // were packed — the exact mirror bug this module exists to prevent. A false
  // negative only costs some roughness detail, so the ambiguous token is out.
  return /(?:^|[_-])(orm|rma)(?:[_-]|$)/.test(stem);
}


function packOrmPixels(opts) {
  const { width, height } = opts;
  const n = width * height;
  if (!(n > 0)) throw new Error("packOrmPixels: bad dimensions");

  const metal = opts.metal || null;
  const rough = opts.rough || null;
  const ao = opts.ao || null;
  const invert = !!opts.invertRough;
  // Non-metal and fairly rough is the safe default for a missing channel.
  const metalFallback = clamp255(opts.metalFallback != null ? opts.metalFallback : 0);
  const roughFallback = clamp255(opts.roughFallback != null ? opts.roughFallback : 229);

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const r = rough ? rough[p] : roughFallback;
    out[p] = ao ? ao[p] : 255;
    out[p + 1] = invert ? 255 - r : r;
    out[p + 2] = metal ? metal[p] : metalFallback;
    out[p + 3] = 255;
  }
  return out;
}

function clamp255(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 255 ? 255 : n | 0;
}


module.exports = {packOrmPixels, isPackedOrmName};
