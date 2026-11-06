'use strict';

function readEmbeddedResource(html, key) {
    const marker = JSON.stringify(key);
    const at = html.indexOf(marker);
    if (at < 0) return null;
    let start = at + marker.length;
    while (/\s/.test(html[start] || '') && start < html.length) start++;
    if (html[start++] !== ':') return null;
    while (/\s/.test(html[start] || '') && start < html.length) start++;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === '{' || c === '[') depth++;
        else if ((c === '}' || c === ']') && --depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
    throw new Error(`Incomplete embedded resource ${key}`);
}

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
    const order = c.MetalnessPBR?.enable ? ['AlbedoPBR','DiffuseColor','DiffusePBR'] : ['DiffuseColor','DiffusePBR','AlbedoPBR'];
    const a = order.map(k => c[k]).find(v => v && v.enable !== false) || {};
    const roughness = c.RoughnessPBR?.enable ? c.RoughnessPBR.factor ?? 1
        : c.GlossinessPBR?.enable ? 1 - (c.GlossinessPBR.factor ?? 1) : 1;
    const material = {
        name,
        doubleSided: source?.cullFace === 'DISABLE',
        pbrMetallicRoughness: {
            baseColorFactor: [...(a.color || [1, 1, 1]).map(v => v * (a.factor ?? 1)), 1],
            metallicFactor: c.MetalnessPBR?.enable ? (c.MetalnessPBR.factor ?? 1) : 0,
            roughnessFactor: Math.max(0, Math.min(1, roughness ?? 1))
        }
    };
    const opacity = c.Opacity?.enable ? c.Opacity : c.AlphaMask?.enable ? c.AlphaMask : null;
    if (opacity) {
        if (/refract/i.test(opacity.type || '')) {
            material.extensions = {KHR_materials_transmission: {transmissionFactor: 1}};
        } else {
            material.pbrMetallicRoughness.baseColorFactor[3] = Math.max(0, Math.min(1, opacity.factor ?? 1));
            material.alphaMode = /mask|cutout/i.test(opacity.type || '') || c.AlphaMask?.enable ? 'MASK' : 'BLEND';
            if (material.alphaMode === 'MASK') material.alphaCutoff = opacity.threshold ?? 0.5;
        }
    }
    if (c.EmitColor?.enable) {
        const color = c.EmitColor.color || [1,1,1], factor = c.EmitColor.factor ?? 1;
        const strength = Math.max(1, factor * Math.max(...color));
        material.emissiveFactor = color.map(v => v * factor / strength);
        if (strength > 1) (material.extensions ||= {}).KHR_materials_emissive_strength = {emissiveStrength: strength};
    }
    if (c.ClearCoat?.enable) (material.extensions ||= {}).KHR_materials_clearcoat = {
        clearcoatFactor: c.ClearCoat.factor ?? 1,
        clearcoatRoughnessFactor: c.ClearCoatRoughness?.enable ? c.ClearCoatRoughness.factor ?? 0 : 0
    };
    if (c.Sheen?.enable) (material.extensions ||= {}).KHR_materials_sheen = {
        sheenColorFactor: (c.Sheen.color || [1,1,1]).map(v => v * (c.Sheen.factor ?? 1)),
        sheenRoughnessFactor: c.SheenRoughness?.enable ? c.SheenRoughness.factor ?? 0 : 0
    };
    return material;
}

module.exports = { readMaterials, materialProperties, extractExportedKey, readEmbeddedResource };
