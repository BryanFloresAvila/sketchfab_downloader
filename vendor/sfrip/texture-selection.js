'use strict';
// Adapted from Corpocore/sfrip 2bb0b75, lib/sf-api.js. See LICENSE.
function readPk(tex, im) {
  const own = im && Object.prototype.hasOwnProperty.call(im, "pk") ? im.pk : undefined;
  const raw = own === undefined ? tex && tex.pk : own;
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Whether a protected variant can actually be descrambled.
 *
 * The viewer only ever uploads power-of-two textures — WebGL1 needs them for
 * mipmapping and REPEAT wrapping — so those are the only variants its
 * protection shader is ever asked to reverse, and the only ones scrambled in a
 * form that reverses. Sketchfab also keeps the raw upload at its original
 * size; that copy is stored scrambled but nothing ever unscrambles it, and
 * running the shader's permutation over it yields a patchwork.
 *
 * The permutation shuffles pixels within 8x8 tiles over a
 * floor(w/8) x floor(h/8) grid while wrapping indices modulo w*h, so an
 * off-grid size is not even a bijection: at 800x100 it reads 3040 pixels twice
 * and never reads 6368 others. Power-of-two rules that out too.
 */
function isDescramblable(im, texPk) {
  if (!im) return false;
  if (readPk({ pk: texPk }, im) == null) return true; // never scrambled
  const w = im.width || 0;
  const h = im.height || 0;
  if (!w || !h) return true;
  return isPowerOfTwo(w) && isPowerOfTwo(h);
}

function imageEdge(im) {
  return Math.max(im && im.width ? im.width : 0, im && im.height ? im.height : 0);
}

/**
 * Variants carrying `options` (format/quality) were re-encoded by Sketchfab's
 * image pipeline. They are NOT the bytes `pk` was computed against — the
 * descramble permutation only reverses the original upload. Same dimensions,
 * same area, but running the shader over a re-encoded copy yields a patchwork
 * (and PNG re-encodes of a scrambled JPEG decode to near-flat noise).
 *
 * The original upload is the one with an empty `options` object, so it must
 * outrank an equally-sized re-encoded twin.
 */
function isReencoded(im) {
  const o = im && im.options;
  return !!o && Object.keys(o).length > 0;
}

function scoreImage(im) {
  const w = im.width || 0;
  const h = im.height || 0;
  const area = w * h || 0;
  const size = im.size || 0;
  const url = (im.url || "").toLowerCase();
  const isPng = url.endsWith(".png");
  return (
    area * 10 +
    (isPng ? 5 : 0) +
    Math.min(size, 1e9) / 1e12 -
    (isReencoded(im) ? 1000 : 0)
  );
}

/**
 * Pick a texture variant.
 * maxEdge 0 / omitted = original (largest). Never downscale unless the
 * caller explicitly passes 2048 or 4096.
 */
function pickBestImage(images, maxEdge, texPk = null) {
  if (!images || !images.length) return null;
  const edge = maxEdge === 2048 || maxEdge === 4096 ? maxEdge : 0;
  const usable = [];
  for (const im of images) {
    const w = im.width || 0;
    const h = im.height || 0;
    if (w > 0 && h > 0 && (w < 32 || h < 32)) continue;
    usable.push(im);
  }
  let pool = usable.length ? usable : images.slice();
  const decodable = pool.filter((im) => isDescramblable(im, texPk));
  if (decodable.length) pool = decodable;
  if (!edge) {
    let best = null;
    for (const im of pool) {
      const score = scoreImage(im);
      if (!best || score > best._score) best = { ...im, _score: score };
    }
    return best;
  }
  const atMost = pool.filter((im) => imageEdge(im) <= edge);
  if (atMost.length) {
    let best = null;
    for (const im of atMost) {
      const score = scoreImage(im);
      if (!best || score > best._score) best = { ...im, _score: score };
    }
    return best;
  }
  let nearest = null;
  for (const im of pool) {
    const e = imageEdge(im);
    if (!e) continue;
    if (!nearest || e < imageEdge(nearest)) nearest = im;
  }
  return nearest ? { ...nearest } : null;
}


module.exports = {pickBestImage, isDescramblable};
