// 可选 AI 流程。调度仍由 0.2 的任务点运行器负责；每次副作用前重新检查上下文。
const AI_COMMANDS = new Set(['READ_QUIZ', 'CAPTURE_QUESTION', 'FILL_QUIZ', 'VERIFY_QUIZ', 'SUBMIT_QUIZ', 'CONFIRM_SUBMIT', 'CONFIRM_TOP_SUBMIT',
  'READ_VIDEO_QUESTION', 'CAPTURE_VIDEO_QUESTION', 'FILL_VIDEO_QUESTION', 'SUBMIT_VIDEO_QUESTION']);
function aiHash(value) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(i); }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
async function aiOptions() {
  const s = await chrome.storage.local.get(['aiEnabled', 'aiVideoEnabled', 'aiQuizEnabled', 'aiRevision', 'autoSubmit', 'videoAnswerMode']);
  return { enabled: s.aiEnabled === true, video: s.aiVideoEnabled !== false, quiz: s.aiQuizEnabled !== false,
    revision: s.aiRevision || 'initial', autoSubmit: s.autoSubmit === true,
    videoMode: ['trial', 'manual'].includes(s.videoAnswerMode) ? s.videoAnswerMode : 'ai' };
}
async function assertAICommand(guard) {
  if (!guard || guard.frameToken !== AI_DOCUMENT) throw new Error('题目页面已变化，旧结果已失效');
  const result = await chrome.runtime.sendMessage({ type: 'AI_VALIDATE', guard });
  if (result?.error) throw new Error(result.error);
  if (!result?.ok) throw new Error('AI 上下文无法核对');
  if (guard.fingerprint) {
    const current = guard.kind === 'video' ? videoAIEnvelope() : quizEnvelope();
    if (current.fingerprint !== guard.fingerprint) throw new Error('题目或选项已变化，停止填写与提交');
  }
}

// 识别失败（网络、超时、解析、读题或核对失败）在提交前自动重试；密钥、授权、结构不支持等无法靠重试解决的直接转人工或跳过。
const AI_RETRY_DELAYS = [5000, 15000];
const AI_FATAL_ERROR = /填写答题接口密钥|截图授权|状态码 40[0-4]|暂不支持|已关闭|已取消|模式已变化|设置已变化/;

const AIFlow = (() => {
  async function enabled(kind) {
    const options = await aiOptions();
    return options.enabled && options[kind];
  }
  function guardFor(task, frame, kind, options) {
    return { runId: task.runId, chapterId: task.activeChapterId, jobId: task.currentJobId,
      frameId: frame.frameId, frameToken: frame.aiDocument, kind, revision: options.revision,
      eventIdentity: kind === 'video' ? frame.videoQuestionIdentity : undefined };
  }
  async function check(tabId, guard) {
    const options = await aiOptions();
    const task = (await chrome.storage.local.get(`task:${tabId}`))[`task:${tabId}`];
    if (!options.enabled || !options[guard.kind] || (guard.kind === 'video' && options.videoMode !== 'ai') || options.revision !== guard.revision || !task || task.state !== 'running' ||
        task.runId !== guard.runId || task.activeChapterId !== guard.chapterId || task.currentJobId !== guard.jobId) {
      throw new Error('AI 已关闭或运行已变化，旧结果已失效');
    }
    const frames = await inspect();
    const main = frames.find(f => f.frameId === 0);
    const target = frames.find(f => f.frameId === guard.frameId);
    if (!target?.active || target.aiDocument !== guard.frameToken || (main?.chapterId && main.chapterId !== guard.chapterId) ||
        frames.some(f => f.captcha || f.face)) throw new Error('课程页面已变化或需要验证，旧结果已失效');
    if (guard.kind === 'video' && guard.fingerprint && target.videoQuestionFingerprint &&
        target.videoQuestionFingerprint !== guard.fingerprint) throw new Error('视频题目已变化，停止使用上一题结果');
  }
  function submissionKey(task, guard) {
    const url = new URL(location.href);
    const course = [url.origin, url.searchParams.get('courseId') || url.searchParams.get('courseid'), url.searchParams.get('clazzid') || url.searchParams.get('clazzId'), url.searchParams.get('cpi')];
    return aiHash(JSON.stringify([course, task.activeChapterId, guard.jobId, guard.kind, guard.fingerprint]));
  }
  async function state(tabId, guard, patch) {
    await check(tabId, guard);
    return saveTask(tabId, patch);
  }
  async function waitForUser(tabId, task, kind, status, ai, extra = {}) {
    const latest = (await chrome.storage.local.get(`task:${tabId}`))[`task:${tabId}`];
    if (latest?.runId !== task.runId || latest?.state !== 'running' || latest.activeChapterId !== task.activeChapterId ||
        latest.currentJobId !== task.currentJobId) return;
    await saveTask(tabId, { phase: 'waiting', waitReason: kind === 'video' ? 'videoQuestion' : 'quiz', ai, status, ...extra });
    if (!ai?.retryAt) notifyUser(kind === 'video' ? 'videoQuestion' : 'quiz', status);
  }
  // 未提交的失败按次数退避重试；返回 true 表示已安排自动重试。
  async function fail(tabId, task, kind, message, ai) {
    const label = kind === 'video' ? '视频弹题' : '章节测验';
    const attempts = (task.aiAttempts || 0) + 1;
    if (ai.stage === 'error' && attempts <= AI_RETRY_DELAYS.length && !AI_FATAL_ERROR.test(message)) {
      const delay = AI_RETRY_DELAYS[attempts - 1];
      await waitForUser(tabId, task, kind, `${label}识别失败：${message}；${delay / 1000} 秒后自动重新识别（第 ${attempts}/${AI_RETRY_DELAYS.length} 次）`,
        { ...ai, retryAt: Date.now() + delay }, { aiAttempts: attempts });
      return true;
    }
    await waitForUser(tabId, task, kind, `${label}需要人工处理：${message}`, ai);
    return false;
  }
  // 到达重试时间后清掉错误状态，让调用方重新走识题流程；未到时间返回 'wait'。
  async function dueRetry(tabId, task, label) {
    if (task.ai?.stage !== 'error' || !task.ai.retryAt) return null;
    if (Date.now() < task.ai.retryAt) return 'wait';
    await saveTask(tabId, { ai: null, phase: 'page', waitReason: null, questionClosedAt: null, questionContinueClickedAt: null,
      status: `正在自动重新识别${label}（第 ${task.aiAttempts || 1}/${AI_RETRY_DELAYS.length} 次重试）` });
    return 'go';
  }
  function quizFrame(ctx, job) {
    const frames = ctx.frames.filter(f => f.active && f.quizPageVisible && f.questionCount > 0);
    return frames.find(f => f.jobId === job.id) || (frames.length === 1 && !frames[0].jobId ? frames[0] : null);
  }
  async function perform(tabId, task, frame, kind) {
    const options = await aiOptions();
    const guard = guardFor(task, frame, kind, options);
    const label = kind === 'video' ? '视频弹题' : '章节测验';
    try {
      await check(tabId, guard);
      const read = await frameCommand(frame.frameId, kind === 'video' ? 'READ_VIDEO_QUESTION' : 'READ_QUIZ', { guard });
      guard.fingerprint = read.fingerprint;
      if (!guard.fingerprint || !read.questions?.length) throw new Error('题目读取不完整');
      const key = submissionKey(task, guard);
      const { aiSubmissionLocks = {} } = await chrome.storage.local.get('aiSubmissionLocks');
      if (aiSubmissionLocks[key]) {
        return waitForUser(tabId, task, kind, `${label}已有提交记录，等待平台结果；不会重复提交`,
          { kind, stage: 'submitted', key, at: aiSubmissionLocks[key].at, frameToken: guard.frameToken, fingerprint: guard.fingerprint });
      }
      await state(tabId, guard, { ai: { kind, stage: 'processing', revision: guard.revision, at: Date.now() }, status: `已识别 ${read.questions.length} 道${label}，正在读取题目` });
      const images = [];
      for (const question of read.questions) if (question.needsImage) {
        await check(tabId, guard);
        images.push(await frameCommand(frame.frameId, kind === 'video' ? 'CAPTURE_VIDEO_QUESTION' : 'CAPTURE_QUESTION', { id: question.id, guard }));
      }
      await state(tabId, guard, { status: `AI 正在分析${label}` });
      const answers = await chrome.runtime.sendMessage({ type: 'ANSWER', questions: read.questions, images, guard });
      if (answers?.error) throw new Error(answers.error);
      await state(tabId, guard, { status: `正在填写并核对${label}` });
      await frameCommand(frame.frameId, kind === 'video' ? 'FILL_VIDEO_QUESTION' : 'FILL_QUIZ', { answers, guard });
      await check(tabId, guard);
      if (kind === 'quiz') await frameCommand(frame.frameId, 'VERIFY_QUIZ', { answers, guard });
      await check(tabId, guard);
      if (kind === 'quiz' && !options.autoSubmit) {
        return waitForUser(tabId, task, kind, '章节测验答案已填写并核对，请检查后手动提交', { kind, stage: 'manual', key });
      }
      const lock = await chrome.runtime.sendMessage({ type: 'AI_CLAIM_SUBMISSION', key, guard });
      if (lock?.error) throw new Error(lock.error);
      if (!lock?.claimed) return waitForUser(tabId, task, kind, `${label}已有提交记录，请核对平台结果`,
        { kind, stage: 'submitted', key, at: lock?.record?.at || Date.now(), frameToken: guard.frameToken, fingerprint: guard.fingerprint });
      await state(tabId, guard, { ai: { kind, stage: 'submitted', key, at: Date.now(), frameToken: guard.frameToken, fingerprint: guard.fingerprint }, status: `正在提交${label}` });
      await frameCommand(frame.frameId, kind === 'video' ? 'SUBMIT_VIDEO_QUESTION' : 'SUBMIT_QUIZ',
        kind === 'video' ? { guard, answers } : { guard });
      await state(tabId, guard, { phase: 'waiting', waitReason: kind === 'video' ? 'videoQuestion' : 'quiz',
        questionClosedAt: null, questionContinueClickedAt: null, questionResumePlayAt: null, questionResultAt: null,
        status: kind === 'video' ? '视频弹题已点击提交，等待平台作答反馈' : `${label}已提交，等待平台确认` });
    } catch (error) {
      const latest = (await chrome.storage.local.get(`task:${tabId}`))[`task:${tabId}`];
      // 已发起提交则保留提交记录，即使响应断开也不能重试提交。
      const ai = latest?.ai?.stage === 'submitted' ? latest.ai : { kind, stage: 'error', revision: guard.revision,
        frameToken: guard.frameToken, fingerprint: guard.fingerprint, eventIdentity: guard.eventIdentity };
      await fail(tabId, latest || task, kind, displayError(error), ai);
    }
  }
  async function handleQuiz(tabId, task, ctx, job) {
    const frame = quizFrame(ctx, job);
    if (!frame) {
      if (!task.jobRevealedAt) {
        await frameCommand(job.frameId, 'REVEAL_JOB', { id: job.id });
        return saveTask(tabId, { jobRevealedAt: Date.now(), status: '正在等待章节测验加载' });
      }
      if (Date.now() - task.jobRevealedAt < 45000) return;
      return waitForUser(tabId, task, 'quiz', '章节测验结构无法识别，请人工处理', { kind: 'quiz', stage: 'error' });
    }
    return perform(tabId, task, frame, 'quiz');
  }
  async function maybeVideo(tabId, task, ctx) {
    if (!ctx.questionFrame) return false;
    const options = await aiOptions();
    if (!options.enabled || !options.video || options.videoMode !== 'ai') return false;
    const surface = ctx.questionFrame;
    const job = ctx.jobs.find(j => j.type === 'video' && j.id === surface.jobId) ||
      ctx.jobs.find(j => j.type === 'video' && mediaFrameFor(j, ctx)?.frameId === surface.frameId);
    if (!job) {
      if (task.waitingSince && Date.now() - task.waitingSince > 20000) return deferVideoChapter(tabId, task, ctx, null, '视频弹题 AI 无法匹配所属任务点');
      await saveTask(tabId, { phase: 'waiting', waitReason: 'videoQuestion', waitingSince: task.waitingSince || Date.now(),
        ai: { kind: 'video', stage: 'error', code: 'unmatched-video', revision: options.revision },
        status: ctx.cardsLoaded ? '视频弹题 AI 已开启，但无法匹配所属视频任务点；请重新读取当前题目或导出日志' :
          '已发现视频弹题，正在等待课程任务点加载，随后进入 AI 识题' });
      return true;
    }
    // 用户从测验切回视频，或点击了另一段视频时，旧任务的 AI 状态不能挡住新弹题。
    if (task.currentJobId !== job.id || (task.ai && task.ai.kind !== 'video')) {
      task = await saveTask(tabId, { ...jobReset(), phase: 'page', waitReason: null, currentJobId: job.id });
    }
    if (task.ai?.code === 'unmatched-video') task = await saveTask(tabId, { ai: null });
    // 两次弹题可能间隔短于轮询周期，期间不一定能观察到“弹层关闭”。
    if (task.ai?.kind === 'video' && ['submitted', 'error'].includes(task.ai.stage) &&
        surface.videoQuestionFeedback === 'open' &&
        ((surface.videoQuestionFingerprint && task.ai.fingerprint && surface.videoQuestionFingerprint !== task.ai.fingerprint) ||
          (task.ai.eventIdentity && surface.videoQuestionIdentity && task.ai.eventIdentity !== surface.videoQuestionIdentity))) {
      task = await saveTask(tabId, { ai: null, aiAttempts: 0, phase: 'page', waitReason: null,
        questionClosedAt: null, questionContinueClickedAt: null, questionResumePlayAt: null, questionResultAt: null });
    }
    if (task.ai?.stage === 'error' && task.ai.revision && task.ai.revision !== options.revision) task = await saveTask(tabId, { ai: null, aiAttempts: 0 });
    // 刷新等原因中断的识题流程，同样按重试次数重新开始。
    if (task.ai?.stage === 'processing' && Date.now() - (task.ai.at || 0) > 45000 &&
        await fail(tabId, task, 'video', '识题流程被刷新或中断', { kind: 'video', stage: 'error', revision: options.revision })) return true;
    const retry = await dueRetry(tabId, task, '视频弹题');
    if (retry === 'wait') return true;
    if (retry === 'go') task = (await chrome.storage.local.get(`task:${tabId}`))[`task:${tabId}`];
    if (task.ai) return false;
    if (!['open', null, undefined].includes(ctx.questionFrame.videoQuestionFeedback)) return false;
    await perform(tabId, task, ctx.questionFrame, 'video');
    return true;
  }
  async function waitingQuiz(tabId, task, ctx) {
    const job = ctx.jobs.find(j => j.id === task.currentJobId);
    if (!job || job.finished) return false;
    const options = await aiOptions();
    // 章节测验不一定计入左侧目录的未完成任务点；AI 开启时不能因为“任务点已完成”
    // 就把它当成做完，否则会离开等待、下一轮又重新填写同一份测验。
    if (ctx.treeTask?.kind === 'complete' && !(options.enabled && options.quiz)) return false;
    if (task.ai?.stage === 'error' && task.ai.revision && task.ai.revision !== options.revision && options.enabled && options.quiz) task = await saveTask(tabId, { ai: null, aiAttempts: 0 });
    if (options.enabled && options.quiz) {
      const retry = await dueRetry(tabId, task, '章节测验');
      if (retry === 'wait') return true;
      if (retry === 'go') task = (await chrome.storage.local.get(`task:${tabId}`))[`task:${tabId}`];
    }
    if (!task.ai && await enabled('quiz')) { await handleQuiz(tabId, task, ctx, job); return true; }
    if (task.ai?.stage === 'processing') {
      await fail(tabId, task, 'quiz', '识题流程被刷新或中断', { kind: 'quiz', stage: 'error', revision: options.revision });
      return true;
    }
    if (task.ai?.stage !== 'submitted') return false;
    const frame = quizFrame(ctx, job);
    const main = ctx.frames.find(f => f.frameId === 0);
    // 确认框可能在测验 iframe 内（旧版/submitBack），也可能在顶层学习页（#workpop）。
    const where = frame?.hasSubmitConfirm ? 'quiz' : main?.topSubmitConfirm ? 'top' : null;
    if (where && options.enabled && options.quiz && options.autoSubmit && !task.ai.confirmedAt) {
      const documentChanged = frame && task.ai.frameToken && frame.aiDocument !== task.ai.frameToken;
      if (where === 'quiz' && (!task.ai.frameToken || documentChanged)) {
        await saveTask(tabId, { status: '测验页面已刷新或变化，请人工核对提交确认；不会重复提交' });
        return true;
      }
      // 顶层弹窗没有题目指纹，只在本次提交后不久、测验文档未变时确认。
      if (where === 'top' && (!task.ai.at || Date.now() - task.ai.at > 60000 || documentChanged)) {
        await saveTask(tabId, { status: '确认提交弹窗与本次提交对不上，请人工核对；不会自动确认' });
        return true;
      }
      const guard = where === 'quiz' ? { ...guardFor(task, frame, 'quiz', options), fingerprint: task.ai.fingerprint } :
        guardFor(task, main, 'quiz', options);
      try {
        const claim = await chrome.runtime.sendMessage({ type: 'AI_CLAIM_SUBMISSION', key: task.ai.key, confirmation: true, guard });
        if (claim?.error) throw new Error(claim.error);
        if (claim?.claimed) {
          await check(tabId, guard);
          await frameCommand(guard.frameId, where === 'quiz' ? 'CONFIRM_SUBMIT' : 'CONFIRM_TOP_SUBMIT', { guard });
          await saveTask(tabId, { ai: { ...task.ai, confirmedAt: Date.now(), confirmWhere: where }, status: '已确认提交，等待平台完成标记' });
        }
      } catch (error) { await saveTask(tabId, { status: displayError(error) }); }
    }
    if (Date.now() - task.ai.at > 30000) await saveTask(tabId, { status: '测验提交状态尚未确认，请人工核对；不会重复提交' });
    return true;
  }
  return { enabled, handleQuiz, maybeVideo, waitingQuiz };
})();
