const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const loadContent=require('./load-content.cjs');
function fixture(kind='quiz', extra={}, onAnswer) {
  const main={frameId:0,active:true,kind:'other',chapterId:'7',tabs:[],catalog:[{id:'7',name:'本节',unfinished:1,active:true}]};
  const frame={frameId:3,active:true,kind,jobId:'j1',aiDocument:'doc1',questionCount:1,quizPageVisible:kind==='quiz',mediaPage:kind==='video',
    videoQuestionSurface:kind==='video',videoQuestionFeedback:kind==='video'?'open':null,videoQuestionIdentity:kind==='video'?'event1':null, video:{paused:true,ready:true,time:20,duration:100}};
  const cards={frameId:2,active:true,kind:'other',jobs:[{id:'j1',name:'任务',type:kind==='quiz'?'quiz':'video',isJob:true,finished:false}]};
  const stored={aiEnabled:true,aiQuizEnabled:true,aiVideoEnabled:true,aiRevision:'v1',apiKey:'test',
    'task:1':{state:'running',phase:'page',runId:'r1',activeChapterId:'7',currentJobId:'j1',jobStartedAt:Date.now(),tabOpenedAt:Date.now(),skippedJobs:[]},...extra};
  const targets=[];const commands=[];let answers=0;const filled=[];let submits=0;
  const questions=[{id:kind==='quiz'?'q1':'video-question',type:'single',needsImage:false,stem:'一加一？',options:[{id:'A',text:'二'},{id:'B',text:'三'}]}];
  const win={};win.top=win;
  const context=vm.createContext({window:win,top:win,URL,URLSearchParams,setTimeout,clearTimeout,
    location:{pathname:'/mycourse/studentstudy',href:'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7&courseId=8&clazzid=9',search:'?chapterId=7&courseId=8&clazzid=9'},
    document:{querySelector:()=>null,querySelectorAll:()=>[]},
    chrome:{storage:{local:{get:async keys=>Object.fromEntries((typeof keys==='string'?[keys]:keys||Object.keys(stored)).map(k=>[k,stored[k]])),set:async p=>Object.assign(stored,JSON.parse(JSON.stringify(p)))}},
      runtime:{onMessage:{addListener(){}},sendMessage:async m=>{
        if(m.type==='INSPECT_FRAMES')return [main,cards,frame];
        if(m.type==='ANSWER'){answers++;await onAnswer?.({stored,main,frame});return [{id:questions[0].id,choices:['A']}];}
        if(m.type==='AI_CLAIM_SUBMISSION'){const locks=stored.aiSubmissionLocks ||= {};const old=locks[m.key];if(m.confirmation?(!old||old.confirmed):old)return {claimed:false,record:old};locks[m.key]={at:Date.now(),confirmed:!!m.confirmation};return {claimed:true};}
        if(m.type==='COMMAND_FRAME'){
          commands.push(m.command);targets.push([m.command,m.frameId]);
          if(m.command==='REVEAL_JOB'&&cards.revealError)throw new Error('测试：任务点定位失败');
          if(m.command==='READ_QUIZ'||m.command==='READ_VIDEO_QUESTION'){if(frame.readError)throw new Error(frame.readError);return {questions,fingerprint:frame.fingerprint || 'fp1'};}
          if(m.command==='FILL_QUIZ'||m.command==='FILL_VIDEO_QUESTION')filled.push(m.data);
          if(m.command==='SUBMIT_QUIZ'||m.command==='SUBMIT_VIDEO_QUESTION')submits++;
          return {ok:true,verified:1};
        }
      }}}
  });
  loadContent(context);
  return {stored,main,frame,cards,commands,targets,filled,submits:()=>submits,answers:()=>answers,task:()=>stored['task:1'],
    retry:()=>vm.runInContext("startLoop=()=>{};retryAI(1,'task:1',JSON.parse(JSON.stringify(chromeState)))",Object.assign(context,{chromeState:stored['task:1']})),
    tick:()=>vm.runInContext(`tick(1,${JSON.stringify(stored['task:1'])})`,context)};
}
test('chapter AI fills and verifies, then waits for manual submission by default',async()=>{
 const f=fixture();await f.tick();assert.equal(f.answers(),1);assert.equal(f.filled.length,1);assert.equal(f.submits(),0);assert.equal(f.task().phase,'waiting');assert.match(f.task().status,/填写|核对|提交/);await f.tick();assert.equal(f.answers(),1);
});
test('video AI fills, submits once and uses the existing continue flow',async()=>{
 const f=fixture('video');await f.tick();assert.equal(f.answers(),1);assert.equal(f.submits(),1);f.frame.videoQuestionFeedback='continue';await f.tick();assert.ok(f.commands.includes('CONTINUE_VIDEO_QUESTION'));await f.tick();assert.equal(f.submits(),1);
});
test('master and video switches independently preserve manual handling',async()=>{
 for(const extra of [{aiEnabled:false},{aiVideoEnabled:false}]){const f=fixture('video',extra);await f.tick();assert.equal(f.answers(),0);assert.equal(f.submits(),0);assert.equal(f.task().waitReason,'videoQuestion');}
});
test('AI off then on during a request invalidates the old result',async()=>{
 const f=fixture('quiz',{},({stored})=>{stored.aiRevision='v2';});await f.tick();assert.equal(f.answers(),1);assert.equal(f.filled.length,0);assert.equal(f.submits(),0);
});
test('manual chapter navigation during AI prevents writing the old answer',async()=>{
 const f=fixture('quiz',{},({main})=>{main.chapterId='8';});await f.tick();assert.equal(f.filled.length,0);assert.equal(f.submits(),0);
});
test('an enabled quiz submit is not repeated after starting a new run',async()=>{
 const f=fixture('quiz',{autoSubmit:true});await f.tick();assert.equal(f.submits(),1);
 f.stored['task:1']={...f.task(),phase:'page',runId:'r2',ai:null};await f.tick();assert.equal(f.submits(),1);assert.equal(f.answers(),1);
});
test('video error feedback never triggers blind option guessing',async()=>{
 const f=fixture('video');await f.tick();f.frame.videoQuestionFeedback='incorrect';await f.tick();assert.equal(f.submits(),1);assert.equal(f.answers(),1);assert.equal(f.stored.todos.length,1);assert.match(f.stored.todos[0].reason,/未通过/);
});
test('enabling AI again retries a cancelled request using a new settings revision',async()=>{
 let once=true;const f=fixture('video',{},({stored})=>{if(once){stored.aiEnabled=false;stored.aiRevision='v2';once=false}});
 await f.tick();assert.equal(f.submits(),0);f.stored.aiEnabled=true;f.stored.aiRevision='v3';await f.tick();assert.equal(f.answers(),2);assert.equal(f.submits(),1);
});
test('turning chapter auto-submit off also prevents a pending confirmation',async()=>{
 const f=fixture('quiz',{autoSubmit:true});await f.tick();f.frame.hasSubmitConfirm=true;f.stored.autoSubmit=false;await f.tick();assert.equal(f.commands.includes('CONFIRM_SUBMIT'),false);
});
test('a replacement quiz document cannot receive confirmation for the old submission',async()=>{
 const f=fixture('quiz',{autoSubmit:true});await f.tick();f.frame.hasSubmitConfirm=true;f.frame.aiDocument='new-document';await f.tick();assert.equal(f.commands.includes('CONFIRM_SUBMIT'),false);
});
test('a recovered video processing state explains that it needs a fresh start',async()=>{
 const f=fixture('video');f.task().phase='waiting';f.task().waitReason='videoQuestion';f.task().ai={kind:'video',stage:'processing',revision:'v1'};
 await f.tick();assert.match(f.task().status,/中断|重新开始/);assert.equal(f.answers(),0);
});
test('independent quiz switch can disable quiz AI while video AI remains enabled',async()=>{
 const f=fixture('quiz',{aiQuizEnabled:false,quizMode:'wait'});await f.tick();assert.equal(f.answers(),0);assert.equal(f.task().waitReason,'quiz');
});

test('chapter AI runs after the platform marks all task points complete',async()=>{
 const f=fixture();
 f.main.treeTask={kind:'complete',count:0};
 f.main.tabs=[{index:1,kind:'video',active:true},{index:2,kind:'quiz',active:false}];
 f.cards.jobs=[];
 Object.assign(f.task(),{currentJobId:null,visitedTabs:[1],tabOpenedAt:Date.now(),jobs:[]});
 await f.tick();
 assert.ok(f.commands.includes('OPEN_TAB'));
 assert.notEqual(f.task().state,'completed');
 // 模拟打开测验标签：卡片页出现测验任务点。
 f.main.tabs=[{index:1,kind:'video',active:false},{index:2,kind:'quiz',active:true}];
 f.cards.jobs=[{id:'j1',name:'章节测验',type:'quiz',isJob:true,finished:false}];
 Object.assign(f.task(),{currentJobId:null,visitedTabs:[1,2],tabOpenedAt:Date.now()});
 await f.tick();
 await f.tick();
 assert.equal(f.answers(),1);
 assert.equal(f.filled.length,1);
});

test('a filled chapter quiz is not filled again after the platform marks the section complete',async()=>{
 const f=fixture('quiz');
 f.main.treeTask={kind:'complete',count:0};
 Object.assign(f.task(),{phase:'waiting',waitReason:'quiz',ai:{kind:'quiz',stage:'manual',key:'k',at:Date.now()}});
 await f.tick();
 assert.equal(f.answers(),0);
 assert.equal(f.task().phase,'waiting');
});

test('two distinct video questions both submit and click continue',async()=>{
 const f=fixture('video');
 for(const fingerprint of ['fp1','fp2']) {
  f.frame.fingerprint=fingerprint;f.frame.videoQuestionSurface=true;f.frame.videoQuestionFeedback='open';
  await f.tick();f.frame.videoQuestionFeedback='continue';await f.tick();
  f.frame.videoQuestionSurface=false;f.frame.videoQuestionFeedback='closed';await f.tick();await f.tick();
  f.frame.video.paused=false;f.frame.video.time+=1;await f.tick();f.frame.video.paused=true;
 }
 assert.equal(f.answers(),2);assert.equal(f.submits(),2);
 assert.equal(f.commands.filter(c=>c==='CONTINUE_VIDEO_QUESTION').length,2);
});

test('quiz reader selects the question document instead of the outer work wrapper',async()=>{
 const f=fixture();const wrapper={...f.frame,frameId:2,questionCount:0};f.cards.quizPageVisible=true;f.cards.aiDocument='wrapper';f.cards.questionCount=0;f.cards.jobId='j1';
 // The wrapper is before the question document in INSPECT_FRAMES, as in the supplied log.
 await f.tick();assert.equal(f.answers(),1);assert.equal(f.task().ai?.stage,'manual');assert.equal(f.targets.find(t=>t[0]==='READ_QUIZ')[1],3);
});

test('a second video question may appear before a closed-popup polling tick',async()=>{
 const f=fixture('video');await f.tick();f.frame.videoQuestionFeedback='continue';await f.tick();
 f.frame.fingerprint='fp2';f.frame.videoQuestionFingerprint='fp2';f.frame.videoQuestionFeedback='open';await f.tick();
 f.frame.videoQuestionFeedback='continue';await f.tick();assert.equal(f.answers(),2);assert.equal(f.submits(),2);assert.equal(f.commands.filter(c=>c==='CONTINUE_VIDEO_QUESTION').length,2);
});

test('read retry resets an error but refuses an already submitted question',async()=>{
 const f=fixture();f.task().phase='waiting';f.task().ai={stage:'error',kind:'quiz'};await f.retry();assert.equal(f.task().phase,'page');assert.equal(f.task().ai,null);
 f.task().phase='waiting';f.task().ai={stage:'submitted',kind:'quiz'};await assert.rejects(f.retry(),/没有可重新读取/);assert.equal(f.task().ai.stage,'submitted');
});

test('top-level workpop confirmation is clicked once in the top frame after auto-submit',async()=>{
 const f=fixture('quiz',{autoSubmit:true});f.main.aiDocument='top-doc';await f.tick();assert.equal(f.submits(),1);
 f.main.topSubmitConfirm=true;await f.tick();
 assert.deepEqual(f.targets.filter(t=>t[0]==='CONFIRM_TOP_SUBMIT'),[['CONFIRM_TOP_SUBMIT',0]]);
 assert.equal(f.commands.includes('CONFIRM_SUBMIT'),false);
 await f.tick();await f.tick();assert.equal(f.commands.filter(c=>c==='CONFIRM_TOP_SUBMIT').length,1);
});
test('top-level confirmation is not clicked when auto-submit is off',async()=>{
 const f=fixture('quiz',{autoSubmit:true});f.main.aiDocument='top-doc';await f.tick();f.stored.autoSubmit=false;f.main.topSubmitConfirm=true;await f.tick();
 assert.equal(f.commands.includes('CONFIRM_TOP_SUBMIT'),false);
});
test('a stale submission never confirms a later top-level dialog',async()=>{
 const f=fixture('quiz',{autoSubmit:true});f.main.aiDocument='top-doc';await f.tick();f.task().ai.at=Date.now()-120000;f.main.topSubmitConfirm=true;await f.tick();
 assert.equal(f.commands.includes('CONFIRM_TOP_SUBMIT'),false);assert.match(f.task().status,/人工/);
});
test('without a submission record the top-level dialog is left alone',async()=>{
 const f=fixture('quiz');f.main.aiDocument='top-doc';await f.tick();assert.equal(f.task().ai.stage,'manual');f.stored.autoSubmit=true;f.main.topSubmitConfirm=true;await f.tick();
 assert.equal(f.commands.includes('CONFIRM_TOP_SUBMIT'),false);
});

test('three short-gap video questions submit independently while chapter auto-submit is off',async()=>{
 const f=fixture('video',{autoSubmit:false});
 for(const fp of ['first','second','third']){
  f.frame.fingerprint=fp;f.frame.videoQuestionFingerprint=fp;f.frame.videoQuestionFeedback='open';await f.tick();
  assert.match(f.task().status,/等待平台作答反馈/);f.frame.videoQuestionFeedback='continue';await f.tick();
 }
 assert.equal(f.answers(),3);assert.equal(f.submits(),3);assert.equal(f.commands.filter(c=>c==='CONTINUE_VIDEO_QUESTION').length,3);
});
test('same submitted video question is not requested or submitted again when its response is lost',async()=>{
 const f=fixture('video');await f.tick();await f.tick();await f.tick();assert.equal(f.answers(),1);assert.equal(f.submits(),1);assert.match(f.task().status,/等待平台作答反馈/);
 f.task().ai.at=Date.now()-40000;await f.tick();assert.equal(f.stored.todos.length,1);assert.match(f.stored.todos[0].reason,/未返回明确结果/);assert.equal(f.submits(),1);
});
test('changing the video question during an AI request discards the old answer before filling',async()=>{
 const f=fixture('video',{},({frame})=>{frame.videoQuestionFingerprint='changed';});await f.tick();assert.equal(f.filled.length,0);assert.equal(f.submits(),0);assert.match(f.task().status,/变化/);
});
test('pausing or disabling the video feature during a request prevents writing',async()=>{
 for(const change of [({stored})=>{stored['task:1'].state='paused'},({stored})=>{stored.aiVideoEnabled=false}]){
  const f=fixture('video',{},change);await f.tick();assert.equal(f.filled.length,0);assert.equal(f.submits(),0);
 }
});

test('a prior quiz or different video AI state cannot silently force a new video question to manual',async()=>{
 for(const [kind,id] of [['quiz','old-quiz'],['video','old-video']]){
  const f=fixture('video');f.task().currentJobId=id;f.task().ai={kind,stage:'manual'};f.task().phase='waiting';f.task().waitReason='quiz';
  await f.tick();assert.equal(f.answers(),1);assert.equal(f.submits(),1);assert.equal(f.task().currentJobId,'j1');assert.equal(f.task().ai.kind,'video');
 }
});
test('an unmatched video reports the exact reason and resumes AI when its task point appears',async()=>{
 const f=fixture('video');const job=f.cards.jobs.pop();await f.tick();assert.equal(f.answers(),0);assert.match(f.task().status,/无法匹配/);assert.equal(f.task().ai.code,'unmatched-video');
 f.cards.jobs.push(job);await f.tick();assert.equal(f.answers(),1);assert.equal(f.submits(),1);
});
test('disabled master and video switches explain which setting needs enabling',async()=>{
 for(const [settings,pattern] of [[{aiEnabled:false},/总开关已关闭/],[{aiVideoEnabled:false},/分项已关闭/]]){
  const f=fixture('video',settings);await f.tick();assert.match(f.task().status,pattern);await f.tick();assert.match(f.task().status,pattern);assert.equal(f.answers(),0);
 }
});

test('a distinct video event arriving before failure deferral can recover from a read error',async()=>{
 const f=fixture('video');f.frame.readError='测试：未知选项结构';await f.tick();assert.equal(f.task().ai.stage,'error');assert.equal(f.task().ai.fingerprint,undefined);assert.equal(f.task().ai.eventIdentity,'event1');
 delete f.frame.readError;
 f.frame.videoQuestionIdentity='event2';f.frame.fingerprint='new-question';f.frame.videoQuestionFingerprint='new-question';await f.tick();assert.equal(f.answers(),1);assert.equal(f.submits(),1);
});

test('unmatched video AI has a bounded wait before deferring the section',async()=>{
 const f=fixture('video');f.cards.jobs=[];f.task().waitingSince=Date.now()-25000;
 await f.tick();assert.equal(f.stored.todos?.length,1);assert.notEqual(f.task().phase,'waiting');
});
test('interrupted processing state does not hold the run forever after reload',async()=>{
 const f=fixture('video');f.task().ai={kind:'video',stage:'processing',revision:'v1',at:Date.now()-90000};f.task().waitingSince=Date.now()-90000;
 await f.tick();assert.equal(f.stored.todos?.length,1);assert.notEqual(f.task().phase,'waiting');
});
test('video AI failure still defers the section without retrying',async()=>{
 const f=fixture('video');f.frame.readError='答题接口等待超时，请稍后重试';await f.tick();
 assert.equal(f.task().ai.retryAt,undefined);await f.tick();assert.equal(f.stored.todos.length,1);assert.equal(f.answers(),0);
});
test('chapter quiz retries are bounded, then wait for the user',async()=>{
 const f=fixture('quiz');f.frame.readError='答题接口等待超时，请稍后重试';
 for(let i=0;i<3;i++){await f.tick();assert.ok(f.task().ai.retryAt);f.task().ai.retryAt=Date.now()-1;}
 await f.tick();assert.equal(f.task().ai.retryAt,undefined);assert.match(f.task().status,/人工/);
 await f.tick();assert.equal(f.answers(),0);assert.equal(f.task().waitReason,'quiz');
});
test('chapter quiz errors that retrying cannot fix are not retried',async()=>{
 const f=fixture('quiz');f.frame.readError='请先在扩展中填写答题接口密钥';await f.tick();
 assert.equal(f.task().ai.retryAt,undefined);assert.match(f.task().status,/人工/);
});
test('interrupted chapter quiz processing is retried automatically',async()=>{
 const f=fixture('quiz');Object.assign(f.task(),{phase:'waiting',waitReason:'quiz',ai:{kind:'quiz',stage:'processing',revision:'v1',at:Date.now()-90000}});
 await f.tick();assert.ok(f.task().ai.retryAt);f.task().ai.retryAt=Date.now()-1;await f.tick();assert.equal(f.answers(),1);assert.equal(f.filled.length,1);
});
test('a chapter quiz that never loads is revealed again and retried',async()=>{
 const f=fixture('quiz');f.frame.quizPageVisible=false;await f.tick();assert.ok(f.task().jobRevealedAt);
 f.task().jobRevealedAt=Date.now()-50000;await f.tick();assert.ok(f.task().ai.retryAt);assert.equal(f.task().waitReason,'quiz');
 f.frame.quizPageVisible=true;f.task().ai.retryAt=Date.now()-1;await f.tick();
 assert.equal(f.answers(),1);assert.equal(f.filled.length,1);
});
test('a chapter quiz reveal error is retried instead of stopping the run',async()=>{
 const f=fixture('quiz');f.frame.quizPageVisible=false;f.cards.revealError=true;await f.tick();
 assert.equal(f.task().state,'running');assert.ok(f.task().ai.retryAt);
});
test('chapter quiz AI failure is retried automatically',async()=>{
 const f=fixture('quiz');f.frame.readError='DeepSeek 返回的 JSON 无法解析';await f.tick();
 assert.equal(f.task().ai.stage,'error');assert.ok(f.task().ai.retryAt);assert.equal(f.task().waitReason,'quiz');
 await f.tick();assert.equal(f.answers(),0);
 delete f.frame.readError;f.task().ai.retryAt=Date.now()-1;await f.tick();assert.equal(f.answers(),1);assert.equal(f.filled.length,1);
});
