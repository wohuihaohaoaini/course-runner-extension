// 真实 Chromium 加载扩展，拦截本地模拟课程和 AI 响应；不会访问真实课程或计费 API。
// NODE_PATH 指向 playwright，CHROMIUM_PATH 可指定 Chromium 可执行文件。
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const extension = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'course-ai-e2e-'));
const output = process.env.E2E_OUTPUT || temp;
fs.mkdirSync(output, { recursive: true });
execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y','-f','lavfi','-i','color=c=0x087b71:s=320x180:r=10:d=5','-c:v','libvpx','-an',path.join(temp,'clip.webm')], {stdio:'ignore'});
const clip = fs.readFileSync(path.join(temp,'clip.webm'));
const site=require('./course-site.cjs')({clip});
const {finished,events}=site;
(async()=>{
 const context=await chromium.launchPersistentContext(path.join(temp,'profile'),{
  ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,viewport:{width:1300,height:1000},ignoreHTTPSErrors:true,
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--autoplay-policy=no-user-gesture-required',...(process.env.E2E_VISION?['--enable-unsafe-extension-debugging']:[])]});
 try {
 await context.route('https://mooc1.chaoxing.com/**',async route=>{
  const r=site.respond(new URL(route.request().url()));
  await route.fulfill(r);
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
