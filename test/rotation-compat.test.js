const test=require('node:test'), assert=require('node:assert/strict');
const {compatibleRotations,nlerp,slerp,angleDegrees}=require('../rotation-compat');

test('opposite quaternion signs cannot introduce a full turn between keys',()=>{
  const source=Float32Array.from([0,0,0,1,0,0,-0.1,-Math.sqrt(0.99)]);
  const fixed=compatibleRotations(Float32Array.from([0,1]),source);
  assert.equal(fixed.flippedKeys,1);
  const expected=nlerp(Array.from(source.slice(0,4)),Array.from(source.slice(4)),0.5);
  const blended=nlerp(Array.from(fixed.values.slice(0,4)),Array.from(fixed.values.slice(-4)),0.5);
  assert.ok(angleDegrees(expected,blended)<1e-5);
});
test('adaptive keys reproduce viewer NLERP under both SLERP and component interpolation',()=>{
  const a=[0,0,0,1],b=[0,0,Math.sin(80*Math.PI/180),Math.cos(80*Math.PI/180)];
  const fixed=compatibleRotations(Float32Array.from([0,2]),Float32Array.from([...a,...b]));
  assert.ok(fixed.addedKeys>0);
  for(let i=0;i<fixed.times.length-1;i++){
    const q0=Array.from(fixed.values.slice(4*i,4*i+4)),q1=Array.from(fixed.values.slice(4*i+4,4*i+8));
    for(let j=1;j<20;j++){
      const t=j/20,absolute=fixed.times[i]+t*(fixed.times[i+1]-fixed.times[i]);
      const expected=nlerp(a,b,absolute/2);
      assert.ok(angleDegrees(expected,slerp(q0,q1,t))<0.035);
      assert.ok(angleDegrees(expected,nlerp(q0,q1,t))<0.035);
    }
  }
  assert.equal(fixed.times[0],0);assert.equal(fixed.times.at(-1),2);
});
test('constant rotation and original nonuniform key times are preserved',()=>{
  const times=Float32Array.from([0,0.1,0.67,2]),values=Float32Array.from(Array(4).fill([0,0,0,1]).flat());
  const fixed=compatibleRotations(times,values);
  assert.deepEqual(fixed.times,times);assert.deepEqual(fixed.values,values);
});
