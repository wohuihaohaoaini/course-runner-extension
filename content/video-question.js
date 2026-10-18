// 视频弹题和反馈都限定在实际题块内；常驻空容器、背景层不算弹题。
const VIDEO_QUESTION_SELECTORS = ['.tkTopic', '.tkItem_title', '.ans-videoquiz', 'li.ans-videoquiz-opt',
  '#videoquiz-submit', '#videoquiz-submitting', '#videoquiz-continue', '#spanNot', '#spanNotBackPoint'];
function shownWithSize(element) {
  if (!visible(element)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 20 && rect.height > 20;
}

function videoQuestionSurface() {
  if (!isVideoPage()) return null;
  const roots = [...document.querySelectorAll('.tkTopic, .ans-videoquiz, .ans-timelineobjects')]
    .filter(root => shownWithSize(root) && [...root.querySelectorAll(
      '.tkItem_title, .ans-videoquiz-title, .question-title, li.ans-videoquiz-opt, .num_option, .num_option_dx, #videoquiz-submit, #videoquiz-continue, .ans-videoquiz-continue, #spanHas, #spanNot, #spanNotBack, #spanNotBackPoint, #videoquiz-submitting')].some(visible));
  // .ans-videoquiz > .tkTopic：取包含题干、选项、操作区的最内层完整题块。
  return roots.find(root => !roots.some(other => other !== root && root.contains(other))) || null;
}

const videoQuestionSurfaceVisible = () => Boolean(videoQuestionSurface());

function videoQuestionFeedback() {
  const root = videoQuestionSurface();
  if (!root) return 'closed';
  const shown = selector => [...root.querySelectorAll(selector)].some(visible);
  if (shown('#spanHas') && textOf(root.querySelector('#spanHas'))) return shown('#videoquiz-continue, .ans-videoquiz-continue') ? 'continue' : 'correct';
  if (shown('#spanNot, #spanNotBack, #spanNotBackPoint')) return 'incorrect';
  if (shown('#videoquiz-submitting')) return 'submitting';
  if (shown('#videoquiz-continue, .ans-videoquiz-continue')) return 'continue';
  if (shown('#spanHas') && textOf(root.querySelector('#spanHas'))) return 'correct';
  return 'open';
}

// 仅关闭答题结果提示，不点回看、跳过或答错后的“继续”。AI 关闭时也保留人工作答后的继续功能。
function videoQuestionContinueButton() {
  const root = videoQuestionSurface();
  if (!root || ['incorrect', 'submitting', 'open'].includes(videoQuestionFeedback())) return null;
  const button = [...root.querySelectorAll('#videoquiz-continue, .ans-videoquiz-continue')].find(visible);
  if (button) return button;
  return findButton(/^(继续学习|继续播放|继续)$/, root);
}
