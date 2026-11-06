'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const sharp=require('sharp');
const {packOrmPixels,isPackedOrmName}=require('./vendor/sfrip/orm');
const {sameBinding,baseRoles}=require('./materials');

async function prepareTextures(config, directory, descramble, {maxEdge=0,warn=()=>{}}={}) {
  const output={}, cache=new Map();
  const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
  async function prepare(tex, channel, role) {
    const flipY=['NormalMap','ClearCoatNormalMap'].includes(role) && channel?.flipY !== false;
    const key=hash(['v2',tex.filename,tex.pk,maxEdge,flipY]);
    if(cache.has(key))return cache.get(key);
    const cleanFile=`${key}.png`,dest=path.join(directory,cleanFile);
    if(!fs.existsSync(dest)) {
      const {data,info}=await sharp(path.join(directory,tex.filename)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      let pixels=data;
      if(tex.pk!==null && tex.pk!==undefined) {
        const pow2=n=>n>=8 && (n&(n-1))===0;
        if(!pow2(info.width)||!pow2(info.height))throw new Error(`Protected texture cannot be decoded safely: ${tex.filename}`);
        pixels=descramble(data,info.width,info.height,4,tex.pk);
      }
      if(flipY)for(let p=1;p<pixels.length;p+=4)pixels[p]=255-pixels[p];
      let image=sharp(pixels,{raw:{width:info.width,height:info.height,channels:4}});
      if(maxEdge)image=image.resize({width:maxEdge,height:maxEdge,fit:'inside',withoutEnlargement:true});
      await image.png().toFile(dest);
    }
    const value={...tex,cleanFile};cache.set(key,value);return value;
  }
  async function rgba(tex,w,h) {
    let image=sharp(path.join(directory,tex.cleanFile));
    if(w && h)image=image.resize(w,h,{fit:'fill'});
    return image.ensureAlpha().raw().toBuffer({resolveWithObject:true});
  }
  for(const [id,images] of Object.entries(config.materials || {})) {
    const source=config.sourceMaterials[id] || Object.values(config.sourceMaterials).find(m=>m.name===id),c=source?.channels || {};
    const clean={};output[id]=clean;
    for(const [role,tex] of Object.entries(images))clean[role]=await prepare(tex,c[role],role);
    const metal=clean.MetalnessPBR, rough=clean.RoughnessPBR || clean.GlossinessPBR;
    const rRole=clean.RoughnessPBR?'RoughnessPBR':'GlossinessPBR';
    if(metal || rough) {
      if(metal && rough && !sameBinding(c.MetalnessPBR,c[rRole]))warn(`${source?.name || id}: metalness and roughness have different UV bindings; packed map omitted`);
      else {
        const first=await rgba(metal || rough),w=first.info.width,h=first.info.height;
        const m=metal?(await rgba(metal,w,h)).data:null,r=rough?(await rgba(rough,w,h)).data:null;
        const mf=c.MetalnessPBR?.enable ? c.MetalnessPBR.factor ?? 1 : 0;
        const rf=c.RoughnessPBR?.enable ? c.RoughnessPBR.factor ?? 1 : c.GlossinessPBR?.enable ? c.GlossinessPBR.factor ?? 1 : 1;
        const packed=isPackedOrmName(metal?.sourceName) || isPackedOrmName(rough?.sourceName) ||
          (metal && rough && metal.setUid && metal.setUid===rough.setUid && /RGB/.test(c.MetalnessPBR?.texture?.internalFormat || ''));
        if(m)for(let p=0;p<m.length;p+=4)m[p]=Math.round(m[p+(packed?2:0)]*mf);
        if(r)for(let p=0;p<r.length;p+=4)r[p]=Math.round(r[p+(packed?1:0)]*rf);
        const pixels=packOrmPixels({width:w,height:h,metal:m,rough:r,
          invertRough:!!rough && rRole==='GlossinessPBR',metalFallback:255*mf,
          roughFallback:255*(c.GlossinessPBR?.enable && !c.RoughnessPBR?.enable ? 1-rf:rf)});
        const cleanFile=`${hash(['orm-v2',id,metal?.cleanFile,rough?.cleanFile,mf,rf,rRole,packed])}.png`;
        await sharp(pixels,{raw:{width:w,height:h,channels:4}}).png().toFile(path.join(directory,cleanFile));
        clean.MetalRough={cleanFile,binding:c[metal?'MetalnessPBR':rRole]};
      }
    }
    const base=baseRoles(c).find(k=>clean[k]);
    const alphaRole=clean.Opacity?'Opacity':clean.AlphaMask?'AlphaMask':null;
    if(alphaRole && !/refract/i.test(c[alphaRole]?.type || '')) {
      if(base && !sameBinding(c[base],c[alphaRole]))warn(`${source?.name || id}: opacity uses different UV binding; separate opacity texture omitted`);
      else {
        const a=await rgba(clean[alphaRole]),w=a.info.width,h=a.info.height;
        const pixels=base?(await rgba(clean[base],w,h)).data:Buffer.alloc(w*h*4,255);
        for(let p=0;p<pixels.length;p+=4)pixels[p+3]=Math.round(pixels[p+3]*a.data[p]/255);
        const cleanFile=`${hash(['alpha-v2',clean[base]?.cleanFile,clean[alphaRole].cleanFile])}.png`;
        await sharp(pixels,{raw:{width:w,height:h,channels:4}}).png().toFile(path.join(directory,cleanFile));
        const target=base || 'AlbedoPBR';
        clean[target]={...(clean[base] || clean[alphaRole]),cleanFile};
        // Preserve the opacity binding when creating a white albedo atlas.
        if(!base)clean[target].binding=c[alphaRole];
      }
    }
  }
  return output;
}
module.exports={prepareTextures};
