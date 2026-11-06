#!/usr/bin/env node
'use strict';
const fs = require('fs');
const {compatibleRotations} = require('./rotation-compat');

function repairAnimations(bytes) {
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2)
    throw new Error('Expected a glTF 2.0 GLB');
  const jsonSize = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonSize));
  const original = bytes.subarray(28 + jsonSize, 28 + jsonSize + gltf.buffers[0].byteLength);
  const chunks = [original, Buffer.alloc((-original.length >>> 0) % 4)];
  let offset = chunks.reduce((sum, b) => sum + b.length, 0);
  function read(index) {
    const a = gltf.accessors[index], v = gltf.bufferViews[a.bufferView];
    if (a.componentType !== 5126 || a.sparse || v.byteStride) throw new Error('Unsupported rotation accessor');
    const width = a.type === 'VEC4' ? 4 : a.type === 'SCALAR' ? 1 : 0;
    if (!width) throw new Error('Unsupported rotation shape');
    const result = new Float32Array(a.count * width), start = (v.byteOffset || 0) + (a.byteOffset || 0);
    for (let i = 0; i < result.length; i++) result[i] = original.readFloatLE(start + i * 4);
    return result;
  }
  function add(values, width) {
    const data = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    const view = gltf.bufferViews.push({buffer: 0, byteOffset: offset, byteLength: data.length}) - 1;
    chunks.push(data); offset += data.length;
    const accessor = {bufferView: view, componentType: 5126, count: values.length / width,
      type: width === 4 ? 'VEC4' : 'SCALAR'};
    if (width === 1) {accessor.min = [values[0]]; accessor.max = [values[values.length - 1]];}
    return gltf.accessors.push(accessor) - 1;
  }
  const stats = {rotationTracks: 0, flippedKeys: 0, addedKeys: 0, shiftedClips: 0};
  for (const animation of gltf.animations || []) {
    const sourceTimes = animation.samplers.map(s => read(s.input));
    const sourceStart = Math.min(...sourceTimes.map(t => t[0]));
    const shiftedTimes = sourceTimes.map(t => Float32Array.from(t, v => v - sourceStart));
    if (sourceStart > 0) stats.shiftedClips++;
    animation.extras = {...animation.extras,
      sourceStartTime: animation.extras?.sourceStartTime ?? sourceStart};
    const done = new Set();
    for (const channel of animation.channels) {
      if (channel.target.path !== 'rotation' || done.has(channel.sampler)) continue;
      done.add(channel.sampler);
      const sampler = animation.samplers[channel.sampler];
      if (sampler.interpolation && sampler.interpolation !== 'LINEAR') throw new Error('Expected a source LINEAR track');
      const fixed = compatibleRotations(shiftedTimes[channel.sampler], read(sampler.output));
      sampler.input = add(fixed.times, 1); sampler.output = add(fixed.values, 4);
      stats.rotationTracks++; stats.flippedKeys += fixed.flippedKeys; stats.addedKeys += fixed.addedKeys;
    }
    if (sourceStart > 0)
      for (let i = 0; i < animation.samplers.length; i++)
        if (!done.has(i)) animation.samplers[i].input = add(shiftedTimes[i], 1);
  }
  gltf.asset.generator = 'sketchfab-downloader (clip time origin, continuous rotations, adaptive viewer NLERP)';
  gltf.buffers[0].byteLength = offset;
  gltf.asset.extras = {...gltf.asset.extras, rotationCompatibility: {source: 'shortest-path NLERP',
    toleranceDegrees: 0.03, preservesSourceKeyPoses: true, timeline: 'source times minus clip start'}};
  const rawJson = Buffer.from(JSON.stringify(gltf));
  const json = Buffer.alloc(Math.ceil(rawJson.length / 4) * 4, 32);rawJson.copy(json);
  const bin = Buffer.concat(chunks), head = Buffer.alloc(20), binHead = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67);head.writeUInt32LE(2,4);head.writeUInt32LE(28+json.length+bin.length,8);
  head.writeUInt32LE(json.length,12);head.writeUInt32LE(0x4e4f534a,16);
  binHead.writeUInt32LE(bin.length);binHead.writeUInt32LE(0x004e4942,4);
  return {bytes: Buffer.concat([head,json,binHead,bin]), stats};
}
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || input === output) throw new Error('Usage: node repair-animations.js input.glb output.glb');
  const result = repairAnimations(fs.readFileSync(input));fs.writeFileSync(output,result.bytes);
  console.log(JSON.stringify(result.stats));
}
module.exports = {repairAnimations};
