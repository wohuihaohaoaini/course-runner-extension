// 此函数同时用于内容脚本快照和 MAIN 世界填写，保持两处题目识别完全一致。
function blankEditorAction(questionId, blanks, mode, expected) {
  const roots = [...document.querySelectorAll('.TiMu, .newTiMu')].filter(item =>
    item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden' &&
    item.querySelector('.Zy_TItle, .newZy_TItle') && item.querySelector("textarea[name^='answerEditor']"));
  const root = roots.find(item => {
    if (roots.some(other => other !== item && item.contains(other))) return false;
    const raw = item.getAttribute('data');
    const modern = item.classList.contains('newTiMu') && /^\d+$/.test(raw || '');
    const explicit = item.getAttribute('data-question-id') || item.id || (!modern && raw);
    if (explicit) return explicit === questionId;
    const fields = [...item.querySelectorAll('[name]')].map(field => (field.getAttribute('name') || '').match(/^(?:answer(?:check)?|tiankongsize)(\d+)$/i)?.[1]).filter(Boolean);
    if (fields.length) return new Set(fields).size === 1 && fields[0] === questionId;
    const ids = [...new Set([...item.querySelectorAll("input[name], textarea[name^='answerEditor']")]
      .map(input => input.name.match(/^answer(?:check|Editor)?(\d+)$/i)?.[1]).filter(Boolean))];
    return ids.length === 1 && ids[0] === questionId;
  });
  if (!root) return { error: '填空题已变化，停止填写' };
  const textareas = [...root.querySelectorAll("textarea[name^='answerEditor']")];
  function snapshot() {
    const title = root.querySelector('.Zy_TItle, .newZy_TItle');
    if (!title) throw new Error('填空题缺少题干，停止填写');
    return JSON.stringify([title.outerHTML,
      [...title.querySelectorAll('img')].map(img => [img.currentSrc || img.src, img.naturalWidth, img.naturalHeight]),
      [...title.querySelectorAll('canvas')].map(canvas => canvas.toDataURL()),
      textareas.map(input => [input.id, input.name])]);
  }
  let current;
  try { current = snapshot(); } catch { return { error: '无法核对填空题图像，请人工处理' }; }
  if (mode === 'snapshot') return { snapshot: current };
  if (!expected || current !== expected || !root.isConnected) return { error: '填空题已变化，停止填写' };
  if (!Array.isArray(blanks) || !textareas.length || textareas.length !== blanks.length) return { error: '填空数量与页面不一致，停止填写' };
  if (!window.UE?.getEditor) return { error: '填空编辑器尚未加载，请稍后重试' };
  const editors = textareas.map(textarea => textarea.id && window.UE.getEditor(textarea.id));
  if (editors.some(editor => !editor || typeof editor.getContent !== 'function' || typeof editor.setContent !== 'function')) return { error: '填空编辑器尚未准备好' };
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  for (let index = 0; index < editors.length; index++) {
    // setContent 可能同步触发页面脚本；每一空写入前再核对。
    if (!root.isConnected || snapshot() !== expected) return { error: '填空题已变化，停止填写' };
    if (mode === 'fill') {
      const escaped = String(blanks[index]).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      editors[index].setContent(escaped);
    }
    const decoded = document.createElement('div');
    decoded.innerHTML = editors[index].getContent();
    if (normalize(decoded.textContent) !== normalize(blanks[index])) return { error: `第 ${index + 1} 空的内容未通过核对，停止提交` };
  }
  return mode === 'fill' ? { filled: textareas.length } : { verified: textareas.length };
}
