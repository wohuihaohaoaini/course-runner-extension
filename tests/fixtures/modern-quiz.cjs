// 根据真实页面只读检查结果整理，题目内容和编号已替换成测试数据。
function modernQuestion(id, type='0', encrypted=false) {
 const multiple=type==='1', judgment=type==='3';const values=judgment?['true','false']:['A','B','C'];
 return `<div class="TiMu newTiMu" data="${type}"><div class="Zy_TItle clearfix"><i class="fl">1</i><div class="clearfix ${encrypted?'font-cxsecret fontLabel':''}"><span class="newZy_TItle">【${judgment?'判断题':multiple?'多选题':'单选题'}】</span>示例题干 ${id}</div></div><div class="clearfix"><ul class="Zy_ulTop w-top fl"${!judgment?' aria-hidden="true"':''}>${values.map((v,i)=>`<li class="before-after ${encrypted?'font-cxsecret':''}" qid="${id}" qtype="${type}" role="${multiple?'checkbox':'radio'}"><label class="fl before"><span class="${multiple?'num_option_dx':'num_option'} choice${id}" name="answer${id}" data="${v}">${'ABC'[i]}</span></label><a href="javascript:void(0);" class="fl after">${judgment?(i?'错':'对'):'选项'+(i+1)}</a></li>`).join('')}</ul><input type="hidden" name="answer${id}" id="answer${id}"><input type="hidden" name="answertype${id}" id="answertype${id}"></div></div>`;
}
function wireModernChoices(window) {
 for(const row of window.document.querySelectorAll('li[qid][qtype]'))row.addEventListener('click',()=>{
  const id=row.getAttribute('qid'),multiple=row.getAttribute('qtype')==='1',marker=row.querySelector('.num_option,.num_option_dx'),cls=multiple?'check_answer_dx':'check_answer';
  const was=marker.classList.contains(cls);if(!multiple)for(const other of window.document.querySelectorAll(`[qid="${id}"]`)){other.querySelector('.num_option')?.classList.remove(cls);other.setAttribute('aria-checked','false')}
  marker.classList.toggle(cls,!was);row.setAttribute('aria-checked',String(!was));row.setAttribute('aria-pressed',String(!was));
  window.document.getElementById('answer'+id).value=[...window.document.querySelectorAll(`[qid="${id}"] .${cls}`)].map(m=>m.getAttribute('data')).join('');
 });
}
module.exports={modernQuestion,wireModernChoices};
