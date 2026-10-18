// 隔离浏览器中的完整视频流程：所有课程与 AI 请求均由本地模拟响应。
const {chromium}=require('playwright');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {videoQuestion}=require('../fixtures/video-quiz.cjs');
const extension=path.resolve(__dirname,'../..'),out=process.env.E2E_OUTPUT||path.join(extension,'验证/视频流程');
fs.mkdirSync(out,{recursive:true});const temp=fs.mkdtempSync(path.join(os.tmpdir(),'course-027-'));
execFileSync(process.env.FFMPEG_PATH||'ffmpeg',['-y','-f','lavfi','-i','color=c=0x2563eb:s=320x180:r=10:d=10','-c:v','libvpx','-an',path.join(temp,'clip.webm')],{stdio:'ignore'});
const clip=fs.readFileSync(path.join(temp,'clip.webm'));
function topHTML(){return `<!doctype html><meta charset="utf-8"><title>0.2.7 本地视频验证</title><style>body{font:16px system-ui;margin:24px}.posChapter_right{position:fixed;right:0;top:70px;width:220px;background:#eee}.switchbtn{cursor:pointer}iframe{width:800px;height:500px}</style><h2>0.2.7 本地模拟课程</h2><input id="curChapterId" value="7" hidden>
<div id="selector" class="posChapter posChapter_right"><button class="switchbtn">收起 / 展开</button><p>平台原生目录</p></div>
<div class="posCatalog_select"><span onclick="getTeacherAjax('8','9','7')">第一节</span><input class="jobUnfinishCount" value="1" hidden></div>
<div class="posCatalog_select"><span onclick="getTeacherAjax('8','9','8')">第二节</span><input class="jobUnfinishCount" value="1" hidden></div>
<iframe id="cards" src="/mooc-ans/knowledge/cards?chapter=7"></iframe><script>
 document.querySelector('.switchbtn').onclick=e=>{e.target.classList.toggle('switchbtn_cur');document.querySelector('#selector').style.right=e.target.classList.contains('switchbtn_cur')?'-220px':'0px'};
 function getTeacherAjax(c,cl,id){document.querySelector('#curChapterId').value=id;document.querySelector('#cards').src='/mooc-ans/knowledge/cards?chapter='+id}
</script>`}
function cardsHTML(id){return `<meta charset="utf-8"><div class="ans-attach-ct"><div class="ans-job-icon">任务点</div><iframe style="width:680px;height:420px" module="insertvideo" data='${JSON.stringify({jobid:'v'+id,name:'视频'+id})}' src="/ananas/modules/video/index.html?id=${id}"></iframe></div>`}
function playerHTML(id,scenario){const question=videoQuestion().replace('</ul>','<li class="ans-videoquiz-opt"><label><span class="tkRadio"><input type="radio" name="ans-videoquiz-opt" value="false"><i></i></span>D、七</label></li></ul>');
return `<meta charset="utf-8"><video id="video_html5_api" style="width:320px;height:180px" ${scenario==='stall'&&id==='7'?'':'src="/clip.webm"'} muted preload="auto"></video><div id="question" style="display:none;position:absolute;top:5px;background:white;border:1px solid #ccc;padding:12px;width:450px">${question}</div><script>
const v=document.querySelector('video'),q=document.querySelector('#question');let asked=false;
v.addEventListener('timeupdate',()=>{if('${id}'==='7'&&'${scenario}'!=='stall'&&!asked&&v.currentTime>.3){asked=true;v.pause();q.style.display='block'}});
document.querySelector('#videoquiz-submit').onclick=()=>{const radios=[...q.querySelectorAll('input[type=radio]')],choice='ABCD'[radios.findIndex(i=>i.checked)];fetch('/event?type=submit&choice='+choice);
 document.querySelector('#videoquiz-submit').style.display='none';document.querySelector('#videoquiz-submitting').style.display='block';
 setTimeout(()=>{document.querySelector('#videoquiz-submitting').style.display='none';document.querySelector('#videoquiz-submit').style.display='block';
 if('${scenario}'==='trial'&&choice==='B'){document.querySelector('#spanHas').style.display='block';document.querySelector('#videoquiz-continue').style.display='block';}
 else document.querySelector('#spanNotBackPoint').style.display='block';},100);
};
document.querySelector('#videoquiz-continue').onclick=()=>{fetch('/event?type=continue');q.style.display='none';v.play()};
</script>`}
async function scenario(name){const events=[],errors=[];const ctx=await chromium.launchPersistentContext(path.join(temp,name),{executablePath:process.env.CHROMIUM_PATH,headless:true,viewport:{width:1300,height:900},ignoreHTTPSErrors:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--autoplay-policy=no-user-gesture-required']});
try{
 await ctx.route('https://mooc1.chaoxing.com/**',async route=>{const u=new URL(route.request().url());let body='';
 if(u.pathname.includes('studentstudy'))body=topHTML();else if(u.pathname.includes('knowledge/cards'))body=cardsHTML(u.searchParams.get('chapter'));
 else if(u.pathname.includes('/video/'))body=playerHTML(u.searchParams.get('id'),name);
 else if(u.pathname==='/clip.webm')return route.fulfill({status:200,contentType:'video/webm',body:clip});
 else if(u.pathname==='/event')events.push(Object.fromEntries(u.searchParams));
 return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body});});
 await ctx.route('**/*',async route=>{if(new URL(route.request().url()).host==='mooc1.chaoxing.com')return route.fallback();throw new Error('Unexpected external network')});
 const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
 await worker.evaluate(async(name)=>{
 globalThis.apiCalls=0;globalThis.fetch=async()=>{apiCalls++;throw new Error('本地模拟：AI 未找到有效答案')};
 await chrome.storage.local.set({notify:false,muted:true,collapseCourseSidebar:true,videoAnswerMode:name==='ai-error'?'ai':'trial',aiEnabled:name==='ai-error',apiKey:'local-test-only'});
 },name);
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7&courseId=8&clazzid=9');
 await page.waitForSelector('#course-runner-panel',{state:'attached'});
 const tabId=await worker.evaluate(async()=>(await chrome.tabs.query({})).find(t=>t.url?.includes('studentstudy')).id);
 await worker.evaluate(id=>chrome.tabs.sendMessage(id,{type:'START'},{frameId:0}),tabId);
 const deadline=Date.now()+80000;let task,accelerated=false,passed=false;
 while(Date.now()<deadline){await page.waitForTimeout(300);task=await worker.evaluate(async id=>(await chrome.storage.local.get(`task:${id}`))[`task:${id}`],tabId);
 if(name==='stall'&&task?.initialPlayWaitingAt&&!accelerated){await worker.evaluate(async id=>{const k=`task:${id}`,t=(await chrome.storage.local.get(k))[k];await chrome.storage.local.set({[k]:{...t,initialPlayWaitingAt:Date.now()-35000,initialPlayAttemptedAt:Date.now()-35000,playRetries:1}})},tabId);accelerated=true}
 if(name==='trial'&&events.some(e=>e.type==='continue')){const frame=page.frames().find(f=>f.url().includes('/video/'));if(frame&&await frame.locator('video').evaluate(v=>!v.paused&&v.currentTime>1)){passed=true;break}}
 if(name!=='trial'&&await page.locator('#curChapterId').inputValue()==='8'){const frame=page.frames().find(f=>f.url().includes('/video/'));if(frame&&await frame.locator('video').evaluate(v=>!v.paused&&v.currentTime>0)){passed=true;break}}
 if(task?.state==='error'||task?.state==='paused')throw new Error(task.status);
 }
 assert.equal(passed,true,`${name}: ${task?.status}`);
 const stored=await worker.evaluate(async()=>({...await chrome.storage.local.get(['todos','aiEnabled']),apiCalls}));
 if(name==='trial'){assert.deepEqual(events.filter(e=>e.type==='submit').map(e=>e.choice),['A','B']);assert.equal(stored.apiCalls,0);assert.equal(stored.todos?.length||0,0)}
 if(name==='exhausted'){assert.deepEqual(events.filter(e=>e.type==='submit').map(e=>e.choice),['A','B','C','D']);assert.equal(stored.todos.length,1);assert.equal(stored.apiCalls,0)}
 if(name==='ai-error'){assert.equal(stored.apiCalls,1);assert.equal(events.filter(e=>e.type==='submit').length,0);assert.equal(stored.todos.length,1)}
 if(name==='stall'){assert.equal(stored.todos.length,1);assert.equal(stored.apiCalls,0)}
 assert.equal(await page.locator('#selector .switchbtn').evaluate(e=>e.classList.contains('switchbtn_cur')),true);assert.equal(await page.locator('#cards').count(),1);assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(out,name+'.png')});const result={scenario:name,status:'passed',events,apiCalls:stored.apiCalls,todos:stored.todos?.length||0,chapter:await page.locator('#curChapterId').inputValue(),nativeSidebarFolded:true,errors};
 console.log(JSON.stringify(result));return result;
}finally{await ctx.close()}}
(async()=>{try{const results=[];for(const name of (process.env.E2E_SCENARIOS||'trial,exhausted,ai-error,stall').split(','))results.push(await scenario(name));fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(results,null,2));}finally{fs.rmSync(temp,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
