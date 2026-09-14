import {ERIDANUS_EDGES,KEY_STARS,projectEridanus} from './eridanus-data.js?v=20260912-1';

function bvColor(THREE,bv){
  const blue=new THREE.Color(0xb9d9ff),white=new THREE.Color(0xf1fff8),warm=new THREE.Color(0xffd6a0);
  if(bv<=.2)return blue.clone().lerp(white,(bv+.25)/.45);
  return white.clone().lerp(warm,Math.min(1,(bv-.2)/1.45));
}

function ribbonGeometry(THREE,stars,edges,width){
  const byId=new Map(stars.map(s=>[s.id,s])),position=[],order=[],side=[];
  edges.forEach(([aId,bId],edgeIndex)=>{
    const a=byId.get(aId),b=byId.get(bId);if(!a||!b)return;
    const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1,nx=-dy/len*width,ny=dx/len*width;
    const verts=[[a.x+nx,a.y+ny],[a.x-nx,a.y-ny],[b.x+nx,b.y+ny],[b.x+nx,b.y+ny],[a.x-nx,a.y-ny],[b.x-nx,b.y-ny]];
    verts.forEach(([x,y],i)=>{position.push(x,y,0);order.push((edgeIndex+1)/edges.length);side.push([1,-1,1,1,-1,-1][i]);});
  });
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(position,3));
  geometry.setAttribute('aOrder',new THREE.Float32BufferAttribute(order,1));
  geometry.setAttribute('aSide',new THREE.Float32BufferAttribute(side,1));
  return geometry;
}

function ribbonMaterial(THREE,color,opacity){
  return new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,uniforms:{uReveal:{value:.18},uBase:{value:.13},uOpacity:{value:opacity},uColor:{value:new THREE.Color(color)}},vertexShader:`attribute float aOrder;attribute float aSide;uniform float uReveal;uniform float uBase;varying float vAlpha;varying float vSide;void main(){vSide=aSide;float traced=smoothstep(aOrder-.055,aOrder+.018,uReveal);vAlpha=mix(uBase,1.,traced);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,fragmentShader:`precision highp float;uniform vec3 uColor;uniform float uOpacity;varying float vAlpha;varying float vSide;void main(){float edge=1.-smoothstep(.48,1.,abs(vSide));gl_FragColor=vec4(uColor,uOpacity*vAlpha*edge);}`});
}

function starMaterial(THREE){
  return new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,vertexColors:true,uniforms:{uTime:{value:0},uReveal:{value:.18},uPixelRatio:{value:1}},vertexShader:`attribute float aSize;attribute float aOrder;attribute float aBrightness;uniform float uTime;uniform float uReveal;uniform float uPixelRatio;varying vec3 vColor;varying float vAlpha;varying float vBrightness;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);float traced=smoothstep(aOrder-.07,aOrder+.02,uReveal);float pulse=.94+.06*sin(uTime*(.65+aBrightness*.14)+aOrder*31.);gl_PointSize=clamp(aSize*uPixelRatio*(240./-mv.z),2.4*uPixelRatio,28.*uPixelRatio);gl_Position=projectionMatrix*mv;vColor=color;vAlpha=mix(.62,1.,traced)*pulse;vBrightness=aBrightness;}`,fragmentShader:`precision highp float;varying vec3 vColor;varying float vAlpha;varying float vBrightness;void main(){vec2 p=gl_PointCoord-.5;float r=length(p);float core=1.-smoothstep(.025,.17,r);float halo=(1.-smoothstep(.10,.50,r))*.43;float rays=(exp(-abs(p.x)*46.)*exp(-abs(p.y)*4.3)+exp(-abs(p.y)*46.)*exp(-abs(p.x)*4.3))*.18;float a=(core+halo+rays)*vAlpha;if(a<.008)discard;gl_FragColor=vec4(vColor*(1.05+core*vBrightness*.85),a);}`});
}

export function createEridanusConstellation({THREE,scene,camera,canvas,label,nameNode,metaNode,quality,onSelect=()=>{}}){
  const stars=projectEridanus(),byId=new Map(stars.map(s=>[s.id,s]));
  const routeOrder=new Map();ERIDANUS_EDGES.forEach((edge,i)=>edge.forEach(id=>{if(!routeOrder.has(id))routeOrder.set(id,(i+1)/ERIDANUS_EDGES.length)}));
  const geometry=new THREE.BufferGeometry(),positions=[],sizes=[],brightness=[],orders=[],colors=[];
  stars.forEach(star=>{positions.push(star.x,star.y,star.z);sizes.push(star.id===7588?8.5:Math.max(2.1,5.6-star.mag*.63));brightness.push(star.id===7588?2.8:Math.max(.72,1.65-star.mag*.15));orders.push(routeOrder.get(star.id)||.5);const c=bvColor(THREE,star.bv);colors.push(c.r,c.g,c.b)});
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('aSize',new THREE.Float32BufferAttribute(sizes,1));geometry.setAttribute('aBrightness',new THREE.Float32BufferAttribute(brightness,1));geometry.setAttribute('aOrder',new THREE.Float32BufferAttribute(orders,1));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  const material=starMaterial(THREE),points=new THREE.Points(geometry,material),group=new THREE.Group();
  const haloMaterial=ribbonMaterial(THREE,0x58c79b,.11),coreMaterial=ribbonMaterial(THREE,0xc4f5df,.48);
  const halo=new THREE.Mesh(ribbonGeometry(THREE,stars,ERIDANUS_EDGES,.10),haloMaterial),core=new THREE.Mesh(ribbonGeometry(THREE,stars,ERIDANUS_EDGES,.024),coreMaterial);
  halo.renderOrder=1;core.renderOrder=2;points.renderOrder=3;group.add(halo,core,points);group.position.set(2.4,.2,-8);scene.add(group);
  const anchors=KEY_STARS.map(id=>{const star=byId.get(id),node=document.createElement('span');node.className='constellation-anchor';node.textContent=star.name;node.setAttribute('aria-hidden','true');document.body.append(node);return{star,node,width:node.offsetWidth,projected:new THREE.Vector3()};});
  const raycaster=new THREE.Raycaster(),ndc=new THREE.Vector2(2,2),projected=new THREE.Vector3();
  const river=document.querySelector('#riverJourney'),hoverQuery=matchMedia('(hover:hover)');
  raycaster.params.Points.threshold=.31;
  let active=null,tapLocked=false,interactive=true,labelWidth=0,labelHeight=0,baseY=.2;
  const setPointer=event=>{const rect=canvas.getBoundingClientRect();ndc.set((event.clientX-rect.left)/rect.width*2-1,-((event.clientY-rect.top)/rect.height*2-1))};
  const allowed=event=>{const rect=river.getBoundingClientRect();return interactive&&event.clientY>=Math.max(0,rect.top)&&event.clientY<Math.min(innerHeight,rect.bottom)&&!event.target?.closest?.('a,button,select,input,textarea,option')};
  const place=(x,y)=>{const width=labelWidth,height=labelHeight;label.style.left=`${Math.max(12,Math.min(innerWidth-width-12,x+14))}px`;label.style.top=`${Math.max(72,Math.min(innerHeight-height-12,y+14))}px`};
  const placeActive=()=>{if(!active)return;projected.set(active.x,active.y,0).applyMatrix4(group.matrixWorld).project(camera);place((projected.x*.5+.5)*innerWidth,(-projected.y*.5+.5)*innerHeight)};
  const show=(index,event)=>{const star=stars[index];if(!star)return;const changed=active!==star;active=star;if(changed){nameNode.textContent=star.name;metaNode.textContent=`${star.designation} · ${star.mag.toFixed(2)} mag · J2000`;}label.hidden=false;labelWidth=label.offsetWidth;labelHeight=label.offsetHeight;if(event)place(event.clientX,event.clientY);else placeActive()};
  const clear=()=>{active=null;tapLocked=false;label.hidden=true};
  const onMove=event=>{if(!allowed(event)){if(!tapLocked)clear();return}if(!hoverQuery.matches)return;setPointer(event);raycaster.setFromCamera(ndc,camera);const hit=raycaster.intersectObject(points,false)[0];if(hit&&!tapLocked)show(hit.index,event);else if(!hit&&!tapLocked)clear()};
  const onClick=event=>{if(!allowed(event))return;setPointer(event);raycaster.setFromCamera(ndc,camera);const hit=raycaster.intersectObject(points,false)[0];tapLocked=Boolean(hit);if(hit){show(hit.index,event);onSelect(stars[hit.index].id)}else{clear();onSelect('')}};
  const onKey=event=>{if(event.key==='Escape')clear()};
  window.addEventListener('pointermove',onMove,{passive:true});window.addEventListener('click',onClick);window.addEventListener('keydown',onKey);
  return{
    group,stars,materials:[material,haloMaterial,coreMaterial],
    selectStar(id){const index=stars.findIndex(star=>star.id===Number(id));if(index<0){clear();return}tapLocked=true;show(index)},
    setInteractive(value){interactive=value;if(!value)clear()},
    setViewport(width,height,pixelRatio=1){const aspect=width/height;if(aspect<.68){group.position.set(-.35,2.3,-8);group.scale.setScalar(.69)}else if(aspect<1.1){group.position.set(.4,.8,-8);group.scale.setScalar(.92)}else if(aspect>2.05){group.position.set(4.2,.1,-8);group.scale.setScalar(1.2)}else{group.position.set(2.7,.1,-8);group.scale.setScalar(1.06)}baseY=group.position.y;material.uniforms.uPixelRatio.value=pixelRatio;anchors.forEach(anchor=>{anchor.width=anchor.node.offsetWidth});if(!label.hidden){labelWidth=label.offsetWidth;labelHeight=label.offsetHeight}},
    update(progress,time,pointer){const reveal=.16+progress*.84;material.uniforms.uReveal.value=reveal;material.uniforms.uTime.value=time;haloMaterial.uniforms.uReveal.value=reveal;coreMaterial.uniforms.uReveal.value=reveal;group.position.y=baseY+progress*.65;group.position.z=-8+progress*2.3;group.rotation.z=-progress*.012;group.rotation.y=pointer.x*.008;group.rotation.x=-pointer.y*.006;group.updateMatrixWorld(true);
      anchors.forEach(({star,node,width,projected:v})=>{v.set(star.x,star.y,0).applyMatrix4(group.matrixWorld).project(camera);const rawX=(v.x*.5+.5)*innerWidth,rawY=(-v.y*.5+.5)*innerHeight,x=Math.min(Math.max(rawX,12),Math.max(12,innerWidth-width-12)),y=Math.min(Math.max(rawY,72),innerHeight-28);node.style.transform=`translate(${x}px,${y}px)`;node.classList.toggle('is-visible',interactive&&v.z>-1&&v.z<1&&Math.abs(v.x)<=1&&Math.abs(v.y)<=1)});
      if(tapLocked&&active&&interactive)placeActive();
    },
    dispose(){window.removeEventListener('pointermove',onMove);window.removeEventListener('click',onClick);window.removeEventListener('keydown',onKey);clear();anchors.forEach(a=>a.node.remove());geometry.dispose();material.dispose();halo.geometry.dispose();haloMaterial.dispose();core.geometry.dispose();coreMaterial.dispose();scene.remove(group)}
  };
}
