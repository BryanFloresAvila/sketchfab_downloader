'use strict';

function dot(a, b) { return a.reduce((s, v, i) => s + v * b[i], 0); }
function normalize(q) {
  const length = Math.hypot(...q);
  if (!Number.isFinite(length) || length < 1e-12) throw new Error('Invalid rotation');
  return q.map(v => v / length);
}
function nlerp(a, b, t) {
  const sign = dot(a, b) < 0 ? -1 : 1;
  return normalize(a.map((v, i) => v * (1 - t) + sign * b[i] * t));
}
function slerp(a, b, t) {
  let d = dot(a, b);
  if (d < 0) { b = b.map(v => -v); d = -d; }
  if (d > 0.9999995) return nlerp(a, b, t);
  const theta = Math.acos(Math.min(1, d)), denominator = Math.sin(theta);
  const x = Math.sin((1 - t) * theta) / denominator;
  const y = Math.sin(t * theta) / denominator;
  return normalize(a.map((v, i) => x * v + y * b[i]));
}
function angleDegrees(a, b) {
  return 2 * Math.acos(Math.min(1, Math.abs(dot(normalize(a), normalize(b))))) * 180 / Math.PI;
}

// The live OSG viewer binds QuatSlerpChannel to createQuatChannel, which uses
// shortest-path NLERP. Preserve that curve with adaptive samples for glTF's
// SLERP readers, and continuous quaternion signs for component-lerp readers.
function compatibleRotations(times, values, toleranceDegrees = 0.03) {
  if (!times.length || values.length !== times.length * 4) throw new Error('Invalid rotation track');
  if (!(toleranceDegrees > 0 && toleranceDegrees < 10)) throw new Error('Invalid rotation tolerance');
  const quats = [], outTimes = [times[0]], outValues = [];
  let flippedKeys = 0;
  for (let i = 0; i < times.length; i++) {
    if (i && !(times[i] > times[i - 1])) throw new Error('Rotation times must increase');
    let q = normalize(Array.from(values.subarray(i * 4, i * 4 + 4)));
    if (i && dot(quats[i - 1], q) < 0) { q = q.map(v => -v); flippedKeys++; }
    quats.push(q);
  }
  outValues.push(...quats[0]);
  for (let i = 1; i < times.length; i++) {
    const start = times[i - 1], duration = times[i] - start;
    const a = quats[i - 1], b = quats[i];
    function subdivide(left, right, ql, qr, depth) {
      let error = 0;
      for (const u of [0.25, 0.5, 0.75]) {
        const reference = nlerp(a, b, left + (right - left) * u);
        error = Math.max(error, angleDegrees(reference, slerp(ql, qr, u)),
          angleDegrees(reference, nlerp(ql, qr, u)));
      }
      const mid = (left + right) / 2, midTime = Math.fround(start + duration * mid);
      if (error > toleranceDegrees && depth < 16 &&
          midTime > Math.fround(start + duration * left) &&
          midTime < Math.fround(start + duration * right)) {
        const qm = nlerp(a, b, mid);
        subdivide(left, mid, ql, qm, depth + 1);
        subdivide(mid, right, qm, qr, depth + 1);
      } else {
        outTimes.push(right === 1 ? times[i] : Math.fround(start + duration * right));
        outValues.push(...qr);
      }
    }
    subdivide(0, 1, a, b, 0);
  }
  return {times: Float32Array.from(outTimes), values: Float32Array.from(outValues),
    size: 4, flippedKeys, addedKeys: outTimes.length - times.length};
}
module.exports = { compatibleRotations, nlerp, slerp, angleDegrees };
