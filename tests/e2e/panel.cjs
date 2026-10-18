// 真实浏览器验证关闭 Shadow DOM 内的拖动、滚动、局部更新与 AI 开关。仅使用模拟页面。
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const extension=path.resolve(__dirname,'../..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'course-panel-e2e-'));
const output=process.env.E2E_OUTPUT||path.join(temp,'output');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const context=await chromium.launchPersistentContext(path.join(temp,'profile'),{
  ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,viewport:{width:1300,height:900},
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 try{
 await context.route('https://mooc1.chaoxing.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#f6f8fa;font:16px system-ui"><main style="margin:40px;max-width:850px;background:white;padding:32px;border-radius:12px"><p style="color:#168577">模拟课程 · 悬浮窗验证</p><h2>章节测验</h2><p>保留熟悉的布局，使用蓝灰配色；拖动与滚动保持顺畅。</p><iframe srcdoc="<body style='height:650px;font:16px system-ui;color:#334b57'><h3>1. 题目所在的课程框架</h3><p>拖动悬浮窗跨过这里，鼠标事件仍保持连续。</p><label><input type='radio'> 选项 A</label><p><label><input type='radio'> 选项 B</label></p></body>" style="border:0;width:760px;height:540px"></iframe></main></body>`}));
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const page=await context.newPage();await page.goto('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7&courseId=8&clazzid=9');
 await page.waitForSelector('#course-runner-panel',{state:'attached'});
 const tabId=await worker.evaluate(async()=> (await chrome.tabs.query({})).find(t=>t.url?.includes('studentstudy')).id);
 await worker.evaluate(id=>chrome.storage.local.set({aiEnabled:true,[`task:${id}`]:{state:'paused',phase:'page',status:'已暂停，可以继续播放或开启 AI 识题',chapterName:'1.1 课程示例',jobs:[{name:'章节练习',type:'quiz',state:'current'}]},todos:Array.from({length:30},(_,i)=>({chapterName:`第 ${i+1} 节`,type:'quiz',jobName:'章节练习',reason:'等待检查'}))}),tabId);
 await page.waitForTimeout(250);
 const cdp=await context.newCDPSession(page);
 const doc=(await cdp.send('DOM.getDocument',{depth:-1,pierce:true})).root;
 function find(node){if(node.attributes?.includes('course-runner-panel'))return node;for(const child of [...(node.children||[]),...(node.shadowRoots||[])]){const f=find(child);if(f)return f}}
 const shadow=find(doc).shadowRoots[0].nodeId;
 async function node(selector){const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:shadow,selector});assert.ok(nodeId,selector);return nodeId}
 async function call(selector,fn){const {object}=await cdp.send('DOM.resolveNode',{nodeId:await node(selector)});const {result}=await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:fn.toString(),returnByValue:true});return result.value}
 const rect=selector=>call(selector,function(){const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}});
 async function click(selector){const b=await rect(selector);await page.mouse.click(b.x+b.width/2,b.y+b.height/2)}
 assert.ok((await rect('.box')).height<360);
 const headerId=await node('header'),initial=await rect('.box');
 await page.screenshot({path:path.join(output,'panel-classic-blue.png')});
 const h=await rect('header');await page.mouse.move(h.x+30,h.y+20);await page.mouse.down();
 await page.mouse.move(h.x-550,h.y+240,{steps:25});
 await worker.evaluate(id=>chrome.storage.local.set({[`task:${id}`]:{state:'paused',phase:'page',status:'状态更新不会打断拖动',jobs:[]}}),tabId);
 await page.mouse.move(h.x-650,h.y+260,{steps:15});await page.mouse.up();await page.waitForTimeout(250);
 const moved=await rect('.box');assert.ok(initial.x-moved.x>600,'drag must cross the iframe');assert.ok(moved.y>initial.y+200);
 assert.equal(await node('header'),headerId,'header must survive state changes');
 await click('[data-act=todo]');await page.waitForTimeout(180);
 const listId=await node('.details-content'),list=await rect('.details-content');
 assert.ok(list.height<=181);await page.mouse.move(list.x+100,list.y+70);await page.mouse.wheel(0,500);await page.waitForTimeout(180);
 const scroll=await call('.details-content',function(){return this.scrollTop});assert.ok(scroll>0,'wheel must scroll the list');
 await worker.evaluate(id=>chrome.storage.local.set({[`task:${id}`]:{state:'paused',phase:'page',status:'列表滚动位置保留',jobs:[]}}),tabId);await page.waitForTimeout(220);
 assert.equal(await node('.details-content'),listId);assert.equal(await call('.details-content',function(){return this.scrollTop}),scroll);
 await click('[data-act=ai]');await page.waitForTimeout(150);assert.equal((await worker.evaluate(()=>chrome.storage.local.get('aiEnabled'))).aiEnabled,false);
 await click('[data-act=min]');await page.waitForTimeout(180);const m=await rect('.mini');
 await page.mouse.move(m.x+20,m.y+20);await page.mouse.down();await page.mouse.move(m.x+150,m.y-80,{steps:15});await page.mouse.up();await page.waitForTimeout(180);
 assert.equal(await call('.box',function(){return this.hidden}),true,'dragging mini must not expand it');await click('.mini');await page.waitForTimeout(180);assert.equal(await call('.box',function(){return this.hidden}),false);
 const report={status:'passed',panelHeight:initial.height,appearance:'classic-blue',dragAcrossIframe:true,stableHeader:true,scrollerPreserved:true,scrollTop:scroll,aiToggle:true,miniDrag:true};
 const popup=await context.newPage();await popup.setViewportSize({width:360,height:1000});await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
 await popup.waitForTimeout(200);assert.equal(await popup.locator('#model').inputValue(),'deepseek-flash');
 await popup.getByText('运行设置',{exact:true}).click();
 await popup.locator('#videoAnswerMode').selectOption('trial');await popup.locator('#collapseCourseSidebar').check();await popup.waitForTimeout(200);
 const preferences=await worker.evaluate(()=>chrome.storage.local.get(['videoAnswerMode','aiEnabled','collapseCourseSidebar']));assert.equal(preferences.videoAnswerMode,'trial');assert.equal(preferences.aiEnabled,false);assert.equal(preferences.collapseCourseSidebar,true);
 report.trialSettingWithoutAI=true;report.nativeSidebarPreference=true;
 await popup.locator('body').screenshot({path:path.join(output,'settings-blue.png')});await popup.close();
 fs.writeFileSync(path.join(output,'panel-result.json'),JSON.stringify(report,null,2));console.log('PASS',JSON.stringify(report));
 }finally{await context.close();fs.rmSync(temp,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
