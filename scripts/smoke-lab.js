'use strict';
// Real Chromium/WebGL regression checks; no user profile or external services.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'runshi-lab-smoke-'));
app.setPath('userData',path.join(output,'profile'));
app.on('window-all-closed',()=>{});
const checks=[],errors=[],requests=[];
checks.push=function(...items){console.log(items.join('\n'));return Array.prototype.push.apply(this,items)};
setTimeout(()=>{console.error('Lab smoke watchdog timeout');app.exit(1)},90000).unref();let server,window,origin,scenario='normal';
const inspect=source=>window.webContents.executeJavaScript(source);
async function until(source,timeout=10000){const start=Date.now();while(Date.now()-start<timeout){if(await inspect(source))return;await new Promise(r=>setTimeout(r,30))}throw new Error(`Timed out: ${source}`)}
async function frame(){await inspect('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')}
async function open({mode='normal',reduced=false,disableJS=false}={}){
  if(window)window.destroy();scenario=mode;console.log('Opening scenario:',mode);
  window=new BrowserWindow({width:1440,height:900,show:true,webPreferences:{partition:`lab-${Date.now()}-${Math.random()}`,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,javascript:!disableJS}});
  window.webContents.session.webRequest.onBeforeRequest((details,callback)=>{requests.push({scenario,url:details.url});callback({cancel:/^https?:/.test(details.url)&&(!details.url.startsWith(origin+'/')||(mode==='vendor'&&details.url.includes('/vendor/'))||(mode==='entry'&&/\/lab\.js\?/.test(details.url)))})});
  window.webContents.on('console-message',event=>{if(event.level==='error')errors.push({scenario,message:event.message})});
  await window.loadURL('about:blank');
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]});
  await window.loadURL(origin+'/lab/');
  if(!disableJS){await until('document.body.classList.contains("lab-ready")');await until('!document.querySelector("#labLoader")');await inspect('addEventListener("wheel",e=>e.preventDefault(),{passive:false,capture:true})')}
}
async function screenshot(name){await frame();fs.writeFileSync(path.join(output,name),(await window.capturePage()).toPNG())}
app.whenReady().then(async()=>{
  server=http.createServer((request,response)=>{try{const base=path.join(root,'docs');let file=path.resolve(base,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));if(!file.startsWith(base+path.sep))throw new Error('path');if(fs.statSync(file).isDirectory())file=path.join(file,'index.html');response.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream');response.end(fs.readFileSync(file))}catch{response.writeHead(404);response.end()}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  await open();
  assert.equal(await inspect('window.__labDiagnostics.mode'),'webgl','This smoke run must exercise real WebGL, not silently accept a fallback');
  await until('window.__labDiagnostics.frames>5');checks.push('WebGL initializes and renders without a blocking loader');
  assert.equal(await inspect('document.querySelector("#skyControls").hidden'),true);
  assert.equal(await inspect('document.querySelector("#starLabel").hidden'),true);
  assert.doesNotMatch(await inspect('document.body.innerText'),/探索恒星|选择一颗恒星|暂停动画|指向或轻点星图/);
  checks.push('Removed star picker and pause controls stay hidden');
  await screenshot('scroll-start.png');
  await inspect('scrollTo({top:(document.querySelector("#riverJourney").offsetHeight-innerHeight)*.65,behavior:"instant"})');
  await until('window.__labDiagnostics.scrollDrift>.12');
  await screenshot('scroll-forward.png');
  const forwardDrift=await inspect('window.__labDiagnostics.scrollDrift');
  await inspect('scrollTo({top:0,behavior:"instant"})');await until('window.__labDiagnostics.scrollDrift<.01');
  checks.push(`Scroll parallax moves forward (${forwardDrift}) and returns smoothly (<0.01)`);
  const timing=await inspect('new Promise(resolve=>{const times=[];let last;function sample(now){if(last)times.push(now-last);last=now;if(times.length<120)requestAnimationFrame(sample);else{times.sort((a,b)=>a-b);resolve({medianMs:times[60],p95Ms:times[114],drawCalls:window.__labDiagnostics.drawCalls,quality:window.__labDiagnostics.quality})}}requestAnimationFrame(sample)})');
  fs.writeFileSync(path.join(output,'frame-timing.json'),JSON.stringify(timing,null,2));
  assert(timing.drawCalls<=6, 'Unexpected rendering passes');
  checks.push(`Steady rendering: ${timing.drawCalls} draw calls, median ${timing.medianMs.toFixed(1)}ms / p95 ${timing.p95Ms.toFixed(1)}ms on this machine`);
  await inspect('window.scrollTo({top:document.querySelector("#lab-manifesto").offsetTop+10,behavior:"instant"})');await until('window.__labDiagnostics.running===false');await frame();const offscreenFrames=await inspect('window.__labDiagnostics.frames');await frame();assert.equal(await inspect('window.__labDiagnostics.frames'),offscreenFrames);
  await inspect('document.querySelector(".manifesto-lead").click()');assert.equal(await inspect('document.querySelector("#starLabel").hidden'),true);checks.push('Introduction keeps the background still to save GPU work and cannot select background stars');
  for(const width of[320,390,768,900,1024,1440]){
    window.setContentSize(width,900);await frame();
    const overflow=await inspect(`Array.from(document.querySelectorAll('h1,h2,h3,p,a,select,output')).filter(e=>{if(e.closest('[hidden]'))return false;if(e.closest('.lab-footer')&&getComputedStyle(e.closest('.lab-footer')).overflowX==='auto')return false;const style=getComputedStyle(e);if(style.clipPath==='inset(50%)'&&style.overflow==='hidden'&&e.clientWidth===1&&e.clientHeight===1)return false;const r=e.getBoundingClientRect();return r.width&&(r.right>innerWidth+1||r.left<-1||e.scrollWidth>e.clientWidth+2)}).map(e=>({tag:e.tagName,text:e.textContent.slice(0,45),width:e.clientWidth,scroll:e.scrollWidth}))`);
    assert.deepEqual(overflow,[],`overflow at ${width}px`);
    await inspect('window.scrollTo({top:0,behavior:"instant"})');await until('window.__labDiagnostics.running');
    await screenshot(`hero-${width}.png`);
    await inspect('window.scrollTo({top:document.querySelector("#lab-manifesto").offsetTop+10,behavior:"instant"})');await until('!window.__labDiagnostics.running');
    if(width===390||width===900||width===1440)await screenshot(`manifesto-${width}.png`);
    checks.push(`Layout and text fit at ${width}px`);
  }
  window.setContentSize(844,390);await frame();await inspect('scrollTo({top:0,behavior:"instant"})');await frame();
  const boxes=await inspect(`['.sky-controls','.river-copy','.lab-header'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return{top:r.top,bottom:r.bottom}})`);assert(boxes[0].bottom<boxes[1].top,'landscape controls overlap hero text');checks.push('Short landscape viewport keeps controls and hero copy separate');
  window.setContentSize(390,844);await frame();assert.equal(await inspect('document.querySelector("#starLabel").hidden'),true);checks.push('Removed star tooltip remains hidden on mobile');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await until('window.__labDiagnostics.mode==="static"');assert.equal(await inspect('document.querySelectorAll(".constellation-anchor").length'),0);assert.equal(await inspect('document.querySelector("#starLabel").hidden'),true);assert.equal(await inspect('document.querySelectorAll("#staticSkyCanvas").length'),1);checks.push('Changing system reduced-motion preference disposes WebGL and shows one static sky');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await until('window.__labDiagnostics.mode==="webgl"');await until('window.__labDiagnostics.frames>2');assert.equal(await inspect('document.querySelectorAll("#staticSkyCanvas").length'),0);checks.push('Re-enabling motion replaces the fallback without duplicate canvases');
  await inspect('document.querySelector("#spaceCanvas").getContext("webgl2").getExtension("WEBGL_lose_context").loseContext()');await until('window.__labDiagnostics.mode==="static"');assert.equal(await inspect('document.querySelectorAll(".constellation-anchor").length'),0);await inspect('document.querySelector("#spaceCanvas").dispatchEvent(new Event("webglcontextlost"))');assert.equal(await inspect('document.querySelectorAll("#staticSkyCanvas").length'),1);checks.push('WebGL context loss cleans old anchors and does not duplicate fallback canvases');
  await open({mode:'reduced',reduced:true});assert.equal(await inspect('window.__labDiagnostics.mode'),'static');assert(!requests.some(r=>r.scenario==='reduced'&&r.url.includes('/vendor/')));assert.equal(await inspect('document.querySelector("#skyControls").hidden'),true);checks.push('Reduced motion avoids downloading Three.js and keeps removed controls hidden');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await until('window.__labDiagnostics.mode==="webgl"');await until('window.__labDiagnostics.frames>2');checks.push('Initially reduced-motion page can enable WebGL later');
  await open({mode:'vendor'});assert.equal(await inspect('window.__labDiagnostics.mode'),'static');assert.equal(await inspect('document.querySelector("#skyControls").hidden'),true);checks.push('Blocked Three.js falls back to a static constellation background');
  await open({mode:'entry'});assert.match(await inspect('document.querySelector(".sky-unavailable").textContent'),/仍可正常阅读/);checks.push('Blocked entry module still reveals the introduction with a clear notice');
  await open({mode:'no-js',disableJS:true});const disabledStyles=await window.webContents.debugger.sendCommand('Runtime.evaluate',{expression:'["#labLoader","#skyControls"].map(s=>getComputedStyle(document.querySelector(s)).display)',returnByValue:true});assert.deepEqual(disabledStyles.result.value,['none','none']);checks.push('JavaScript-disabled page remains readable without inactive controls');
  const unexpected=errors.filter(e=>!['vendor','entry'].includes(e.scenario)&&/Uncaught|TypeError|ReferenceError|SyntaxError|Content Security Policy/.test(e.message));assert.deepEqual(unexpected,[]);
  const result={ok:true,checks,errors,output};fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));window.destroy();server.close();app.exit(0);
}).catch(error=>{console.error(error.stack,output);fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error.stack,checks,errors,output},null,2));window?.destroy();server?.close();app.exit(1)});
