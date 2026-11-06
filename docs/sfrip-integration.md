# Importing missing sfrip capabilities

The integration keeps the existing decoder, skinning, morphs and animation
writer. It ports the missing texture/material behavior and adds compatible
download and output options. Source revision and attribution are recorded in
`THIRD_PARTY_NOTICES.md`; there is no new runtime dependency.

## Implemented

- Parse the public texture registry as JSON, including per-variant protection
  keys. Prefer a decodable original over a same-size re-encoded variant.
  Unprotected images bypass descrambling; protected unsupported dimensions
  fail explicitly. `--max-edge` resizes only after descrambling.
- Preserve material identity by StateSet document ordinal, with one inferred
  global offset for viewer-generated entries. Distinct source IDs retain
  distinct materials even when names repeat. Unresolved bindings are reported.
- Support AO, constant opacity, compatible separate opacity maps, gloss-to-
  roughness conversion, per-normal-map green-channel inversion, clearcoat,
  sheen, refraction transmission and emissive intensity. Disabled channels
  remain disabled. Texture units are remapped numerically; texture wrap modes
  are preserved. Shared image bytes are embedded once across samplers.
- Pack metalness/roughness at a common resolution with channel factors baked
  into the map. Different UV bindings are reported instead of silently packed.
- Retry transient HTTP failures, reject non-success responses, time out stalled
  native requests, follow relative redirects and cap response size. Texture
  downloads use a bounded pool (default three).
- Optionally group static primitives into meshes (`objects` or `groups`),
  preserving primitive/material boundaries and world placement. Transform
  normals with inverse transpose, correct mirrored winding and tangent signs,
  and remove obsolete empty nodes. Animated descendants, skinning, morphs and
  singular transforms are excluded from merging.
- Write an adjacent `.info.json` with source attribution, options, warnings,
  counts, clip durations and SHA-256. `--external` additionally writes glTF,
  its binary buffer and image files. Existing positional GLB commands work.

## Deliberate limits

The merge implementation is conservative and does not include sfrip's aggressive
`materials` or `all` modes. Point clouds, authored lines, punctual lights,
rest-pose skeleton removal, interactive menus and ZIP output were not imported.
No changes were made to the legacy standalone `osgjs2gltf.js` converter.

Like the inspected upstream converter, rotated nonuniform UV transforms are
approximated through `KHR_texture_transform` and reported. Separate opacity
maps with incompatible UV bindings are reported and omitted. Roughness textures
for the clearcoat/sheen extensions and complete specular-workflow conversion
are not supported; constant clearcoat/sheen roughness is retained. The external
binary currently retains redundant embedded-image byte ranges to preserve all
accessor offsets; images are nevertheless bound through external files.

The importer does not recover constraints or source authoring controls that
are absent from the viewer data. This integration is not a guarantee that every
source animation will look correct or form a seamless loop.

## Validation

- Automated regression tests cover pixel values, UV bindings, duplicate names,
  enabled extensions, mirrored/nonuniform transforms, animated merge exclusions,
  external resource loading, CLI validation, retry behavior and concurrency.
- All 31 Cartoon Animals collection models were reconverted from cached source
  geometry and freshly read viewer materials. Geometry arrays and topology
  match the prior revision; all 126 clips retain their channel bindings and
  sampled keys within float precision. All 31 pass Khronos validation without
  errors or warnings, and no material-binding warnings were emitted.
- The Corgi CLI preserves one skin, 11 morph targets, one animation and two
  images. GLB and external glTF both pass validation without errors/warnings.
- Courage's optional group merge reduces 13 meshes to 11 while retaining its
  image and materials. GLB and external glTF both pass validation.

Production assets used for integration checks are excluded from the repository.
