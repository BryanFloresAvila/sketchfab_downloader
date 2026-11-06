'use strict';
const {matrixOf,multiply}=require('./animation');
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function determinant(m) {
  return m[0]*(m[5]*m[10]-m[9]*m[6])-m[4]*(m[1]*m[10]-m[9]*m[2])+m[8]*(m[1]*m[6]-m[5]*m[2]);
}
function transformGeometry(geom,m) {
  const det=determinant(m);
  if(Math.abs(det)<1e-12) return null;
  // Cofactor / determinant is inverse transpose, in row-major form here.
  const n=[m[5]*m[10]-m[9]*m[6],m[9]*m[2]-m[1]*m[10],m[1]*m[6]-m[5]*m[2],
    m[8]*m[6]-m[4]*m[10],m[0]*m[10]-m[8]*m[2],m[4]*m[2]-m[0]*m[6],
    m[4]*m[9]-m[8]*m[5],m[8]*m[1]-m[0]*m[9],m[0]*m[5]-m[4]*m[1]].map(v=>v/det);
  const attributes={...geom.attributes};
  for(const name of ['POSITION','NORMAL','TANGENT']) {
    const a=attributes[name];if(!a)continue;
    const data=Float32Array.from(a.data),size=a.itemSize;
    for(let p=0;p<data.length;p+=size) {
      const [x,y,z]=a.data.slice(p,p+3);
      let v=name==='NORMAL'
        ? [n[0]*x+n[1]*y+n[2]*z,n[3]*x+n[4]*y+n[5]*z,n[6]*x+n[7]*y+n[8]*z]
        : [m[0]*x+m[4]*y+m[8]*z,m[1]*x+m[5]*y+m[9]*z,m[2]*x+m[6]*y+m[10]*z];
      if(name==='POSITION')v=v.map((q,i)=>q+m[12+i]);
      else {const length=Math.hypot(...v);if(length)v=v.map(q=>q/length);}
      data.set(v,p);
      if(name==='TANGENT' && det<0)data[p+3]*=-1;
    }
    attributes[name]={...a,data,componentType:5126,normalized:false};
  }
  const indices=Uint32Array.from(geom.indices);
  if(det<0)for(let i=0;i<indices.length;i+=3)[indices[i+1],indices[i+2]]=[indices[i+2],indices[i+1]];
  return {...geom,attributes,indices};
}
function mergeStaticGeometries(scene,level) {
  if(level==='off')return;
  if(!['objects','groups'].includes(level))throw new Error('Unsupported merge level');
  const parents=new Map();
  scene.nodes.forEach((n,i)=>(n.children || []).forEach(c=>parents.set(c,i)));
  const animated=new Set();
  for(const clip of scene.clips)for(const wrapped of clip.Channels || []) {
    const c=Object.values(wrapped)[0],target=scene.targets.get(`${c.TargetName}\0${c.Name}`);
    if(target)animated.add(target.node);
  }
  for(const skin of scene.skins)animated.add(skin.skeleton.node);
  const worlds=new Map();
  function world(i){if(!worlds.has(i))worlds.set(i,multiply(parents.has(i)?world(parents.get(i)):I,matrixOf(scene.nodes[i])));return worlds.get(i);}
  const buckets=new Map();
  for(const geom of scene.geometries) {
    if(geom.targets || geom.attributes.JOINTS_0)continue;
    const ancestors=[];let node=geom.node;
    while(node!==undefined){ancestors.push(node);node=parents.get(node);}
    if(ancestors.some(i=>animated.has(i)))continue;
    const named=ancestors.slice(1).filter(i=>scene.nodes[i].name && !scene.nodes[i].name.startsWith('osg.') && !scene.nodes[i].name.includes('/'));
    let group=named[0] ?? parents.get(geom.node) ?? -1;
    if(level==='groups') {
      // Keep the branches immediately below the first scene branch separate.
      const order=ancestors.slice().reverse();
      const split=order.findIndex(i=>(scene.nodes[i].children || []).length>1);
      group=split>=0 && split<order.length-2 ? order[split+1] : group;
    }
    const part=transformGeometry(geom,world(geom.node));if(!part)continue;
    const list=buckets.get(group) || [];list.push({original:geom,part});buckets.set(group,list);
  }
  const removed=new Set(),merged=[];
  for(const [group,list] of buckets) {
    if(list.length<2)continue;
    const name=`${scene.nodes[group]?.name || 'scene'} (merged)`;
    const node=scene.nodes.push({name})-1;scene.roots.push(node);
    merged.push({name,node,parts:list.map(g=>g.part)});
    list.forEach(g=>removed.add(g.original));
  }
  scene.geometries=[...scene.geometries.filter(g=>!removed.has(g)),...merged];
}
function pruneEmptyNodes(gltf) {
  const parents=new Map();gltf.nodes.forEach((n,i)=>(n.children || []).forEach(c=>parents.set(c,i)));
  const keep=new Set();
  function retain(i){while(i!==undefined && !keep.has(i)){keep.add(i);i=parents.get(i);}}
  gltf.nodes.forEach((n,i)=>{if(n.mesh!==undefined || n.camera!==undefined || n.extensions)retain(i);});
  for(const a of gltf.animations || [])for(const c of a.channels)retain(c.target.node);
  for(const s of gltf.skins || []){s.joints.forEach(retain);if(s.skeleton!==undefined)retain(s.skeleton);}
  const map=new Map([...keep].sort((a,b)=>a-b).map((old,i)=>[old,i]));
  gltf.nodes=gltf.nodes.filter((_,i)=>keep.has(i)).map(n=>{
    if(n.children){n.children=n.children.filter(i=>keep.has(i)).map(i=>map.get(i));if(!n.children.length)delete n.children;}
    return n;
  });
  for(const s of gltf.scenes)s.nodes=s.nodes.filter(i=>keep.has(i)).map(i=>map.get(i));
  for(const s of gltf.skins || []){s.joints=s.joints.map(i=>map.get(i));if(s.skeleton!==undefined)s.skeleton=map.get(s.skeleton);}
  for(const a of gltf.animations || [])for(const c of a.channels)c.target.node=map.get(c.target.node);
}
module.exports={mergeStaticGeometries,transformGeometry,pruneEmptyNodes};
