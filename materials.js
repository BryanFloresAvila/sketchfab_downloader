'use strict';
// StateSet binding and channel mapping adapted from sfrip's approach.
// See THIRD_PARTY_NOTICES.md for source revision and MIT attribution.
const {materialProperties} = require('./viewer-config');
const CHANNELS = ['AlbedoPBR','DiffusePBR','DiffuseColor','NormalMap','MetalnessPBR',
  'RoughnessPBR','GlossinessPBR','AOPBR','CavityPBR','EmitColor','Opacity','AlphaMask',
  'ClearCoat','ClearCoatNormalMap','Sheen'];
const wrapModes = {REPEAT:10497, CLAMP_TO_EDGE:33071, MIRRORED_REPEAT:33648};
const baseRoles = c => c.MetalnessPBR?.enable ? ['AlbedoPBR','DiffuseColor','DiffusePBR'] : ['DiffuseColor','DiffusePBR','AlbedoPBR'];
function binding(channel = {}) {
  return {unit: channel.texture?.texCoordUnit ?? 0,
    wrapS: wrapModes[channel.texture?.wrapS] || 10497, wrapT: wrapModes[channel.texture?.wrapT] || 10497,
    transform: channel.UVTransforms || null};
}
function sameBinding(a, b) { return JSON.stringify(binding(a)) === JSON.stringify(binding(b)); }
function stateSetName(ss) {
  return (ss?.AttributeList || []).map(a=>a['osg.Material']?.Name).find(Boolean);
}
function createMaterialResolver(scene, sourceMaterials, warn = () => {}) {
  const entries = Object.entries(sourceMaterials), sets = [], seen = new Set(), visited = new Set();
  function walk(o) {
    if (!o || typeof o !== 'object' || visited.has(o)) return;visited.add(o);
    const ss=o['osg.StateSet'];
    if (ss && !seen.has(ss.UniqueID ?? ss)) {seen.add(ss.UniqueID ?? ss);sets.push(ss);}
    for(const v of Object.values(o)) walk(v);
  }
  walk(scene);
  // Some viewer versions reserve an extra entry. Infer one global offset from
  // named StateSets instead of choosing a different guessed offset per mesh.
  const family = s => String(s || '').replace(/_\d+$/, '');
  const scores = [0,1].map(offset=>({offset,score:sets.reduce((n,ss,i)=>n+Number(!!stateSetName(ss) && entries.some(([,m])=>m.stateSetID===i+1+offset && family(m.name)===family(stateSetName(ss)))),0)}));
  scores.sort((a,b)=>b.score-a.score || a.offset-b.offset);
  const offset=scores[0].offset, ordinal=new Map(sets.map((ss,i)=>[ss.UniqueID ?? ss,i+1+offset]));
  return geom => {
    const ss=geom.stateSet, id=ss && ordinal.get(ss.UniqueID ?? ss);
    if(!ss){const defaults=entries.filter(([,m])=>m.stateSetID===0);if(defaults.length===1)return defaults[0][0];}
    let matches=id===undefined?[]:entries.filter(([,m])=>m.stateSetID===id);
    if (matches.length===1 && (!geom.matName || family(matches[0][1].name)===family(geom.matName))) return matches[0][0];
    matches=entries.filter(([,m])=>m.name===geom.matName);
    if(matches.length===1)return matches[0][0];
    if(geom.texSetUid){matches=entries.filter(([,m])=>CHANNELS.some(k=>m.channels?.[k]?.texture?.uid===geom.texSetUid));if(matches.length===1)return matches[0][0];}
    if(entries.length===1)return entries[0][0];
    if(entries.length)warn(`Material binding unresolved for ${geom.name}; using first source material`);
    return entries[0]?.[0];
  };
}

function buildMaterial(name, source, images, uvUnits, addTexture, warn = () => {}) {
  const mat=materialProperties(name, source), c=source?.channels || {}, pbr=mat.pbrMetallicRoughness;
  function info(role, data=images[role], spec=data?.binding || c[role]) {
    if (!data) return undefined;
    const b=binding(spec), unit=uvUnits.indexOf(b.unit);
    if(unit<0) {warn(`${name}/${role}: texture UV unit ${b.unit} missing; texture omitted`);return undefined;}
    const index=addTexture(data.cleanFile || data.filename,b);
    if(index<0) {warn(`${name}/${role}: image unavailable`);return undefined;}
    const result={index,...(unit?{texCoord:unit}:{})};
    // Keep the upstream convention for ordinary tiling/offset. Nonuniform
    // rotation does not commute with scaling and is reported explicitly.
    const t=b.transform;
    if(t) {
      const scale=t.scale || [1,1], offset=t.offset || [0,0], rotation=t.rotation || 0;
      if(scale[0]!==1 || scale[1]!==1 || offset[0] || offset[1] || rotation) {
        result.extensions={KHR_texture_transform:{scale,offset,rotation}};
        if(rotation && scale[0]!==scale[1])warn(`${name}/${role}: nonuniform rotated UV transform is approximate`);
      }
    }
    return result;
  }
  const base=baseRoles(c).find(k=>images[k]);
  if(base) pbr.baseColorTexture=info(base);
  if(images.MetalRough) {
    pbr.metallicRoughnessTexture=info('MetalRough',images.MetalRough,images.MetalRough.binding);
    // Factors were baked into the packed texture, including gloss inversion.
    if(pbr.metallicRoughnessTexture){pbr.metallicFactor=1;pbr.roughnessFactor=1;}
  }
  if(images.NormalMap) {const n=info('NormalMap');if(n)mat.normalTexture={...n,scale:c.NormalMap?.factor ?? 1};}
  const ao=['AOPBR','CavityPBR'].find(k=>images[k]);
  if(ao) {const n=info(ao);if(n)mat.occlusionTexture={...n,strength:c[ao]?.factor ?? 1};}
  if(images.EmitColor)mat.emissiveTexture=info('EmitColor');
  if(mat.extensions?.KHR_materials_clearcoat){
    const ext=mat.extensions.KHR_materials_clearcoat;
    if(images.ClearCoat)ext.clearcoatTexture=info('ClearCoat');
    if(images.ClearCoatNormalMap)ext.clearcoatNormalTexture=info('ClearCoatNormalMap');
  }
  if(mat.extensions?.KHR_materials_sheen && images.Sheen)mat.extensions.KHR_materials_sheen.sheenColorTexture=info('Sheen');
  return mat;
}
module.exports={CHANNELS,binding,sameBinding,baseRoles,createMaterialResolver,buildMaterial};
