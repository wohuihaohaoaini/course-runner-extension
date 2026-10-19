// 章节测验：题目识别、截图、填写与核对。

function quizRoot() {
  if (!QUIZ_URL.test(location.pathname)) return null;
  const roots = [...document.querySelectorAll(".TiMu, .newTiMu")].filter(root =>
    root.querySelector('.Zy_TItle, .newZy_TItle') && root.querySelector("input[name^='answer'], textarea[name^='answerEditor'], input[name^='tiankongsize']"));
  return roots.length ? roots : null;
}

function getQuestionElements() {
  const roots = quizRoot();
  if (!roots) return [];
  // newTiMu 也可能是整张试卷的容器。保留最内层的完整题块，避免把多道题合为一道。
  return roots.filter((root) => visible(root) && !roots.some((other) => other !== root && root.contains(other)));
}

function ensureQuizVisible() {
  if (!QUIZ_URL.test(location.pathname) || !frameVisible()) throw new Error('测验标签已切换，停止填写与提交');
  if (!getQuestionElements().length) throw new Error('当前框架尚未加载可填写题目，正在等待真正的题目页');
}

function quizSubmitConfirmation() {
  const dialog = document.querySelector("#confirmSubWin[role='alertdialog']");
  const legacy = dialog?.querySelector("a.bluebtn[onclick*='submitCheckTimes']");
  if (visible(dialog) && visible(legacy)) return legacy;
  const modern = document.querySelector('#submitBackOk');
  return visible(modern) && /^(确认|确定|确认提交|提交|确认交卷)$/.test(textOf(modern) || modern.value || '') ? modern : null;
}

// 新版学习页把“确认提交？”放在顶层文档的通用弹窗 #workpop 中，而不在测验 iframe 内。
// 只认提交确认文案和 #popok，其他提示（如未答完）交给用户。
function topSubmitConfirmation() {
  if (window !== window.top) return null;
  const dialog = document.querySelector('#workpop');
  const ok = dialog?.querySelector('#popok');
  if (!visible(dialog) || !visible(ok)) return null;
  if (!/^(是否)?确认提交(作业|测验|答案)?[？?]?$/.test(textOf(dialog.querySelector('#popcontent')))) return null;
  return /^(提交|确定|确认|确认提交)$/.test(textOf(ok)) ? ok : null;
}

function questionId(root) {
  const raw = root.getAttribute('data');
  const modern = root.querySelector('.num_option, .num_option_dx') ||
    (root.classList.contains('newTiMu') && /^\d+$/.test(raw || ''));
  const explicit = root.getAttribute('data-question-id') || root.id || (!modern && raw);
  if (explicit) return String(explicit);
  const ids = new Set([...root.querySelectorAll('[qid]')].map(row => row.getAttribute('qid')).filter(Boolean));
  for (const field of root.querySelectorAll('[name]')) {
    const match = (field.getAttribute('name') || '').match(/^(?:answer(?:check)?|tiankongsize)(\d+)$/i);
    if (match) ids.add(match[1]);
  }
  if (ids.size) return ids.size === 1 ? [...ids][0] : null;
  const blanks = [...new Set(blankEditors(root).map(field => field.name.match(/^answerEditor(\d+)$/i)?.[1]).filter(Boolean))];
  return blanks.length === 1 ? blanks[0] : null;
}

function questionInputs(root) {
  return [...root.querySelectorAll("input[type='radio'], input[type='checkbox']")]
    .filter(input => /^answer(?:check)?/i.test(input.name || ''));
}

function blankEditors(root) {
  return [...root.querySelectorAll("textarea[name^='answerEditor']")]
    .filter(element => /^answerEditor/i.test(element.name || ''));
}

function optionElements(root) {
  const inputs = questionInputs(root);
  if (inputs.length) return inputs.map((input, index) => {
    const row = input.closest('li') || input.closest('label') || input.parentElement;
    const value = clean(input.value);
    return { id: /^[A-Z]$/i.test(value) ? value.toUpperCase() : LETTERS[index],
      text: textOf(row?.querySelector('a.fl.after') || row).replace(/^[A-Z][.、\s]*/, ''),
      input, row, value, type: input.type, target: input.closest('label') || input, selected: input.checked };
  });
  return [...root.querySelectorAll('.num_option, .num_option_dx')].map((marker, index) => {
    const row = marker.closest('li[qid][qtype]');
    const value = marker.getAttribute('data') || '';
    const label = textOf(marker).toUpperCase();
    const qtype = row?.getAttribute('qtype');
    const type = qtype === '1' ? 'checkbox' : ['0','3'].includes(qtype) ? 'radio' : 'unknown';
    return { id: /^[A-Z]$/.test(label) ? label : LETTERS[index],
      text: textOf(row?.querySelector('a.fl.after')),
      input: null, row, marker, value, type, qtype, target: row,
      selected: marker.classList.contains(type === 'checkbox' ? 'check_answer_dx' : 'check_answer') };
  });
}

function questionType(root) {
  if (blankEditors(root).length) return 'fill';
  const options = optionElements(root);
  if (options.length < 2 || options.length > 26 || options.some(o => !o.target) || new Set(options.map(o => o.value)).size !== options.length) return 'unknown';
  if (options.every(o => o.type === 'checkbox' && /^[A-Z]$/i.test(o.value))) return 'multiple';
  if (!options.every(o => o.type === 'radio')) return 'unknown';
  const values = options.map(o => o.value.toLowerCase());
  if (values.length === 2 && new Set(values).size === 2 && values.every(value => /^(true|false)$/.test(value))) return 'judgment';
  return options.every(o => /^[A-Z]$/i.test(o.value)) ? 'single' : 'unknown';
}

function verifyChoiceAnswer(root, answer) {
  const options = optionElements(root);
  if (options.length < 2 || options.some(o => o.selected !== answer.choices.includes(o.id))) {
    throw new Error('页面选中状态与答案不一致，停止提交');
  }
  if (options.every(o => o.input)) return;
  // 新版页面的选中外观与提交字段必须同时正确；只改 CSS 不算填写成功。
  if (options.some(o => o.row.hasAttribute('aria-checked') && (o.row.getAttribute('aria-checked') === 'true') !== o.selected)) {
    throw new Error('选项无障碍状态与选中状态不一致，停止提交');
  }
  const id = questionId(root);
  const fields = [...root.querySelectorAll('input[type="hidden"]')].filter(input => input.name === `answer${id}`);
  const expected = options.filter(o => answer.choices.includes(o.id)).map(o => o.value);
  if (fields.length !== 1) throw new Error('无法核对页面保存答案的隐藏字段，停止提交');
  const saved = fields[0].value.trim();
  const same = questionType(root) === 'multiple' ? saved.split('').sort().join('') === expected.join('').split('').sort().join('') : saved === expected[0];
  if (!same) throw new Error('页面保存的答案字段与选中答案不一致，停止提交');
}

function extractQuestions() {
  const roots = getQuestionElements();
  if (!roots.length) return { error: "未识别到章节测验题目" };
  const questions = roots.map((root, index) => {
    const options = optionElements(root);
    const type = questionType(root);
    const title = root.querySelector(".Zy_TItle, .newZy_TItle");
    const stem = textOf(title);
    const encryptedTitle = Boolean(title?.matches?.(".font-cxsecret") ||
      title?.querySelector?.(".font-cxsecret") || /[\uE000-\uF8FF]/.test(stem));
    const needsImage = type === "fill" ? encryptedTitle || Boolean(title?.querySelector("img, svg, canvas")) :
      Boolean(root.matches(".font-cxsecret") || root.querySelector(".font-cxsecret, img, svg, canvas"));
    return {
      id: questionId(root, index),
      type,
      stem: needsImage ? "[题干见截图]" : clean(stem).slice(0, 3000),
      needsImage,
      blankCount: blankEditors(root).length,
      options: options.map(({ id, text }) => ({ id, text: needsImage ? "[选项见截图]" : text.slice(0, 1000) }))
    };
  });
  const unsupported = roots.find((root, index) => questions[index].type === "unknown" &&
    root.querySelector("input[name^='tiankongsize']"));
  if (unsupported) return { error: "检测到填空题，但编辑器尚未加载；请等待后重试" };
  const bad = questions.find((question) => question.type === "unknown" || !question.stem ||
    (question.type === "fill" ? question.blankCount < 1 :
      question.options.length < 2 || question.options.some((option) => !option.id || !option.text) ||
      new Set(question.options.map((option) => option.id)).size !== question.options.length));
  if (bad) return { error: `第 ${questions.indexOf(bad) + 1} 题识别不完整（题型 ${bad.type}，选项 ${bad.options.length} 个），请人工检查` };
  if (questions.some((question) => !question.id) || new Set(questions.map((question) => question.id)).size !== questions.length) {
    return { error: "题目缺少稳定编号，停止填写以免答案错位" };
  }
  if (questions.some((question) => /[\uE000-\uF8FF]/.test(question.stem + question.options.map((option) => option.text).join("")))) return { error: "题目含有无法识别的特殊字符" };
  return { questions };
}

function topViewportRect(element) {
  const rect = element.getBoundingClientRect();
  let x = rect.left;
  let y = rect.top;
  let current = window;
  while (current !== current.top) {
    const iframe = current.frameElement;
    if (!iframe) throw new Error("无法定位测验内嵌页面的屏幕位置");
    if (x < 0 || y < 0 || x + rect.width > current.innerWidth || y + rect.height > current.innerHeight) {
      throw new Error("题目被内层窗口截断，无法完整截图");
    }
    const parentRect = iframe.getBoundingClientRect();
    x += parentRect.left + iframe.clientLeft;
    y += parentRect.top + iframe.clientTop;
    current = current.parent;
  }
  return { x, y, width: rect.width, height: rect.height, viewportWidth: current.innerWidth, viewportHeight: current.innerHeight };
}

function aiVisualIdentity(root) {
  try {
    return {
      images: [...root.querySelectorAll('img')].map(img => [img.currentSrc || img.src, img.naturalWidth, img.naturalHeight]),
      svg: [...root.querySelectorAll('svg')].map(svg => svg.outerHTML),
      canvas: [...root.querySelectorAll('canvas')].map(canvas => canvas.toDataURL())
    };
  } catch { throw new Error('题目图像无法核对是否变化，请人工处理'); }
}

async function captureStableViewport(root, guard, box) {
  const signature = value => JSON.stringify(value);
  const expected = signature(box);
  let changed = false, stopped = false, raf;
  // 后台页面不绘制画面，滚动事件会延迟到截图强制绘制时才派发，不能据此判断布局变化；
  // 此时只比较截图前后题目的实际位置。
  const eventsReliable = document.hidden !== true;
  const markChanged = () => { if (eventsReliable) changed = true; };
  const windows = [];
  for (let current = window;; current = current.parent) {
    windows.push(current);
    current.addEventListener('scroll', markChanged, true);
    current.addEventListener('resize', markChanged);
    if (current === current.top) break;
  }
  const check = () => {
    try { if (!root.isConnected || signature(topViewportRect(root)) !== expected) changed = true; }
    catch { changed = true; }
    if (!stopped) raf = requestAnimationFrame(check);
  };
  check();
  try {
    await assertAICommand(guard);
    const shot = await chrome.runtime.sendMessage({ type: 'CAPTURE_TAB', guard, pageHidden: document.hidden === true });
    if (shot?.error) throw new Error(shot.error);
    await assertAICommand(guard);
    if (changed || !root.isConnected || signature(topViewportRect(root)) !== expected) throw new Error('截图期间页面发生滚动或布局变化，请保持页面稳定后重新开始');
    return shot;
  } finally {
    stopped = true;
    cancelAnimationFrame(raf);
    for (const current of windows) {
      current.removeEventListener('scroll', markChanged, true);
      current.removeEventListener('resize', markChanged);
    }
  }
}

function scrollTargetThroughFrames(element) {
  element.scrollIntoView({ block: "center", behavior: "auto" });
  let current = window;
  let rect = element.getBoundingClientRect();
  while (current !== current.top) {
    const iframe = current.frameElement;
    if (!iframe) throw new Error("无法定位测验内嵌页面的屏幕位置");
    const parent = current.parent;
    const frameRect = iframe.getBoundingClientRect();
    const targetCenter = frameRect.top + iframe.clientTop + rect.top + rect.height / 2;
    parent.scrollBy(0, targetCenter - parent.innerHeight / 2);
    const movedFrame = iframe.getBoundingClientRect();
    rect = {
      top: movedFrame.top + iframe.clientTop + rect.top,
      left: movedFrame.left + iframe.clientLeft + rect.left,
      width: rect.width,
      height: rect.height
    };
    current = parent;
  }
}

async function captureQuestion(id, guard) {
  const root = getQuestionElements().find((candidate, index) => questionId(candidate, index) === String(id));
  if (!root) throw new Error(`题目 ${id} 已变化，无法截图`);
  if (questionType(root) === "fill") {
    const title = root.querySelector(".Zy_TItle, .newZy_TItle");
    if (!title) throw new Error(`题目 ${id} 缺少题干，无法截图`);
    return captureElement(title, id, 20, guard);
  }
  return captureElement(root, id, 60, guard);
}

function verifyVideoCaptureLayout(root) {
  // 平台的 tkScroll 可能只显示一部分题干/选项；整块截图并不代表内容完整。
  for (const node of [root.querySelector('.tkItem_title, .ans-videoquiz-title, .question-title, .Zy_TItle'),
    ...aiVideoOptions(root).map(option => option.row)].filter(Boolean)) {
    const rect = node.getBoundingClientRect();
    for (let parent = node.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      if ((/auto|scroll|hidden|clip/.test(style.overflowY) && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) ||
          (/auto|scroll|hidden|clip/.test(style.overflowX) && (rect.left < box.left - 1 || rect.right > box.right + 1))) {
        throw new Error('视频弹题截图不完整：题干或选项被滚动区裁切，请展开题目后重新读取');
      }
    }
  }
}

async function captureVideoQuestion(guard) {
  const root = aiVideoRoot();
  if (!root) throw new Error("视频弹题已消失或结构不完整，无法截图");
  verifyVideoCaptureLayout(root);
  return captureElement(root, videoAIEnvelope().questions[0].id, 60, guard, () => verifyVideoCaptureLayout(root));
}

// 后台标签页的计时器至少 1 秒才触发一次，稳定判断改按采样次数并放宽总时长。
async function captureElement(root, id, minHeight = 60, guard, verifyLayout) {
  const prepared = await chrome.runtime.sendMessage({ type: 'CAPTURE_PREPARE', guard, pageHidden: document.hidden === true });
  if (prepared?.error) throw new Error(prepared.error);
  // 同一轮识题的多张截图共用一个调试连接，由识题流程在全部截图结束后释放（到期也会自动释放）。
  try { return await captureMeasuredElement(root, id, minHeight, guard, verifyLayout); }
  catch (error) {
    // 后台标签页的尺寸变化（如调试提示条）可能要到第一次正式截图时才生效：重新测量位置后再截一次。
    if (document.hidden !== true || !/布局变化|位置未稳定/.test(error?.message || '')) throw error;
    return captureMeasuredElement(root, id, minHeight, guard, verifyLayout);
  }
}

async function captureMeasuredElement(root, id, minHeight, guard, verifyLayout) {
  scrollTargetThroughFrames(root);
  let box;
  let previous;
  let stable = 0;
  let boundsError;
  const deadline = Date.now() + (document.hidden ? 12000 : 3000);
  while (Date.now() < deadline) {
    await wait(150);
    try { box = topViewportRect(root); boundsError = null; }
    catch (error) { boundsError = error; continue; }
    const signature = [box.x, box.y, box.width, box.height, box.viewportWidth, box.viewportHeight].map((value) => Math.round(value)).join(":");
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
    if (stable >= 2) break;
  }
  if (stable < 2 || !box) throw boundsError || new Error(`题目 ${id} 页面位置未稳定，停止识别`);
  if (box.width < 100 || box.height < minHeight || box.x < 0 || box.y < 0 ||
      box.x + box.width > box.viewportWidth || box.y + box.height > box.viewportHeight) {
    throw new Error(`题目 ${id} 未完整显示在屏幕内，停止识别`);
  }
  verifyLayout?.();
  const shot = await captureStableViewport(root, guard, box);
  verifyLayout?.();
  const image = await new Promise((resolve, reject) => {
    const candidate = new Image();
    candidate.onload = () => resolve(candidate);
    candidate.onerror = () => reject(new Error("无法解码题目截图"));
    candidate.src = shot;
  });
  const scaleX = image.naturalWidth / box.viewportWidth;
  const scaleY = image.naturalHeight / box.viewportHeight;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(box.width * scaleX);
  canvas.height = Math.ceil(box.height * scaleY);
  canvas.getContext("2d").drawImage(image, box.x * scaleX, box.y * scaleY,
    canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return { id, image: canvas.toDataURL("image/png") };
}

async function verifyAnswers(answers, guard) {
  const roots = getQuestionElements();
  if (roots.length !== answers.length) throw new Error("填写后题数发生变化，停止提交");
  const byId = new Map(answers.map((answer) => [String(answer.id), answer]));
  for (let index = 0; index < roots.length; index++) {
    await assertAICommand(guard);
    const root = roots[index];
    const id = questionId(root, index);
    if (!id) throw new Error("题目缺少稳定编号，停止核对");
    const answer = byId.get(id);
    if (!answer) throw new Error(`题目 ${id} 无法核对答案`);
    if (questionType(root) === "fill") {
      const result = await chrome.runtime.sendMessage({ type: "VERIFY_BLANKS", questionId: id, blanks: answer.blanks, guard, expected: blankEditorAction(id, [], "snapshot").snapshot });
      if (result?.error) throw new Error(result.error);
      if (result?.verified !== answer.blanks.length) throw new Error(`题目 ${id} 的填空内容未通过核对`);
      continue;
    }
    verifyChoiceAnswer(root, answer);
  }
  return { verified: roots.length };
}

function quizEnvelope() {
  ensureQuizVisible();
  const result = extractQuestions();
  if (result.error) throw new Error(result.error);
  const visual = getQuestionElements().map(root => ({ text: textOf(root.querySelector(".Zy_TItle, .newZy_TItle")),
    options: optionElements(root).map(o => [o.id, o.text, o.value, o.type]), media: aiVisualIdentity(root) }));
  return { ...result, fingerprint: aiHash(JSON.stringify([result.questions, visual])) };
}
