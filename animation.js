"use strict";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const meta = (o) =>
  Object.fromEntries(
    (o.UserDataContainer?.Values || []).map((v) => [v.Name, Number(v.Value)]),
  );
function multiply(a, b) {
  const r = Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++)
        r[c * 4 + row] += a[k * 4 + row] * b[c * 4 + k];
  return r;
}
function quaternion(q) {
  const n = Math.hypot(...q);
  if (!Number.isFinite(n) || n < 1e-12) throw new Error("Invalid quaternion");
  return q.map((v) => v / n);
}
function matrixOf(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1],
    s = n.scale || [1, 1, 1];
  const m = [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    0,
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    0,
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
    0,
    ...(n.translation || [0, 0, 0]),
    1,
  ];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] *= s[c];
  return m;
}
function visitObjects(value, fn, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  fn(value);
  for (const child of Object.values(value)) visitObjects(child, fn, seen);
}
function referencedBuffers(scene) {
  const files = new Set();
  visitObjects(scene, (o) => {
    if (o.Array)
      for (const d of Object.values(o.Array)) if (d.File) files.add(d.File);
  });
  return [...files];
}
function collectAnimatedScene(
  scene,
  { processGeom, readBuf, polyBin, wireBin, buffers },
) {
  const nodes = [],
    roots = [],
    geometries = [],
    skins = [],
    clips = [],
    targets = new Map(),
    morphs = new Map();
  function add(n, parent) {
    const id = nodes.push(n) - 1;
    if (parent === null) roots.push(id);
    else (nodes[parent].children ||= []).push(id);
    return id;
  }
  function read(def) {
    if (Array.isArray(def)) return Float32Array.from(def);
    if (!def) throw new Error("Missing animation/skin buffer");
    if (def.Elements) return Float32Array.from(def.Elements);
    const [type, data] = Object.entries(def.Array || {})[0] || [];
    if (!data) throw new Error("Missing buffer array");
    const file = data.File;
    const bin =
      file === "model_file.binz" || file === "model_file.bin"
        ? polyBin
        : file?.includes("wireframe")
          ? wireBin
          : buffers[file];
    if (!bin && !data.Elements)
      throw new Error(`Missing binary resource: ${file}`);
    return readBuf(bin, data, def.ItemSize || 1, type);
  }
  function bindTarget(key, target) {
    if (targets.has(key)) throw new Error(`Ambiguous animation target: ${key}`);
    targets.set(key, target);
  }
  function walk(
    wrapped,
    parent = null,
    skeleton = null,
    relative = IDENTITY,
    path = [],
  ) {
    const entry = Object.entries(wrapped).find(
      ([k]) => k.startsWith("osg.") || k.startsWith("osgAnimation."),
    );
    if (!entry) throw new Error("Unsupported scene node");
    const [type, obj] = entry;
    if (
      type === "osgAnimation.RigGeometry" ||
      type === "osgAnimation.MorphGeometry" ||
      type === "osg.Geometry"
    ) {
      const source = obj.SourceGeometry
        ? Object.values(obj.SourceGeometry)[0]
        : obj;
      const g = processGeom(source);
      if (!g || !g.attributes.POSITION) return; // e.g. wireframe
      g.node = add({ name: source.Name || "mesh" }, parent);
      const count = g.attributes.POSITION.count;
      if (obj.SourceGeometry) {
        if (!skeleton) throw new Error("RigGeometry has no ancestor skeleton");
        const joint = read(obj.VertexAttributeList?.Bones),
          weight = read(obj.VertexAttributeList?.Weights);
        if (joint.length !== count * 4 || weight.length !== count * 4)
          throw new Error("Only four influences per vertex are supported");
        const palette = Object.entries(obj.BoneMap || {}).sort(
          (a, b) => a[1] - b[1],
        );
        if (!palette.length || palette.some(([, index], i) => index !== i))
          throw new Error("Invalid bone palette");
        const weights = new Float32Array(weight.length),
          joints = new Uint16Array(joint.length);
        for (let i = 0; i < count; i++) {
          let sum = 0;
          for (let j = 0; j < 4; j++) {
            const k = i * 4 + j;
            if (
              !Number.isInteger(joint[k]) ||
              joint[k] < 0 ||
              joint[k] >= palette.length ||
              palette.length > 65536
            )
              throw new Error("Joint index out of range");
            if (!Number.isFinite(weight[k]) || weight[k] < 0)
              throw new Error("Invalid skin weight");
            joints[k] = joint[k];
            sum += weight[k];
          }
          if (sum <= 0) throw new Error("Vertex has no skin influences");
          for (let j = 0; j < 4; j++)
            weights[i * 4 + j] = weight[i * 4 + j] / sum;
        }
        g.attributes.JOINTS_0 = {
          data: joints,
          count,
          itemSize: 4,
          componentType: 5123,
        };
        g.attributes.WEIGHTS_0 = { data: weights, count, itemSize: 4 };
        skins.push({ node: g.node, skeleton, palette, relative, path });
      }
      if (source.MorphTargets) {
        g.targets = [];
        g.targetNames = [];
        for (const wrappedTarget of source.MorphTargets) {
          const target = Object.values(wrappedTarget)[0];
          // Targets have no topology; decode using the base primitive list.
          const decoded = processGeom({
            ...target,
            PrimitiveSetList: source.PrimitiveSetList,
            UserDataContainer: {
              Values: [
                ...(target.UserDataContainer?.Values || []),
                ...["triangle_mode"].map((Name) => ({
                  Name,
                  Value: meta(source)[Name] || 0,
                })),
                {
                  Name: "attributes",
                  Value:
                    (meta(target).attributes || 0) |
                    ((meta(source).attributes || 0) & 16),
                },
              ],
            },
          });
          const delta = {};
          for (const name of ["POSITION", "NORMAL", "TANGENT"]) {
            const a = decoded?.attributes[name],
              b = g.attributes[name];
            if (!a || !b) continue;
            if (a.count !== count)
              throw new Error("Morph vertex count mismatch");
            const data = new Float32Array(count * 3);
            for (let i = 0; i < count; i++)
              for (let j = 0; j < 3; j++)
                data[i * 3 + j] =
                  a.data[i * a.itemSize + j] - b.data[i * b.itemSize + j];
            delta[name] = { data, count, itemSize: 3 };
          }
          if (!delta.POSITION) throw new Error("Morph target has no positions");
          const index = g.targets.length;
          g.targets.push(delta);
          g.targetNames.push(target.Name || `target_${index}`);
          const list = morphs.get(target.Name) || [];
          list.push({ node: g.node, index, count: source.MorphTargets.length });
          morphs.set(target.Name, list);
        }
      }
      geometries.push(g);
      return;
    }
    if (
      ![
        "osg.Node",
        "osg.MatrixTransform",
        "osgAnimation.Skeleton",
        "osgAnimation.Bone",
      ].includes(type)
    )
      throw new Error(`Unsupported scene node: ${type}`);
    let node = add({ name: obj.Name || type }, parent),
      local = IDENTITY;
    const callbacks = obj.UpdateCallbacks || [];
    const update = callbacks
      .map(
        (c) =>
          c["osgAnimation.UpdateBone"] ||
          c["osgAnimation.UpdateMatrixTransform"],
      )
      .find(Boolean);
    if (update) {
      // Separate nodes retain arbitrary stack order without decomposing matrices.
      for (const entry of update.StackedTransforms || []) {
        const [kind, st] = Object.entries(entry)[0];
        let transform = {},
          property;
        if (kind === "osgAnimation.StackedTranslate") {
          property = "translation";
          transform.translation = st.Translate;
        } else if (kind === "osgAnimation.StackedQuaternion") {
          property = "rotation";
          transform.rotation = quaternion(st.Quaternion);
        } else if (
          kind === "osgAnimation.StackedScale" ||
          kind === "osgAnimation.StackedScaleElement"
        ) {
          property = "scale";
          transform.scale = st.Scale;
        } else if (
          kind === "osgAnimation.StackedMatrix" ||
          kind === "osgAnimation.StackedMatrixElement"
        )
          transform.matrix = st.Matrix;
        else throw new Error(`Unsupported transform stack: ${kind}`);
        node = add(
          {
            name: `${obj.Name || update.Name}/${st.Name || kind}`,
            ...transform,
          },
          node,
        );
        local = multiply(local, matrixOf(transform));
        if (property)
          bindTarget(`${update.Name}\0${st.Name}`, { node, path: property });
        path = [...path, node];
      }
    } else if (obj.Matrix) {
      nodes[node].matrix = obj.Matrix;
      local = obj.Matrix;
      path = [...path, node];
    }
    relative = multiply(relative, local);
    if (type === "osgAnimation.Skeleton") {
      skeleton = { node, bones: new Map() };
      relative = IDENTITY;
      path = [];
    }
    if (type === "osgAnimation.Bone") {
      if (!skeleton || skeleton.bones.has(obj.Name))
        throw new Error("Missing skeleton or duplicate bone name");
      skeleton.bones.set(obj.Name, {
        node,
        inverse: obj.InvBindMatrixInSkeletonSpace,
      });
    }
    for (const child of obj.Children || [])
      walk(child, node, skeleton, relative, path);
  }
  walk(scene);
  if (!geometries.length)
    throw new Error(
      "No triangle geometries found; refusing to export an empty GLB",
    );
  visitObjects(scene, (o) => {
    if (o["osgAnimation.Animation"]) clips.push(o["osgAnimation.Animation"]);
  });
  return { nodes, roots, geometries, skins, clips, targets, morphs, read };
}

function decodeChannel(type, channel, read) {
  const m = meta(channel),
    mode = m.channel_mode || 0;
  if (
    !/^osgAnimation\.(Vec3Lerp|QuatSlerp|FloatLerp)Channel(CompressedPacked|Compressed|Packed)?$/.test(
      type,
    )
  )
    throw new Error(`Unsupported animation channel: ${type}`);
  const size = type.includes("Vec3") ? 3 : type.includes("Quat") ? 4 : 1,
    compressed = type.includes("Compressed"),
    packed = type.includes("Packed");
  if (size === 4 && mode & 8)
    throw new Error(
      "Spherical compressed quaternion channels are not supported",
    );
  function decode(def, width, isTime) {
    let data;
    if (Array.isArray(def) && typeof def[0] === "object") {
      const columns = def.map(read);
      data = new Float32Array(columns[0].length * columns.length);
      for (let i = 0; i < columns[0].length; i++)
        for (let j = 0; j < columns.length; j++)
          data[i * columns.length + j] = columns[j][i];
    } else data = Float32Array.from(read(def));
    if (packed && !isTime && width > 1) {
      const planar = data;
      data = new Float32Array(planar.length);
      const n = data.length / width;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < width; j++) data[i * width + j] = planar[i + n * j];
    }
    if (compressed && width === 3 && mode & 1)
      for (let i = 0; i < data.length; i++)
        data[i] =
          m[["bx", "by", "bz"][i % 3]] + data[i] * m[["hx", "hy", "hz"][i % 3]];
    if (compressed && mode & (width === 1 ? 16 : 4)) {
      if (width === 4)
        throw new Error("Delta quaternion channels are not supported");
      const out = new Float32Array(data.length + width);
      out.set(width === 1 ? [m.ot] : [m.ox, m.oy, m.oz]);
      for (let i = 0; i < data.length; i++) out[i + width] = out[i] + data[i];
      data = out;
    }
    return data;
  }
  let times = decode(channel.KeyFrames.Time, 1, true),
    values = decode(channel.KeyFrames.Key, size, false);
  if (
    !times.length ||
    values.length !== times.length * size ||
    [...times, ...values].some((v) => !Number.isFinite(v))
  )
    throw new Error("Invalid animation keys");
  const uniqueTimes = [],
    uniqueValues = [];
  for (let i = 0; i < times.length; i++) {
    if (times[i] < 0 || (i && times[i] < times[i - 1]))
      throw new Error(
        `Unordered animation time in ${channel.TargetName}/${channel.Name}`,
      );
    // OSG streams may repeat timestamps; glTF requires strict increase.
    // Keep the last key at that time, as the viewer does when advancing.
    if (i && times[i] === times[i - 1])
      uniqueValues.splice(uniqueValues.length - size, size);
    else uniqueTimes.push(times[i]);
    for (let j = 0; j < size; j++) uniqueValues.push(values[i * size + j]);
  }
  times = Float32Array.from(uniqueTimes);
  values = Float32Array.from(uniqueValues);
  if (size === 4)
    for (let i = 0; i < values.length; i += 4)
      values.set(quaternion(Array.from(values.subarray(i, i + 4))), i);
  return { times, values, size };
}
function sample(track, time) {
  const { times, values } = track;
  let lo = 0,
    hi = times.length - 1;
  if (time <= times[0]) return values[0];
  if (time >= times[hi]) return values[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  const a = (time - times[lo]) / (times[hi] - times[lo]);
  return values[lo] * (1 - a) + values[hi] * a;
}
function writeAnimationData(scene, gltf, addAccessor) {
  for (const skin of scene.skins) {
    const joints = [],
      inverse = [];
    for (const [name] of skin.palette) {
      const bone = skin.skeleton.bones.get(name);
      if (!bone || bone.inverse?.length !== 16)
        throw new Error(`Missing bone/bind matrix: ${name}`);
      joints.push(bone.node);
      inverse.push(...multiply(bone.inverse, skin.relative));
    }
    gltf.skins ||= [];
    gltf.nodes[skin.node].skin =
      gltf.skins.push({
        joints,
        skeleton: skin.skeleton.node,
        inverseBindMatrices: addAccessor(inverse, 5126, joints.length, 16),
      }) - 1;
  }
  for (const clip of scene.clips) {
    const animation = {
        name: clip.Name || "animation",
        samplers: [],
        channels: [],
      },
      weightTracks = new Map(),
      used = new Set();
    function emit(node, path, times, values, size) {
      const key = `${node}/${path}`;
      if (used.has(key)) throw new Error(`Duplicate animation target ${key}`);
      used.add(key);
      const sampler =
        animation.samplers.push({
          input: addAccessor(times, 5126, times.length, 1),
          output: addAccessor(values, 5126, values.length / size, size),
          interpolation: "LINEAR",
        }) - 1;
      animation.channels.push({ sampler, target: { node, path } });
    }
    for (const wrapped of clip.Channels || []) {
      const [type, c] = Object.entries(wrapped)[0],
        track = decodeChannel(type, c, scene.read);
      const target = scene.targets.get(`${c.TargetName}\0${c.Name}`);
      if (target) {
        if (track.size !== (target.path === "rotation" ? 4 : 3))
          throw new Error("Animation target arity mismatch");
        for (const skin of scene.skins)
          if (skin.path.includes(target.node)) {
            const initial = scene.nodes[target.node][target.path];
            if (
              track.values.some(
                (v, i) => Math.abs(v - initial[i % track.size]) > 1e-5,
              )
            )
              throw new Error(
                "Animated transform between skeleton and skin requires baking (not supported)",
              );
          }
        emit(target.node, target.path, track.times, track.values, track.size);
      } else if (scene.morphs.has(c.TargetName) && track.size === 1) {
        for (const target of scene.morphs.get(c.TargetName)) {
          const group = weightTracks.get(target.node) || {
            count: target.count,
            tracks: new Map(),
          };
          if (group.tracks.has(target.index))
            throw new Error("Duplicate morph channel");
          group.tracks.set(target.index, track);
          weightTracks.set(target.node, group);
        }
      } else
        throw new Error(
          `Unresolved animation target: ${c.TargetName}/${c.Name}`,
        );
    }
    for (const [node, group] of weightTracks) {
      const times = Float32Array.from(
        [
          ...new Set(
            [...group.tracks.values()].flatMap((t) => Array.from(t.times)),
          ),
        ].sort((a, b) => a - b),
      );
      const values = new Float32Array(times.length * group.count);
      for (let i = 0; i < times.length; i++)
        for (const [j, track] of group.tracks)
          values[i * group.count + j] = sample(track, times[i]);
      emit(node, "weights", times, values, 1);
    }
    if (animation.channels.length) (gltf.animations ||= []).push(animation);
  }
}
module.exports = {
  collectAnimatedScene,
  writeAnimationData,
  decodeChannel,
  referencedBuffers,
  multiply,
};
