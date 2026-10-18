// 本地模拟课程站点：学习页、任务点卡片、视频弹题播放器、章节测验与事件记录。
// run-ai.cjs（Playwright 拦截）与 background-flow.cjs（本地 HTTPS 服务）共用，保证两条流程面对同一套页面。
const {modernQuestion,wireModernChoices}=require('../fixtures/modern-quiz.cjs');
const {videoQuestion}=require('../fixtures/video-quiz.cjs');
module.exports=function createCourseSite({clip,vision=!!process.env.E2E_VISION,mutedVideo=true}={}){
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
 return `<!doctype html><html><meta charset="utf-8"><body><video id="video_html5_api" src="/clip.webm" style="width:320px;height:180px" preload="auto" ${mutedVideo?'muted':''}></video>
 <div id="question" style="display:none;position:absolute;top:10px;left:10px;width:440px;background:white;border:2px solid #2563EB;padding:14px">${markup}</div>
 <script>const v=document.querySelector('video');let asked=0,resumeAt=null,resumeQuestion=null;const q=document.querySelector('#question');const original=q.querySelector('.tkItem').innerHTML;
 v.addEventListener('timeupdate',()=>{
  if(resumeAt!==null && v.currentTime>resumeAt+0.15){fetch('/event?type=video-resumed&id=${id}&question='+resumeQuestion);resumeAt=null}
  if('${id}'==='v2' && asked<3 && v.currentTime>= [1,1.6,2.2][asked]){asked++;v.pause();q.style.display='block';
   q.querySelector('.tkItem').innerHTML=asked===2?${JSON.stringify(custom)}:original;
   if(asked===2){(${wireModernChoices.toString()})(window)}
   q.querySelector('.tkTopic_title').textContent=asked===2?'多选题':'单选题';
   if(asked===3 && ${vision})q.querySelector('.tkItem_title').classList.add('font-cxsecret');
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
${[['101','0'],['102','0'],['103','3'],['104','3'],['105','1']].map(([id,type])=>modernQuestion(id,type,vision)).join('')}
<div class="TiMu" data="fill1"><div class="Zy_TItle">填写：示例答案</div><textarea id="editor1" name="answerEditor1" hidden></textarea><div id="editor-content" contenteditable="true" style="height:40px;border:1px solid gray"></div></div>
<button id="submit">提交</button>
<script>(${wireModernChoices.toString()})(window);
window.UE={getEditor:()=>({setContent:v=>document.querySelector('#editor-content').innerHTML=v,getContent:()=>document.querySelector('#editor-content').innerHTML})};
document.querySelector('#submit').onclick=()=>{fetch('/event?type=quiz-submit');top.showWorkpop(submitCheckTimes)};
function submitCheckTimes(){fetch('/event?type=quiz-confirm');const expected={'101':'B','102':'B','103':'false','104':'false','105':'AC'};if(Object.entries(expected).every(([id,value])=>document.getElementById('answer'+id).value===value)&&document.querySelector('#editor-content').textContent==='示例答案'){parent.postMessage({done:'q'},location.origin)}}
</script></body></html>`;}


// 返回 {status, contentType, body}；未知路径返回空页面。
function respond(u){let body;
  if(u.pathname.includes('studentstudy'))body=topHTML();
  else if(u.pathname.includes('knowledge/cards'))body=cardsHTML(u.searchParams.get('chapter'));
  else if(u.pathname.includes('/video/'))body=videoHTML(u.searchParams.get('id'));
  else if(u.pathname.includes('/modules/work/'))body='<iframe id="frame_content" src="/mooc-ans/work/dohomeworknew?jobid=q" style="border:0;width:650px;height:400px"></iframe><script>addEventListener("message",e=>{if(e.data.done)parent.postMessage(e.data,location.origin)})</script>';
  else if(u.pathname.includes('/work/dohomeworknew'))body=quizHTML();
  else if(u.pathname==='/clip.webm')return {status:200,contentType:'video/webm',body:clip};
  else if(u.pathname==='/done'){finished.add(u.searchParams.get('id'));body='ok'}
  else if(u.pathname==='/event'){events.push(Object.fromEntries(u.searchParams));body='ok'}
  else if(u.pathname==='/other-site')body='<!doctype html><meta charset="utf-8"><title>其他网页</title><h1>用户正在浏览的其他网页</h1>';
  else body='';
  return {status:200,contentType:'text/html; charset=utf-8',body};
}
return {finished,events,respond};
};
