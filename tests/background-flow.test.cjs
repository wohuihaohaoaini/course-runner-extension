// 后台答题（第 10 节）：图片/加密题截图不可用时保留当前题，不记待办、不换节、不重复提交。
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
  const questions=[{id:kind==='quiz'?'q1':'video-question',type:'single',needsImage:true,stem:'一加一？',options:[{id:'A',text:'二'},{id:'B',text:'三'}]}];
  const win={};win.top=win;
  const context=vm.createContext({window:win,top:win,URL,URLSearchParams,setTimeout,clearTimeout,
    location:{pathname:'/mycourse/studentstudy',href:'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7&courseId=8&clazzid=9',search:'?chapterId=7&courseId=8&clazzid=9'},
    document:{hidden:true,querySelector:()=>null,querySelectorAll:()=>[]},
    chrome:{storage:{local:{get:async keys=>Object.fromEntries((typeof keys==='string'?[keys]:keys||Object.keys(stored)).map(k=>[k,stored[k]])),set:async p=>Object.assign(stored,JSON.parse(JSON.stringify(p)))}},
      runtime:{onMessage:{addListener(){}},sendMessage:async m=>{
        if(m.type==='INSPECT_FRAMES')return [main,cards,frame];
        if(m.type==='ANSWER'){answers++;await onAnswer?.({stored,main,frame});return [{id:questions[0].id,choices:['A']}];}
        if(m.type==='AI_CLAIM_SUBMISSION'){const locks=stored.aiSubmissionLocks ||= {};const old=locks[m.key];if(m.confirmation?(!old||old.confirmed):old)return {claimed:false,record:old};locks[m.key]={at:Date.now(),confirmed:!!m.confirmation};return {claimed:true};}
        if(m.type==='COMMAND_FRAME'){
          commands.push(m.command);targets.push([m.command,m.frameId]);
          if(m.command==='REVEAL_JOB'&&cards.revealError)throw new Error('测试：任务点定位失败');
          if(m.command==='READ_QUIZ'||m.command==='READ_VIDEO_QUESTION'){if(frame.readError)throw new Error(frame.readError);return {questions,fingerprint:frame.fingerprint || 'fp1'};}
          if(m.command==='CAPTURE_QUESTION'||m.command==='CAPTURE_VIDEO_QUESTION'){if(frame.captureError)throw new Error(frame.captureError);return {id:questions[0].id,image:'data:image/png;base64,AA=='};}
          if(m.command==='FILL_QUIZ'||m.command==='FILL_VIDEO_QUESTION')filled.push(m.data);
          if(m.command==='SUBMIT_QUIZ'||m.command==='SUBMIT_VIDEO_QUESTION')submits++;
          return {ok:true,verified:1};
        }
      }}}
  });
  loadContent(context);
  return {context,stored,main,frame,cards,commands,targets,filled,submits:()=>submits,answers:()=>answers,task:()=>stored['task:1'],
    retry:()=>vm.runInContext("startLoop=()=>{};retryAI(1,'task:1',JSON.parse(JSON.stringify(chromeState)))",Object.assign(context,{chromeState:stored['task:1']})),
    tick:()=>vm.runInContext(`tick(1,${JSON.stringify(stored['task:1'])})`,context)};
}

const NOT_FOREGROUND='课程标签页不在前台，无法截图：请回到课程页，或把课程页单独放在一个未最小化的窗口里，或开启“后台截图答题”';
const UNAVAILABLE='后台截图暂不可用：课程页已打开开发者工具或其他调试连接，请关闭后重新读取；当前题目会保留';

test('background image video question waits on the same question when capture is impossible, without deferring the section',async()=>{
 const f=fixture('video');f.frame.captureError=NOT_FOREGROUND;
 await f.tick();
 assert.equal(f.task().ai.stage,'foreground');assert.equal(f.task().ai.retryAt,null);
 assert.equal(f.task().waitReason,'videoQuestion');assert.match(f.task().status,/已保留当前题/);
 for(let i=0;i<3;i++)await f.tick();
 assert.equal(f.stored.todos,undefined);assert.equal(f.answers(),0);assert.equal(f.submits(),0);
 assert.equal(f.task().activeChapterId,'7');assert.ok(!f.commands.includes('OPEN_CHAPTER'));
});

test('returning to the course page re-reads the kept video question and completes it',async()=>{
 const f=fixture('video');f.frame.captureError=NOT_FOREGROUND;await f.tick();
 f.context.document.hidden=false;delete f.frame.captureError;
 await f.tick();await f.tick();
 assert.equal(f.answers(),1);assert.equal(f.submits(),1);assert.equal(f.stored.todos,undefined);
});

test('transient background capture problems retry a bounded number of times, never submitting twice',async()=>{
 const f=fixture('video');f.frame.captureError=UNAVAILABLE;await f.tick();
 assert.ok(f.task().ai.retryAt);
 await f.tick();assert.equal(f.commands.filter(c=>c==='CAPTURE_VIDEO_QUESTION').length,1,'waits until the retry time');
 for(let i=0;i<4;i++){f.task().ai.retryAt&&(f.task().ai.retryAt=Date.now()-1);await f.tick();await f.tick();}
 assert.equal(f.commands.filter(c=>c==='CAPTURE_VIDEO_QUESTION').length,3,'initial try plus two retries');
 assert.equal(f.task().ai.stage,'foreground');assert.equal(f.task().ai.retryAt,null);
 assert.equal(f.stored.todos,undefined);assert.equal(f.submits(),0);
 delete f.frame.captureError;f.context.document.hidden=false;await f.tick();await f.tick();
 assert.equal(f.submits(),1);
});

test('fixing the authorization while still in the background (new settings revision) re-reads immediately',async()=>{
 const f=fixture('video');f.frame.captureError=NOT_FOREGROUND;await f.tick();
 delete f.frame.captureError;f.stored.aiRevision='v2';
 await f.tick();await f.tick();
 assert.equal(f.answers(),1);assert.equal(f.submits(),1);
});

test('layout instability during a background capture keeps the question instead of failing it',async()=>{
 const f=fixture('video');f.frame.captureError='截图期间页面发生滚动或布局变化，请保持页面稳定后重新开始';await f.tick();
 assert.equal(f.task().ai.stage,'foreground');assert.equal(f.stored.todos,undefined);
});

test('the same layout problem in the foreground keeps the existing 0.2.7 behaviour',async()=>{
 const f=fixture('video');f.context.document.hidden=false;f.frame.captureError='截图期间页面发生滚动或布局变化，请保持页面稳定后重新开始';await f.tick();
 assert.equal(f.task().ai.stage,'error');
});

test('chapter quiz image question in the background is kept and auto-submit settings are unchanged',async()=>{
 const f=fixture('quiz');f.frame.captureError=NOT_FOREGROUND;
 await f.tick();
 assert.equal(f.task().ai.stage,'foreground');assert.equal(f.task().waitReason,'quiz');
 f.task().phase='waiting';await f.tick();await f.tick();
 assert.equal(f.answers(),0);assert.equal(f.stored.todos,undefined);
 f.context.document.hidden=false;delete f.frame.captureError;await f.tick();
 assert.equal(f.answers(),1);assert.equal(f.filled.length,1);assert.equal(f.submits(),0,'auto-submit stays off by default');
});

test('chapter quiz in the background submits only when auto-submit is enabled',async()=>{
 const f=fixture('quiz',{autoSubmit:true});
 await f.tick();assert.equal(f.answers(),1);assert.equal(f.submits(),1);
 await f.tick();await f.tick();assert.equal(f.submits(),1);
});

test('text-only video question is answered fully in the background',async()=>{
 const f=fixture('video');
 // 纯文字题：不需要截图。
 vm.runInContext('0',f.context);
 f.frame.captureError='不应截图';
 const questions=[{id:'video-question',type:'single',needsImage:false,stem:'一加一？',options:[{id:'A',text:'二'},{id:'B',text:'三'}]}];
 const send=f.context.chrome.runtime.sendMessage;
 f.context.chrome.runtime.sendMessage=async m=>m.type==='COMMAND_FRAME'&&m.command==='READ_VIDEO_QUESTION'?{questions,fingerprint:'fp1'}:send(m);
 await f.tick();
 assert.equal(f.answers(),1);assert.equal(f.submits(),1);assert.ok(!f.commands.includes('CAPTURE_VIDEO_QUESTION'));
});
