'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const sharp=require('sharp');
const {validateBytes,validateString}=require('gltf-validator');
const {convertToGltf}=require('../download');
const {parseGlb,writeOutputs}=require('../output');
const {prepareTextures}=require('../textures');
const {pickBestImage}=require('../vendor/sfrip/texture-selection');
const {isPackedOrmName}=require('../vendor/sfrip/orm');
const {buildMaterial,createMaterialResolver}=require('../materials');
const {readEmbeddedResource,materialProperties}=require('../viewer-config');
const {fetchBuffer,mapPool}=require('../http');
const {parseArgs}=require('../cli-options');
const {transformGeometry}=require('../merge');
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const arr=(data,size=1,type='Float32Array')=>({ItemSize:size,Array:{[type]:{Elements:data,Size:data.length/size}}});
function geometry(id=1) {return {Name:`part-${id}`,StateSet:{'osg.StateSet':{UniqueID:id,AttributeList:[{'osg.Material':{Name:'same'}}]}},
  PrimitiveSetList:[{DrawElementsUInt:{Mode:'TRIANGLES',Indices:arr([0,1,2],1,'Uint32Array')}}],
  VertexAttributeList:{Vertex:arr([0,0,0,1,0,0,0,1,0],3),Normal:arr([0,0,1,0,0,1,0,0,1],3)}};}
function scene(){return {'osg.Node':{Name:'Object',Children:[{'osg.Geometry':geometry(1)},{'osg.Geometry':geometry(2)}]}};}
function convert(s,materials={},images={},opts={}){return convertToGltf(s,Buffer.alloc(0),null,images,materials,opts);}
async function valid(bytes){const r=await validateBytes(new Uint8Array(bytes));assert.equal(r.issues.numErrors,0,JSON.stringify(r.issues));assert.equal(r.issues.numWarnings,0,JSON.stringify(r.issues));}
function values(result,index){const a=result.json.accessors[index],v=result.json.bufferViews[a.bufferView];return Array.from(new Float32Array(Uint8Array.from(result.bin.subarray(v.byteOffset,v.byteOffset+v.byteLength)).buffer));}
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sfrip-port-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('embedded resource parser respects escaped braces and exact resource paths',()=>{
  const data={results:[{name:'quoted " } ]',url:'https://example.test/x'}]};
  assert.deepEqual(readEmbeddedResource(JSON.stringify({'/a':data,'/ab':{}}),'/a'),data);
  assert.equal(readEmbeddedResource('{}','/missing'),null);
});
test('texture selection prefers decodable original variant at the requested size',()=>{
  const images=[{width:800,height:100,url:'bad.png',pk:2},{width:512,height:512,url:'reencoded.png',pk:2,options:{format:'png'}},
    {width:512,height:512,url:'original.jpg',pk:2,options:{}},{width:4096,height:4096,url:'large.jpg',pk:2}];
  assert.equal(pickBestImage(images,2048).url,'original.jpg');
  assert.equal(pickBestImage(images,0).url,'large.jpg');
});
test('packed ORM detection does not confuse normal or arm textures',()=>{
  assert.equal(isPackedOrmName('body_ORM.png'),true);assert.equal(isPackedOrmName('metallicRoughness.png'),true);
  assert.equal(isPackedOrmName('normal.png'),false);assert.equal(isPackedOrmName('arm_metallic.png'),false);
});
test('enabled roughness without an explicit factor keeps a finite default',()=>{
  assert.equal(materialProperties('rough',{channels:{RoughnessPBR:{enable:true}}}).pbrMetallicRoughness.roughnessFactor,1);
});
test('duplicate material names bind to distinct StateSets and retain their colors',async()=>{
  const materials={red:{name:'same',stateSetID:1,channels:{AlbedoPBR:{enable:true,color:[1,0,0]}}},
    blue:{name:'same',stateSetID:2,channels:{AlbedoPBR:{enable:true,color:[0,0,1]}}}};
  const bytes=convert(scene(),materials);await valid(bytes);
  const {json}=parseGlb(bytes),m=json.meshes.map(m=>json.materials[m.primitives[0].material]);
  assert.deepEqual(m.map(x=>x.pbrMetallicRoughness.baseColorFactor),[[1,0,0,1],[0,0,1,1]]);
});
test('material resolver infers a consistent viewer ordinal offset from named StateSets',()=>{
  const s=scene();s['osg.Node'].Children[1]['osg.Geometry'].StateSet['osg.StateSet'].AttributeList[0]['osg.Material'].Name='blue';
  const resolver=createMaterialResolver(s,{generated:{name:'Merged',stateSetID:1},red:{name:'same',stateSetID:2},blue:{name:'blue',stateSetID:3}});
  assert.equal(resolver({name:'part',matName:'blue',stateSet:s['osg.Node'].Children[1]['osg.Geometry'].StateSet['osg.StateSet']}),'blue');
});
test('geometry without a StateSet uses the explicit viewer default material',()=>{
  const warnings=[],resolver=createMaterialResolver({}, {named:{name:'named',stateSetID:1},fallback:{name:'material_0',stateSetID:0}},x=>warnings.push(x));
  assert.equal(resolver({name:'unassigned'}),'fallback');assert.deepEqual(warnings,[]);
});
test('disabled coat and sheen do not leak extension defaults; constant alpha survives',()=>{
  const a=materialProperties('glass',{channels:{Opacity:{enable:true,type:'alphaBlend',factor:.25},ClearCoat:{enable:false,factor:1},Sheen:{enable:false}}});
  assert.equal(a.alphaMode,'BLEND');assert.equal(a.pbrMetallicRoughness.baseColorFactor[3],.25);assert.equal(a.extensions,undefined);
  const b=materialProperties('glass',{channels:{Opacity:{enable:true,type:'refraction',factor:0}}});
  assert.equal(b.extensions.KHR_materials_transmission.transmissionFactor,1);assert.equal(b.pbrMetallicRoughness.baseColorFactor[3],1);
});
test('sparse UV units map numerically to glTF indices and honor separate samplers',async t=>{
  const dir=temp(t);await sharp({create:{width:2,height:2,channels:4,background:'#ffffff'}}).png().toFile(path.join(dir,'white.png'));
  const g=geometry();g.VertexAttributeList.TexCoord10=arr([0,0,1,0,0,1],2);g.VertexAttributeList.TexCoord2=arr([0,0,1,0,0,1],2);
  g.VertexAttributeList.Tangent=arr([1,0,0,1,1,0,0,1,1,0,0,1],4);
  const source={m:{name:'same',stateSetID:1,channels:{AlbedoPBR:{enable:true,texture:{texCoordUnit:10,wrapS:'CLAMP_TO_EDGE'}},NormalMap:{enable:true,texture:{texCoordUnit:2}}}}};
  const b=convert({'osg.Node':{Children:[{'osg.Geometry':g}]}},source,{m:{AlbedoPBR:{cleanFile:'white.png'},NormalMap:{cleanFile:'white.png'}}},{textureDir:dir});
  await valid(b);const {json}=parseGlb(b),m=json.materials[0];
  assert.equal(m.pbrMetallicRoughness.baseColorTexture.texCoord,1);assert.equal(m.normalTexture.texCoord,undefined);
  assert.equal(json.samplers[json.textures[m.pbrMetallicRoughness.baseColorTexture.index].sampler].wrapS,33071);
});
test('material extensions are declared and conform to glTF schema',async()=>{
  const b=convert(scene(),{m:{name:'same',channels:{ClearCoat:{enable:true,factor:.5},Sheen:{enable:true,color:[.2,.3,.4]},EmitColor:{enable:true,color:[1,.5,0],factor:3}}}});
  await valid(b);assert.deepEqual(new Set(parseGlb(b).json.extensionsUsed),new Set(['KHR_materials_clearcoat','KHR_materials_sheen','KHR_materials_emissive_strength']));
});
test('unprotected images bypass descrambling; normal Y flip is a per-binding operation',async t=>{
  const dir=temp(t);await sharp(Buffer.from([20,30,40,255]),{raw:{width:1,height:1,channels:4}}).png().toFile(path.join(dir,'in.png'));
  const tex={filename:'in.png',pk:null,setUid:'image'};
  const result=await prepareTextures({sourceMaterials:{m:{channels:{NormalMap:{enable:true,flipY:true}}}},materials:{m:{AlbedoPBR:tex,NormalMap:tex}}},dir,()=>{throw Error('Must not descramble');});
  const color=await sharp(path.join(dir,result.m.AlbedoPBR.cleanFile)).raw().toBuffer();
  const normal=await sharp(path.join(dir,result.m.NormalMap.cleanFile)).raw().toBuffer();
  assert.deepEqual([...color],[20,30,40,255]);assert.deepEqual([...normal],[20,225,40,255]);
});
test('ORM packing resizes mismatched maps and applies gloss factor before inversion',async t=>{
  const dir=temp(t);
  await sharp({create:{width:2,height:2,channels:4,background:{r:200,g:200,b:200,alpha:1}}}).png().toFile(path.join(dir,'m.png'));
  await sharp({create:{width:1,height:1,channels:4,background:{r:100,g:100,b:100,alpha:1}}}).png().toFile(path.join(dir,'g.png'));
  const c={MetalnessPBR:{enable:true,factor:.5},GlossinessPBR:{enable:true,factor:.5}};
  const result=await prepareTextures({sourceMaterials:{m:{channels:c}},materials:{m:{MetalnessPBR:{filename:'m.png',pk:null},GlossinessPBR:{filename:'g.png',pk:null}}}},dir,()=>{});
  const {data,info}=await sharp(path.join(dir,result.m.MetalRough.cleanFile)).raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,2);for(let i=0;i<data.length;i+=4)assert.deepEqual([...data.subarray(i,i+4)],[255,205,100,255]);
});
test('separate opacity multiplies existing albedo alpha without losing RGB',async t=>{
  const dir=temp(t);
  for(const [name,data] of [['c.png',[80,90,100,128]],['a.png',[128,128,128,255]]])await sharp(Buffer.from(data),{raw:{width:1,height:1,channels:4}}).png().toFile(path.join(dir,name));
  const result=await prepareTextures({sourceMaterials:{m:{channels:{AlbedoPBR:{enable:true},Opacity:{enable:true,type:'alphaBlend'}}}},materials:{m:{AlbedoPBR:{filename:'c.png',pk:null},Opacity:{filename:'a.png',pk:null}}}},dir,()=>{});
  assert.deepEqual([...await sharp(path.join(dir,result.m.AlbedoPBR.cleanFile)).raw().toBuffer()],[80,90,100,64]);
});
test('incompatible ORM UV bindings are reported instead of silently merged',async t=>{
  const dir=temp(t);await sharp({create:{width:1,height:1,channels:4,background:'#ffffff'}}).png().toFile(path.join(dir,'a.png'));
  const warnings=[],tex={filename:'a.png',pk:null};
  const result=await prepareTextures({sourceMaterials:{m:{channels:{MetalnessPBR:{enable:true,texture:{texCoordUnit:1}},RoughnessPBR:{enable:true,texture:{texCoordUnit:2}}}}},materials:{m:{MetalnessPBR:tex,RoughnessPBR:tex}}},dir,()=>{},{warn:x=>warnings.push(x)});
  assert.equal(result.m.MetalRough,undefined);assert.equal(warnings.length,1);
});
test('static merge reduces meshes while preserving all primitives and world placement',async()=>{
  const s=scene(),translated=I.slice();translated[12]=5;
  s['osg.Node'].Children[1]={'osg.MatrixTransform':{Matrix:translated,Children:[s['osg.Node'].Children[1]]}};
  const b=convert(s,{}, {},{merge:'objects'});await valid(b);const r=parseGlb(b);
  assert.equal(r.json.meshes.length,1);assert.equal(r.json.meshes[0].primitives.length,2);
  assert.equal(r.json.nodes.length,1);
  const p=r.json.meshes[0].primitives[1];assert.deepEqual(values(r,p.attributes.POSITION),[5,0,0,6,0,0,5,1,0]);
});
test('merging excludes descendants of animated transforms',()=>{
  const s=scene();s['osg.Node'].UpdateCallbacks=[{'osgAnimation.UpdateMatrixTransform':{Name:'move',StackedTransforms:[{'osgAnimation.StackedTranslate':{Name:'translate',Translate:[0,0,0]}}]}},
    {'osgAnimation.BasicAnimationManager':{Animations:[{'osgAnimation.Animation':{Name:'move',Channels:[{'osgAnimation.Vec3LerpChannel':{TargetName:'move',Name:'translate',KeyFrames:{Time:arr([0,1]),Key:arr([0,0,0,1,0,0],3)}}}]}}]}}];
  const {json}=parseGlb(convert(s,{}, {},{merge:'objects'}));assert.equal(json.meshes.length,2);assert.equal(json.animations.length,1);
});
test('mirrored static transforms reverse winding and preserve normal/tangent handedness',()=>{
  const g={indices:Uint32Array.from([0,1,2]),attributes:{POSITION:{data:Float32Array.from([0,0,0,1,0,0,0,1,0]),itemSize:3,count:3},
    NORMAL:{data:Float32Array.from([0,0,1,0,0,1,0,0,1]),itemSize:3,count:3},TANGENT:{data:Float32Array.from([1,0,0,1,1,0,0,1,1,0,0,1]),itemSize:4,count:3}}};
  const m=I.slice();m[0]=-2;m[5]=3;
  const result=transformGeometry(g,m);assert.deepEqual([...result.indices],[0,2,1]);
  assert.deepEqual([...result.attributes.NORMAL.data].map(v=>v+0),[0,0,1,0,0,1,0,0,1]);
  assert.deepEqual([...result.attributes.TANGENT.data.slice(0,4)],[-1,0,0,-1]);
  assert.deepEqual([...g.indices],[0,1,2]);
});
test('normal transform remains perpendicular to surface under nonuniform rotated scale',()=>{
  const g={indices:Uint32Array.from([0,1,2]),attributes:{
    POSITION:{data:Float32Array.from([0,0,0,1,0,1,0,1,0]),itemSize:3,count:3},
    NORMAL:{data:Float32Array.from([-Math.SQRT1_2,0,Math.SQRT1_2]),itemSize:3,count:1}}};
  const m=[0,2,0,0,-3,0,0,0,0,0,4,0,5,6,7,1];
  const r=transformGeometry(g,m),p=r.attributes.POSITION.data,n=r.attributes.NORMAL.data;
  for(const at of [3,6])assert.ok(Math.abs(n[0]*(p[at]-p[0])+n[1]*(p[at+1]-p[1])+n[2]*(p[at+2]-p[2]))<1e-6);
});
test('external export resolves escaped paths and validates with external resource loading',async t=>{
  const dir=temp(t),filename=path.join(dir,'model space.glb'),bytes=convert(scene());
  const info=writeOutputs(filename,bytes,{external:true,metadata:{source:'example',warnings:[]}});
  assert.equal(info.meshes,2);assert.equal(fs.readFileSync(filename).compare(bytes),0);
  const report=await validateString(fs.readFileSync(path.join(dir,'model space.gltf'),'utf8'),{
    externalResourceFunction:async uri=>new Uint8Array(fs.readFileSync(path.join(dir,decodeURIComponent(uri))))});
  assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));
});
test('CLI preserves positional output and validates options before network work',()=>{
  const uid='a'.repeat(32);
  assert.equal(parseArgs([uid,'dog.glb','--merge=objects','--external']).output,'dog.glb');
  assert.equal(parseArgs([uid,'--no-textures','--max-edge','2048']).textures,false);
  for(const args of [[uid,'--merge=all'],[uid,'--concurrency','0'],[uid,'--typo'],[uid,'dog.glb','--out','cat.glb']])assert.throws(()=>parseArgs(args));
  assert.equal(parseArgs(['--help']).help,true);
});
test('HTTP retries transient status, follows relative redirects, and never retries 404',async t=>{
  let retry=0,missing=0;
  const server=http.createServer((req,res)=>{
    if(req.url==='/retry' && ++retry===1){res.writeHead(503);res.end('unavailable');}
    else if(req.url==='/retry'){res.writeHead(302,{Location:'/ok'});res.end();}
    else if(req.url==='/missing'){missing++;res.writeHead(404);res.end();}
    else res.end('asset');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const root=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetchBuffer(root+'/retry',{curl:false,delay:1})).toString(),'asset');assert.equal(retry,2);
  await assert.rejects(fetchBuffer(root+'/missing',{curl:false,delay:1}),/HTTP 404/);assert.equal(missing,1);
});
test('bounded download pool retains result order and caps simultaneous requests',async()=>{
  let active=0,max=0;
  const result=await mapPool([1,2,3,4,5],2,async x=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,3));active--;return x*2;});
  assert.equal(max,2);assert.deepEqual(result,[2,4,6,8,10]);
});
