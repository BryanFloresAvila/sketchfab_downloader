'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function parseGlb(bytes) {
  if(bytes.readUInt32LE(0)!==0x46546c67)throw new Error('Expected GLB');
  const size=bytes.readUInt32LE(12);
  return {json:JSON.parse(bytes.subarray(20,20+size)),bin:bytes.subarray(28+size)};
}
function writeOutputs(filename,bytes,{external=false,metadata={}}={}) {
  const dest=path.resolve(filename),directory=path.dirname(dest),stem=path.basename(dest).replace(/\.glb$/i,'');
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(dest,bytes);
  const {json,bin}=parseGlb(bytes);
  const manifest={...metadata,output:path.basename(dest),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes:bytes.length,meshes:json.meshes?.length || 0,skins:json.skins?.length || 0,
    animations:(json.animations || []).map(a=>({name:a.name,channels:a.channels.length,
      duration:Math.max(...a.samplers.map(s=>json.accessors[s.input].max[0]))})),images:json.images?.length || 0};
  if(external) {
    const imageDir=`${stem}_textures`;
    if(json.images?.length)fs.mkdirSync(path.join(directory,imageDir),{recursive:true});
    for(let i=0;i<(json.images || []).length;i++) {
      const image=json.images[i],view=json.bufferViews[image.bufferView];
      const ext=image.mimeType==='image/png'?'png':'jpg',name=`image_${i}.${ext}`;
      fs.writeFileSync(path.join(directory,imageDir,name),bin.subarray(view.byteOffset || 0,(view.byteOffset || 0)+view.byteLength));
      delete image.bufferView;image.uri=encodeURIComponent(imageDir)+'/'+name;
    }
    // Keep accessor offsets intact; the redundant image views are harmless.
    json.buffers[0].uri=encodeURIComponent(`${stem}.bin`);
    fs.writeFileSync(path.join(directory,`${stem}.bin`),bin.subarray(0,json.buffers[0].byteLength));
    fs.writeFileSync(path.join(directory,`${stem}.gltf`),JSON.stringify(json,null,2));
    manifest.external=`${stem}.gltf`;
  }
  fs.writeFileSync(path.join(directory,`${stem}.info.json`),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
module.exports={writeOutputs,parseGlb};
