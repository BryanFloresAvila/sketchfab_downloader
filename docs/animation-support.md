# Animation support: research, implementation and validation

## Observed failure

Starting at `999defc`, the Corgi model
`17ad827294ef44f6a6a50f652dd59311` decrypted successfully, but `download.js`
reported zero geometries and still wrote a GLB. Traversal only recognized
`osg.Node`, `osg.MatrixTransform` and `osg.Geometry`. The visible geometry is
inside a `Skeleton -> RigGeometry -> MorphGeometry` graph. Animation streams
are separate files under the model version's `/animations/` directory, not
beside `model_file.binz`.

## Primary sources consulted

- [OSG.js animation serializers](https://github.com/cedricpinson/osgjs/blob/master/sources/osgWrappers/serializers/osgAnimation.js):
  BoneMap, inverse binds, stacked transforms, SourceGeometry, morph targets and
  channel target names.
- [OSG.js hardware skinning](https://github.com/cedricpinson/osgjs/blob/master/sources/osgAnimation/RigTransformHardware.js)
  and [RigGeometry](https://github.com/cedricpinson/osgjs/blob/master/sources/osgAnimation/RigGeometry.js):
  skin matrix order and geometry-to-skeleton conversion.
- [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html):
  joints/weights, inverseBindMatrices, morph deltas, animation sampler shapes,
  normalized rotations and strictly increasing time inputs.
- The Corgi embed scene and its advertised animation stream, inspected during
  this implementation. The live viewer implements packed/compressed channels
  beyond upstream OSG.js. Its channel decoder was inspected in the viewer
  bundle whose SHA-256 cache name is
  `168460075440e9a33567dd9f17d7a8b8beb910fc4da4bbe496755f216e192214.js`.
  Source assets and viewer code are intentionally excluded from this repository.

## Mapping decisions

| Viewer data | glTF output |
| --- | --- |
| Skeleton/Bone children | Nodes with the original hierarchy |
| UpdateBone/UpdateMatrixTransform stacks | Ordered helper nodes, avoiding lossy matrix decomposition |
| BoneMap palette | `skin.joints` in the palette's numeric order |
| Bones/Weights attributes | `JOINTS_0` as unsigned shorts and normalized float `WEIGHTS_0` |
| Inverse bind in skeleton space | Source inverse bind multiplied by geometry-to-skeleton transform |
| Absolute morph geometry | POSITION/NORMAL/TANGENT deltas from the base mesh |
| Translation/scale/quaternion keys | LINEAR samplers targeting transform helper nodes |
| Independent scalar facial tracks | One weights sampler using the union of all key times |

Skin mesh nodes are scene roots: their source transform is already accounted for
in inverse binds, and glTF computes deformation from joint world transforms.
The optional Z-up conversion still transforms the joint hierarchy.

Packed vectors use planar component storage. For supported compressed channels,
mode bit 1 enables vector dequantization, bit 4 enables vector delta accumulation,
and bit 16 enables scalar/time delta accumulation. Origins are prepended before
cumulative reconstruction. Duplicate timestamps retain the last source key;
decreasing times, malformed dimensions and non-finite keys fail explicitly.
Quaternion keys are normalized and their signs made continuous. The inspected
viewer binds QuatSlerpChannel to shortest-path NLERP. Rotation curves are
adaptively sampled for glTF SLERP and component-NLERP readers (0.03 degree
subdivision target), while preserving source key orientations.

Binary reads copy the requested view, preserving Node Buffer offsets and source
data. This is essential when buffers are pooled or shared by base/morph meshes.
Missing resources and unsupported channel types are errors, not silently dropped
tracks. Existing WASM initialization fixes are unchanged.

## Corgi integration result

The scene contains 33 bone nodes; 32 are used in the skin palette. The exported
mesh contains 7,018 vertices (render vertices include attribute seams), 11 morph
targets and one animation named `Take 001`. The viewer labels that stream
`All Animations`; its duration is 66.333 seconds. The 110 source channels become
100 glTF channels because 11 facial channels are combined into one weights
channel. This does **not** create 20 separately named clips from the product's
marketing description.

The corrected main CLI produced approximately 5.9 MiB with one mesh, one skin,
one material and two embedded images. Its diffuse color uses DiffusePBR rather
than AlbedoPBR, which required a material fallback as part of this fix.

Validation performed:

- Synthetic regression suite with the real glTF validator, including skinning,
  morph deltas, packed/delta vectors, duplicate times, quaternion normalization,
  shared geometry instances, buffer offsets and expected failures.
- Khronos `gltf-validator` on the full Corgi GLB: zero errors and zero warnings.
- Blender 4.3.2 import and rendering at multiple points in the timeline, checking
  body deformation, facial shape keys, texture appearance and orientation.
- Static Courage regression (`2a0f4b27d69a419a8944fdc8e4067d3f`): 13 meshes,
  nine materials, one image, no skins/animations; zero validator errors/warnings.

## Current limits

This is support for the observed formats, not universal Sketchfab compatibility.
The converter rejects cubic Bézier tracks, non-spherical delta-compressed
quaternions, unsupported transform stack types, ambiguous targets, and moving
transforms between the skeleton and its mesh (which require baking). Only four
skin influences per vertex are supported. Source editor rigs, constraints and
animation clips not present in the viewer cannot be recovered by this pipeline.
The older standalone `osgjs2gltf.js` path has not been upgraded.

## Cartoon Animals collection compatibility

The 3DDisco collection exposed quaternion channel mode 28: planar spherical
axis/angle codes (bit 8), multiplicative orientation deltas (bit 4), and delta
timestamps (bit 16). The stored code width is three, while decoded quaternions
have four components. Decode the spherical axis using the viewer's epsilon and
nphi grid, decode the half-angle, prepend the origin orientation, then compose
each delta as `previous * delta`. Final rotations are normalized for glTF.

Differential validation against the current viewer's spherical decoder covered
1,026 channels and 77,887 keys, with maximum component difference below 1e-6.
Synthetic tests cover packed axes, the quaternion multiplication order and delta
timestamps. Zero-weight joint indices are canonicalized to zero to avoid
validator warnings without changing deformation.

## Collection motion audit, 2026-11-06

Schema validation does not establish visual motion fidelity. Reviewing all 126
clips found 81 with a first key at 0.04 or 0.0416667 seconds. OSG's animation
manager evaluates elapsed time plus `firstKeyTime` and uses end minus start as
the duration. Export now shifts every track by the same clip-wide origin,
retaining inter-channel offsets. Previously, players repeating from zero could
insert an extra pause. All 126 resulting durations match the public viewer
metadata within its three-decimal rounding (maximum error 0.000334 seconds).

There were 768 negative-dot adjacent quaternion pairs across all 14 animated
files. This is not itself invalid glTF, and compliant SLERP players already
handle them. Continuity improves compatibility with component interpolators.
Source NLERP versus exported SLERP differed by up to 3.629 degrees in the audit.
Adaptive sampling added 5,237 keys across 5,375 rotation tracks. Nine interior
points per resulting interval (399,955 intervals) were checked against the
source NLERP curve under both interpolation methods: maximum measured angular
error 0.030684 degrees. This is a sampled measurement, not a formal global bound.

`repair-animations.js input.glb output.glb` applies both changes to collection
files already exported. It preserves the original binary payload and appends
replacement animation accessors; unused old accessors may produce validator
informational messages. Supported inputs are this converter's GLBs with
non-sparse, non-interleaved float animation data and LINEAR rotations. It is
not a generic fixer for arbitrary rigs or clips. All 31 revised GLBs pass the
Khronos validator with zero errors and warnings; the 17 static GLBs are unchanged.

Independent comparison: Corpocore/sfrip commit
`2bb0b7594aeea9f979af035eccb8c6ad29586633` decoded the fox's six animations to
the same times and near-identical keys (maximum quaternion component-vector
distance below 5.6e-7). It emits a simpler skeleton, but still uses LINEAR
rotations and did not remove the observed sharp motion in Blender. Switching
converters is therefore not established as a complete remedy.

Remaining limitations: source endpoint poses can differ, so arbitrary looping
can still jump (fox Run tail ~7.55 degrees, hound Walk ~78.39 degrees). Those are
diagnostic flags, not proof of faulty authored motion. One-shot clips such as
Land and TakeOff must not be made cyclic blindly. The live Sketchfab viewer
failed to initialize in this environment; cached viewer code, public metadata,
decoded curves and Blender 4.3.2 were inspected instead. Visual validation did
not cover every clip. Full source .blend/GLB files from the author remain the
preferred basis for production animation editing.
