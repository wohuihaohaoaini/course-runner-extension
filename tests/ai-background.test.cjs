const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const questions = [{ id: 'q1', type: 'single', needsImage: false, stem: '一加一等于几？', options: [{ id:'A', text:'二' }, { id:'B', text:'三' }] }];
const guard = { runId:'r1', revision:'s1', kind:'quiz', chapterId:'7', jobId:'q', frameId:2, frameToken:'doc1' };
function fixture(extra = {}, responder) {
  const stored = { aiEnabled:true, aiQuizEnabled:true, aiVideoEnabled:true, aiRevision:'s1', apiKey:'test-key',
    'task:1':{ state:'running', runId:'r1', activeChapterId:'7', currentJobId:'q' }, ...extra };
  const listeners=[]; let onMessage;
  const sent=[]; let calls=0;
  const context=vm.createContext({ AbortController, setTimeout, clearTimeout, setInterval, clearInterval, TextDecoder, URL, console,
    fetch: async (...args) => { calls++; return responder ? responder(...args) : { ok:true, status:200, json:async()=>({choices:[{message:{content:JSON.stringify({answers:[{id:'q1',choices:['A']}]})},finish_reason:'stop'}]}) }; },
    chrome:{ runtime:{getManifest:()=>({version:'0.2.1'}),onMessage:{addListener:f=>onMessage=f}},
      storage:{local:{get:async(keys)=>{ const list=typeof keys==='string'?[keys]:keys||Object.keys(stored); return Object.fromEntries(list.map(k=>[k,stored[k]])); },set:async(patch)=>{ const changes={}; for(const [k,v] of Object.entries(patch)){ changes[k]={oldValue:stored[k],newValue:v}; stored[k]=v; } listeners.forEach(f=>f(changes,'local')); },remove:async k=>delete stored[k]},onChanged:{addListener:f=>listeners.push(f)}},
      webNavigation:{getAllFrames:async()=>[{frameId:0},{frameId:2}]},
      tabs:{sendMessage:async(id,m,o)=>{sent.push(m);return o.frameId===0?{kind:'other',chapterId:'7'}:{kind:'quiz',active:true,aiDocument:'doc1',jobId:'q'};},
        get:async id=>({id,active:true,windowId:1,url:'https://mooc1.chaoxing.com/mycourse/studentstudy'})}
    }});
  context.importScripts=(...files)=>files.forEach(f=>vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),context,{filename:f}));
  vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context);
  const run=code=>vm.runInContext(code,context);
  const send=message=>new Promise(resolve=>onMessage(message,{tab:{id:1,windowId:1},frameId:0},resolve));
  return {stored,context,run,send,calls:()=>calls,sent};
}
test('AI is opt-in: a saved key alone never sends a request',async()=>{
  const f=fixture({aiEnabled:false});
  const r=await f.send({type:'ANSWER',questions,images:[],guard});
  assert.match(r.error,/关闭|开启/); assert.equal(f.calls(),0);
});
test('valid chapter AI uses the text model and validates answers',async()=>{
  let body; const f=fixture({},async(url,options)=>{body=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({choices:[{message:{content:'{"answers":[{"id":"q1","choices":["A"]}]}'},finish_reason:'stop'}]})};});
  const r=await f.send({type:'ANSWER',questions,images:[],guard});
  assert.equal(r[0]?.choices[0],'A'); assert.equal(body.model,'deepseek-flash');
});
test('duplicate answer ids are rejected instead of silently taking the last',async()=>{
  const f=fixture();
  assert.throws(()=>f.run(`normalizeAnswers({answers:[{id:'q1',choices:['A']},{id:'q1',choices:['B']}]},${JSON.stringify(questions)})`),/重复|数量/);
});
test('a stale run cannot send an AI request',async()=>{
  const f=fixture();const r=await f.send({type:'ANSWER',questions,images:[],guard:{...guard,runId:'old'}});
  assert.match(r.error,/变化|失效|暂停/);assert.equal(f.calls(),0);
});
test('disabling AI aborts a pending request and discards the response',async()=>{
  let began; const started=new Promise(r=>began=r);
  const f=fixture({},(u,o)=>new Promise((resolve,reject)=>{began();o.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})));}));
  const pending=f.send({type:'ANSWER',questions,images:[],guard});await Promise.race([started, pending.then(r => { throw new Error(r.error || "request ended before fetch"); })]);
  await f.send({type:'SET_AI_SETTINGS',patch:{aiEnabled:false}});
  assert.match((await pending).error,/取消|关闭|失效/);assert.equal(f.stored.aiEnabled,false);assert.notEqual(f.stored.aiRevision,'s1');
});
test('submission claim survives re-start and refuses a duplicate',async()=>{
  const f=fixture();const m={type:'AI_CLAIM_SUBMISSION',guard,key:'course:7:q:fp'};
  assert.equal((await f.send(m)).claimed,true);
  assert.equal((await f.send(m)).claimed,false);
  assert.equal(Object.keys(f.stored.aiSubmissionLocks).length,1);
});
test('capture errors restore the panel and explain the missing authorization',async()=>{
 const f=fixture();f.context.chrome.tabs.query=async()=>[{id:1}];f.context.chrome.tabs.captureVisibleTab=async()=>{throw new Error('activeTab permission denied')};
 const r=await f.send({type:'CAPTURE_TAB',guard});assert.match(r.error,/截图授权/);
 assert.deepEqual(f.sent.filter(m=>m.type==='CAPTURE_PANEL').map(m=>m.hidden),[true,false]);
});
test('changing the configured model during a request discards the old result',async()=>{
 let began;const started=new Promise(r=>began=r);
 const f=fixture({},(u,o)=>new Promise((resolve,reject)=>{began();o.signal.addEventListener('abort',()=>reject(Object.assign(new Error('abort'),{name:'AbortError'})));}));
 const pending=f.send({type:'ANSWER',questions,images:[],guard});await started;
 await f.send({type:'SET_AI_SETTINGS',patch:{model:'deepseek-flash'}});assert.match((await pending).error,/取消|失效/);
});

test('streaming answers handle split UTF-8 data and usage without exposing reasoning',async()=>{
 const payload=JSON.stringify({answers:[{id:'q1',choices:['A']}]});
 const chunks=[{choices:[{delta:{reasoning_content:'内部推理'}}]},
   ...[payload.slice(0,17),payload.slice(17)].map(content=>({choices:[{delta:{content},finish_reason:null}]})),
   {choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}];
 const data=new TextEncoder().encode(chunks.map(c=>'data: '+JSON.stringify(c)+'\r\n\r\n').join('')+'data: [DONE]\n\n');
 let streamRequested=false;
 const f=fixture({},async(u,o)=>{streamRequested=JSON.parse(o.body).stream;let i=0;return new Response(new ReadableStream({pull(c){if(i>=data.length)return c.close();c.enqueue(data.slice(i,i+3));i+=3}}),{headers:{'content-type':'text/event-stream'}})});
 const result=await f.send({type:'ANSWER',questions,images:[],guard});assert.equal(result[0].choices[0],'A');assert.equal(streamRequested,true);
});
test('truncated stream does not produce an answer',async()=>{
 const f=fixture({},async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'{}'}}]})+'\n\n',{headers:{'content-type':'text/event-stream'}}));
 assert.match((await f.send({type:'ANSWER',questions,images:[],guard})).error,/中断/);
});
test('slow response headers time out within the Chrome fetch lifetime',async()=>{
 const timers=[];
 const f=fixture({},(u,o)=>new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})))));
 f.context.setTimeout=(fn,ms)=>{timers.push(ms);return setTimeout(fn,ms===25000?5:1000)};
 assert.match((await f.send({type:'ANSWER',questions,images:[],guard})).error,/超时/);assert.ok(timers.includes(25000));
});
test('blank injection targets the originating document, never a recycled frame id',async()=>{
 const f=fixture();let injection;f.context.chrome.scripting={executeScript:async options=>{injection=options;return [{result:{filled:1}}]}};
 const result=await f.run(`runBlankEditorAction({tab:{id:1},frameId:2,documentId:'original-document'},'q1',['答案'],'fill',${JSON.stringify(guard)},'expected-question')`);
 assert.equal(result.filled,1);assert.equal(injection.target.documentIds[0],'original-document');assert.equal(injection.target.frameIds,undefined);assert.equal(injection.args[3],'expected-question');
});

test('Pro remains available when explicitly selected, while images always use Flash',async()=>{
 const models=[];const f=fixture({model:'deepseek-v4-pro'},async(u,o)=>{models.push(JSON.parse(o.body).model);return {ok:true,status:200,json:async()=>({choices:[{message:{content:'{"answers":[{"id":"q1","choices":["A"]}]}'},finish_reason:'stop'}]})}});
 await f.send({type:'ANSWER',questions,images:[],guard});await f.send({type:'ANSWER',questions:questions.map(q=>({...q,needsImage:true})),images:[{id:'q1',image:'data:image/png;base64,YQ=='}],guard});
 assert.deepEqual(models,['deepseek-v4-pro','deepseek-flash']);
});

test('trial validation permits AI-off video actions but never permits an AI API request',async()=>{
 const f=fixture({aiEnabled:false,videoAnswerMode:'trial'});
 assert.equal(f.run('typeof validateVideoTrialContext'),'function');
 f.run(`chrome.tabs.sendMessage=async(id,m,o)=>o.frameId===0?{chapterId:'7'}:{active:true,kind:'video',mediaPage:true,aiDocument:'doc1',jobId:'q',videoQuestionSurface:true,videoTrialFingerprint:'trial-fp'}`);
 const g={...guard,kind:'video',fingerprint:'trial-fp'};
 const valid=await f.send({type:'VIDEO_TRIAL_VALIDATE',guard:g});assert.equal(valid.ok,true);
 const answer=await f.send({type:'ANSWER',questions,images:[],guard:g});assert.match(answer.error,/关闭|开启/);assert.equal(f.calls(),0);
 f.stored.videoAnswerMode='manual';const stopped=await f.send({type:'VIDEO_TRIAL_VALIDATE',guard:g});assert.match(stopped.error,/模式|关闭|变化/);
});
test('trial validation rejects changed document, question and captcha',async()=>{
 const f=fixture({videoAnswerMode:'trial'});assert.equal(f.run('typeof validateVideoTrialContext'),'function');
 const g={...guard,kind:'video',fingerprint:'trial-fp'};
 for(const patch of [{aiDocument:'new'},{videoTrialFingerprint:'new'},{captcha:true},{jobId:'other'}]){
 f.context.testFrame={active:true,kind:'video',mediaPage:true,aiDocument:'doc1',jobId:'q',videoQuestionSurface:true,videoTrialFingerprint:'trial-fp',...patch};
 f.run(`chrome.tabs.sendMessage=async(id,m,o)=>o.frameId===0?{chapterId:'7'}:testFrame`);
 const invalid=await f.send({type:'VIDEO_TRIAL_VALIDATE',guard:g});assert.match(invalid.error,/变化|验证|匹配/);
 }
});
