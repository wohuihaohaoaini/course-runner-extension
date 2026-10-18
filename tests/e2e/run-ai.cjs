// 真实 Chromium 加载扩展，拦截本地模拟课程和 AI 响应；不会访问真实课程或计费 API。
// NODE_PATH 指向 playwright，CHROMIUM_PATH 可指定 Chromium 可执行文件。
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const {modernQuestion,wireModernChoices}=require('../fixtures/modern-quiz.cjs');
const {videoQuestion}=require('../fixtures/video-quiz.cjs');
const extension = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'course-ai-e2e-'));
const output = process.env.E2E_OUTPUT || temp;
fs.mkdirSync(output, { recursive: true });
execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y','-f','lavfi','-i','color=c=0x087b71:s=320x180:r=10:d=5','-c:v','libvpx','-an',path.join(temp,'clip.webm')], {stdio:'ignore'});
const clip = fs.readFileSync(path.join(temp,'clip.webm'));
const finished = new Set();
const events=[];
const jobs = id => id === '7' ? [{id:'v1',type:'video'},{id:'v2',type:'video'},{id:'q',type:'quiz'}] : [{id:'v3',type:'video'}];
function topHTML() { return `<!doctype html><html><meta charset="utf-8"><title>整合版模拟课程</title><body style="font:16px system-ui;margin:20px">
<h2>课程流程助手 0.2.7 · 本地验证</h2><input id="curChapterId" type="hidden" value="7">
<div class="posCatalog_select" id="chapter7"><span onclick="getTeacherAjax('8','9','7')" title="第一节">第一节</span><input type="hidden" class="jobUnfinishCount" value="3"></div>
<div class="posCatalog_select" id="chapter8"><span onclick="getTeacherAjax('8','9','8')" title="第二节">第二节</span><input type="hidden" class="jobUnfinishCount" value="1"></div>
<div><span id="dct1" class="currents" title="视频与练习">视频与练习</span></div>
<div class="maskDiv" id="workpop" style="display:none;position:fixed;top:120px;left:300px;background:white;border:1px solid #ccc;padding:16px"><div class="popHead" role="alertdialog">提示</div><p id="popcontent">确认提交？</p><div class="popBottom"><a href="javascript:;" id="popok" role="button">提交</a> <a href="javascript:;" id="popno" role="button">取消</a></div></div>
<iframe id="cards" src="/mooc-ans/knowledge/cards?chapter=7" style="border:1px solid #ddd;width:850px;height:1400px"></iframe>
<script>
window.showWorkpop=cb=>{const pop=document.querySelector('#workpop');pop.style.display='block';document.querySelector('#popok').onclick=()=>{pop.style.display='none';cb()};document.querySelector('#popno').onclick=()=>{fetch('/event?type=quiz-cancel');pop.style.display='none'}};
function getTeacherAjax(c,cl,id){document.querySelector('#curChapterId').value=id;document.querySelector('#cards').src='/mooc-ans/knowledge/cards?chapter='+id}
window.addEventListener('message', e=>{if(e.origin!==location.origin||!e.data.done)return;let n=document.querySelector('#chapter'+document.querySelector('#curChapterId').value+' input');n.value=Math.max(0,Number(n.value)-1)})
</script></body></html>`; }
function cardsHTML(id) {return `<!doctype html><html><meta charset="utf-8"><body>${jobs(id).map(j=>`<div class="ans-attach-ct" id="${j.id}"><div class="ans-job-icon">任务点</div><iframe module="${j.type==='quiz'?'work':'insertvideo'}" data='${JSON.stringify({jobid:j.id,name:j.id})}' src="${j.type==='quiz'?'/ananas/modules/work/index.html?jobid=q':'/ananas/modules/video/index.html?id='+j.id}" style="width:680px;height:${j.type==='quiz'?400:300}px;border:1px solid #eee"></iframe></div>`).join('')}
<script>window.addEventListener('message',e=>{if(e.origin!==location.origin||!e.data.done)return;document.getElementById(e.data.done).classList.add('ans-job-finished');fetch('/done?id='+e.data.done);top.postMessage(e.data,location.origin)})</script></body></html>`;}
function videoHTML(id) {
 const markup=videoQuestion();
 const custom=modernQuestion('909','1');
 return `<!doctype html><html><meta charset="utf-8"><body><video id="video_html5_api" src="/clip.webm" style="width:320px;height:180px" preload="auto" muted></video>
 <div id="question" style="display:none;position:absolute;top:10px;left:10px;width:440px;background:white;border:2px solid #2563EB;padding:14px">${markup}</div>
 <script>const v=document.querySelector('video');let asked=0,resumeAt=null,resumeQuestion=null;const q=document.querySelector('#question');const original=q.querySelector('.tkItem').innerHTML;
 v.addEventListener('timeupdate',()=>{
  if(resumeAt!==null && v.currentTime>resumeAt+0.15){fetch('/event?type=video-resumed&id=${id}&question='+resumeQuestion);resumeAt=null}
  if('${id}'==='v2' && asked<3 && v.currentTime>= [1,1.6,2.2][asked]){asked++;v.pause();q.style.display='block';
   q.querySelector('.tkItem').innerHTML=asked===2?${JSON.stringify(custom)}:original;
   if(asked===2){(${wireModernChoices.toString()})(window)}
   q.querySelector('.tkTopic_title').textContent=asked===2?'多选题':'单选题';
   if(asked===3 && ${!!process.env.E2E_VISION})q.querySelector('.tkItem_title').classList.add('font-cxsecret');
   q.querySelectorAll('input[type="radio"],input[type="checkbox"]').forEach(i=>i.checked=false);
   document.querySelector('#videoquiz-submit').style.display='inline-block';document.querySelector('#videoquiz-continue').style.display='none';
  }
 });
 document.querySelector('#videoquiz-submit').onclick=()=>{fetch('/event?type=video-submit&id=${id}&question='+asked);
  const correct=asked===2?document.getElementById('answer909').value==='BC':q.querySelectorAll('input[type="radio"]')[1].checked;
  if(!correct){document.querySelector('#spanNot').style.display='inline';return}
  document.querySelector('#videoquiz-submit').style.display='none';document.querySelector('#videoquiz-continue').style.display='inline-block'};
 document.querySelector('#videoquiz-continue').onclick=()=>{fetch('/event?type=video-continue&id=${id}&question='+asked);q.style.display='none';resumeAt=v.currentTime;resumeQuestion=asked;
  // 第三题平台只关闭弹题，特意不启动视频，验证运行器恢复播放。
  if(asked!==3)v.play()
 };
 v.onended=()=>parent.postMessage({done:'${id}'},location.origin);
 </script></body></html>`;
}
function quizHTML() {return `<!doctype html><html><meta charset="utf-8"><body>
${[['101','0'],['102','0'],['103','3'],['104','3'],['105','1']].map(([id,type])=>modernQuestion(id,type,!!process.env.E2E_VISION)).join('')}
<div class="TiMu" data="fill1"><div class="Zy_TItle">填写：示例答案</div><textarea id="editor1" name="answerEditor1" hidden></textarea><div id="editor-content" contenteditable="true" style="height:40px;border:1px solid gray"></div></div>
<button id="submit">提交</button>
<script>(${wireModernChoices.toString()})(window);
window.UE={getEditor:()=>({setContent:v=>document.querySelector('#editor-content').innerHTML=v,getContent:()=>document.querySelector('#editor-content').innerHTML})};
document.querySelector('#submit').onclick=()=>{fetch('/event?type=quiz-submit');top.showWorkpop(submitCheckTimes)};
function submitCheckTimes(){fetch('/event?type=quiz-confirm');const expected={'101':'B','102':'B','103':'false','104':'false','105':'AC'};if(Object.entries(expected).every(([id,value])=>document.getElementById('answer'+id).value===value)&&document.querySelector('#editor-content').textContent==='示例答案'){parent.postMessage({done:'q'},location.origin)}}
</script></body></html>`;}

(async()=>{
 const context=await chromium.launchPersistentContext(path.join(temp,'profile'),{
  ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,viewport:{width:1300,height:1000},ignoreHTTPSErrors:true,
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--autoplay-policy=no-user-gesture-required',...(process.env.E2E_VISION?['--enable-unsafe-extension-debugging']:[])]});
 try {
 await context.route('https://mooc1.chaoxing.com/**',async route=>{
  const u=new URL(route.request().url());let body;
  if(u.pathname.includes('studentstudy'))body=topHTML();
  else if(u.pathname.includes('knowledge/cards'))body=cardsHTML(u.searchParams.get('chapter'));
  else if(u.pathname.includes('/video/'))body=videoHTML(u.searchParams.get('id'));
  else if(u.pathname.includes('/modules/work/'))body='<iframe id="frame_content" src="/mooc-ans/work/dohomeworknew?jobid=q" style="border:0;width:650px;height:400px"></iframe><script>addEventListener("message",e=>{if(e.data.done)parent.postMessage(e.data,location.origin)})</script>';
  else if(u.pathname.includes('/work/dohomeworknew'))body=quizHTML();
  else if(u.pathname==='/clip.webm')return route.fulfill({status:200,contentType:'video/webm',body:clip});
  else if(u.pathname==='/done'){finished.add(u.searchParams.get('id'));body='ok'}
  else if(u.pathname==='/event'){events.push(Object.fromEntries(u.searchParams));body='ok'}
  else body='';
  await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body});
 });
 let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 await worker.evaluate(()=>{
  globalThis.testRequests=[];
  globalThis.fetch=async(url,options)=>{
    if(url!=='https://api.deepseek.com/chat/completions')throw new Error('Unexpected external network');
    const body=JSON.parse(options.body);
    const content=body.messages[1].content;const raw=typeof content==='string'?content:content[0].text.slice(content[0].text.indexOf('{'));const data=JSON.parse(raw);testRequests.push({model:body.model,image:Array.isArray(content),questionIds:data.questions.map(q=>q.id),stems:data.questions.filter(q=>q.id.startsWith('video-')).map(q=>q.stem),types:data.questions.map(q=>q.type),imageCount:Array.isArray(content)?content.filter(c=>c.type==='image_url').length:0});
    const answer=JSON.stringify({answers:data.questions.map(q=>q.type==='fill'?{id:q.id,blanks:['示例答案']}:{id:q.id,choices:q.id.startsWith('video-')?(q.type==='multiple'?['B','C']:['B']):q.type==='multiple'?['A','C']:['B']})});
    return new Response('data: '+JSON.stringify({choices:[{delta:{content:answer},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:6,total_tokens:18}})+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
  };
 });
 const errors=[];const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7&courseId=8&clazzid=9');
 await page.waitForSelector('#course-runner-panel', { state: 'attached' });
 const tabId=await worker.evaluate(async()=> (await chrome.tabs.query({})).find(t=>t.url?.includes('studentstudy')).id);
 const extId=new URL(worker.url()).host;
 const popup=await context.newPage();await popup.goto(`chrome-extension://${extId}/popup.html`);
 await popup.locator('#apiKey').fill('local-test-key');await popup.locator('#saveKey').click();await popup.locator('#aiEnabled').check();await popup.locator('#autoSubmit').check();
 await popup.waitForFunction(()=>document.querySelector('#message').textContent.includes('保存'));
 await popup.waitForTimeout(200);assert.equal(await worker.evaluate(async()=> (await chrome.storage.local.get('aiEnabled')).aiEnabled),true);
 await popup.screenshot({path:path.join(output,'settings.png'),fullPage:true});await popup.close();await page.bringToFront();
 if(process.env.E2E_VISION){
  const browserSession=await context.browser().newBrowserCDPSession();
  const {targetInfos}=await browserSession.send('Target.getTargets',{filter:[{type:'tab'},{exclude:true}]});
  const targetInfo=targetInfos.find(t=>t.url===page.url());assert.ok(targetInfo,'course tab target');
  await browserSession.send('Extensions.triggerAction',{id:extId,targetId:targetInfo.targetId});
  await page.bringToFront();await page.waitForTimeout(200);
 }
 await worker.evaluate(async()=>chrome.storage.local.set({notify:false,muted:true}));
 assert.equal((await worker.evaluate(id=>chrome.tabs.sendMessage(id,{type:'START'},{frameId:0}),tabId)).ok,true);
 let previous='';const deadline=Date.now()+140000;let task;
 while(Date.now()<deadline){
  await page.waitForTimeout(700);task=await worker.evaluate(async id=>(await chrome.storage.local.get(`task:${id}`))[`task:${id}`],tabId);
  if(task?.status!==previous){previous=task?.status;console.log(task?.state+'/'+task?.phase,previous)}
  if(task?.state!=='running')break;
 }
 assert.equal(task?.state,'completed');assert.deepEqual([...finished].sort(),['q','v1','v2','v3']);
 assert.equal(events.filter(e=>e.type==='video-submit').length,3);assert.equal(events.filter(e=>e.type==='quiz-submit').length,1);assert.equal(events.filter(e=>e.type==='quiz-confirm').length,1);assert.equal(events.filter(e=>e.type==='quiz-cancel').length,0);
 assert.equal(events.filter(e=>e.type==='video-continue').length,3);assert.equal(events.filter(e=>e.type==='video-resumed').length,3);
 assert.equal(await page.locator('#curChapterId').inputValue(),'8');
 await page.screenshot({path:path.join(output,'completed.png'),fullPage:false});
 const requests=await worker.evaluate(()=>testRequests);assert.equal(requests.length,4);assert.deepEqual(errors,[]);
 assert.deepEqual(requests.at(-1).questionIds,['101','102','103','104','105','fill1']);
 assert.equal(requests[0].stems[0],'二加三等于多少？');assert.equal(new Set(requests.slice(0,3).flatMap(r=>r.questionIds)).size,3);
 if(process.env.E2E_VISION){assert.equal(requests[2].image,true);assert.equal(requests[2].imageCount,1);assert.equal(requests.at(-1).image,true);assert.equal(requests.at(-1).imageCount,5);}
 const report={status:'passed',vision:!!process.env.E2E_VISION,finished:[...finished],events,requests,errors};fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log('PASS',JSON.stringify(report),'outputs:',output);
 }finally{await context.close();fs.rmSync(temp,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
