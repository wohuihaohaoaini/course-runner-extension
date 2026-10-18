// 单选顺序试答只使用选项和页面作答反馈；不调用 AI，也不读取隐藏的正确答案。
function videoTrialEnvelope() {
  const root = aiVideoRoot(), options = aiVideoOptions(root);
  if (!root || options.length < 2 || options.length > 4 || options.some(o => o.type !== 'radio' || o.input?.disabled || !visible(o.row)) ||
      /判断|是非/.test(textOf(root.querySelector('.tkTopic_title'))) || new Set(options.map(o => o.id)).size !== options.length) {
    throw new Error('顺序试答仅支持可重选的二至四项单选题');
  }
  const fingerprint = aiHash(JSON.stringify([videoQuestionIdentity(), options.map(o => [o.id, o.text, o.type]), aiVisualIdentity(root)]));
  const submit = root.querySelector('#videoquiz-submit');
  return { fingerprint, choices: options.map(o => o.id), type: 'single',
    canRetry: visible(submit) && !submit.disabled && !visible(root.querySelector('#knowledgeBack')) &&
      !visible(root.querySelector('#spanNotBack')) };
}

let trialReceipt = null;
function videoTrialFeedback() {
  if (!trialReceipt) return null;
  return { token: trialReceipt.token, status: trialReceipt.status };
}
async function assertVideoTrialCommand(guard) {
  if (!guard || guard.frameToken !== AI_DOCUMENT) throw new Error('播放器已变化，旧试答已失效');
  const result = await chrome.runtime.sendMessage({ type: 'VIDEO_TRIAL_VALIDATE', guard });
  if (!result?.ok || result.error) throw new Error(result?.error || '顺序试答上下文无法核对');
  if (guard.fingerprint && videoTrialEnvelope().fingerprint !== guard.fingerprint) throw new Error('题目已变化，停止试答');
}
async function submitVideoTrial({ choice, token, guard }) {
  await assertVideoTrialCommand(guard);
  const read = videoTrialEnvelope();
  if (!token || !read.canRetry || !['open', 'incorrect'].includes(videoQuestionFeedback()) || !read.choices.includes(choice)) {
    throw new Error('当前题目不允许继续试答');
  }
  const root = aiVideoRoot(), option = aiVideoOptions(root).find(o => o.id === choice);
  if (!option.selected) option.target.click();
  await wait(100);
  await assertVideoTrialCommand(guard);
  verifyAIVideoSelection({ choices: [choice] });
  const button = root.querySelector('#videoquiz-submit');
  if (!videoTrialEnvelope().canRetry) throw new Error('提交按钮已变化，停止试答');
  trialReceipt?.observer?.disconnect();
  // 当前错误已经被运行器确认并记入 attempted。清理上一轮的可见错误，
  // 平台本次再显示它时才形成新的反馈；网络失败只恢复按钮不会误判为答错。
  for (const hint of root.querySelectorAll('#spanNot, #spanNotBack, #spanNotBackPoint')) {
    if (visible(hint)) hint.style.display = 'none';
  }
  // A 的错误提示可能一直留在页面。只有本次提交经历“提交中→响应结束”，
  // 或出现新的正确提示，才把反馈归到当前选项；旧错误不能推动下一项。
  const receipt = { token, status: 'pending', busy: false };
  const observe = (records = []) => {
    const freshError = records.some(record => {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      return Boolean(element?.closest('#spanNot, #spanNotBack, #spanNotBackPoint'));
    });
    if (freshError) receipt.errorUpdated = true;
    if (!root.isConnected || !videoQuestionSurfaceVisible()) { receipt.observer.disconnect(); return; }
    const feedback = videoQuestionFeedback();
    const submitting = visible(root.querySelector('#videoquiz-submitting'));
    if (submitting || !visible(button)) receipt.busy = true;
    if (submitting) return;
    if (feedback === 'continue' || feedback === 'correct') receipt.status = 'correct';
    else if (receipt.busy && receipt.errorUpdated && visible(button) && feedback === 'incorrect') receipt.status = 'incorrect';
    else if (receipt.busy && receipt.errorUpdated && feedback === 'incorrect' && !visible(button)) receipt.status = 'blocked';
    if (receipt.status !== 'pending') receipt.observer.disconnect();
  };
  receipt.observer = new MutationObserver(observe);
  trialReceipt = receipt;
  receipt.observer.observe(root, { subtree: true, attributes: true, childList: true, characterData: true });
  button.click();
  observe();
  return { clicked: true };
}

const VideoTrialFlow = (() => {
  async function maybeVideo(tabId, task, ctx) {
    const options = await aiOptions();
    if (options.videoMode !== 'trial' || !ctx.questionFrame) return false;
    const frame = ctx.questionFrame;
    const job = ctx.jobs.find(j => j.type === 'video' && j.id === frame.jobId) ||
      ctx.jobs.find(j => j.type === 'video' && mediaFrameFor(j, ctx)?.frameId === frame.frameId);
    if (!job) {
      if (!task.waitingSince) await enterWaiting(tabId, task, 'videoQuestion');
      else if (Date.now() - task.waitingSince > 20000) await deferVideoChapter(tabId, task, ctx, null, '弹题无法匹配所属视频任务点');
      return true;
    }
    if (task.currentJobId !== job.id) task = await saveTask(tabId, { ...jobReset(), currentJobId: job.id });
    const guard = { runId: task.runId, chapterId: task.activeChapterId, jobId: job.id,
      frameId: frame.frameId, frameToken: frame.aiDocument, kind: 'video', revision: options.revision };
    let trial = task.videoTrial;
    if (trial && trial.frameToken !== frame.aiDocument) return deferVideoChapter(tabId, task, ctx, job, '弹题提交后播放器刷新，无法核对本次结果');
    // 同一文档里确认出现另一道题时，才允许重新从 A 开始。
    if (trial && frame.videoTrialFingerprint && trial.fingerprint !== frame.videoTrialFingerprint) trial = null;
    if (trial) {
      const receipt = frame.videoTrialResult;
      if (receipt?.token === trial.token && receipt.status === 'correct') return false;
      if (receipt?.token !== trial.token || receipt.status === 'pending') {
        if (Date.now() - trial.at > 30000) await deferVideoChapter(tabId, task, ctx, job, '视频弹题提交后未返回明确结果');
        return true;
      }
      if (receipt.status === 'blocked' || !frame.videoTrialCanRetry) return deferVideoChapter(tabId, task, ctx, job, '答错后平台要求回看或不允许重选');
      if (receipt.status !== 'incorrect') return true;
    } else if (!['open', 'incorrect'].includes(frame.videoQuestionFeedback)) return false;
    try {
      const read = await frameCommand(frame.frameId, 'READ_VIDEO_TRIAL', { guard });
      guard.fingerprint = read.fingerprint;
      if (!read.canRetry || read.type !== 'single') throw new Error('平台未提供可重选的单选题');
      const attempted = trial?.attempted || [];
      const choice = read.choices.find(id => !attempted.includes(id));
      if (!choice) return deferVideoChapter(tabId, task, ctx, job, '单选题所有选项均已试过，平台仍未确认正确');
      const token = `${Date.now()}:${Math.random()}`;
      await ensureRunning(tabId);
      // 先落盘再点击，刷新或消息中断也不会再次提交同一选项。
      await saveTask(tabId, { phase: 'waiting', waitReason: 'videoQuestion', waitingSince: task.waitingSince || Date.now(),
        videoTrial: { fingerprint: read.fingerprint, frameToken: frame.aiDocument, attempted: [...attempted, choice], token, at: Date.now() },
        questionClosedAt: null, questionContinueClickedAt: null, questionResultAt: null, status: `视频单选顺序试答：正在尝试第 ${attempted.length + 1} 个选项，等待本次反馈` });
      await frameCommand(frame.frameId, 'SUBMIT_VIDEO_TRIAL', { choice, token, guard });
    } catch (error) {
      const latest = (await chrome.storage.local.get(`task:${tabId}`))[`task:${tabId}`];
      if (latest?.state !== 'running' || latest?.runId !== task.runId || (await aiOptions()).videoMode !== 'trial') return true;
      const fresh = summarizeFrames(await inspect(), latest);
      if (attentionReason(fresh) !== 'videoQuestion' || fresh.main?.chapterId !== task.activeChapterId ||
          fresh.questionFrame?.aiDocument !== frame.aiDocument) return true;
      await deferVideoChapter(tabId, latest, fresh, job, displayError(error));
    }
    return true;
  }
  return { maybeVideo };
})();
