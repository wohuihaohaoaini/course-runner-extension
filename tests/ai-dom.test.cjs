const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const root=process.env.COURSE_EXTENSION_ROOT || path.join(__dirname,'..');
function page(html,url='https://mooc1.chaoxing.com/mooc-ans/api/work',stored={}) {
 const dom=new JSDOM(html,{url,runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;
 w.Element.prototype.getClientRects=function(){for(let n=this;n;n=n.parentElement)if(n.style.display==='none'||n.hidden)return [];return [1]};
 w.Element.prototype.getBoundingClientRect=()=>({width:300,height:180,top:0,left:0});
 const attach=w.Element.prototype.attachShadow;w.Element.prototype.attachShadow=function(){return attach.call(this,{mode:'open'})};
 const listeners=[];const messages=[];
 w.chrome={storage:{local:{get:async keys=>Object.fromEntries((typeof keys==='string'?[keys]:keys||Object.keys(stored)).map(k=>[k,stored[k]])),set:async patch=>{Object.assign(stored,patch);listeners.forEach(f=>f(Object.fromEntries(Object.entries(patch).map(([k,v])=>[k,{newValue:v}])),'local'));}},onChanged:{addListener:f=>listeners.push(f)}},runtime:{onMessage:{addListener(){}},sendMessage:async m=>{messages.push(m);if(m.type==='AI_VALIDATE')return {ok:true};if(m.type==='SET_AI_SETTINGS'){await w.chrome.storage.local.set({...m.patch,aiRevision:'changed'});return {ok:true}}}}};
 const context=dom.getInternalVMContext();const run=c=>vm.runInContext(c,context);
 for(const f of JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))).content_scripts[0].js)run(fs.readFileSync(path.join(root,f),'utf8'));
 return {w,run,stored,messages,close:()=>w.close()};
}
const quiz=`<div class="TiMu singleQuesId" data="q1"><div class="Zy_TItle">1+1 等于多少</div><li><label><input type="radio" name="answer1" value="A">A. 二</label></li><li><label><input type="radio" name="answer1" value="B">B. 三</label></li></div>`;
test('quiz fingerprint detects changed options but stays stable after checking an answer',()=>{
 const p=page(quiz);try {const a=p.run('quizEnvelope().fingerprint');p.w.document.querySelector('input').checked=true;assert.equal(p.run('quizEnvelope().fingerprint'),a);p.w.document.querySelectorAll('label')[1].append('改变');assert.notEqual(p.run('quizEnvelope().fingerprint'),a);}finally{p.close()}
});
test('changed question is refused before filling even when the id is unchanged',async()=>{
 const p=page(quiz);try {p.run('var g={frameToken:AI_DOCUMENT,kind:"quiz",fingerprint:quizEnvelope().fingerprint}');p.w.document.querySelector('.Zy_TItle').textContent='新的题目';await assert.rejects(p.run('assertAICommand(g)'),/变化/);assert.equal(p.w.document.querySelector('input').checked,false);}finally{p.close()}
});
test('encrypted titles and image choices require screenshots',()=>{
 const p=page(quiz);try {p.w.document.querySelector('.Zy_TItle').classList.add('font-cxsecret');assert.equal(p.run('extractQuestions().questions[0].needsImage'),true);p.w.document.querySelector('.Zy_TItle').classList.remove('font-cxsecret');p.w.document.querySelector('li').append(p.w.document.createElement('img'));assert.equal(p.run('extractQuestions().questions[0].needsImage'),true);}finally{p.close()}
});
test('video AI reads actual options and verifies the selection',async()=>{
 const p=page(`<div class="ans-videoquiz"><p class="ans-videoquiz-title">1+1=?</p><label><input type="radio" name="v" value="1">二</label><label><input type="radio" name="v" value="2">三</label><button id="videoquiz-submit">提交</button></div>`,'https://mooc1.chaoxing.com/ananas/modules/video/index.html');
 try {p.run('var g={frameToken:AI_DOCUMENT,kind:"video",fingerprint:videoAIEnvelope().fingerprint}');await p.run('fillAIVideoQuestion({choices:["B"]},g)');assert.equal(p.w.document.querySelectorAll('input')[1].checked,true);assert.equal(p.w.document.querySelectorAll('input')[0].checked,false);}finally{p.close()}
});
test('floating panel toggles AI and hides safely for screenshots',async()=>{
 const p=page('<body></body>','https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7',{aiEnabled:false});try {
 p.run('Panel.init(1)');await new Promise(r=>setTimeout(r,20));const host=p.w.document.getElementById('course-runner-panel');
 const button=host.shadowRoot.querySelector('[data-act="ai"]');assert.ok(button);assert.match(button.textContent,/关闭/);button.click();await new Promise(r=>setTimeout(r,200));assert.equal(p.stored.aiEnabled,true);assert.match(host.shadowRoot.querySelector('[data-act="ai"]').textContent,/开启/);
 p.run('Panel.captureHidden(true)');assert.equal(host.style.visibility,'hidden');p.run('Panel.captureHidden(false)');assert.notEqual(host.style.visibility,'hidden');
 }finally{p.close()}
});
test('popup presents master, per-feature and chapter-submit switches',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'popup.html'),'utf8'),{runScripts:'outside-only'});const w=dom.window;const stored={};const messages=[];
 w.chrome={runtime:{sendMessage:async m=>{messages.push(m);Object.assign(stored,m.patch);return {ok:true}}},storage:{local:{get:async()=>stored}},tabs:{query:async()=>[{id:1}],sendMessage:async()=>({ok:true})}};
 try {w.eval(fs.readFileSync(path.join(root,'popup.js'),'utf8'));await new Promise(r=>setTimeout(r,25));for(const id of ['aiEnabled','aiVideoEnabled','aiQuizEnabled','autoSubmit'])assert.ok(w.document.getElementById(id));assert.equal(w.document.getElementById('model').value,'deepseek-flash');const master=w.document.getElementById('aiEnabled');master.checked=true;master.dispatchEvent(new w.Event('change'));await new Promise(r=>setTimeout(r,20));assert.equal(stored.aiEnabled,true);assert.equal(messages.at(-1).type,'SET_AI_SETTINGS');assert.equal(w.document.getElementById('autoSubmit').checked,false);}finally{w.close()}
});

test('SVG geometry and canvas pixels are part of question identity',()=>{
 const p=page(quiz);try {
 const title=p.w.document.querySelector('.Zy_TItle');title.innerHTML='<svg><path d="M0 0 L20 20"></path></svg><canvas></canvas>';
 let pixels='first';p.w.HTMLCanvasElement.prototype.toDataURL=()=>pixels;
 const before=p.run('quizEnvelope().fingerprint');title.querySelector('path').setAttribute('d','M0 0 L20 0');
 const changed=p.run('quizEnvelope().fingerprint');assert.notEqual(changed,before);pixels='second';assert.notEqual(p.run('quizEnvelope().fingerprint'),changed);
 }finally{p.close()}
});
test('new layout blanks fill and reject replacement questions with the same id',()=>{
 const p=page('<div class="newTiMu" id="q1"><div class="newZy_TItle">原题</div><textarea id="edit" name="answerEditor1"></textarea></div>');
 try {
 let value='';p.w.UE={getEditor:()=>({getContent:()=>value,setContent:v=>{value=v}})};
 assert.equal(p.run('extractQuestions().questions[0].type'),'fill');
 p.run('var expected=blankEditorAction("q1",[],"snapshot").snapshot');
 assert.equal(p.run('blankEditorAction("q1",["正确答案"],"fill",expected).filled'),1);
 p.w.document.querySelector('.newZy_TItle').textContent='新题';value='';
 assert.match(p.run('blankEditorAction("q1",["旧题答案"],"fill",expected).error'),/变化/);assert.equal(value,'');
 }finally{p.close()}
});
test('scrolling during asynchronous capture rejects the screenshot',async()=>{
 const p=page(quiz);try {
 p.run('var g={frameToken:AI_DOCUMENT,kind:"quiz",fingerprint:quizEnvelope().fingerprint}');
 const send=p.w.chrome.runtime.sendMessage;p.w.chrome.runtime.sendMessage=async m=>{if(m.type==='CAPTURE_TAB'){p.w.dispatchEvent(new p.w.Event('scroll'));return 'data:image/png;base64,abc'}return send(m)};
 await assert.rejects(p.run('captureStableViewport(getQuestionElements()[0],g,topViewportRect(getQuestionElements()[0]))'),/滚动|布局/);
 }finally{p.close()}
});

test('plain TiMu question blocks inside a newTiMu page wrapper are read separately',()=>{
 const p=page('<div class="newTiMu">'+quiz.replace('TiMu singleQuesId','TiMu')+quiz.replace('TiMu singleQuesId','TiMu').replace('data="q1"','data="q2"').replaceAll('answer1','answer2')+'</div>', 'https://mooc1.chaoxing.com/mooc-ans/work/dohomeworknew');
 try{assert.equal(p.run('getQuestionElements().length'),2);assert.equal(p.run('quizEnvelope().questions.length'),2);}finally{p.close()}
});
test('the outer work iframe is not advertised as a ready quiz document',()=>{
 const p=page('<iframe id="frame_content"></iframe>','https://mooc1.chaoxing.com/ananas/modules/work/index.html');
 try{assert.equal(p.run('inspectPayload({}).quizPageVisible'),false);}finally{p.close()}
});

test('panel keeps its header and scroller when task status changes',async()=>{
 const stored={'task:1':{state:'running',status:'播放中',jobs:[]},todos:Array.from({length:20},(_,i)=>({chapterName:'小节'+i,reason:'等候处理',type:'quiz'}))};const p=page('<body></body>','https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7',stored);
 try {
 p.run('Panel.init(1)');await new Promise(r=>setTimeout(r,25));const root=p.w.document.getElementById('course-runner-panel').shadowRoot;
 assert.equal(root.querySelector('.details-content').hidden,true);root.querySelector('[data-act="todo"]').click();await new Promise(r=>setTimeout(r,25));
 const header=root.querySelector('header'),scroller=root.querySelector('.details-content');scroller.scrollTop=70;
 await p.w.chrome.storage.local.set({'task:1':{...stored['task:1'],status:'第2段播放中'}});await new Promise(r=>setTimeout(r,150));
 assert.equal(root.querySelector('header'),header);assert.equal(root.querySelector('.details-content'),scroller);assert.equal(scroller.scrollTop,70);assert.match(root.querySelector('.status').textContent,/第2段/);
 }finally{p.close()}
});

test('modern quiz confirmation targets the explicit submit button and never cancel',()=>{
 const p=page(quiz+'<div id="submitBack"><button id="submitBackCancel">取消</button><button id="submitBackOk">确认提交</button></div>');try{
 assert.equal(p.run('quizSubmitConfirmation().id'),'submitBackOk');p.w.document.getElementById('submitBackOk').style.display='none';assert.equal(p.run('quizSubmitConfirmation()'),null);
 }finally{p.close()}
});

const {modernQuestion,wireModernChoices}=require('./fixtures/modern-quiz.cjs');
test('real-layout data 0 and 3 are question types, not duplicate question ids',()=>{
 const p=page(modernQuestion('101','0',true)+modernQuestion('102','0',true)+modernQuestion('103','3',true)+modernQuestion('104','3',true));
 try {const result=p.run('extractQuestions()');assert.equal(result.error,undefined);assert.deepEqual(Array.from(result.questions,q=>q.id),['101','102','103','104']);assert.deepEqual(Array.from(result.questions,q=>q.type),['single','single','judgment','judgment']);assert.ok(result.questions.every(q=>q.needsImage));}finally{p.close()}
});
test('custom single and judgment choices use the platform row handler and verify hidden answers',async()=>{
 const p=page(modernQuestion('101')+modernQuestion('103','3'));wireModernChoices(p.w);
 try {p.run('var g={kind:"quiz",frameToken:AI_DOCUMENT,fingerprint:quizEnvelope().fingerprint};var answers=[{id:"101",choices:["B"]},{id:"103",choices:["B"]}]');
 await p.run('FRAME_COMMANDS.FILL_QUIZ({answers,guard:g})');assert.equal(p.w.document.getElementById('answer101').value,'B');assert.equal(p.w.document.getElementById('answer103').value,'false');assert.equal((await p.run('verifyAnswers(answers,g)')).verified,2);
 const before=p.run('quizEnvelope().fingerprint');await p.run('FRAME_COMMANDS.FILL_QUIZ({answers,guard:g})');assert.equal(p.w.document.getElementById('answer103').value,'false');assert.equal(p.run('quizEnvelope().fingerprint'),before);
 p.w.document.getElementById('answer101').value='';await assert.rejects(p.run('verifyAnswers(answers,g)'),/保存|隐藏|字段|不一致/);
 }finally{p.close()}
});
test('custom multiple choices toggle only changed rows and verify the saved set',async()=>{
 const p=page(modernQuestion('105','1'));wireModernChoices(p.w);
 try {p.w.document.querySelector('li').click();p.run('var g={kind:"quiz",frameToken:AI_DOCUMENT,fingerprint:quizEnvelope().fingerprint};var answers=[{id:"105",choices:["B","C"]}]');await p.run('FRAME_COMMANDS.FILL_QUIZ({answers,guard:g})');assert.equal(p.w.document.getElementById('answer105').value,'BC');assert.equal((await p.run('verifyAnswers(answers,g)')).verified,1);}finally{p.close()}
});

test('displayed option letters map to stored values when options are reordered',async()=>{
 const p=page(modernQuestion('106'));wireModernChoices(p.w);
 try{const markers=p.w.document.querySelectorAll('.num_option');markers[0].setAttribute('data','C');markers[2].setAttribute('data','A');p.run('var g={kind:"quiz",frameToken:AI_DOCUMENT,fingerprint:quizEnvelope().fingerprint};var answers=[{id:"106",choices:["A"]}]');await p.run('FRAME_COMMANDS.FILL_QUIZ({answers,guard:g})');assert.equal(p.w.document.getElementById('answer106').value,'C');assert.equal((await p.run('verifyAnswers(answers,g)')).verified,1);}finally{p.close()}
});
test('modern fill type metadata is not mistaken for the question id',()=>{
 const p=page('<div class="TiMu newTiMu" data="2"><div class="Zy_TItle">填空示例</div><input type="hidden" name="tiankongsize107" value="2"><textarea name="answerEditor1071" id="editor1"></textarea><textarea name="answerEditor1072" id="editor2"></textarea></div>');
 try{let values=['',''];p.w.UE={getEditor:id=>{const i=id==='editor1'?0:1;return {getContent:()=>values[i],setContent:v=>values[i]=v}}};assert.equal(p.run('extractQuestions().questions[0].id'),'107');p.run('var before=blankEditorAction("107",[],"snapshot").snapshot');assert.equal(p.run('blankEditorAction("107",["第一空","第二空"],"fill",before).filled'),2);}finally{p.close()}
});

const workpop=(message='确认提交？',display='block')=>`<div class="maskDiv" id="workpop" style="display:${display}"><div class="popHead" role="alertdialog">提示</div><p id="popcontent">${message}</p><div class="popBottom"><a href="javascript:;" id="popok" role="button">提交</a><a href="javascript:;" id="popno" role="button">取消</a></div></div>`;
test('top-level workpop submit confirmation returns only the confirm button',()=>{
 const p=page(workpop(),'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7');
 try{assert.equal(p.run('topSubmitConfirmation().id'),'popok');assert.equal(p.run('inspectPayload({frameId:0}).topSubmitConfirm'),true);}finally{p.close()}
});
test('workpop with other messages or hidden is ignored',()=>{
 for(const [msg,display] of [['您还有题目未作答，确认提交？x','block'],['提示信息','block'],['确认提交？','none']]){
  const p=page(workpop(msg,display),'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7');
  try{assert.equal(p.run('topSubmitConfirmation()'),null);assert.equal(p.run('inspectPayload({frameId:0}).topSubmitConfirm'),false);}finally{p.close()}
 }
});
test('CONFIRM_TOP_SUBMIT clicks popok and never popno',async()=>{
 const p=page(workpop(),'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7');
 try{const clicks=[];for(const id of ['popok','popno'])p.w.document.getElementById(id).addEventListener('click',()=>clicks.push(id));
 p.w.chrome.runtime.sendMessage=async m=>m.type==='TAB_ID'?1:m.type==='AI_VALIDATE'?{ok:true}:undefined;
 p.w.chrome.storage.local.get=async()=>({'task:1':{state:'running'}});
 await p.run('runFrameCommand("CONFIRM_TOP_SUBMIT",{guard:{frameToken:AI_DOCUMENT,kind:"quiz"}})');assert.deepEqual(clicks,['popok']);}finally{p.close()}
});

const {videoQuestion}=require('./fixtures/video-quiz.cjs');
const videoURL='https://mooc1.chaoxing.com/ananas/modules/video/index.html';
test('actual player template reads tkItem_title instead of the question type',async()=>{
 const p=page(videoQuestion(),videoURL);
 try{const read=p.run('videoAIEnvelope()');assert.equal(read.questions[0].stem,'二加三等于多少？');assert.equal(read.questions[0].options[1].text,'五');
 assert.match(read.questions[0].id,/^video-[a-f0-9]+$/);p.run('var g={kind:"video",frameToken:AI_DOCUMENT,fingerprint:videoAIEnvelope().fingerprint}');
 await p.run('fillAIVideoQuestion({id:videoAIEnvelope().questions[0].id,choices:["B"]},g)');assert.equal(p.w.document.querySelectorAll('input')[1].checked,true);assert.equal(p.run('videoAIEnvelope().fingerprint'),read.fingerprint);
 p.w.document.querySelector('.tkItem_title').textContent='一加三等于多少？';assert.notEqual(p.run('videoAIEnvelope().fingerprint'),read.fingerprint);
 }finally{p.close()}
});
test('same text at different video timepoints has distinct identities, but small time jitter does not',()=>{
 const p=page('<video id="video_html5_api"></video>'+videoQuestion(),videoURL);
 try{const v=p.w.document.querySelector('video');v.currentTime=20;const a=p.run('videoAIEnvelope()');v.currentTime=20.03;assert.equal(p.run('videoAIEnvelope().fingerprint'),a.fingerprint);
 v.currentTime=21;const b=p.run('videoAIEnvelope()');assert.notEqual(a.fingerprint,b.fingerprint);assert.notEqual(a.questions[0].id,b.questions[0].id);
 }finally{p.close()}
});
test('explicit event ids distinguish adjacent identical questions at the same playback time',()=>{
 const p=page(videoQuestion(),videoURL);
 try{const root=p.w.document.querySelector('.ans-videoquiz');root.dataset.eventId='event1';const a=p.run('videoAIEnvelope().fingerprint');root.dataset.eventId='event2';assert.notEqual(p.run('videoAIEnvelope().fingerprint'),a);}finally{p.close()}
});
test('empty timeline containers and unrelated hidden feedback do not block playback',()=>{
 const p=page('<div class="ans-timelineobjects" style="width:600px;height:300px"></div><div class="ans-timelineobjectsbg"></div>',videoURL);
 try{assert.equal(p.run('videoQuestionSurfaceVisible()'),false);p.w.document.body.innerHTML=videoQuestion()+'<span id="spanNotBack">无关提示</span>';assert.equal(p.run('videoQuestionFeedback()'),'open');}finally{p.close()}
});
test('wrong-answer feedback takes priority over continue and never closes the question automatically',()=>{
 const p=page(videoQuestion(),videoURL);
 try{p.w.document.getElementById('videoquiz-continue').style.display='block';p.w.document.getElementById('spanNotBackPoint').style.display='block';assert.equal(p.run('videoQuestionFeedback()'),'incorrect');assert.equal(p.run('videoQuestionContinueButton()'),null);assert.equal(p.run('aiVideoSubmitButton()'),null);}finally{p.close()}
});
test('video multiple choices use actual checked state even when stored input values repeat',async()=>{
 const p=page(videoQuestion('选出两项','multiple'),videoURL);
 try{p.w.document.querySelector('input').checked=true;p.run('var g={kind:"video",frameToken:AI_DOCUMENT,fingerprint:videoAIEnvelope().fingerprint}');await p.run('fillAIVideoQuestion({choices:["B","C"]},g)');assert.deepEqual([...p.w.document.querySelectorAll('input')].map(i=>i.checked),[false,true,true]);}finally{p.close()}
});
test('video custom controls verify the platform saved answer and refuse cosmetic-only changes',async()=>{
 const p=page('<div class="tkTopic"><div class="tkItem_title">匿名自定义题</div>'+modernQuestion('909','1')+'<button id="videoquiz-submit">提交</button></div>',videoURL);wireModernChoices(p.w);
 try{p.run('var g={kind:"video",frameToken:AI_DOCUMENT,fingerprint:videoAIEnvelope().fingerprint}');await p.run('fillAIVideoQuestion({choices:["B","C"]},g)');assert.equal(p.w.document.getElementById('answer909').value,'BC');p.w.document.getElementById('answer909').value='';assert.throws(()=>p.run('verifyAIVideoSelection({choices:["B","C"]})'),/保存/);}finally{p.close()}
});
test('stale continue and a play attempt while a question is open are both refused',async()=>{
 const p=page('<video></video>'+videoQuestion(),videoURL);
 try{const fp=p.run('videoAIEnvelope().fingerprint');p.w.document.getElementById('videoquiz-continue').style.display='block';let clicks=0;p.w.document.getElementById('videoquiz-continue').onclick=()=>clicks++;
 p.w.document.querySelector('.tkItem_title').textContent='新的题目';assert.throws(()=>p.run(`FRAME_COMMANDS.CONTINUE_VIDEO_QUESTION({frameToken:AI_DOCUMENT,fingerprint:${JSON.stringify(fp)}})`),/变化/);assert.equal(clicks,0);await assert.rejects(p.run('FRAME_COMMANDS.PLAY()'),/弹题/);
 }finally{p.close()}
});
test('a clipped video question fails before requesting a screenshot',async()=>{
 const p=page(videoQuestion(),videoURL);
 try{const clip=p.w.document.querySelector('.tkScroll');clip.style.overflowY='auto';clip.getBoundingClientRect=()=>({top:0,bottom:80,left:0,width:300,height:80});p.w.document.querySelector('.ans-videoquiz-opt').getBoundingClientRect=()=>({top:100,bottom:150,left:0,width:300,height:50});
 await assert.rejects(p.run('captureVideoQuestion({})'),/裁切|截图不完整/);assert.equal(p.messages.some(m=>m.type==='CAPTURE_TAB'),false);
 }finally{p.close()}
});

test('a visible timeline with a hidden preloaded question is not an open video question',()=>{
 const p=page(videoQuestion(),videoURL);
 try{p.w.document.querySelector('.ans-videoquiz').style.display='none';assert.equal(p.run('videoQuestionSurfaceVisible()'),false);assert.equal(p.run('videoQuestionFeedback()'),'closed');}finally{p.close()}
});
test('event identity survives selection and feedback and remains readable for an unsupported question',()=>{
 const p=page(videoQuestion(),videoURL);
 try{const before=p.run('videoQuestionIdentity()');p.w.document.querySelector('input').checked=true;p.w.document.getElementById('videoquiz-continue').style.display='block';assert.equal(p.run('videoQuestionIdentity()'),before);
 p.w.document.querySelectorAll('input').forEach(i=>i.remove());assert.throws(()=>p.run('videoAIEnvelope()'),/结构/);assert.equal(p.run('videoQuestionIdentity()'),before);
 p.w.document.querySelector('.tkItem_title').textContent='下一道题';assert.notEqual(p.run('videoQuestionIdentity()'),before);
 }finally{p.close()}
});
test('horizontal clipping fails before a partial video screenshot can be sent',async()=>{
 const p=page(videoQuestion(),videoURL);
 try{const clip=p.w.document.querySelector('.tkScroll');clip.style.overflowX='hidden';clip.getBoundingClientRect=()=>({top:0,bottom:180,left:0,right:300,width:300,height:180});p.w.document.querySelector('.tkItem_title').getBoundingClientRect=()=>({top:0,bottom:40,left:0,right:600,width:600,height:40});
 await assert.rejects(p.run('captureVideoQuestion({})'),/裁切|截图不完整/);assert.equal(p.messages.some(m=>m.type==='CAPTURE_TAB'),false);
 }finally{p.close()}
});

test('a changed selection after filling is checked again immediately before video submission',()=>{
 const p=page(videoQuestion(),videoURL);
 try{let clicks=0;p.w.document.getElementById('videoquiz-submit').onclick=()=>clicks++;p.w.document.querySelectorAll('input')[0].checked=true;
 assert.throws(()=>p.run('FRAME_COMMANDS.SUBMIT_VIDEO_QUESTION({answers:[{choices:["B"]}]})'),/核对失败/);assert.equal(clicks,0);
 p.w.document.querySelectorAll('input')[1].checked=true;p.run('FRAME_COMMANDS.SUBMIT_VIDEO_QUESTION({answers:[{choices:["B"]}]})');assert.equal(clicks,1);
 }finally{p.close()}
});

test('trial submits a single choice without reading hidden correctness and distinguishes the next response from stale error',async()=>{
 const {videoQuestion}=require('./fixtures/video-quiz.cjs');
 const p=page(videoQuestion(),'https://mooc1.chaoxing.com/ananas/modules/video/index.html');
 try{
 assert.equal(p.run('typeof submitVideoTrial'),'function');
 p.w.chrome.runtime.sendMessage=async m=>{p.messages.push(m);return {ok:true}};
 const d=p.w.document;let clicked=0;
 d.querySelector('#videoquiz-submit').onclick=()=>{clicked++;d.querySelector('#videoquiz-submit').style.display='none';d.querySelector('#videoquiz-submitting').style.display='block';
 setTimeout(()=>{d.querySelector('#videoquiz-submit').style.display='block';d.querySelector('#videoquiz-submitting').style.display='none';d.querySelector('#spanNot').style.display='block'},10)};
 p.run('var g={frameToken:AI_DOCUMENT,kind:"video",fingerprint:videoTrialEnvelope().fingerprint}');
 await p.run('submitVideoTrial({choice:"A",token:"a",guard:g})');
 await new Promise(r=>setTimeout(r,25));
 assert.equal(clicked,1);assert.equal(p.run('videoTrialFeedback().status'),'incorrect');
 assert.equal(d.querySelectorAll('input[type="radio"]')[0].checked,true);
 // 本次选择 B 后，旧的 A 错误不能立即作为 B 的反馈。
 d.querySelector('#videoquiz-submit').onclick=()=>{clicked++;d.querySelector('#videoquiz-submit').style.display='none';d.querySelector('#videoquiz-submitting').style.display='block'};
 await p.run('submitVideoTrial({choice:"B",token:"b",guard:g})');
 assert.equal(p.run('videoTrialFeedback().status'),'pending');assert.equal(clicked,2);
 assert.equal(d.querySelectorAll('input[type="radio"]')[1].checked,true);
 d.querySelector('#videoquiz-submitting').style.display='none';d.querySelector('#videoquiz-submit').style.display='block';await new Promise(r=>setTimeout(r,10));
 assert.equal(p.run('videoTrialFeedback().token'),'b');assert.equal(p.run('videoTrialFeedback().status'),'pending','restoring submit alone is not a new error response');
 d.querySelector('#spanNot').style.display='block';await new Promise(r=>setTimeout(r,10));assert.equal(p.run('videoTrialFeedback().status'),'incorrect');
 assert.equal(p.messages.some(m=>m.type==='ANSWER'),false);
 }finally{p.close()}
});

test('popup saves independent trial mode with AI off and native sidebar folding preference',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'popup.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window,stored={aiEnabled:false};
 w.chrome={runtime:{sendMessage:async m=>{Object.assign(stored,m.patch);return {ok:true}}},storage:{local:{get:async()=>stored,set:async p=>Object.assign(stored,p)}},tabs:{query:async()=>[{id:1}],sendMessage:async()=>({ok:true})}};
 try{
 w.eval(fs.readFileSync(path.join(root,'popup.js'),'utf8'));await new Promise(r=>setTimeout(r,25));
 const mode=w.document.getElementById('videoAnswerMode');assert.ok(mode);mode.value='trial';mode.dispatchEvent(new w.Event('change'));await new Promise(r=>setTimeout(r,10));
 assert.equal(stored.videoAnswerMode,'trial');assert.equal(stored.aiEnabled,false);
 const fold=w.document.getElementById('collapseCourseSidebar');assert.ok(fold);fold.checked=true;fold.dispatchEvent(new w.Event('change'));await new Promise(r=>setTimeout(r,10));assert.equal(stored.collapseCourseSidebar,true);
 }finally{w.close()}
});

test('InteractiveQuiz generic wrong hint still allows trial when submit stays available',()=>{
 const {videoQuestion}=require('./fixtures/video-quiz.cjs');const p=page(videoQuestion(),'https://mooc1.chaoxing.com/ananas/modules/video/index.html');
 try{p.w.document.querySelector('#spanNotBackPoint').style.display='block';assert.equal(p.run('videoTrialEnvelope().canRetry'),true);}finally{p.close()}
});

test('standard video correct feedback can supersede the previous visible wrong hint',()=>{
 const {videoQuestion}=require('./fixtures/video-quiz.cjs');const p=page(videoQuestion(),'https://mooc1.chaoxing.com/ananas/modules/video/index.html');
 try{const d=p.w.document;d.querySelector('#spanNot').style.display='block';d.querySelector('#spanHas').style.display='block';d.querySelector('#videoquiz-continue').style.display='block';assert.equal(p.run('videoQuestionFeedback()'),'continue');assert.ok(p.run('videoQuestionContinueButton()'));}finally{p.close()}
});

test('a browser play promise that never settles cannot block the runner indefinitely',{timeout:4500},async()=>{
 const p=page('<video></video>','https://mooc1.chaoxing.com/ananas/modules/video/index.html');
 try{p.w.document.querySelector('video').play=()=>new Promise(()=>{});await assert.rejects(p.run('FRAME_COMMANDS.PLAY()'),/响应|超时/);}finally{p.close()}
});
test('a background screenshot retakes once after the hidden tab resizes during the first capture',async()=>{
 const p=page(quiz);try {
 Object.defineProperty(p.w.document,'hidden',{configurable:true,get:()=>true});
 p.run('var g={frameToken:AI_DOCUMENT,kind:"quiz",fingerprint:quizEnvelope().fingerprint}');
 let top=0,shots=0;p.w.Element.prototype.getBoundingClientRect=()=>({width:300,height:180,top,left:0});p.w.Element.prototype.scrollIntoView=()=>{};p.w.Image=class{set src(v){setTimeout(()=>this.onerror?.())}};
 const send=p.w.chrome.runtime.sendMessage;p.w.chrome.runtime.sendMessage=async m=>{if(m.type==='CAPTURE_PREPARE')return {mode:'debugger'};if(m.type==='CAPTURE_TAB'){shots++;if(shots===1)top=40;return 'data:image/png;base64,abc'}return send(m)};
 // 测试中的图片无法解码：第二次截图拿到画面后只会在解码时失败，而不是再报布局变化。
 await assert.rejects(p.run('captureQuestion(questionId(getQuestionElements()[0],0),g)'),/无法解码/);
 assert.equal(shots,2);
 }finally{p.close()}
});
test('a foreground layout change still rejects without a second screenshot',async()=>{
 const p=page(quiz);try {
 p.run('var g={frameToken:AI_DOCUMENT,kind:"quiz",fingerprint:quizEnvelope().fingerprint}');
 let top=0,shots=0;p.w.Element.prototype.getBoundingClientRect=()=>({width:300,height:180,top,left:0});p.w.Element.prototype.scrollIntoView=()=>{};p.w.Image=class{set src(v){setTimeout(()=>this.onerror?.())}};
 const send=p.w.chrome.runtime.sendMessage;p.w.chrome.runtime.sendMessage=async m=>{if(m.type==='CAPTURE_PREPARE')return {mode:'visible'};if(m.type==='CAPTURE_TAB'){shots++;top+=40;return 'data:image/png;base64,abc'}return send(m)};
 await assert.rejects(p.run('captureQuestion(questionId(getQuestionElements()[0],0),g)'),/布局变化/);
 assert.equal(shots,1);
 }finally{p.close()}
});
