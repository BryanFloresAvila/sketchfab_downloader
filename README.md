# Sketchfab Downloader

Download 3D models from Sketchfab's embed viewer and convert them to glTF 2.0 (`.glb`).

Handles the full pipeline: encrypted `.binz` decryption, `osgjs` scene graph parsing, texture descrambling, and PBR material assembly.

## Usage

```bash
npm install
node download.js <sketchfab_url_or_uid> [output.glb]
```

```bash
# Full URL
node download.js https://sketchfab.com/3d-models/some-model-abc123def456

# Just the UID
node download.js abc123def456789abcdef0123456789a

# Custom output path
node download.js https://sketchfab.com/3d-models/some-model-abc123 my_model.glb
```

## Requirements

- Node.js 18+
- `sharp` (installed via npm, handles image decode/encode for texture descrambling)

## What it does

```
Sketchfab embed page
    │
    ├─ Extract model config (binz URLs, encryption keys, texture PKs)
    │
    ├─ Download encrypted .binz files
    │   ├─ file.binz          (scene graph)
    │   ├─ model_file.binz    (geometry)
    │   └─ model_file_wireframe.binz
    │
    ├─ Decrypt via WASM module
    │   ├─ XOR key derivation (static key + per-model diter.b)
    │   ├─ Web Worker protocol replication
    │   └─ Gunzip decompression
    │
    ├─ Download & descramble textures
    │   ├─ 8×8 block diagonal zigzag permutation
    │   ├─ Per-block rotation (4 orientations)
    │   └─ pk-seeded pixel offset
    │
    ├─ Decode osgjs geometry
    │   ├─ Varint + zigzag decoding
    │   ├─ Triangle strip → triangle list
    │   ├─ Parallelogram vertex prediction
    │   ├─ Spherical normal/tangent decode
    │   └─ Quantized vertex/UV dequantization
    │
    └─ Output .glb with PBR material
        ├─ Albedo, metalness, roughness textures
        ├─ Normal map, emissive map
        └─ Positions, normals, tangents, UVs, colors
```

## Individual scripts

| Script | Purpose |
|--------|---------|
| `download.js` | All-in-one: URL → `.glb` |
| `decrypt.js` | Decrypt `.binz` files only |
| `osgjs2gltf.js` | Convert decrypted osgjs → glTF |
| `descramble.py` | Descramble a single texture (Python) |

## Documentation

Full reverse engineering writeup in [`docs/sketchfab-binz-format.md`](docs/sketchfab-binz-format.md) covering:

- Embed page structure and model config extraction
- JS bundle identification and deobfuscation (webcrack, string array rotation)
- WASM decryption module (Rick Roll export names)
- Web Worker communication protocol
- osgjs binary format (varint, parallelogram prediction, spherical normals)
- GPU texture descramble shader (block zigzag + pk offset)
- UV coordinate conventions (OpenGL → glTF V-flip)

## Notes

- `decrypt.wasm` is automatically extracted from Sketchfab's viewer JS bundles on first run. No manual setup needed.
- Texture descrambling requires `sharp`. Without it, the script falls back to using scrambled textures and prints a warning.
- Cached downloads are stored in `.cache/` and reused on subsequent runs for the same model.

## License

MIT

## Viewer compatibility fixes

This fork fixes `WASM abort` with viewer builds that re-export the static key
from a CommonJS asset module. A fresh WASM decoder uses request ID `0` for key
initialization, rather than the random transport seed.

Material channels are parsed as complete JSON objects. Disabled normal maps no
longer borrow an enabled flag or texture from neighboring channels. Color-only
materials, base colors, metalness, glossiness-derived roughness, and double-sided
settings are retained. Viewer JavaScript bundles are cached by their full URL.

For networks that require the proxy support provided by curl:

```bash
SKETCHFAB_HTTP=curl node download.js <model-url-or-uid> output.glb
```

For models whose source coordinates are Z-up, explicitly request conversion to
glTF Y-up. The default preserves existing orientation behavior:

```bash
SKETCHFAB_HTTP=curl SKETCHFAB_UP_AXIS=Z node download.js <model-url-or-uid> output.glb
```

Run regression tests with `node --test`. The fixes were exercised on the Courage
model (`2a0f4b27d69a419a8944fdc8e4067d3f`): 13 meshes, 9 materials, one embedded
color image, and no normal map, skin, or animation. Import/render was checked in
Blender. This is not a guarantee of compatibility with every model or future
viewer build. Model assets and viewer bundles are not included in the source.
