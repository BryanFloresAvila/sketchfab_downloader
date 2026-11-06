const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readMaterials, materialProperties, extractExportedKey } = require('../viewer-config');

test('parses nested channels without borrowing enable flags or textures', () => {
    const source = { name: 'Eye {"test"}', channels: {
        NormalMap: { enable: false }, AlbedoPBR: { enable: true, color: [1, 1, 1] },
        Matcap: { enable: true, texture: { uid: 'unrelated' } }
    }};
    const data = readMaterials('prefix ' + JSON.stringify({materials: {updatedAt: 42, eye: source}}) + ' suffix');
    assert.deepEqual(data, {eye: source});
    assert.equal(data.eye.channels.NormalMap.enable, false);
    assert.equal(data.eye.channels.AlbedoPBR.texture, undefined);
});
test('retains color-only material factors and glossiness', () => {
    const m = materialProperties('Eyes', {cullFace: 'DISABLE', channels: {
        AlbedoPBR: { color: [.8, .4, .2], factor: .5 },
        MetalnessPBR: {enable: true, factor: 0}, GlossinessPBR: {enable: true, factor: .75}
    }});
    assert.deepEqual(m.pbrMetallicRoughness.baseColorFactor, [.4, .2, .1, 1]);
    assert.equal(m.pbrMetallicRoughness.roughnessFactor, .25);
    assert.equal(m.pbrMetallicRoughness.metallicFactor, 0);
    assert.equal(m.doubleSided, true);
});
test('recognizes CommonJS key assets without matching arbitrary hashes', () => {
    const key = 'a'.repeat(40);
    assert.equal(extractExportedKey('t.exports="'+key+'\\n"'), key);
    assert.equal(extractExportedKey('const image="'+key+'"'), null);
});
