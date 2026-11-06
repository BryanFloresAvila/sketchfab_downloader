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
Quaternion keys are normalized. glTF LINEAR rotations use slerp; interpolation
may differ slightly from viewer builds that approximate it using nlerp.

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
The converter rejects cubic Bézier tracks, spherical or delta-compressed
quaternions, unsupported transform stack types, ambiguous targets, and moving
transforms between the skeleton and its mesh (which require baking). Only four
skin influences per vertex are supported. Source editor rigs, constraints and
animation clips not present in the viewer cannot be recovered by this pipeline.
The older standalone `osgjs2gltf.js` path has not been upgraded.
