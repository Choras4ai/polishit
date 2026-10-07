'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(ROOT,file),'utf8');
const main=read('docs/index.html'),lab=read('docs/lab/index.html'),css=read('docs/lab/lab.css'),js=read('docs/lab/lab.js'),data=read('docs/lab/eridanus-data.js'),scene=read('docs/lab/eridanus-constellation.js'),ambient=read('docs/main-ambient.js');
const publicDocs=['docs/index.html','docs/privacy.html','docs/terms.html','docs/security-assessment.html','docs/technical-report.html'].map(read).join('\n');

test('main website routes GitHub navigation to the branded NEO LAB page',()=>{assert.match(main,/href="lab\/"[^>]*>NEO LAB/);assert.match(main,/id="ambientCanvas"/);assert.doesNotMatch(main,/href="https:\/\/github\.com\/Choras4ai/)});
test('main comparison demonstrates the current in-document Word and WPS workflow',()=>{
  for(const copy of ['意见就在字里行间','Word / WPS 加载项现支持批注与原生修订','研究综述.docx · Word','原文浮窗修订','界面交互演示','实际能力以当前版本为准'])assert.ok(main.includes(copy));
  assert.match(main,/data-demo-mode="polish"/);assert.match(main,/data-demo-mode="natural"/);
  assert.match(main,/id="demoDocument"/);assert.match(main,/id="demoUndo"/);assert.match(main,/aria-live="polite"/);
  assert.match(main,/src="review-demo\.js\?v=/);assert.match(main,/href="review-demo\.css\?v=/);
  assert.doesNotMatch(main,/至少 5 步|class="time"|时间数字|复什/);
});
test('public pages do not expose personal identity',()=>{assert.doesNotMatch(publicDocs,/陈实之|Choras4ai|choras@agent\.qq\.com|152\s*4380\s*0189/i);assert.match(publicDocs,/波江座（长沙）人工智能应用软件有限责任公司/)});

test('NEO LAB is now a single Eridanus constellation experience',()=>{
  assert.match(lab,/id="riverJourney"/);assert.match(lab,/ERIDANUS · THE RIVER/);assert.match(lab,/让星河/);assert.match(lab,/波江座人工智能实验室/);
  assert.doesNotMatch(lab,/EVENT HORIZON|RESONANCE VESSEL|hero-black-hole|hero-vessel|data-act=/);assert.doesNotMatch(lab,/gsap|ScrollTrigger|postprocessing/);
  assert.equal(fs.existsSync(path.join(ROOT,'docs/lab/relativistic-black-hole.js')),false);assert.equal(fs.existsSync(path.join(ROOT,'docs/lab/eri-vessel.js')),false);
  assert.equal(fs.existsSync(path.join(ROOT,'docs/lab/hero-black-hole-v7.webp')),false);assert.equal(fs.existsSync(path.join(ROOT,'docs/lab/hero-vessel-v7.webp')),false);assert.equal(fs.existsSync(path.join(ROOT,'docs/lab/og-v2.jpg')),false);
});

test('J2000 catalogue contains 31 explicit stars and 31 explicit edges',()=>{
  const stars=(data.match(/\{id:\d+,name:/g)||[]).length;const edgeBlock=data.match(/export const ERIDANUS_EDGES = \[([\s\S]*?)\n\];/)[1];const edges=(edgeBlock.match(/\[\d+,\d+\]/g)||[]).length;
  assert.equal(stars,31);assert.equal(edges,31);for(const name of ['Cursa','Zaurak','Acamar','Achernar','Ran','Rana','Zibal'])assert.match(data,new RegExp(`name:'${name}'`));
  assert.match(data,/gnomonic|cosc|ra0|dec0/i);assert.match(data,/ERIDANUS_EDGES/);
});

test('constellation rendering maps magnitude and colour and uses two anti-aliased line layers',()=>{
  assert.match(scene,/bvColor/);assert.match(scene,/star\.mag/);assert.match(scene,/ribbonGeometry/);assert.match(scene,/haloMaterial/);assert.match(scene,/coreMaterial/);assert.match(scene,/THREE\.AdditiveBlending/);
  assert.match(scene,/Raycaster/);assert.match(scene,/pointermove/);assert.match(scene,/click/);assert.match(scene,/constellation-anchor/);
});

test('opening frame is visible and scroll only traces the existing river',()=>{assert.match(scene,/uReveal:\{value:\.18\}/);assert.match(scene,/mix\(uBase,1\.,traced\)/);assert.match(scene,/const reveal=\.16\+progress\*\.84/);assert.match(css,/\.river-journey\{height:185vh;height:185svh\}/)});

test('resilient static, reduced-motion and device fallbacks remain',()=>{assert.match(js,/drawStaticSky/);assert.match(js,/staticSkyCanvas/);assert.match(js,/canvas\.after\(target\)/);assert.match(js,/prefers-reduced-motion: reduce/);assert.match(js,/navigator\.connection\?\.saveData/);assert.match(js,/webglcontextlost/);assert.match(js,/document\.hidden/);assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);assert.match(css,/loaderFailsafe/)});

test('interaction cannot be blocked by the sticky page overlay',()=>{assert.match(scene,/window\.addEventListener\('pointermove'/);assert.match(scene,/window\.addEventListener\('click'/);assert.match(css,/\.river-journey,.river-sticky,.river-copy,.river-caption,.scroll-cue\{pointer-events:none\}/);assert.match(lab,/role="img" aria-describedby="river-title"/);assert.match(lab,/select id="starSelect"/);assert.doesNotMatch(lab,/探索恒星|选择一颗恒星|暂停动画|指向或轻点星图/);assert.doesNotMatch(js,/暂停动画|指向或轻点星图|可通过列表/)});

test('mobile constellation labels and return control remain inside the viewport',()=>{assert.match(scene,/aspect<\.68\)\{group\.position\.set\(-\.35,2\.3,-8\);group\.scale\.setScalar\(\.69\)/);assert.match(scene,/innerWidth-width-12/);assert.match(scene,/Math\.max\(rawY,72\)/);assert.match(css,/@media\(max-width:480px\)\{\.back-link\{position:fixed/);assert.match(css,/\.back-link span\{display:block;font-size:15px;line-height:1\}/)});

test('page preserves manifesto, company footer and one-way product routing',()=>{assert.match(lab,/id="lab-manifesto"/);assert.match(lab,/Language &amp; Meaning/);assert.match(lab,/Data &amp; Discovery/);assert.match(lab,/Mind &amp; Connection/);assert.match(lab,/湘ICP备2026023017号-1/);assert.doesNotMatch(lab,/进入润石产品|返回润石/)});

test('all runtime assets are self-hosted and personal details stay absent',()=>{assert.match(lab,/vendor\/three\.module\.min\.js|lab-boot\.js/);assert.doesNotMatch(lab,/<script[^>]+https?:\/\//i);assert.match(lab,/og:image" content="https:\/\/www\.runshi\.top\/lab\/og-eridanus\.jpg/);assert.match(lab,/twitter:image" content="https:\/\/www\.runshi\.top\/lab\/og-eridanus\.jpg/);assert.equal(fs.existsSync(path.join(ROOT,'docs/lab/og-eridanus.jpg')),true);assert.match(lab,/lab\.css\?v=[^"']+/);assert.match(lab,/lab-boot\.js\?v=[^"']+/);assert.doesNotMatch(`${lab}\n${css}\n${js}\n${data}\n${scene}`,/陈实之|Choras4ai|choras@|152\s*4380/i)});

test('main ambient motion remains restrained',()=>{assert.match(ambient,/prefers-reduced-motion: reduce/);assert.match(ambient,/navigator\.connection\?\.saveData/);assert.match(ambient,/visibilitychange/);assert.match(ambient,/cancelAnimationFrame/)});
