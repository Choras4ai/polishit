'use strict';
const payButton=document.querySelector('#payButton'),statusNode=document.querySelector('#paymentStatus'),checkButton=document.querySelector('#checkPayment'),agreement=document.querySelector('#agreement');
const resumeButton=document.querySelector('#resumePayment');let savedPayment=null;try{savedPayment=JSON.parse(sessionStorage.getItem('eridanus-ai-payment')||'null')}catch{}
const pendingKey='eridanus-ai-order',wechat=/MicroMessenger/i.test(navigator.userAgent);let busy=false,pending=null;
try{pending=sessionStorage.getItem(pendingKey)}catch{}
function message(text){statusNode.textContent=text}
function savePayment(data){savedPayment=data;try{data?sessionStorage.setItem('eridanus-ai-payment',JSON.stringify(data)):sessionStorage.removeItem('eridanus-ai-payment')}catch{}}
function remember(id){pending=id;if(!id){savePayment(null);resumeButton.hidden=true;}try{id?sessionStorage.setItem(pendingKey,id):sessionStorage.removeItem(pendingKey)}catch{}}
function lock(value){busy=value;payButton.disabled=value}
function dialog(id){document.querySelector(id).showModal()}
for(const d of document.querySelectorAll('dialog')){d.querySelector('.close').addEventListener('click',()=>d.close());d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()}})}
for(const button of document.querySelectorAll('[data-contact]'))button.addEventListener('click',()=>dialog('#contactDialog'));
document.querySelector('#copyLink').addEventListener('click',async()=>{try{await navigator.clipboard.writeText('https://course.runshi.top/ai');document.querySelector('#copyLink').textContent='链接已复制'}catch{document.querySelector('#copyLink').textContent='请复制上方网址，在微信中打开'}});
async function request(url,options={}){const response=await fetch(url,{...options,signal:AbortSignal.timeout(20000)});const data=await response.json();return{response,data}}
function showPaid(id){savePayment(null);resumeButton.hidden=true;message('微信支付已确认成功。请联系老师助手完成入群。');document.querySelector('#paidPanel').hidden=false;document.querySelector('#orderReference').textContent=`订单号：${id}`;checkButton.hidden=true;payButton.textContent='已支付 · 请联系老师助手';payButton.disabled=true;busy=true;remember(id)}
async function checkOrder(repeat=false){if(!pending)return;const id=pending;lock(true);message('正在核对微信支付结果，请勿重复付款。');try{for(let i=0;i<(repeat?15:1);i++){const{response,data}=await request(`/api/orders?orderId=${encodeURIComponent(id)}`);if(response.status===401){message('微信身份已过期，请在微信中重新授权后查询。');checkButton.textContent='微信授权并查询';checkButton.dataset.authorize='true';checkButton.hidden=false;resumeButton.hidden=true;return}if(!response.ok)throw Error(data.error||'暂时无法查询订单');if(data.status==='paid'){showPaid(id);return}if(data.status==='failed'){remember(null);message('本次订单创建失败，未确认收款，可重新报名。');checkButton.hidden=true;return}if(i<14&&repeat)await new Promise(r=>setTimeout(r,1500))}message('支付结果尚未确认。若已扣款，请勿重复支付，可重新查询或联系老师助手。');checkButton.hidden=false;resumeButton.hidden=!(savedPayment?.id===id);}catch{message('暂时无法核对支付结果。若已扣款，请勿重复支付，请稍后重新查询。');checkButton.hidden=false;}finally{if(document.querySelector('#paidPanel').hidden){lock(false);payButton.textContent=pending?'查询已有订单':'微信支付 · ¥2,899'}}}
checkButton.addEventListener('click',()=>{if(checkButton.dataset.authorize==='true'){location.assign('/api/wechat/oauth/start?product=ai');return}checkOrder(true)});
function invokeWechat(payment){return new Promise((resolve,reject)=>{let timer;const invoke=()=>{clearTimeout(timer);document.removeEventListener('WeixinJSBridgeReady',invoke);window.WeixinJSBridge.invoke('getBrandWCPayRequest',payment,resolve)};if(window.WeixinJSBridge)invoke();else{document.addEventListener('WeixinJSBridgeReady',invoke,{once:true});timer=setTimeout(()=>{document.removeEventListener('WeixinJSBridgeReady',invoke);reject(Error('微信支付组件未就绪，请稍后重试'))},10000)}})}
payButton.addEventListener('click',async()=>{if(busy)return;if(pending){await checkOrder(true);return}if(!agreement.checked){message('请先阅读并勾选课程与金额确认。');agreement.focus();return}if(!wechat){dialog('#qrDialog');return}lock(true);message('正在创建 AI 数据分析课程订单 · ¥2,899…');try{const{response,data}=await request('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:'ai'})});if(response.status===401){location.assign('/api/wechat/oauth/start?product=ai');return}if(!response.ok||!data.orderId||!data.payment)throw Error(data.error||'订单创建失败，请稍后重试');remember(data.orderId);savePayment({id:data.orderId,payment:data.payment});const result=await invokeWechat(data.payment);if(result.err_msg==='get_brand_wcpay_request:cancel'){remember(null);message('你已取消本次支付。');return}if(result.err_msg!=='get_brand_wcpay_request:ok'){resumeButton.hidden=false;message('微信尚未确认支付成功，请先查询订单结果。');checkButton.hidden=false;return}await checkOrder(true);}catch(error){message(pending?'支付状态待确认，请先查询订单结果，避免重复付款。':error.message||'暂时无法创建订单，请稍后重试');if(pending){checkButton.hidden=false;resumeButton.hidden=!(savedPayment?.id===pending);}}finally{if(document.querySelector('#paidPanel').hidden){lock(false);payButton.textContent=pending?'查询已有订单':'微信支付 · ¥2,899'}}});
resumeButton.addEventListener('click',async()=>{
 if(busy||!pending||savedPayment?.id!==pending)return;
 if(!wechat){dialog('#qrDialog');return}lock(true);
 try{const{response,data}=await request(`/api/orders?orderId=${encodeURIComponent(pending)}`);
  if(response.status===401){checkButton.hidden=false;checkButton.dataset.authorize='true';checkButton.textContent='微信授权并查询';message('请先重新授权微信身份。');return}
  if(!response.ok)throw Error(data.error||'订单查询失败');
  if(data.status==='paid'){showPaid(pending);return}
  if(data.status!=='pending'){remember(null);message('订单已失效，可重新报名。');return}
  const result=await invokeWechat(savedPayment.payment);
  if(result.err_msg==='get_brand_wcpay_request:ok')await checkOrder(true);
  else message(result.err_msg==='get_brand_wcpay_request:cancel'?'你已取消支付，可继续支付同一笔订单。':'付款暂未完成。如微信提示订单过期，请联系老师助手核对后处理。');
 }catch(error){message(error.message||'无法调起支付，请稍后重试。')}finally{if(document.querySelector('#paidPanel').hidden)lock(false)}
});
// OAuth never triggers a charge automatically: the learner confirms the course again.
if(new URLSearchParams(location.search).has('payment')){history.replaceState(null,'','/ai#enroll');message('微信授权已完成，请确认课程与金额后点击支付。');document.querySelector('#enroll').scrollIntoView({behavior:'instant'})}
if(pending){checkButton.hidden=false;checkOrder(false)}
