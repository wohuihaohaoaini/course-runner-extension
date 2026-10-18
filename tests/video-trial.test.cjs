const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const loadContent=require('./load-content.cjs');
function fixture(extra={}) {
 const main={frameId:0,active:true,chapterId:'7',tabs:[],catalog:[{id:'7',unfinished:1,active:true},{id:'8',unfinished:1}]};
 const frame={frameId:3,active:true,aiDocument:'doc',jobId:'v',mediaPage:true,video:{paused:true,time:20,ready:true,duration:100},videoQuestionSurface:true,
 videoQuestionFeedback:'open',videoQuestionFingerprint:'ai-fp',videoQuestionIdentity:'event',videoTrialFingerprint:'fp',videoTrialCanRetry:true};
 const job={id:'v',type:'video',isJob:true,finished:false};
 const stored={aiEnabled:false,videoAnswerMode:'trial',aiRevision:'r','task:1':{state:'running',phase:'page',runId:'run',activeChapterId:'7',currentJobId:'v',skippedJobs:[],jobStartedAt:Date.now()},...extra};
 const commands=[],submitted=[];let apiCalls=0;
 const w={};w.top=w;
 const c=vm.createContext({window:w,top:w,URL,URLSearchParams,setTimeout,clearTimeout,
 location:{pathname:'/mycourse/studentstudy',href:'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7&courseId=8&clazzid=9',search:'?chapterId=7&courseId=8&clazzid=9'},
 document:{querySelector:()=>null,querySelectorAll:()=>[]},chrome:{storage:{local:{get:async keys=>Object.fromEntries((typeof keys==='string'?[keys]:keys||Object.keys(stored)).map(k=>[k,stored[k]])),set:async p=>Object.assign(stored,JSON.parse(JSON.stringify(p)))}},runtime:{onMessage:{addListener(){}},sendMessage:async m=>{
 if(m.type==='INSPECT_FRAMES')return [main,{frameId:2,active:true,jobs:[job]},frame];
 if(m.type==='ANSWER'){apiCalls++;throw new Error('trial must not call AI')}
 if(m.type==='VIDEO_TRIAL_VALIDATE')return {ok:true};
 if(m.type==='COMMAND_FRAME'){
 commands.push(m.command);
 if(m.command==='READ_VIDEO_TRIAL')return {fingerprint:frame.videoTrialFingerprint,choices:['A','B','C','D'],type:'single',canRetry:frame.videoTrialCanRetry};
 if(m.command==='SUBMIT_VIDEO_TRIAL'){submitted.push(m.data);return {clicked:true}}
 return {ok:true};
 }
 }}}});
 loadContent(c);
 return {stored,frame,main,commands,submitted,apiCalls:()=>apiCalls,task:()=>stored['task:1'],tick:()=>vm.runInContext('tick(1,chromeTask)',Object.assign(c,{chromeTask:stored['task:1']}))};
}
test('trial works with AI off, then advances A to B only after a fresh incorrect receipt',async()=>{
 const f=fixture();await f.tick();
 assert.equal(f.submitted[0]?.choice,'A');assert.equal(f.apiCalls(),0);
 f.frame.videoQuestionFeedback='incorrect';await f.tick();
 assert.equal(f.submitted.length,1,'old error without receipt must not advance');
 f.frame.videoTrialResult={token:f.submitted[0].token,status:'incorrect'};
 await f.tick();assert.equal(f.submitted[1]?.choice,'B');
 await f.tick();assert.equal(f.submitted.length,2,'A receipt must not advance B');
 f.frame.videoTrialResult={token:f.submitted[1].token,status:'correct'};
 f.frame.videoQuestionFeedback='continue';await f.tick();
 assert.equal(f.commands.at(-1),'CONTINUE_VIDEO_QUESTION');
 assert.equal(f.submitted.length,2);assert.equal(f.apiCalls(),0);
});
test('each A B C D option is tried at most once and exhaustion leaves the section',async()=>{
 const f=fixture();await f.tick();
 for(let i=0;i<4;i++){
 assert.equal(f.submitted[i]?.choice,'ABCD'[i]);
 f.frame.videoQuestionFeedback='incorrect';f.frame.videoTrialResult={token:f.submitted[i]?.token,status:'incorrect'};
 await f.tick();
 }
 assert.equal(f.submitted.length,4);
 assert.equal(f.task().phase,'switchingChapter');assert.equal(f.task().targetChapterId,'8');
 assert.equal(f.stored.todos.length,1);
});
test('trial timeout leaves an uncertain submission alone and continues to the next section',async()=>{
 const f=fixture();await f.tick();f.task().videoTrial.at=Date.now()-31000;
 await f.tick();assert.equal(f.submitted.length,1);
 assert.equal(f.task().phase,'switchingChapter');assert.equal(f.stored.todos.length,1);
});
test('manual mode and captcha do not select or skip any answers',async()=>{
 const f=fixture({videoAnswerMode:'manual'});await f.tick();assert.equal(f.submitted.length,0);assert.equal(f.stored.todos,undefined);
 const g=fixture();g.main.captcha=true;await g.tick();assert.equal(g.submitted.length,0);assert.equal(g.task().waitReason,'captcha');
});
test('AI failure is recorded as unfinished and navigation proceeds while old popup stays visible',async()=>{
 const f=fixture({videoAnswerMode:'ai',aiEnabled:true});
 f.task().ai={kind:'video',stage:'error',revision:'r',frameToken:'doc',fingerprint:'ai-fp'};
 await f.tick();assert.equal(f.task().phase,'switchingChapter');assert.equal(f.task().targetChapterId,'8');
 assert.equal(f.stored.todos.length,1);
});

test('successful trial whose continue page stays open is deferred after a finite wait',async()=>{
 const f=fixture();await f.tick();f.frame.videoTrialResult={token:f.submitted[0].token,status:'correct'};f.frame.videoQuestionFeedback='continue';
 f.task().questionContinueClickedAt=Date.now()-20000;await f.tick();
 assert.equal(f.task().phase,'switchingChapter');assert.equal(f.stored.todos.length,1);
});
test('refreshing the player never restarts uncertain trial A even if paused time changes the fingerprint',async()=>{
 const f=fixture();await f.tick();f.frame.aiDocument='new-doc';f.frame.videoTrialFingerprint='new-time';
 await f.tick();assert.equal(f.submitted.length,1);assert.equal(f.task().phase,'switchingChapter');
});

test('captcha takes precedence over a correct popup and preserves the attempted choice',async()=>{
 const f=fixture();await f.tick();f.frame.videoTrialResult={token:f.submitted[0].token,status:'correct'};f.frame.videoQuestionFeedback='continue';f.main.captcha=true;
 await f.tick();assert.equal(f.task().waitReason,'captcha');assert.equal(f.commands.includes('CONTINUE_VIDEO_QUESTION'),false);assert.deepEqual(f.task().videoTrial.attempted,['A']);
 f.main.captcha=false;await f.tick();await f.tick();assert.equal(f.submitted.length,1);assert.equal(f.commands.includes('CONTINUE_VIDEO_QUESTION'),true);
});
