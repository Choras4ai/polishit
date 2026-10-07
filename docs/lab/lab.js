import {ERIDANUS_EDGES,ERIDANUS_STARS,projectEridanus} from './eridanus-data.js?v=20260912-1';

const body=document.body,canvas=document.querySelector('#spaceCanvas'),loader=document.querySelector('#labLoader'),loaderProgress=document.querySelector('#loaderProgress'),loaderLabel=document.querySelector('#loaderLabel');
const label=document.querySelector('#starLabel'),nameNode=document.querySelector('#starLabelName'),metaNode=document.querySelector('#starLabelMeta');
const starSelect=document.querySelector('#starSelect'),starDetails=document.querySelector('#starDetails'),motionToggle=document.querySelector('#motionToggle'),skyStatus=document.querySelector('#skyStatus'),brandMotionToggle=document.querySelector('#brandMotionToggle');
const motionQuery=matchMedia('(prefers-reduced-motion: reduce)'),saveData=Boolean(navigator.connection?.saveData),deviceMemory=Number(navigator.deviceMemory||4),hardwareConcurrency=Number(navigator.hardwareConcurrency||4);
let teardown=()=>{},renderController=null,bootSerial=0,userPaused=false;
window.__labDiagnostics={mode:'loading',running:false,frames:0};

for(const star of ERIDANUS_STARS){const option=document.createElement('option');option.value=star.id;option.textContent=star.name;starSelect?.append(option)}
function describeStar(id){const star=ERIDANUS_STARS.find(item=>item.id===Number(id));starSelect.value=star?String(star.id):'';starDetails.textContent=star?`${star.name} · ${star.designation} · ${star.mag.toFixed(2)} mag · J2000`:'';}
starSelect.addEventListener('change',()=>{describeStar(starSelect.value);renderController?.selectStar(starSelect.value)});
starSelect.addEventListener('keydown',event=>{
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&!event.altKey&&!event.metaKey&&!event.ctrlKey){
    event.preventDefault();
    const last=starSelect.options.length-1;
    starSelect.selectedIndex=event.key==='Home'?0:event.key==='End'?last:Math.max(0,Math.min(last,starSelect.selectedIndex+(event.key==='ArrowDown'?1:-1)));
    starSelect.dispatchEvent(new Event('change'));
  }else if(event.key==='Escape'){starSelect.value='';describeStar('');renderController?.selectStar('')}
});
motionToggle.addEventListener('click',()=>{userPaused=!userPaused;renderController?.refresh();updateMotionControl()});
brandMotionToggle?.addEventListener('click',()=>{userPaused=!userPaused;renderController?.refresh();updateMotionControl()});
function updateMotionControl(){const paused=userPaused||motionQuery.matches;motionToggle.hidden=true;motionToggle.textContent='';motionToggle.setAttribute('aria-pressed',String(userPaused));brandMotionToggle?.setAttribute('aria-pressed',String(paused));body.classList.toggle('motion-paused',paused);}
function setLoader(value,text){if(loaderProgress)loaderProgress.value=value;if(loaderLabel&&text)loaderLabel.textContent=text}
function reveal(mode='ready'){body.classList.add('lab-ready');body.classList.toggle('canvas-fallback',mode==='fallback');setTimeout(()=>loader?.remove(),750)}
function webgl2(){try{const probe=document.createElement('canvas'),gl=window.WebGL2RenderingContext&&probe.getContext('webgl2',{failIfMajorPerformanceCaveat:true});if(!gl)return false;gl.getExtension('WEBGL_lose_context')?.loseContext();return true}catch{return false}}
function quality(){if(saveData||deviceMemory<=2||hardwareConcurrency<=4)return{name:'low',dpr:.9,stars:1500,antialias:true};if(deviceMemory>=8&&hardwareConcurrency>=8)return{name:'high',dpr:1.35,stars:3800,antialias:true};return{name:'standard',dpr:1.1,stars:2600,antialias:true}}
function staticMode(reason){teardown();renderController=null;label.hidden=true;body.classList.remove('lab-enhanced');teardown=drawStaticSky();window.__labDiagnostics.mode='static';window.__labDiagnostics.running=false;skyStatus.textContent=reason;updateMotionControl();reveal('fallback')}
async function initialize(){
  const serial=++bootSerial;
  teardown();teardown=()=>{};renderController=null;
    if(!canvas||motionQuery.matches||saveData||!webgl2()){staticMode(motionQuery.matches?'已按系统偏好减少动画':saveData?'节省流量模式 · 静态星图':'静态星图');return}
  try{
    const [THREE,{createEridanusConstellation}]=await Promise.all([import('./vendor/three.module.min.js'),import('./eridanus-constellation.js?v=20260912-1')]);
    if(serial!==bootSerial)return;
    boot(THREE,createEridanusConstellation);
  }catch(error){if(serial!==bootSerial)return;console.warn('[NEO LAB] Static star chart activated:',error?.message||error);staticMode('交互星图暂不可用，已切换静态星图')}
}
motionQuery.addEventListener('change',initialize);
addEventListener('pagehide',()=>{bootSerial++;teardown();renderController=null});
addEventListener('pageshow',event=>{if(event.persisted)initialize()});
initialize();

function boot(THREE,createEridanusConstellation){
  const q=quality();body.dataset.renderQuality=q.name;body.classList.add('lab-enhanced');body.classList.remove('canvas-fallback');
  const diagnostics=window.__labDiagnostics={mode:'webgl',quality:q.name,fps:0,drawCalls:0,triangles:0,dpr:0,running:false,frames:0};
  setLoader(24,'CALIBRATING J2000 FIELD');
  const renderer=new THREE.WebGLRenderer({canvas,antialias:q.antialias,alpha:false,powerPreference:q.name==='low'?'low-power':'high-performance'});
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(43,innerWidth/innerHeight,.1,180),events=new AbortController();
  let constellation,raf=0,disposed=false,last=performance.now(),time=0,progress=0,targetProgress=0,drift=0,targetDrift=0,inView=true,samples=[];
  teardown=()=>{if(disposed)return;disposed=true;cancelAnimationFrame(raf);raf=0;diagnostics.running=false;events.abort();constellation?.dispose();scene.traverse(object=>{object.geometry?.dispose();for(const material of[].concat(object.material||[]))material.dispose()});renderer.dispose();label.hidden=true};
  renderer.setClearColor(0x010604,1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.02;camera.position.set(0,0,26);
  const backdrop=createBackdrop(scene,q,THREE);setLoader(57,'TRACING THE RIVER');
  constellation=createEridanusConstellation({THREE,scene,camera,canvas,label,nameNode,metaNode,quality:q.name,onSelect:describeStar});
  const pointer=new THREE.Vector2(),pointerTarget=new THREE.Vector2();
  const section=document.querySelector('#riverJourney'),manifesto=document.querySelector('#lab-manifesto');
  const canAnimate=()=>!disposed&&!document.hidden&&inView&&!userPaused;
  const draw=()=>{camera.position.x=pointer.x*.17;camera.position.y=-pointer.y*.12;camera.lookAt(0,0,-8);camera.updateMatrixWorld();backdrop.update(time,drift,pointer);diagnostics.scrollDrift=Number(drift.toFixed(4));constellation.update(progress,time,pointer);renderer.render(scene,camera);diagnostics.frames++;diagnostics.drawCalls=renderer.info.render.calls;diagnostics.triangles=renderer.info.render.triangles};
  const refresh=()=>{const active=canAnimate();diagnostics.running=active;if(!active){cancelAnimationFrame(raf);raf=0;return}if(!raf){last=performance.now();raf=requestAnimationFrame(frame)}};
  const updateProgress=()=>{const rect=section.getBoundingClientRect();targetProgress=THREE.MathUtils.clamp(-rect.top/Math.max(1,section.offsetHeight-innerHeight),0,1);targetDrift=THREE.MathUtils.clamp(scrollY/Math.max(1,manifesto.offsetTop),0,1);inView=manifesto.getBoundingClientRect().top>0;constellation.setInteractive(rect.bottom>0);refresh();if(userPaused&&inView&&!document.hidden){progress=targetProgress;drift=targetDrift;draw()}};
  const resize=()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();const compact=Math.min(innerWidth,innerHeight)<=820;const budget=q.name==='low'?1600000:3200000;const dpr=Math.min(devicePixelRatio||1,compact?(q.name==='low'?2:3):q.dpr,Math.sqrt(budget/(innerWidth*innerHeight)));renderer.setPixelRatio(dpr);renderer.setSize(innerWidth,innerHeight,false);constellation.setViewport(innerWidth,innerHeight,dpr);diagnostics.dpr=dpr;backdrop.setPixelRatio(dpr);updateProgress();if(!diagnostics.running)draw()};
  addEventListener('scroll',updateProgress,{passive:true,signal:events.signal});
  addEventListener('pointermove',event=>{if(!canAnimate())return;pointerTarget.x=(event.clientX/innerWidth-.5)*2;pointerTarget.y=(event.clientY/innerHeight-.5)*2},{passive:true,signal:events.signal});
  addEventListener('resize',resize,{passive:true,signal:events.signal});
  document.addEventListener('visibilitychange',refresh,{signal:events.signal});
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();staticMode('图形连接已中断，已切换静态星图')},{signal:events.signal});
  renderController={refresh,selectStar:id=>{constellation.selectStar(id);if(userPaused)draw()}};
  skyStatus.textContent='滚动页面，沿星河探索';updateMotionControl();resize();draw();setLoader(100,'SIGNAL ACQUIRED');reveal();
  function frame(now){raf=0;if(!canAnimate()){diagnostics.running=false;return}const frameMs=Math.max(0,now-last),dt=Math.min(frameMs/1000,.05);last=now;time+=dt;progress+=(targetProgress-progress)*(1-Math.pow(.0015,dt));drift+=(targetDrift-drift)*(1-Math.exp(-7.5*dt));pointer.lerp(pointerTarget,1-Math.pow(.03,dt));draw();if(frameMs>0&&time>1){samples.push(frameMs);if(samples.length===90){const avg=samples.reduce((a,b)=>a+b,0)/samples.length;diagnostics.fps=Number((1000/avg).toFixed(1));samples=[]}}raf=requestAnimationFrame(frame)}
}

function createBackdrop(scene,q,THREE){
  const nebulaUniforms={uTime:{value:0},uProgress:{value:0}};
  const nebula=new THREE.Mesh(new THREE.PlaneGeometry(128,84),new THREE.ShaderMaterial({
    uniforms:nebulaUniforms,depthWrite:false,depthTest:false,
    vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`precision highp float;varying vec2 vUv;uniform float uTime;uniform float uProgress;
      float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1)),f.x),f.y);}
      float fbm(vec2 p){return n(p)*.52+n(p*2.07+4.2)*.28+n(p*4.11-2.7)*.14+n(p*8.1)*.06;}
      void main(){vec2 p=(vUv-.5)*vec2(1.7,1.);p.y-=uProgress*.085;
      float cloud=smoothstep(.35,.82,fbm(p*2.8+vec2(uTime*.0015,-uTime*.001)));
      float river=exp(-abs(p.y+sin(p.x*2.1)*.16)*4.3);
      vec3 c=vec3(.002,.009,.006)+vec3(.026,.081,.060)*cloud*1.65+vec3(.009,.030,.034)*river*.85;
      gl_FragColor=vec4(c,1.);}`
  }));nebula.position.z=-58;scene.add(nebula);
  // Depth-dependent movement is evaluated on the GPU in one draw call.
  const random=seeded(7301),positions=new Float32Array(q.stars*3),sizes=new Float32Array(q.stars),phases=new Float32Array(q.stars),depths=new Float32Array(q.stars),colors=new Float32Array(q.stars*3);
  for(let i=0;i<q.stars;i++){
    const depth=random();depths[i]=depth;
    positions[i*3]=(random()-.5)*118;positions[i*3+1]=(random()-.5)*82;positions[i*3+2]=-10-(1-depth)*92;
    sizes[i]=.7+random()*1.35+(random()>.985?1.2:0);phases[i]=random()*6.283;
    const warm=random()>.9;colors[i*3]=warm?1.:.78;colors[i*3+1]=warm?.85:.96;colors[i*3+2]=warm?.67:.9;
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('aSize',new THREE.BufferAttribute(sizes,1));geometry.setAttribute('aPhase',new THREE.BufferAttribute(phases,1));geometry.setAttribute('aDepth',new THREE.BufferAttribute(depths,1));geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,vertexColors:true,blending:THREE.AdditiveBlending,
    uniforms:{uTime:{value:0},uProgress:{value:0},uPixelRatio:{value:1}},
    vertexShader:`attribute float aSize;attribute float aPhase;attribute float aDepth;uniform float uTime;uniform float uProgress;uniform float uPixelRatio;varying float vAlpha;varying vec3 vColor;
      void main(){vec3 p=position;float travel=uProgress;
      p.y+=travel*(5.+aDepth*12.);p.x+=sin(travel*1.8)*aDepth*2.8;p.z+=travel*(2.+aDepth*7.);
      vec4 mv=modelViewMatrix*vec4(p,1.);gl_PointSize=clamp(aSize*uPixelRatio*(145./-mv.z),1.3*uPixelRatio,8.5*uPixelRatio);
      gl_Position=projectionMatrix*mv;vAlpha=(.88+.06*sin(uTime*.33+aPhase))*(.78+aDepth*.22);vColor=color;}`,
    fragmentShader:`precision highp float;varying float vAlpha;varying vec3 vColor;
      void main(){vec2 p=gl_PointCoord-.5;float r2=dot(p,p);float core=exp(-r2*64.);float halo=exp(-r2*17.)*.18;
      float a=(core+halo)*vAlpha*(1.-smoothstep(.12,.25,r2));if(a<.008)discard;gl_FragColor=vec4(vColor,a);}`
  });const field=new THREE.Points(geometry,material);scene.add(field);
  return{
    setPixelRatio(value){material.uniforms.uPixelRatio.value=value},
    update(time,progress,pointer){nebulaUniforms.uTime.value=time;nebulaUniforms.uProgress.value=progress;material.uniforms.uTime.value=time;material.uniforms.uProgress.value=progress;field.rotation.y=pointer.x*.009;field.rotation.x=-pointer.y*.006;}
  };
}

function drawStaticSky(){
  if(!canvas)return()=>{};
  let target=document.querySelector('#staticSkyCanvas');
  if(!target){target=document.createElement('canvas');target.id='staticSkyCanvas';target.setAttribute('aria-hidden','true');canvas.after(target)}
  canvas.style.display='none';
  const cleanup=()=>{target.remove();canvas.style.display=''};
  const ctx=target.getContext('2d');if(!ctx)return cleanup;
  const render=()=>{const w=innerWidth,h=innerHeight,dpr=Math.min(devicePixelRatio||1,3,Math.sqrt(3200000/(w*h)));target.width=Math.round(w*dpr);target.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);const gradient=ctx.createRadialGradient(w*.58,h*.42,0,w*.58,h*.42,Math.max(w,h));gradient.addColorStop(0,'#0a2118');gradient.addColorStop(.48,'#04110c');gradient.addColorStop(1,'#010604');ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);const rnd=seeded(7301);for(let i=0;i<1100;i++){const x=rnd()*w,y=rnd()*h,r=rnd()>.97?1.5:.35+rnd()*.75;ctx.globalAlpha=.3+rnd()*.48;ctx.fillStyle=rnd()>.72?'#8ad5b4':'#d9eee5';ctx.beginPath();ctx.arc(x,y,r,0,6.283);ctx.fill()}ctx.globalAlpha=1;const stars=projectEridanus(),map=new Map(stars.map(s=>[s.id,s])),scale=Math.min(w/18,h/13),ox=w*(w<820?.5:.61),oy=h*.46;const xy=s=>[ox+s.x*scale,oy-s.y*scale];ctx.lineCap='round';ERIDANUS_EDGES.forEach(([a,b])=>{const p=map.get(a),q=map.get(b);if(!p||!q)return;const [x1,y1]=xy(p),[x2,y2]=xy(q);ctx.strokeStyle='rgba(101,202,161,.13)';ctx.lineWidth=5;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();ctx.strokeStyle='rgba(201,246,224,.55)';ctx.lineWidth=1;ctx.stroke()});stars.forEach(s=>{const [x,y]=xy(s),r=s.id===7588?4.2:Math.max(1.4,3.8-s.mag*.45);ctx.shadowColor=s.bv>.8?'#ffd29e':'#bdf3dd';ctx.shadowBlur=r*4;ctx.fillStyle=s.bv>.8?'#ffe0b5':'#dffff0';ctx.globalAlpha=.76;ctx.beginPath();ctx.arc(x,y,r,0,6.283);ctx.fill()});ctx.shadowBlur=0;ctx.globalAlpha=1};render();addEventListener('resize',render,{passive:true});return()=>{removeEventListener('resize',render);if(target!==canvas)target.remove();canvas.style.display='';};
}
function seeded(seed){let value=seed>>>0;return()=>{value+=0x6D2B79F5;let t=value;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}}
