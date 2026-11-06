'use strict';

function readMaterials(html) {
    const marker = /"materials"\s*:\s*\{/g;
    let match;
    while ((match = marker.exec(html))) {
        const start = html.indexOf('{', match.index);
        let depth = 0, quoted = false, escaped = false;
        for (let i = start; i < html.length; i++) {
            const c = html[i];
            if (quoted) {
                if (escaped) escaped = false;
                else if (c === '\\') escaped = true;
                else if (c === '"') quoted = false;
            } else if (c === '"') quoted = true;
            else if (c === '{') depth++;
            else if (c === '}' && --depth === 0) {
                try {
                    const data = JSON.parse(html.slice(start, i + 1));
                    const entries = Object.entries(data).filter(([, v]) => v && v.name && v.channels);
                    if (entries.length) return Object.fromEntries(entries);
                } catch (_) { /* Continue searching other embedded JSON blocks. */ }
                break;
            }
        }
    }
    throw new Error('Could not parse source material JSON');
}

function extractExportedKey(js) {
    // Viewer builds may re-export the key from a CommonJS asset module.
    const match = js.match(/exports\s*=\s*["']([0-9a-f]{40})(?:\\n)?["']/);
    return match ? match[1] : null;
}

function materialProperties(name, source) {
    const c = source?.channels || {};
    const a = c.AlbedoPBR || {};
    const roughness = c.RoughnessPBR?.enable ? c.RoughnessPBR.factor
        : c.GlossinessPBR?.enable ? 1 - c.GlossinessPBR.factor : 1;
    return {
        name,
        doubleSided: source?.cullFace === 'DISABLE',
        pbrMetallicRoughness: {
            baseColorFactor: [...(a.color || [1, 1, 1]).map(v => v * (a.factor ?? 1)), 1],
            metallicFactor: c.MetalnessPBR?.enable ? (c.MetalnessPBR.factor ?? 1) : 0,
            roughnessFactor: Math.max(0, Math.min(1, roughness ?? 1))
        }
    };
}

module.exports = { readMaterials, materialProperties, extractExportedKey };
