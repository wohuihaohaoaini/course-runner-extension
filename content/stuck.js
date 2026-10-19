// 等待用户处理的统一兜底：运行器进入 waiting 后，同一个任务点长时间没有解决（截图没授权、后台截图做不到、
// 测验没做、视频弹题没答、视频一直暂停……），把它记入“待你处理”并跳到下一个任务点，不在原地一直等。
//
// - 计时从本任务点第一次进入 waiting 开始，中途自动重试、前后台切换不重新计时；
//   等待被解决（leaveWaiting）或换了任务点（jobReset）时清零。
// - 验证码、人脸识别会挡住整个平台，跳到下一个任务点也一样要做，所以一直等用户处理。
// - 用户自己选了“等我做”的情况（测验等待模式、视频弹题手动、AI 填好等手动提交）给更长时间。
// - 跳过不修改平台完成标记；用户之后补做完成，待办会在下次读到完成标记时自动去掉。
const STUCK_LIMIT_MS = 3 * 60 * 1000;
const STUCK_MANUAL_LIMIT_MS = 10 * 60 * 1000;
const STUCK_REASONS = {
  quiz: '章节测验',
  videoQuestion: '视频弹题',
  background: '后台播放没有进度',
  paused: '视频一直暂停'
};

const StuckGuard = (() => {
  const key = (task) => `${task.activeChapterId || ''}:${task.currentJobId || ''}`;

  async function manualChoice(task, ctx) {
    if (task.waitReason === 'quiz') {
      if (task.ai?.stage === 'manual') return true;
      return !ctx.aiQuiz && (await settings()).quizMode === 'wait';
    }
    if (task.waitReason === 'videoQuestion') return (await aiOptions()).videoMode === 'manual';
    return false;
  }

  async function limitFor(task, ctx) {
    return await manualChoice(task, ctx) ? STUCK_MANUAL_LIMIT_MS : STUCK_LIMIT_MS;
  }

  // 返回 true 表示本轮已跳过当前任务点，运行器不再继续处理。
  async function check(tabId, task, ctx) {
    if (task.phase !== 'waiting' || !STUCK_REASONS[task.waitReason]) return false;
    const limit = await limitFor(task, ctx);
    if (task.stuck?.key !== key(task)) {
      await saveTask(tabId, { stuck: { key: key(task), since: Date.now(), until: Date.now() + limit } });
      return false;
    }
    if (task.stuck.until !== task.stuck.since + limit) {
      // 设置在等待中途改变（例如关掉 AI 改为手动），按新时长重算截止时间。
      task = await saveTask(tabId, { stuck: { ...task.stuck, until: task.stuck.since + limit } });
    }
    if (Date.now() < task.stuck.until) return false;
    await skip(tabId, task, ctx, Math.round(limit / 60000));
    return true;
  }

  async function skip(tabId, task, ctx, minutes) {
    const reason = `${STUCK_REASONS[task.waitReason]}等待 ${minutes} 分钟仍未解决`;
    const job = ctx.jobs.find((item) => item.id === task.currentJobId);
    // 读不到所属任务点（例如弹题匹配不到视频）时没有“下一个任务点”可去，沿用视频换节兜底。
    if (!job) return deferVideoChapter(tabId, task, ctx, null, reason);
    await chrome.runtime.sendMessage({ type: 'CANCEL_AI' }).catch(() => {});
    if (job.type === 'video' || job.type === 'audio') {
      const media = mediaFrameFor(job, ctx);
      if (media) await frameCommand(media.frameId, 'PAUSE_MEDIA', { frameToken: media.aiDocument }).catch(() => {});
    }
    const status = `${jobLabel(job)}${reason}，已记入待办，先做下一个任务点`;
    await skipJob(tabId, task, ctx, job, reason, status, { aiTried: job.type === 'quiz' && ctx.aiQuiz });
    notifyUser('skipped', status);
  }

  return { check, limitFor };
})();
