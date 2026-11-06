"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { convertToGltf, readBuf } = require("../download");
const { decodeChannel, referencedBuffers } = require("../animation");
const { validateBytes } = require("gltf-validator");
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const arr = (data, itemSize = 1, type = "Float32Array") => ({
  ItemSize: itemSize,
  Array: { [type]: { Size: data.length / itemSize, Elements: data } },
});
const geometry = () => ({
  Name: "triangle",
  PrimitiveSetList: [
    {
      DrawElementsUInt: {
        Mode: "TRIANGLES",
        Indices: arr([0, 1, 2], 1, "Uint32Array"),
      },
    },
  ],
  VertexAttributeList: { Vertex: arr([0, 0, 0, 1, 0, 0, 0, 1, 0], 3) },
});
const callback = (name) => ({
  "osgAnimation.UpdateBone": {
    Name: name,
    StackedTransforms: [
      {
        "osgAnimation.StackedTranslate": {
          Name: "translate",
          Translate: [0, 0, 0],
        },
      },
    ],
  },
});
function track(type, target, name, key, size = 3, times = [0, 1]) {
  return {
    [type]: {
      TargetName: target,
      Name: name,
      KeyFrames: { Time: arr(times), Key: arr(key, size) },
    },
  };
}
function fixture() {
  const source = geometry();
  source.MorphTargets = [
    {
      "osg.Geometry": {
        Name: "smile",
        VertexAttributeList: { Vertex: arr([0, 0, 1, 1, 0, 1, 0, 1, 1], 3) },
      },
    },
  ];
  return {
    "osg.Node": {
      Children: [
        {
          "osgAnimation.Skeleton": {
            Children: [
              {
                "osgAnimation.Bone": {
                  Name: "bone",
                  Matrix: I,
                  InvBindMatrixInSkeletonSpace: I,
                  UpdateCallbacks: [callback("bone-target")],
                },
              },
              {
                "osgAnimation.RigGeometry": {
                  BoneMap: { bone: 0 },
                  SourceGeometry: { "osgAnimation.MorphGeometry": source },
                  VertexAttributeList: {
                    Bones: arr(Array(12).fill(0), 4, "Uint16Array"),
                    Weights: arr([2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0], 4),
                  },
                },
              },
            ],
          },
        },
      ],
      UpdateCallbacks: [
        {
          "osgAnimation.BasicAnimationManager": {
            Animations: [
              {
                "osgAnimation.Animation": {
                  Name: "move",
                  Channels: [
                    track(
                      "osgAnimation.Vec3LerpChannel",
                      "bone-target",
                      "translate",
                      [0, 0, 0, 0, 2, 0],
                    ),
                    track(
                      "osgAnimation.FloatLerpChannel",
                      "smile",
                      "0",
                      [0, 1],
                      1,
                    ),
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}
function convert(scene) {
  const bytes = convertToGltf(scene, Buffer.alloc(0), null, {});
  const size = bytes.readUInt32LE(12),
    json = JSON.parse(bytes.subarray(20, 20 + size));
  return { bytes, json, bin: bytes.subarray(28 + size) };
}
function values(result, index) {
  const a = result.json.accessors[index],
    v = result.json.bufferViews[a.bufferView];
  return Array.from(
    new Float32Array(
      Uint8Array.from(
        result.bin.subarray(v.byteOffset, v.byteOffset + v.byteLength),
      ).buffer,
    ),
  );
}

test("skinned geometry, bind matrices, morph deltas and tracks produce valid glTF", async () => {
  const r = convert(fixture()),
    j = r.json;
  assert.equal(j.skins.length, 1);
  assert.equal(j.skins[0].joints.length, 1);
  assert.deepEqual(values(r, j.skins[0].inverseBindMatrices), I);
  const p = j.meshes[0].primitives[0];
  assert.deepEqual(
    values(r, p.attributes.WEIGHTS_0),
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  );
  assert.deepEqual(
    values(r, p.targets[0].POSITION),
    [0, 0, 1, 0, 0, 1, 0, 0, 1],
  );
  assert.equal(j.animations[0].channels.length, 2);
  assert.deepEqual(
    j.animations[0].channels.map((c) => c.target.path),
    ["translation", "weights"],
  );
  const report = await validateBytes(new Uint8Array(r.bytes));
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues));
});
test("compressed planar vectors unpack, dequantize and accumulate their origin", () => {
  const c = {
    TargetName: "b",
    Name: "translate",
    UserDataContainer: {
      Values: Object.entries({
        channel_mode: 21,
        ox: 1,
        oy: 2,
        oz: 3,
        ot: 0,
        bx: 0,
        by: 0,
        bz: 0,
        hx: 1,
        hy: 1,
        hz: 1,
      }).map(([Name, Value]) => ({ Name, Value })),
    },
    KeyFrames: { Time: [0.5, 0.5], Key: [2, 3, 4, 5, 6, 7] },
  };
  const t = decodeChannel(
    "osgAnimation.Vec3LerpChannelCompressedPacked",
    c,
    Float32Array.from.bind(Float32Array),
  );
  assert.deepEqual(Array.from(t.times), [0, 0.5, 1]);
  assert.deepEqual(Array.from(t.values), [1, 2, 3, 3, 6, 9, 6, 11, 16]);
});
test("clip time origin is removed once for all channels, retaining their offsets", () => {
  const scene = fixture();
  const channels = scene['osg.Node'].UpdateCallbacks[0]['osgAnimation.BasicAnimationManager']
    .Animations[0]['osgAnimation.Animation'].Channels;
  channels[0]['osgAnimation.Vec3LerpChannel'].KeyFrames.Time = arr([2, 3]);
  channels[1]['osgAnimation.FloatLerpChannel'].KeyFrames.Time = arr([2.25, 3]);
  const r = convert(scene), animation = r.json.animations[0];
  assert.equal(animation.extras.sourceStartTime, 2);
  assert.deepEqual(values(r, animation.samplers[0].input), [0, 1]);
  assert.deepEqual(values(r, animation.samplers[1].input), [0.25, 1]);
  assert.deepEqual(values(r, animation.samplers[1].output), [0, 1]);
});
test("existing GLB repair shifts all input tracks and preserves nonrotation payloads", async () => {
  const {repairAnimations} = require('../repair-animations');
  const r = convert(fixture());
  // Build a legacy file whose two input tracks start at 2 and 2.25 seconds.
  const animation = r.json.animations[0];
  for (let i = 0; i < animation.samplers.length; i++) {
    const input = r.json.accessors[animation.samplers[i].input];
    const view = r.json.bufferViews[input.bufferView];
    r.bin.writeFloatLE(i ? 2.25 : 2, view.byteOffset);
    r.bin.writeFloatLE(3, view.byteOffset + 4);
    input.min = [i ? 2.25 : 2]; input.max = [3];
  }
  delete animation.extras;
  const raw = Buffer.from(JSON.stringify(r.json)), json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32);
  raw.copy(json);
  const head = Buffer.from(r.bytes.subarray(0, 20));
  head.writeUInt32LE(28 + json.length + r.bin.length, 8);head.writeUInt32LE(json.length, 12);
  const binHead = Buffer.alloc(8);binHead.writeUInt32LE(r.bin.length);binHead.writeUInt32LE(0x004e4942, 4);
  const fixed = repairAnimations(Buffer.concat([head, json, binHead, r.bin])), size = fixed.bytes.readUInt32LE(12);
  const result = {json: JSON.parse(fixed.bytes.subarray(20, 20 + size)), bin: fixed.bytes.subarray(28 + size)};
  const samplers = result.json.animations[0].samplers;
  assert.equal(fixed.stats.shiftedClips, 1);
  assert.equal(result.json.animations[0].extras.sourceStartTime, 2);
  assert.deepEqual(values(result, samplers[0].input), [0, 1]);
  assert.deepEqual(values(result, samplers[1].input), [0.25, 1]);
  assert.deepEqual(result.json.meshes, r.json.meshes);
  assert.deepEqual(result.json.skins, r.json.skins);
  assert.equal(result.bin.subarray(0, r.bin.length).compare(r.bin), 0);
  const validation = await validateBytes(new Uint8Array(fixed.bytes));
  assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues));
});
test("duplicate times retain last key; quaternion keys normalize", () => {
  const c = {
    TargetName: "b",
    Name: "rotate",
    KeyFrames: { Time: [0, 0, 1], Key: [0, 0, 0, 2, 0, 0, 2, 0, 0, 0, 0, 2] },
  };
  const t = decodeChannel(
    "osgAnimation.QuatSlerpChannel",
    c,
    Float32Array.from.bind(Float32Array),
  );
  assert.deepEqual(Array.from(t.times), [0, 1]);
  assert.deepEqual(Array.from(t.values), [0, 0, 1, 0, 0, 0, 0, 1]);
});
test("unused skin influences use joint zero without changing weighted joints", async () => {
  const scene = fixture();
  const children = scene['osg.Node'].Children[0]['osgAnimation.Skeleton'].Children;
  children.push({'osgAnimation.Bone': {Name: 'unused', Matrix: I, InvBindMatrixInSkeletonSpace: I}});
  const rig = children[1]['osgAnimation.RigGeometry'];
  rig.BoneMap.unused = 1;
  rig.VertexAttributeList.Bones = arr([0,1,1,1,0,1,1,1,0,1,1,1],4,'Uint16Array');
  const result = convert(scene);
  const report = await validateBytes(new Uint8Array(result.bytes));
  assert.equal(report.issues.numErrors,0);
  assert.equal(report.issues.numWarnings,0);
});
test("static merging preserves skinned meshes, morph targets and animation bindings", async () => {
  const bytes = convertToGltf(fixture(), Buffer.alloc(0), null, {}, {}, {merge:'groups'});
  const size=bytes.readUInt32LE(12),j=JSON.parse(bytes.subarray(20,20+size));
  assert.equal(j.skins.length,1);assert.equal(j.meshes.length,1);
  assert.equal(j.meshes[0].primitives[0].targets.length,1);
  assert.equal(j.animations[0].channels.length,2);
  const report=await validateBytes(new Uint8Array(bytes));
  assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));
});
test("spherical quaternion codes unpack three components and retain rotations", () => {
  const c = {
    TargetName: "bone", Name: "rotate",
    UserDataContainer: {Values: [{Name: "channel_mode", Value: "8"}]},
    // Two planar codes for rotations about Z: zero and almost pi radians.
    KeyFrames: {Time: [0, 1], Key: [0, 0, 0, 0, 0, 32767]},
  };
  const t = decodeChannel("osgAnimation.QuatSlerpChannelCompressedPacked", c,
    Float32Array.from.bind(Float32Array));
  assert.equal(t.values.length, 8);
  assert.deepEqual(Array.from(t.values.subarray(0, 4)), [0, 0, 0, 1]);
  const a = 32767 * 0.000047938362584151635;
  assert.ok(Math.abs(t.values[6] - Math.sin(a)) < 1e-7);
  assert.ok(Math.abs(t.values[7] - Math.cos(a)) < 1e-7);
});
test("spherical deltas multiply the origin quaternion in the correct order", () => {
  const c = {
    TargetName: "bone", Name: "rotate",
    UserDataContainer: {Values: Object.entries({channel_mode: 28,
      ox: Math.SQRT1_2, oy: 0, oz: 0, ow: Math.SQRT1_2, ot: 2
    }).map(([Name, Value]) => ({Name, Value: String(Value)}))},
    KeyFrames: {Time: [0.5, 0.5], Key: [0, 0, 0, 0, 16384, 16384]},
  };
  const t = decodeChannel("osgAnimation.QuatSlerpChannelCompressedPacked", c,
    Float32Array.from.bind(Float32Array));
  assert.deepEqual(Array.from(t.times), [2, 2.5, 3]);
  const half = 16384 * 0.000047938362584151635;
  for (let i = 0; i < 3; i++) {
    const expected = [Math.SQRT1_2 * Math.cos(i*half),
      -Math.SQRT1_2 * Math.sin(i*half), Math.SQRT1_2 * Math.sin(i*half),
      Math.SQRT1_2 * Math.cos(i*half)];
    expected.forEach((v, j) => assert.ok(Math.abs(t.values[i*4+j] - v) < 1e-6));
  }
});
test("out of order and unsupported channels fail explicitly", () => {
  const c = {
    TargetName: "b",
    Name: "translate",
    KeyFrames: { Time: [1, 0], Key: [0, 0, 0, 1, 1, 1] },
  };
  assert.throws(
    () =>
      decodeChannel(
        "osgAnimation.Vec3LerpChannel",
        c,
        Float32Array.from.bind(Float32Array),
      ),
    /Unordered/,
  );
  assert.throws(
    () => decodeChannel("osgAnimation.Vec3CubicBezierChannel", c, () => []),
    /Unsupported/,
  );
});
test("buffer reader respects pooled byte offsets, alignment and never mutates source", () => {
  const bytes = Buffer.alloc(20);
  bytes.writeFloatLE(3.5, 3);
  bytes.writeFloatLE(7.5, 7);
  const data = readBuf(bytes.subarray(3, 11), { Size: 2 }, 1, "Float32Array");
  assert.deepEqual(Array.from(data), [3.5, 7.5]);
  data[0] = 99;
  assert.equal(bytes.readFloatLE(3), 3.5);
  assert.throws(
    () => readBuf(bytes, { Size: 100 }, 1, "Float32Array"),
    /Truncated/,
  );
  assert.throws(
    () =>
      readBuf(
        Buffer.from([128]),
        { Size: 1, Encoding: "varint" },
        1,
        "Uint32Array",
      ),
    /varint/,
  );
});
test("static instanced geometry retains both placements and shared data", async () => {
  const g = geometry();
  g.UniqueID = 5;
  const translated = I.slice();
  translated[12] = 10;
  const r = convert({
    "osg.Node": {
      Children: [
        {
          "osg.MatrixTransform": {
            Matrix: translated,
            Children: [{ "osg.Geometry": g }],
          },
        },
        { "osg.Geometry": { UniqueID: 5 } },
      ],
    },
  });
  assert.equal(r.json.meshes.length, 2);
  assert.equal(r.json.animations, undefined);
  assert.ok(r.json.nodes.some((n) => n.matrix?.[12] === 10));
  assert.equal(
    (await validateBytes(new Uint8Array(r.bytes))).issues.numErrors,
    0,
  );
});
test("empty scenes, unresolved targets and invalid skin palettes fail", () => {
  assert.throws(() => convert({ "osg.Node": { Children: [] } }), /empty GLB/);
  let s = fixture();
  s["osg.Node"].UpdateCallbacks[0][
    "osgAnimation.BasicAnimationManager"
  ].Animations[0]["osgAnimation.Animation"].Channels[0][
    "osgAnimation.Vec3LerpChannel"
  ].TargetName = "missing";
  assert.throws(() => convert(s), /Unresolved/);
  s = fixture();
  s["osg.Node"].Children[0]["osgAnimation.Skeleton"].Children[1][
    "osgAnimation.RigGeometry"
  ].BoneMap.bone = 2;
  assert.throws(() => convert(s), /palette/);
});
test("morph tracks with different key times merge into one weights sampler", () => {
  const s = fixture(),
    rig =
      s["osg.Node"].Children[0]["osgAnimation.Skeleton"].Children[1][
        "osgAnimation.RigGeometry"
      ];
  const source = rig.SourceGeometry["osgAnimation.MorphGeometry"];
  source.MorphTargets.push({
    "osg.Geometry": {
      Name: "blink",
      VertexAttributeList: { Vertex: arr([0, 0, 2, 1, 0, 2, 0, 1, 2], 3) },
    },
  });
  s["osg.Node"].UpdateCallbacks[0][
    "osgAnimation.BasicAnimationManager"
  ].Animations[0]["osgAnimation.Animation"].Channels.push(
    track(
      "osgAnimation.FloatLerpChannel",
      "blink",
      "1",
      [0, 1, 0],
      1,
      [0, 0.5, 1],
    ),
  );
  const r = convert(s),
    a = r.json.animations[0],
    c = a.channels.find((c) => c.target.path === "weights"),
    sampler = a.samplers[c.sampler];
  assert.deepEqual(values(r, sampler.input), [0, 0.5, 1]);
  assert.deepEqual(values(r, sampler.output), [0, 0, 0.5, 1, 1, 0]);
});
test("external animation references are discovered once", () => {
  assert.deepEqual(
    referencedBuffers({
      a: arr([0]),
      b: { Array: { Float32Array: { File: "clip.bin.gz" } } },
      c: { Array: { Float32Array: { File: "clip.bin.gz" } } },
    }),
    ["clip.bin.gz"],
  );
});

test("skin bind matrices include the geometry-to-skeleton transform", () => {
  const s = fixture();
  const skeleton = s["osg.Node"].Children[0]["osgAnimation.Skeleton"];
  const rig = skeleton.Children.pop(),
    transform = I.slice();
  transform[12] = 5;
  skeleton.Children.push({
    "osg.MatrixTransform": { Matrix: transform, Children: [rig] },
  });
  const result = convert(s),
    skin = result.json.skins[0];
  assert.deepEqual(values(result, skin.inverseBindMatrices), transform);
  const meshNode = result.json.nodes.findIndex((n) => n.skin === 0);
  assert.ok(result.json.scenes[0].nodes.includes(meshNode));
  assert.equal(
    result.json.nodes.some((n) => n.children?.includes(meshNode)),
    false,
  );
});
test("animated transforms between skeleton and mesh are rejected instead of freezing skin", () => {
  const s = fixture(),
    skeleton = s["osg.Node"].Children[0]["osgAnimation.Skeleton"],
    rig = skeleton.Children.pop();
  skeleton.Children.push({
    "osg.MatrixTransform": {
      UpdateCallbacks: [callback("mesh-transform")],
      Children: [rig],
    },
  });
  s["osg.Node"].UpdateCallbacks[0][
    "osgAnimation.BasicAnimationManager"
  ].Animations[0]["osgAnimation.Animation"].Channels.push(
    track(
      "osgAnimation.Vec3LerpChannel",
      "mesh-transform",
      "translate",
      [0, 0, 0, 1, 0, 0],
    ),
  );
  assert.throws(() => convert(s), /requires baking/);
});
test("missing external animation streams fail with the resource name", () => {
  const s = fixture(),
    channels =
      s["osg.Node"].UpdateCallbacks[0]["osgAnimation.BasicAnimationManager"]
        .Animations[0]["osgAnimation.Animation"].Channels;
  channels[0]["osgAnimation.Vec3LerpChannel"].KeyFrames.Time = {
    ItemSize: 1,
    Array: { Float32Array: { File: "missing.bin.gz", Size: 2 } },
  };
  assert.throws(() => convert(s), /Missing binary resource: missing.bin.gz/);
});
