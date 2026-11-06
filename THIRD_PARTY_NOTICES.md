# Third-party code and adaptations

This repository includes portions of [Corpocore/sfrip](https://github.com/Corpocore/sfrip),
pinned to commit `2bb0b7594aeea9f979af035eccb8c6ad29586633`.

Copyright (c) 2026 sfrip contributors. Used under the MIT license; the full notice
and permission text is retained in [vendor/sfrip/LICENSE](vendor/sfrip/LICENSE).

| Local file | Upstream source | Adaptation |
| --- | --- | --- |
| `vendor/sfrip/texture-selection.js` | `lib/sf-api.js` | Texture-variant selection helpers, CommonJS exports |
| `vendor/sfrip/orm.js` | `lib/orm.js` | Pixel packing and clamping helpers, CommonJS exports |
| `materials.js`, `viewer-config.js` | `lib/sf-api.js`, `lib/osgjs2gltf.js` | Adapted StateSet ordinal binding, extension enable gates, sparse texture units, wrap modes and UV-transform conventions |

`textures.js` integrates the pixel helpers with the project's existing Sharp
dependency and descrambler. Network handling, the conservative static-mesh
merger, CLI parsing and external-file writer are local implementations of
features also provided by sfrip. No upstream WASM binaries, model files,
textures or viewer JavaScript are included in this contribution.

The local skeletal/morph animation pipeline remains in use, including the
clip-time-origin and quaternion-interpolation fixes.
