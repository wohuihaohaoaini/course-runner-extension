// .tkTopic_title 是题型；.tkItem_title 才是当前播放器的真实题干。
const aiVideoRoot = () => videoQuestionSurface();
const videoQuestionAnchors = new WeakMap();
const videoSurfaceAnchors = new WeakMap();

function aiVideoOptions(root) {
  if (!root) return [];
  if (root.querySelector('.num_option, .num_option_dx')) return optionElements(root);
  const rows = [...root.querySelectorAll('li.ans-videoquiz-opt')].filter(visible);
  const inputs = rows.length ? rows.map(row => row.querySelector('input[type="radio"], input[type="checkbox"]')) :
    [...root.querySelectorAll('input[type="radio"], input[type="checkbox"]')].filter(input => visible(input.closest('label') || input));
  return inputs.map((input, index) => {
    const row = rows[index] || input?.closest('label') || input?.parentElement;
    const text = textOf(row);
    const letter = text.match(/^([A-Z])[.、．\s]/i)?.[1]?.toUpperCase();
    return { id: letter || LETTERS[index], input, row, type: input?.type,
      target: input?.closest('label') || input, selected: input?.checked,
      text: text.replace(/^[A-Z][.、．\s]+/i, '') };
  });
}

function videoEventIdentity(root, content, anchors = videoQuestionAnchors) {
  const attrs = ['data-question-id', 'data-event-id', 'data-resource-id', 'data-time', 'data-start-time'];
  const identity = [];
  for (const node of [root, root.closest('.ans-videoquiz')].filter(Boolean)) {
    for (const attr of attrs) if (node.hasAttribute(attr)) identity.push([attr, node.getAttribute(attr)]);
  }
  const video = currentVideo();
  // 没有公开题号时以暂停时间点区分重复题干。锁住本次时间，避免极小的时间抖动改变指纹。
  const time = video && Number.isFinite(video.currentTime) ? video.currentTime : null;
  let anchor = anchors.get(root);
  if (!anchor || anchor.content !== content || (video?.paused && time !== null && Math.abs(time - anchor.time) > 0.2)) {
    anchor = { content, time: time === null ? null : Math.round(time * 10) / 10 };
    anchors.set(root, anchor);
  }
  return [...identity, ['time', anchor.time]];
}

// 即使选项结构不受支持，也记录匿名事件身份，使下一道题不受上一题读题错误阻挡。
function videoQuestionIdentity() {
  const root = aiVideoRoot();
  if (!root) return null;
  const title = root.querySelector('.tkItem_title, .ans-videoquiz-title, .question-title, .Zy_TItle');
  const content = JSON.stringify([textOf(title), [...root.querySelectorAll('li.ans-videoquiz-opt, li[qid], label')].map(textOf)]);
  return aiHash(JSON.stringify([content, videoEventIdentity(root, content, videoSurfaceAnchors)]));
}

function videoAIEnvelope() {
  const root = aiVideoRoot();
  const options = aiVideoOptions(root);
  if (!root || options.length < 2 || options.length > 26 || options.some(o => !o.target || !o.row || !visible(o.row) || o.input?.disabled) ||
      new Set(options.map(o => o.id)).size !== options.length ||
      !options.every(o => o.type === options[0].type) || !['radio', 'checkbox'].includes(options[0].type)) {
    throw new Error('视频弹题读题失败：题型或选项结构暂不支持，请人工处理');
  }
  const title = root.querySelector('.tkItem_title, .ans-videoquiz-title, .question-title, .Zy_TItle');
  const stem = textOf(title).slice(0, 3000);
  const needsImage = Boolean(root.matches('.font-cxsecret') || root.querySelector('.font-cxsecret, img, canvas, svg') ||
    /[\uE000-\uF8FF]/.test(stem + options.map(o => o.text).join('')));
  if ((!stem && !title?.querySelector('img, canvas, svg')) || options.some(o => !o.text && !o.row.querySelector('img, canvas, svg'))) {
    throw new Error('视频弹题读题失败：题干或选项为空，请人工处理');
  }
  const kind = textOf(root.querySelector('.tkTopic_title'));
  const type = options[0].type === 'checkbox' ? 'multiple' : options.length === 2 && /判断|是非/.test(kind) ? 'judgment' : 'single';
  // 原生 input.value 在部分播放器中是 isRight（多项可相同），既不是选项编号，也不能作为 AI 答案来源。
  const content = JSON.stringify([stem, type, options.map(o => [o.id, o.text, o.type, o.input?.name, o.marker?.getAttribute('data')]), aiVisualIdentity(root)]);
  const fingerprint = aiHash(JSON.stringify([content, videoEventIdentity(root, content)]));
  const question = { id: `video-${fingerprint}`, type, needsImage, stem: needsImage ? '[题干见截图]' : stem,
    options: options.map(o => ({ id: o.id, text: needsImage ? '[选项见截图]' : o.text })) };
  return { questions: [question], fingerprint };
}

function aiVideoSubmitButton() {
  const root = aiVideoRoot();
  if (!root || videoQuestionFeedback() !== 'open') return null;
  const button = root.querySelector('#videoquiz-submit');
  if (visible(button) && !button.disabled) return button;
  return findButton(/^(提交|提交答案|确定)$/, root);
}

function verifyAIVideoSelection(answer) {
  const root = aiVideoRoot();
  const options = aiVideoOptions(root);
  if (!options.length || options.some(o => o.selected !== answer.choices.includes(o.id))) throw new Error('视频弹题选中状态核对失败，停止提交');
  // 当前播放器直接读取 input.checked；新版自定义控件还必须核对隐藏的 answer<qid>。
  if (options.every(o => o.input)) return;
  const ids = new Set(options.map(o => o.row.getAttribute('qid')).filter(Boolean));
  if (ids.size !== 1) throw new Error('视频弹题缺少可核对的保存字段，停止提交');
  const id = [...ids][0];
  const fields = [...root.querySelectorAll('input[type="hidden"]')].filter(field => field.name === `answer${id}`);
  const expected = options.filter(o => answer.choices.includes(o.id)).map(o => o.value);
  const saved = fields[0]?.value?.trim();
  const matches = options[0].type === 'checkbox' ? saved?.split('').sort().join('') === expected.join('').split('').sort().join('') : saved === expected[0];
  if (fields.length !== 1 || !matches || options.some(o => o.row.hasAttribute('aria-checked') &&
      (o.row.getAttribute('aria-checked') === 'true') !== o.selected)) throw new Error('视频弹题保存答案与选中状态不一致，停止提交');
}

async function fillAIVideoQuestion(answer, guard) {
  const read = videoAIEnvelope();
  const options = aiVideoOptions(aiVideoRoot());
  if (!answer || (answer.id && answer.id !== read.questions[0].id) || !Array.isArray(answer.choices) || !answer.choices.length ||
      new Set(answer.choices).size !== answer.choices.length || answer.choices.some(c => !options.some(o => o.id === c)) ||
      (options[0].type === 'radio' && answer.choices.length !== 1)) throw new Error('视频弹题答案与选项不匹配');
  for (const option of options) {
    await assertAICommand(guard);
    if (!option.row.isConnected) throw new Error('视频弹题已重新加载，停止填写');
    const selected = aiVideoOptions(aiVideoRoot()).find(o => o.id === option.id)?.selected;
    if (selected !== answer.choices.includes(option.id) && (option.type !== 'radio' || answer.choices.includes(option.id))) {
      pageClick(option.target);
      await wait(100);
    }
  }
  await wait(350);
  await assertAICommand(guard);
  verifyAIVideoSelection(answer);
  return { filled: true };
}
