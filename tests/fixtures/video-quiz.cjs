// 依据当前课程实际加载的 videojs-ext.min.js?v=2026-1012-06 的 VideoQuiz.renderTpl。
// 匿名题目；保留题型、题干分离及重复 input.value，避免把模板简化成旧代码恰好支持的结构。
function videoQuestion(stem='二加三等于多少？',type='single') {
 const multiple=type==='multiple';
 return `<div class="ans-timelineobjects"><div class="ans-videoquiz"><div class="tkTopic"><div class="tkTopic_title">${multiple?'多选题':type==='judgment'?'判断题':'单选题'}</div><div class="tkTopic_con tkScroll"><div class="tkItem"><div class="tkItem_title">${stem}</div><ul class="tkItem_ul">${['四','五','六'].map((text,i)=>`<li class="ans-videoquiz-opt"><label><span class="tkRadio"><input type="${multiple?'checkbox':'radio'}" name="ans-videoquiz-opt" value="${i===1?'true':'false'}"><i></i></span>${'ABC'[i]}、${text}</label></li>`).join('')}</ul></div></div><div class="tkTopic_oper"><a id="videoquiz-submit">提交</a><a id="videoquiz-submitting" style="display:none">提交中</a><a id="videoquiz-continue" style="display:none">继续学习</a><span id="spanHas" style="display:none">回答正确</span><span id="spanNot" style="display:none">回答错误</span><span id="spanNotBackPoint" style="display:none">请回看</span></div></div></div></div>`;
}
module.exports={videoQuestion};
