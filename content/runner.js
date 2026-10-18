// 运行器：只在顶层学习页 / 目录页运行，每 3 秒执行一次 tick。
// 任务状态保存在 chrome.storage.local 的 task:<tabId>，phase 字段决定本轮交给哪个阶段处理函数。
//
// 阶段一览（0.2.0）：
//   directory → enteringChapter → page ⇄ waiting → switchingChapter → page ...
//   page：读本页任务点清单，逐个处理未完成的（视频 / 音频 / 文档），测验按设置跳过或等用户做；
//         本标签做完换下一个标签，整节做完按跳转模式换节。
//   waiting：视频弹题、人脸识别、验证码、测验、视频被未知原因暂停时等用户处理，处理完自动回到 page。
//   returningDirectory：读不到左侧目录时，退回课程目录页找下一节（0.1.x 的做法，作为兜底）。

let loopActive = false;
let cycleActive = false;
let lastDiagnosticSnapshotAt = 0;
const LOG_LIMIT = 40;
const TODO_LIMIT = 100;

async function saveTask(tabId, patch) {
  const key = `task:${tabId}`;
  const task = (await chrome.storage.local.get(key))[key] || {};
  const next = { ...task, ...patch, updatedAt: Date.now() };
  // 状态文字变化时记一行日志，供页面悬浮面板显示。
  if (patch.status && patch.status !== task.status) {
    next.log = [...(task.log || []), { at: Date.now(), text: patch.status }].slice(-LOG_LIMIT);
  }
  await chrome.storage.local.set({ [key]: next });
  if (next.phase !== task.phase || next.state !== task.state) {
    recordDiagnostic("state", { phase: next.phase, state: next.state });
  }
  return next;
}

async function frameCommand(frameId, command, data) {
  try {
    const result = await chrome.runtime.sendMessage({ type: "COMMAND_FRAME", frameId, command, data });
    if (result?.error) throw new Error(result.error);
    recordDiagnostic("command", { command, ok: true });
    return result;
  } catch (error) {
    recordDiagnostic("command", { command, ok: false });
    throw error;
  }
}

async function inspect() {
  const result = await chrome.runtime.sendMessage({ type: "INSPECT_FRAMES" });
  if (result?.error) throw new Error(result.error);
  return result || [];
}

async function settings() {
  const stored = await chrome.storage.local.get(["jumpMode", "quizMode"]);
  return {
    jumpMode: stored.jumpMode === "stop" ? "stop" : "unfinished",
    quizMode: stored.quizMode === "wait" ? "wait" : "skip"
  };
}

function notifyUser(reason, message) {
  try {
    return chrome.runtime.sendMessage({ type: "NOTIFY", reason, message }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

// ---- 待你处理清单（借鉴“学习通任务一览”）：插件跳过的测验、没能完成的任务点 ----
function chapterUrl(id) {
  if (!isRunnerPage() || !id) return null;
  const url = new URL(location.href);
  url.searchParams.set("chapterId", id);
  return url.href;
}

async function addTodo(chapter, job, reason) {
  const { todos } = await chrome.storage.local.get("todos");
  const list = Array.isArray(todos) ? todos : [];
  const key = `${chapter?.id || ""}:${job.id}`;
  if (list.some((item) => item.key === key)) return;
  list.push({ key, chapterId: chapter?.id || null, chapterName: chapter?.name || "", jobName: job.name || "",
    type: job.type, reason, url: chapterUrl(chapter?.id), at: Date.now() });
  await chrome.storage.local.set({ todos: list.slice(-TODO_LIMIT) });
}

// 平台已确认完成的任务点（例如用户补做了测验）从清单里去掉，避免结束时报出早已做完的待办。
async function pruneTodos(ctx) {
  if (!ctx.chapter?.id) return;
  const done = new Set(ctx.jobs.filter((job) => job.isJob && job.finished).map((job) => `${ctx.chapter.id}:${job.id}`));
  if (!done.size) return;
  const { todos } = await chrome.storage.local.get("todos");
  if (!Array.isArray(todos)) return;
  const kept = todos.filter((item) => !done.has(item.key));
  if (kept.length !== todos.length) await chrome.storage.local.set({ todos: kept });
}

// ---- 计时字段 ----
function jobReset() {
  return {
    ai: null, aiAttempts: 0, captureRetries: 0, videoTrial: null, waitingSince: null, jobStartedAt: Date.now(), lastVideoTime: 0, lastProgressAt: null, videoEndedAt: null, playRetries: 0,
    initialPlayAttemptedAt: null, initialPlayWaitingAt: null, jobRevealedAt: null, mediaReloadedAt: null,
    documentAtBottomAt: null, questionContinueClickedAt: null, questionClosedAt: null,
    questionResumeTime: null, questionResumePlayAt: null, questionResultAt: null
  };
}

function chapterReset(id, tabs = []) {
  return {
    ...jobReset(), phase: "page", activeChapterId: id, currentJobId: null, skippedJobs: [],
    visitedTabs: tabs.filter((tab) => tab.active).map((tab) => tab.index),
    tabOpenedAt: Date.now(), chapterEnteredAt: Date.now(), waitReason: null, notifiedKey: null,
    targetChapterId: null, switchStartedAt: null
  };
}

const JOB_LABEL = { video: "视频", audio: "音频", document: "文档", quiz: "章节测验", book: "阅读", link: "链接", other: "任务点" };
const jobLabel = (job) => `${JOB_LABEL[job.type] || "任务点"}${job.name ? `「${job.name}」` : ""}`;

function summarizeFrames(frames, task, aiQuiz = false) {
  const main = frames.find((frame) => frame.frameId === 0);
  const cards = frames.filter((frame) => frame.active && Array.isArray(frame.jobs));
  const jobs = cards.flatMap((frame) => frame.jobs.map((job) => ({ ...job, frameId: frame.frameId })));
  const chapter = (main?.catalog || []).find((item) => item.id === main?.chapterId) || (main?.chapterId ? { id: main.chapterId, name: "" } : null);
  const skipped = task.skippedJobs || [];
  return {
    frames,
    main,
    chapter,
    cardsLoaded: cards.length > 0,
    jobs,
    pending: jobs.filter((job) => job.isJob && !job.finished && !skipped.includes(job.id)),
    media: frames.filter((frame) => frame.active && frame.mediaPage),
    questionFrame: frames.find(frame => frame.active && frame.videoQuestionSurface && frame.jobId === task.currentJobId) ||
      frames.find(frame => frame.active && frame.videoQuestionSurface),
    treeTask: main?.treeTask,
    aiQuiz
  };
}

// 左侧目录的“未完成数”通常只统计任务点。有的课程章节测验不是任务点，
// 视频做完后平台已显示本节完成，测验标签却还没打开。AI 识题开启时仍要进去看一遍，
// 关闭时保持原来的“跳过”行为。
function unvisitedQuizTabs(ctx, task) {
  const visited = task.visitedTabs || [];
  return (ctx.main?.tabs || []).filter((tab) =>
    tab.kind === "quiz" && !tab.active && !visited.includes(tab.index));
}

// 本页任务点清单的精简版，存进任务状态给悬浮面板显示。
function panelJobs(ctx, task) {
  const skipped = task.skippedJobs || [];
  return ctx.jobs.filter((job) => job.isJob).map((job) => ({
    name: job.name, type: job.type,
    state: job.finished ? "done" : skipped.includes(job.id) ? "skipped" : job.id === task.currentJobId ? "current" : "pending"
  }));
}

// ---------------------------------------------------------------------------
// 导航：课程目录页 → 学习页，以及读不到左侧目录时的兜底。
// ---------------------------------------------------------------------------

async function returnToDirectory(tabId, task, status) {
  const url = task.directoryUrl || courseDirectoryUrl();
  if (!url) throw new Error("无法定位当前课程目录，停止自动跳转");
  await ensureRunning(tabId);
  await saveTask(tabId, {
    phase: "returningDirectory", lastProcessedChapterId: task.activeChapterId || chapterId(),
    returnStartedAt: Date.now(), directoryRefreshCount: 0, status
  });
  await ensureRunning(tabId);
  location.assign(url);
}

async function reloadDirectory(tabId, task, status) {
  await saveTask(tabId, {
    returnStartedAt: Date.now(), directoryRefreshCount: (task.directoryRefreshCount || 0) + 1, status
  });
  await ensureRunning(tabId);
  location.reload();
}

async function finishRun(tabId, status) {
  const { todos } = await chrome.storage.local.get("todos");
  const count = Array.isArray(todos) ? todos.length : 0;
  const message = count ? `${status}；还有 ${count} 项等你处理，见“待你处理”清单` : status;
  await saveTask(tabId, { state: "completed", status: message });
  notifyUser("done", message);
}

const NAVIGATION_PHASES = {
  async returningDirectory(tabId, task) {
    if (!DIRECTORY_URL.test(location.pathname)) {
      if (Date.now() - task.returnStartedAt > 20000) throw new Error("返回课程目录超时，请检查页面");
      return;
    }
    if (courseDirectoryUrl() !== task.directoryUrl) throw new Error("进入了另一门课程，已停止以免错用进度");
    const candidates = directoryCandidates();
    if (!candidates) throw new Error("当前页面不是预期的课程目录");
    const deferred = [...new Set([...(task.deferredChapters || []), ...(task.processedChapters || [])])];
    const target = directoryTarget(deferred);
    if (target && task.lastProcessedChapterId && target.chapter === task.lastProcessedChapterId) {
      if (Date.now() - task.returnStartedAt < 10000) return;
      if ((task.directoryRefreshCount || 0) < 2) return reloadDirectory(tabId, task, "目录仍显示本节未完成，正在刷新核对");
      deferred.push(target.chapter);
      await saveTask(tabId, { deferredChapters: deferred, status: "本节仍有未完成任务点，先处理其他小节" });
    }
    const nextTarget = directoryTarget(deferred);
    if (nextTarget) {
      return saveTask(tabId, { phase: "directory", targetChapterId: nextTarget.chapter,
        status: "已从目录找到下一节未完成课程" });
    }
    const { rows, locked, unknown } = directoryStatus();
    if (!rows) {
      if (Date.now() - task.returnStartedAt < 20000) return saveTask(tabId, { status: "正在等待课程目录加载" });
      throw new Error("课程目录长时间未加载，无法核对完成情况");
    }
    if (unknown) return saveTask(tabId, { state: "paused", status: "课程目录有未识别的小节状态，请导出日志核对" });
    if (locked) {
      if ((task.directoryRefreshCount || 0) < 2) return reloadDirectory(tabId, task, "目录暂时没有可做小节，正在刷新检查是否解锁");
      return saveTask(tabId, { state: "paused", status: "当前没有可做的小节，但课程目录仍有锁定内容" });
    }
    const scan = lastDirectoryScan;
    if (scan.rows > 0 && scan.evaluated < scan.rows) {
      // 读不到完成标记时不能宣布“全部完成”，否则会把未完成的小节误报为已完成。
      return saveTask(tabId, { state: "paused",
        status: `课程目录有 ${scan.rows - scan.evaluated} 个小节读不到完成标记，无法确认是否已完成；请导出日志核对` });
    }
    return finishRun(tabId, "课程目录里能做的小节都处理完了");
  },

  async directory(tabId, task) {
    const excluded = [...(task.deferredChapters || []), ...(task.processedChapters || [])];
    const target = directoryTarget(excluded);
    if (!target) return saveTask(tabId, { phase: "returningDirectory", returnStartedAt: Date.now() });
    if (target.chapter !== task.targetChapterId) {
      return saveTask(tabId, { targetChapterId: target.chapter, status: "目录进度已更新，正在重新选择未完成小节" });
    }
    await saveTask(tabId, { phase: "enteringChapter", directoryEnteredAt: Date.now(), status: "正在进入未完成小节" });
    await ensureRunning(tabId);
    if (task.studyView && target.link.href) target.link.href = preserveStudyView(target.link.href, task.studyView);
    target.link.click();
  },

  async enteringChapter(tabId, task) {
    if (!isRunnerPage()) {
      if (Date.now() - task.directoryEnteredAt > 20000) throw new Error("点击目录后未进入学习页，请人工检查");
      return;
    }
    const frames = await inspect();
    const main = frames.find((frame) => frame.frameId === 0);
    return enterChapter(tabId, task, main?.chapterId || chapterId(), main?.tabs, "已进入小节，正在读取任务点");
  }
};

// 进入一个小节。闯关模式下同一节反复进入 3 次还没完成，多半是测验没做把后面锁住了，停下说明。
async function enterChapter(tabId, task, id, tabs, status) {
  const entries = { ...(task.chapterEntries || {}) };
  entries[id] = (entries[id] || 0) + 1;
  if (entries[id] > 3) {
    return saveTask(tabId, { state: "paused", chapterEntries: entries,
      status: "同一小节已反复进入 3 次仍未完成，可能是闯关模式下测验没做导致后面锁住；请先完成本节测验再开始" });
  }
  return saveTask(tabId, { ...chapterReset(id, tabs), studyView: task.studyView || studyViewContext(), chapterEntries: entries, status });
}

// 整节处理完：按跳转模式换节。优先用左侧目录在学习页内换节（借鉴 OCS），读不到再回课程目录页。
async function chapterDone(tabId, task, ctx, reason) {
  const { main } = ctx;
  const current = task.activeChapterId || main?.chapterId;
  const processed = [...new Set([...(task.processedChapters || []), current].filter(Boolean))];
  await saveTask(tabId, { processedChapters: processed, status: reason });
  const { jumpMode } = await settings();
  if (jumpMode === "stop") return finishRun(tabId, `${reason}（跳转模式：做完本节后停下）`);
  const catalog = main?.catalog || [];
  // 左侧目录读不到任何未完成数时不能靠它换节（否则第一节做完就误报“全部处理完”），改走课程目录页或下一节按钮。
  if (catalog.some((item) => item.unfinished !== null && item.unfinished !== undefined)) {
    const index = catalog.findIndex((item) => item.id === current);
    const ordered = index >= 0 ? [...catalog.slice(index + 1), ...catalog.slice(0, index)] : catalog;
    const next = ordered.find((item) => item.unfinished > 0 && !processed.includes(item.id));
    if (!next) {
      const unreadable = ordered.filter((item) => (item.unfinished === null || item.unfinished === undefined) && !processed.includes(item.id)).length;
      if (unreadable) {
        return saveTask(tabId, { state: "paused",
          status: `左侧目录里能读到的未完成小节都处理过了，但还有 ${unreadable} 个小节读不到完成数，无法确认是否完成；请导出日志核对` });
      }
      return finishRun(tabId, "左侧目录里所有未完成小节都处理过了");
    }
    await saveTask(tabId, { phase: "switchingChapter", targetChapterId: next.id, previousChapterId: current,
      switchStartedAt: Date.now(), status: `正在进入下一个未完成小节${next.name ? `「${next.name}」` : ""}` });
    await frameCommand(main.frameId, "OPEN_CHAPTER", { id: next.id });
    return;
  }
  if (task.directoryUrl) return returnToDirectory(tabId, { ...task, activeChapterId: current }, "本节已处理完，正在回课程目录找下一节");
  if (main?.jobBlocked) return saveTask(tabId, { state: "paused", status: "平台提示本节仍有任务点未完成，已停止翻页" });
  if (!main?.hasNext) return finishRun(tabId, "没有找到下一节，课程可能已经到底了");
  await saveTask(tabId, { phase: "switchingChapter", targetChapterId: null, previousChapterId: current,
    switchStartedAt: Date.now(), status: "正在进入下一节" });
  await frameCommand(main.frameId, "NEXT");
}

// ---------------------------------------------------------------------------
// 需要用户处理的情况：优先级高于一切，出现就进入 waiting。
// ---------------------------------------------------------------------------

const WAIT_STATUS = {
  captcha: "出现验证码：请在页面上自己输入，插件会在验证码消失后自动继续",
  face: "需要人脸识别：请用手机扫码完成识别，完成后插件自动继续",
  videoQuestion: "视频中出现答题：请在视频里自己选择答案并提交，插件会在弹题关闭后自动继续播放",
  quiz: "本节有章节测验：请你自己完成并提交，平台确认完成后插件自动继续",
  background: "后台播放未能继续（浏览器或平台可能暂停了后台视频），当前小节已保留；回到课程页后自动重新检查，检测到进度也会自动继续",
  paused: "视频多次暂停且未恢复进度，已留在当前小节；请保持课程页在前台并手动播放，检测到进度后自动继续"
};

function attentionReason(ctx) {
  if (ctx.frames.some((frame) => frame.captcha)) return "captcha";
  if (ctx.frames.some((frame) => frame.face)) return "face";
  if (ctx.questionFrame) return "videoQuestion";
  return null;
}

async function videoManualStatus() {
  const options = await aiOptions();
  if (options.videoMode === 'trial') return '视频单选顺序试答已开启，不需要开启 AI';
  if (options.videoMode === 'manual') return '视频弹题已设为手动，完成后自动继续';
  if (!options.enabled) return 'AI 总开关已关闭：请开启悬浮窗 AI 后自动处理视频弹题，或在视频里手动作答';
  if (!options.video) return '视频弹题 AI 分项已关闭：请在 AI 设置中开启，或在视频里手动作答';
  return '已发现视频弹题，正在定位 AI 识题流程';
}

async function enterWaiting(tabId, task, reason, extra = {}) {
  const key = `${reason}:${task.activeChapterId}:${task.currentJobId || ""}`;
  const status = reason === 'videoQuestion' ? await videoManualStatus() : WAIT_STATUS[reason];
  await saveTask(tabId, { ...extra, phase: "waiting", waitReason: reason, waitingSince: Date.now(),
    questionContinueClickedAt: null, questionClosedAt: null, questionResumePlayAt: null, notifiedKey: key, status });
  if (task.notifiedKey !== key) notifyUser(reason, status);
}

async function leaveWaiting(tabId, status, ctx) {
  return saveTask(tabId, { ...jobReset(), phase: "page", waitReason: null,
    lastVideoTime: ctx?.mediaTime || 0, lastProgressAt: Date.now(), status });
}

// ---------------------------------------------------------------------------
// 单个任务点的处理
// ---------------------------------------------------------------------------

// 找到这个任务点对应的播放器框架。能读到 jobId 时精确匹配；读不到（跨域）时按本页第几个音视频任务点对应第几个播放器。
function mediaFrameFor(job, ctx) {
  if (ctx.media.some((frame) => frame.jobId)) return ctx.media.find((frame) => frame.jobId === job.id) || null;
  const mediaJobs = ctx.jobs.filter((item) => item.type === "video" || item.type === "audio");
  return ctx.media[mediaJobs.findIndex((item) => item.id === job.id)] || null;
}

async function skipJob(tabId, task, ctx, job, reason, status) {
  await addTodo(ctx.chapter, job, reason);
  return saveTask(tabId, { ...jobReset(), currentJobId: null,
    skippedJobs: [...new Set([...(task.skippedJobs || []), job.id])], status });
}

// 跳过只记录未完成并正常换节，不修改平台完成标记。
async function deferVideoChapter(tabId, task, ctx, job, reason) {
  await ensureRunning(tabId);
  const latest = (await chrome.storage.local.get(`task:${tabId}`))[`task:${tabId}`];
  if (latest.runId !== task.runId || latest.activeChapterId !== task.activeChapterId ||
      (job && latest.currentJobId && latest.currentJobId !== job.id) || ctx.frames.some(f => f.captcha || f.face)) return true;
  const failed = job || { id: 'unmatched-video', type: 'video', name: '' };
  await addTodo(ctx.chapter || { id: task.activeChapterId }, failed, reason);
  const media = job ? mediaFrameFor(job, ctx) : ctx.questionFrame;
  if (media) await frameCommand(media.frameId, 'PAUSE_MEDIA', { frameToken: media.aiDocument }).catch(() => {});
  await ensureRunning(tabId);
  const next = await saveTask(tabId, { ...jobReset(), phase: 'page', waitReason: null,
    skippedJobs: [...new Set([...(task.skippedJobs || []), failed.id])],
    deferredChapters: [...new Set([...(task.deferredChapters || []), task.activeChapterId])],
    status: `本节视频未完成：${reason}；已记入待办，正在转到下一节` });
  await chapterDone(tabId, next, ctx, '本节视频未完成，已记入待办');
  return true;
}

async function deferFailedVideoQuestion(tabId, task, ctx) {
  const options = await aiOptions();
  const automatic = options.videoMode === 'trial' || (options.videoMode === 'ai' && options.enabled && options.video);
  if (!automatic) return false;
  const frame = ctx.questionFrame;
  const job = ctx.jobs.find(j => j.type === 'video' && j.id === task.currentJobId);
  if (!frame || !job || (frame.jobId && frame.jobId !== job.id)) return false;
  if ((task.questionContinueClickedAt && Date.now() - task.questionContinueClickedAt > 15000) ||
      (task.questionResultAt && Date.now() - task.questionResultAt > 15000)) return deferVideoChapter(tabId, task, ctx, job, '视频弹题结果页无法关闭');
  if (options.videoMode === 'trial') return false;
  if (task.ai?.kind === 'video' && task.ai.stage === 'processing' && Date.now() - (task.ai.at || task.waitingSince || task.jobStartedAt || 0) > 45000) {
    return deferVideoChapter(tabId, task, ctx, job, '视频弹题 AI 流程中断或超时');
  }
  if (task.ai?.kind === 'video' && task.ai.stage === 'error') {
    return deferVideoChapter(tabId, task, ctx, job, '视频弹题 AI 未能取得或填写有效答案');
  }
  if (frame.videoQuestionFeedback === 'incorrect') return deferVideoChapter(tabId, task, ctx, job, '视频弹题 AI 答案未通过平台校验');
  if (task.ai?.stage === 'submitted' && Date.now() - task.ai.at > 30000 && ['open', 'submitting'].includes(frame.videoQuestionFeedback)) {
    return deferVideoChapter(tabId, task, ctx, job, '视频弹题提交后未返回明确结果');
  }
  if (task.questionContinueClickedAt && Date.now() - task.questionContinueClickedAt > 15000) {
    return deferVideoChapter(tabId, task, ctx, job, '视频弹题结果页无法关闭');
  }
  return false;
}

async function handleMedia(tabId, task, ctx, job) {
  const frame = mediaFrameFor(job, ctx);
  const label = jobLabel(job);
  const since = task.jobStartedAt || Date.now();
  if (!frame) {
    const cards = ctx.jobs.find((item) => item.id === job.id);
    if (!task.jobRevealedAt && cards) {
      await frameCommand(cards.frameId, "REVEAL_JOB", { id: job.id });
      return saveTask(tabId, { jobRevealedAt: Date.now(), status: `${label}在下方，已滚动到播放器位置` });
    }
    if (Date.now() - since < 20000) return saveTask(tabId, { status: `正在等待${label}的播放器加载` });
    if (ctx.backgroundPlayback) return enterWaiting(tabId, task, "background");
    return skipJob(tabId, task, ctx, job, "播放器一直没有加载出来", `${label}的播放器一直没加载出来，已记入待办，先做后面的`);
  }
  if (frame.mediaError) {
    if (!task.mediaReloadedAt) {
      await saveTask(tabId, { mediaReloadedAt: Date.now(), jobStartedAt: Date.now(), initialPlayAttemptedAt: null,
        initialPlayWaitingAt: null, status: `${label}加载失败，正在重新加载播放器` });
      await frameCommand(frame.frameId, "RELOAD_MEDIA");
      return;
    }
    return skipJob(tabId, task, ctx, job, "播放器报错（网络或文件问题）", `${label}重新加载后仍然报错，已记入待办，先做后面的`);
  }
  const info = frame.video;
  if (info?.error) return skipJob(tabId, task, ctx, job, "播放器报错", `${label}播放器报错，已记入待办，先做后面的`);
  if (!info || (info.paused && !info.ready && info.time === 0)) {
    const waitingSince = task.initialPlayWaitingAt || Date.now();
    if (frame.hasInitialPlayButton && !task.initialPlayAttemptedAt) {
      await saveTask(tabId, { initialPlayAttemptedAt: Date.now(), initialPlayWaitingAt: waitingSince,
        status: `正在开始播放${label}` });
      await frameCommand(frame.frameId, "INITIAL_PLAY");
      return;
    }
    if (info && !task.playRetries) {
      await frameCommand(frame.frameId, "PLAY").catch(() => {});
      return saveTask(tabId, { playRetries: 1, initialPlayWaitingAt: waitingSince, status: `正在启动${label}并等待加载` });
    }
    if (Date.now() - waitingSince > 25000) {
      if (ctx.backgroundPlayback) return enterWaiting(tabId, task, "background", { lastVideoTime: info?.time || 0 });
      return job.type === "video" ? deferVideoChapter(tabId, task, ctx, job, "播放器等待超时，仍未开始播放") :
        skipJob(tabId, task, ctx, job, "音频加载超时", "音频加载超时，先处理后面的任务点");
    }
    return saveTask(tabId, { initialPlayWaitingAt: waitingSince, status: `正在等待${label}加载` });
  }
  if (info.ended) {
    const endedAt = task.videoEndedAt || Date.now();
    if (Date.now() - endedAt > 30000) {
      return skipJob(tabId, task, ctx, job, "播完了但平台没有确认完成", `${label}已播完但平台迟迟没确认，已记入待办，先做后面的`);
    }
    return saveTask(tabId, { videoEndedAt: endedAt, status: `${label}已播完，等待平台确认任务点` });
  }
  // 轮询时恰好暂停不代表两轮之间没有播放，先记录真实进度并重置失败次数。
  const progressed = info.time > (task.lastVideoTime || 0) + 1;
  if (progressed) {
    task = await saveTask(tabId, { lastVideoTime: info.time, lastProgressAt: Date.now(), playRetries: 0 });
  }
  if (info.paused) {
    if ((task.playRetries || 0) >= 3) return enterWaiting(tabId, task, ctx.backgroundPlayback ? "background" : "paused", { lastVideoTime: info.time });
    await frameCommand(frame.frameId, "PLAY").catch(() => {});
    return saveTask(tabId, { playRetries: (task.playRetries || 0) + 1,
      status: info.time < 1 ? `正在开始播放${label}` : `${label}暂停了，已尝试继续播放` });
  }
  if (progressed) {
    return saveTask(tabId, {
      status: `正在播放${label} ${clock(info.time)} / ${clock(info.duration)}` });
  }
  if (Date.now() - Math.max(task.lastProgressAt || 0, since, task.initialPlayAttemptedAt || 0) > 45000) {
    if (ctx.backgroundPlayback) return enterWaiting(tabId, task, "background", { lastVideoTime: info.time });
    return job.type === "video" ? deferVideoChapter(tabId, task, ctx, job, "视频长时间没有播放进度") : enterWaiting(tabId, task, "paused", { lastVideoTime: info.time });
  }
}

function clock(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

// 文档 / PPT：像人一样往下翻到底，然后等平台确认；不调用页面的 finishJob 直接标记完成。
async function handleDocument(tabId, task, ctx, job) {
  const label = jobLabel(job);
  const readers = ctx.frames.filter((frame) => frame.active && frame.documentReader);
  const reader = readers.find((frame) => frame.jobId === job.id) || (readers.some((frame) => frame.jobId) ? null : readers[0]);
  const since = task.jobStartedAt || Date.now();
  if (!reader) {
    const cards = ctx.jobs.find((item) => item.id === job.id);
    if (!task.jobRevealedAt && cards) {
      await frameCommand(cards.frameId, "REVEAL_JOB", { id: job.id });
      return saveTask(tabId, { jobRevealedAt: Date.now(), status: `已滚动到${label}` });
    }
    if (Date.now() - since < 15000) return saveTask(tabId, { status: `正在等待${label}加载` });
    return skipJob(tabId, task, ctx, job, "识别不到文档的翻页区域", `${label}识别不到翻页区域，已记入待办，先做后面的`);
  }
  if (!reader.documentReader.atBottom) {
    const result = await frameCommand(reader.frameId, "SCROLL_DOCUMENT");
    if (!result.moved && !result.atBottom) {
      return skipJob(tabId, task, ctx, job, "文档没有响应翻页", `${label}没有响应翻页，已记入待办，先做后面的`);
    }
    return saveTask(tabId, { status: `正在翻阅${label}` });
  }
  const atBottom = task.documentAtBottomAt || Date.now();
  if (Date.now() - atBottom > 20000) {
    return skipJob(tabId, task, ctx, job, "翻到底了但平台没有确认完成", `${label}已翻到底但平台没确认，已记入待办，先做后面的`);
  }
  return saveTask(tabId, { documentAtBottomAt: atBottom, status: `${label}已翻到底，等待平台确认任务点` });
}

// 本标签没有待做的任务点了：换下一个没看过的标签（测验标签放最后），都看过就算整节处理完。
async function nextTabOrDone(tabId, task, ctx, reason) {
  const visited = task.visitedTabs || [];
  const tabs = (ctx.main?.tabs || []).filter((tab) => !tab.active && !visited.includes(tab.index));
  const complete = ctx.treeTask?.kind === "complete";
  // 平台确认任务点全部完成时，普通标签没必要再看；但 AI 章节测验开启时，
  // 还没看过的测验标签仍要打开，否则会在 AI 作答前就把整节判为完成。
  const tab = complete ? (ctx.aiQuiz ? tabs.find((item) => item.kind === "quiz") : null)
    : (tabs.find((item) => item.kind !== "quiz") || tabs[0]);
  if (tab) {
    const active = (ctx.main?.tabs || []).filter((item) => item.active).map((item) => item.index);
    await frameCommand(ctx.main.frameId, "OPEN_TAB", { index: tab.index });
    return saveTask(tabId, { ...jobReset(), currentJobId: null, tabOpenedAt: Date.now(),
      visitedTabs: [...new Set([...visited, ...active, tab.index])],
      status: `${reason}，正在查看${tab.kind === "quiz" ? "章节测验" : "下一个"}标签` });
  }
  return chapterDone(tabId, task, ctx, complete ? "平台已确认本节任务点全部完成" : `${reason}，本节已处理完`);
}

const CHAPTER_PHASES = {
  async page(tabId, task, ctx) {
    const { main } = ctx;
    if (main?.introDismissible) {
      await frameCommand(main.frameId, "DISMISS_INTRO");
      return saveTask(tabId, { status: "已关闭课程介绍提示层" });
    }
    if (ctx.treeTask?.kind === "complete" && !ctx.pending.length) {
      // 任务点已完成不代表没有章节测验：AI 开启时先看完还没进过的测验标签。
      const activeQuizTab = (ctx.main?.tabs || []).some((tab) => tab.active && tab.kind === "quiz");
      if (ctx.aiQuiz && unvisitedQuizTabs(ctx, task).length) {
        return nextTabOrDone(tabId, task, ctx, "平台已确认本节任务点完成");
      }
      // 刚打开测验标签时卡片页还没加载完，先等一会儿，别立刻判为整节完成。
      if (ctx.aiQuiz && activeQuizTab && Date.now() - (task.tabOpenedAt || 0) < 15000) {
        return saveTask(tabId, { status: "正在等待章节测验加载" });
      }
      return chapterDone(tabId, task, ctx, "平台已确认本节任务点全部完成");
    }
    if (!ctx.cardsLoaded && !ctx.pending.length) {
      if (Date.now() - (task.tabOpenedAt || task.chapterEnteredAt || 0) < 8000) {
        return saveTask(tabId, { status: "正在等待本节内容加载" });
      }
      return nextTabOrDone(tabId, task, ctx, "当前标签没有任务点");
    }
    const job = ctx.pending[0];
    if (!job) {
      const done = ctx.jobs.filter((item) => item.isJob).length;
      // 超星的卡片页是先加载外框、再用脚本插入任务点 iframe，刚打开时清单可能还是空的。
      if (!done && Date.now() - (task.tabOpenedAt || task.chapterEnteredAt || 0) < 8000) {
        return saveTask(tabId, { status: "正在等待本节内容加载" });
      }
      return nextTabOrDone(tabId, task, ctx, done ? "本标签的任务点都处理过了" : "当前标签没有任务点");
    }
    if (job.id !== task.currentJobId) {
      const index = ctx.jobs.filter((item) => item.isJob).findIndex((item) => item.id === job.id);
      return saveTask(tabId, { ...jobReset(), currentJobId: job.id,
        status: `开始第 ${index + 1} 个任务点：${jobLabel(job)}` });
    }
    if (job.type === "video" || job.type === "audio") return handleMedia(tabId, task, ctx, job);
    if (job.type === "document") return handleDocument(tabId, task, ctx, job);
    if (job.type === "quiz") {
      if (await AIFlow.enabled("quiz")) return AIFlow.handleQuiz(tabId, task, ctx, job);
      const { quizMode } = await settings();
      if (quizMode === "wait") return enterWaiting(tabId, task, "quiz");
      return skipJob(tabId, task, ctx, job, "章节测验需要你自己完成", `${jobLabel(job)}需要你自己完成，已记入待办，先做后面的`);
    }
    return skipJob(tabId, task, ctx, job, "插件不处理这类任务点", `${jobLabel(job)}插件不处理，已记入待办，先做后面的`);
  },

  async waiting(tabId, task, ctx) {
    const reason = attentionReason(ctx);
    if (task.waitReason === "videoQuestion" && ctx.questionFrame) {
      const surface = ctx.questionFrame;
      if (['continue', 'correct'].includes(surface.videoQuestionFeedback) && !task.questionResultAt) task = await saveTask(tabId, { questionResultAt: Date.now() });
      if (surface.videoQuestionFeedback === "continue" && !task.questionContinueClickedAt) {
        await saveTask(tabId, { questionClosedAt: null, questionContinueClickedAt: Date.now(), status: "平台已返回作答结果，正在点击继续学习" });
        try {
          await frameCommand(surface.frameId, "CONTINUE_VIDEO_QUESTION", { frameToken: surface.aiDocument, fingerprint: surface.videoQuestionFingerprint });
        } catch (error) { await saveTask(tabId, { status: `视频弹题继续失败，请人工核对：${displayError(error)}` }); }
        return;
      }
      const status = task.ai?.stage === "processing" ? "视频弹题识题流程被刷新或中断，请暂停后重新开始" :
        task.ai?.stage === "error" && surface.videoQuestionFeedback === "open" ? task.status :
        surface.videoQuestionFeedback === "incorrect" ? "视频弹题显示回答错误或被平台拒绝，请人工检查答案；不会自动重试" :
        surface.videoQuestionFeedback === "submitting" ? "视频弹题正在提交，等待平台响应" :
        surface.videoQuestionFeedback === "correct" ? "视频弹题已通过，等待平台显示继续按钮或关闭题目" :
        task.questionContinueClickedAt ? "弹题仍未关闭，请手动点击“继续”或关闭弹题" : await videoManualStatus();
      const submitted = task.ai?.stage === 'submitted' && surface.videoQuestionFeedback === 'open' && !task.questionContinueClickedAt;
      return saveTask(tabId, { questionClosedAt: null, status: submitted ? Date.now() - task.ai.at > 30000 ?
        '视频弹题提交后未收到明确结果，请人工核对；不会重复提交' : '视频弹题已点击提交，等待平台作答反馈' : status });
    }
    if (reason && reason !== task.waitReason) return enterWaiting(tabId, task, reason);
    if (reason) return;
    const job = ctx.jobs.find((item) => item.id === task.currentJobId);
    const media = job ? mediaFrameFor(job, ctx) : null;
    const mediaTime = media?.video?.time || 0;
    if (task.waitReason === "videoQuestion") {
      // 连续两轮看不到弹题才算关闭，避免平台切换“提交中 / 答对”提示时的瞬间空档。
      if (!task.questionClosedAt) return saveTask(tabId, { questionClosedAt: Date.now(), questionResumeTime: mediaTime,
        status: '视频弹题已关闭，正在核对播放是否恢复' });
      if (job?.finished || media?.video?.ended) return leaveWaiting(tabId, '视频弹题已结束，视频已播完，继续核对任务点', { mediaTime });
      if (media?.video && !media.video.paused && mediaTime > (task.questionResumeTime ?? mediaTime) + 0.2) {
        return leaveWaiting(tabId, '视频弹题已结束，播放已恢复', { mediaTime });
      }
      if (media?.video?.paused && !task.questionResumePlayAt) {
        await saveTask(tabId, { questionResumePlayAt: Date.now(), status: '视频弹题已关闭，正在恢复播放并等待进度增长' });
        try { await frameCommand(media.frameId, 'PLAY'); }
        catch (error) { await saveTask(tabId, { status: `弹题已关闭，播放未恢复：${displayError(error)}；请手动点击播放` }); }
        return;
      }
      if (Date.now() - task.questionClosedAt > 15000 && job?.type === 'video') {
        // 后台时平台可能因页面不可见暂停视频，不能据此跳过本节。
        if (ctx.backgroundPlayback) return enterWaiting(tabId, task, 'background', { lastVideoTime: mediaTime });
        return deferVideoChapter(tabId, task, ctx, job, '弹题结束后视频未能恢复播放');
      }
      return saveTask(tabId, { status: Date.now() - task.questionClosedAt > 15000 ?
        '弹题已关闭，但未检测到播放进度增长，请手动播放或检查播放器' : '弹题已关闭，等待视频进度增长以确认播放恢复' });
    }
    if (task.waitReason === "captcha") return leaveWaiting(tabId, "验证码已通过，继续", { mediaTime });
    if (task.waitReason === "face") return leaveWaiting(tabId, "人脸识别已完成，继续", { mediaTime });
    if (task.waitReason === "quiz") {
      if (await AIFlow.waitingQuiz(tabId, task, ctx)) return;
      if (!job || job.finished) return leaveWaiting(tabId, "章节测验已完成，继续", { mediaTime });
      // 测验不是任务点时，平台会先显示“本节任务点完成”。AI 正在处理或等用户提交时
      // 继续留在等待阶段；否则会回到 page、再次识题并重复填写。
      if (ctx.treeTask?.kind === "complete" && !(ctx.aiQuiz && task.ai?.kind === "quiz")) {
        return leaveWaiting(tabId, "章节测验已完成，继续", { mediaTime });
      }
      return;
    }
    if (task.waitReason === "background") {
      if (!document.hidden) return leaveWaiting(tabId, "已返回课程页，重新检查播放状态", { mediaTime });
      if (!job || job.finished) return leaveWaiting(tabId, "任务点已完成，继续", { mediaTime });
      const info = media?.video;
      if (info && !info.paused && info.time > (task.lastVideoTime || 0) + 1) {
        return leaveWaiting(tabId, "后台播放已恢复，继续运行", { mediaTime: info.time });
      }
      // 每分钟最多尝试一次正常播放；不伪造页面可见性，平台仍暂停时保持等待。
      if (media && info?.paused && Date.now() - (task.backgroundPlayAt || task.waitingSince || 0) > 60000) {
        await saveTask(tabId, { backgroundPlayAt: Date.now() });
        await frameCommand(media.frameId, "PLAY").catch(() => {});
      }
      return;
    }
    // 视频被未知原因暂停：视频重新走起来、或任务点已完成时继续。
    if (!job || job.finished) return leaveWaiting(tabId, "任务点已完成，继续", { mediaTime });
    // 未知原因暂停需要人工确认；不能因等待超时再跳过尚未完成的视频。
    const info = media?.video;
    if (info && !info.paused && info.time > (task.lastVideoTime || 0) + 1) {
      return leaveWaiting(tabId, "视频已恢复播放，继续运行", { mediaTime: info.time });
    }
  },

  async switchingChapter(tabId, task, ctx) {
    const current = ctx.main?.chapterId;
    const arrived = task.targetChapterId ? current === task.targetChapterId : current && current !== task.previousChapterId;
    if (arrived) return enterChapter(tabId, task, current, ctx.main?.tabs, "已进入小节，正在读取任务点");
    if (Date.now() - (task.switchStartedAt || 0) < 20000) return;
    if (task.directoryUrl) return returnToDirectory(tabId, task, "在学习页内换节没有成功，改为回课程目录找下一节");
    throw new Error("点击下一节后小节没有变化，请人工检查");
  }
};

function recordSnapshot(task, ctx) {
  if (Date.now() - lastDiagnosticSnapshotAt < 15000) return;
  lastDiagnosticSnapshotAt = Date.now();
  const job = ctx.jobs.find((item) => item.id === task.currentJobId);
  const media = job ? mediaFrameFor(job, ctx) : null;
  const jobs = ctx.jobs.filter((item) => item.isJob);
  recordDiagnostic("snapshot", {
    phase: task.phase,
    page: ctx.media.length ? "video" : ctx.frames.some((frame) => frame.quizPageVisible) ? "quiz" :
      ctx.frames.some((frame) => frame.documentReader) ? "document" : "other",
    videoPaused: media?.video?.paused,
    videoReady: media?.video?.ready,
    videoEnded: media?.video?.ended,
    videoSeconds: media?.video?.time,
    videoDuration: media?.video?.duration,
    jobCount: jobs.length,
    jobIndex: job ? jobs.indexOf(job) : undefined,
    jobType: job?.type,
    waitReason: task.waitReason || undefined,
    remainingTasks: ctx.treeTask?.count,
    frameCount: ctx.frames.length
  });
}

async function tick(tabId, task) {
  if (NAVIGATION_PHASES[task.phase]) return NAVIGATION_PHASES[task.phase](tabId, task);
  if (!isRunnerPage()) return saveTask(tabId, { state: "paused", status: "已离开学习页，插件已暂停" });
  await CourseLayout.apply();
  const aiQuiz = await AIFlow.enabled("quiz");
  const ctx = summarizeFrames(await inspect(), task, aiQuiz);
  const { allowBackgroundPlayback } = await chrome.storage.local.get("allowBackgroundPlayback");
  ctx.backgroundPlayback = allowBackgroundPlayback === true && document.hidden === true;
  if (Boolean(task.backgroundWasHidden) !== ctx.backgroundPlayback) {
    // 从后台回到前台：后台计时器节流期间累积的等待时间不能算作播放器故障，重新计时。
    const now = Date.now();
    const reset = task.backgroundWasHidden ? { jobStartedAt: now, lastProgressAt: now, playRetries: 0,
      initialPlayWaitingAt: task.initialPlayWaitingAt ? now : null, videoEndedAt: task.videoEndedAt ? now : null,
      documentAtBottomAt: task.documentAtBottomAt ? now : null, questionClosedAt: task.questionClosedAt ? now : null,
      questionContinueClickedAt: task.questionContinueClickedAt ? now : null, questionResultAt: task.questionResultAt ? now : null,
      waitingSince: task.waitingSince ? now : null } : {};
    task = await saveTask(tabId, { ...reset, backgroundWasHidden: ctx.backgroundPlayback });
  }
  // 之前 AI 关闭时跳过的测验，在 AI 打开后应该重新尝试，而不是一直留在“已跳过”。
  if (aiQuiz && task.skippedJobs?.length) {
    const quizIds = new Set(ctx.jobs.filter((job) => job.type === "quiz").map((job) => job.id));
    const kept = task.skippedJobs.filter((id) => !quizIds.has(id));
    if (kept.length !== task.skippedJobs.length) {
      // 测验标签之前已经看过，重新打开它才能让 AI 重新识题。
      const quizTabIndexes = new Set((ctx.main?.tabs || []).filter((tab) => tab.kind === "quiz").map((tab) => tab.index));
      const visitedTabs = (task.visitedTabs || []).filter((index) => !quizTabIndexes.has(index));
      task = await saveTask(tabId, { skippedJobs: kept, currentJobId: null, visitedTabs,
        status: "AI 已开启，重新检查之前跳过的章节测验" });
      ctx.pending = ctx.jobs.filter((job) => job.isJob && !job.finished && !kept.includes(job.id));
    }
  }
  const patch = { jobs: panelJobs(ctx, task), chapterName: ctx.chapter?.name || "" };
  if (JSON.stringify(patch.jobs) !== JSON.stringify(task.jobs) || patch.chapterName !== task.chapterName) {
    task = await saveTask(tabId, patch);
    await pruneTodos(ctx);
  }
  recordSnapshot(task, ctx);
  // 用户自己点了别的小节：从那一节接着做，而不是报错停下。
  if (task.phase !== "switchingChapter" && ctx.main?.chapterId && task.activeChapterId &&
      ctx.main.chapterId !== task.activeChapterId) {
    return enterChapter(tabId, task, ctx.main.chapterId, ctx.main.tabs, "检测到切换到了另一节，从这一节继续");
  }
  const reason = attentionReason(ctx);
  // 人工验证优先，保留已提交和已试选项，验证结束后不从 A 重发。
  if (reason === 'captcha' || reason === 'face') {
    if (task.waitReason !== reason) await enterWaiting(tabId, task, reason);
    return;
  }
  // 换节期间旧弹题可能还在 DOM 中，不能把它重新当成待处理题。
  if (task.phase === 'switchingChapter') return CHAPTER_PHASES.switchingChapter(tabId, task, ctx);
  if (reason === 'videoQuestion') {
    if (await VideoTrialFlow.maybeVideo(tabId, task, ctx)) return;
    if (await AIFlow.maybeVideo(tabId, task, ctx)) return;
    if (await deferFailedVideoQuestion(tabId, task, ctx)) return;
  }
  if (reason && task.phase !== "waiting") return enterWaiting(tabId, task, reason);
  const handler = CHAPTER_PHASES[task.phase];
  if (handler) return handler(tabId, task, ctx);
  // 0.1.x 留下的旧阶段：统一从当前小节重新开始。
  return enterChapter(tabId, task, ctx.main?.chapterId || chapterId(), ctx.main?.tabs, "已升级到新版本，从当前小节重新开始");
}

// 页面定时器与后台唤醒共用互斥检查，避免 AI、提交或换节执行两遍。
async function runCycle(tabId) {
  if (cycleActive) return;
  cycleActive = true;
  try {
    const key = `task:${tabId}`;
    const task = (await chrome.storage.local.get(key))[key];
    if (!task || task.state !== "running") return;
    try { await tick(tabId, task); }
    catch (error) {
      const latest = (await chrome.storage.local.get(key))[key];
      if (latest?.state !== "running" || latest.runId !== task.runId) return;
      recordDiagnostic("error", { source: "content", phase: task.phase, message: error.message || String(error) });
      await saveTask(tabId, { state: "error", status: displayError(error) });
      notifyUser("error", displayError(error));
    }
  } finally { cycleActive = false; }
}

async function startLoop(tabId) {
  if (loopActive) return;
  loopActive = true;
  try {
    while (true) {
      const task = (await chrome.storage.local.get(`task:${tabId}`))[`task:${tabId}`];
      if (!task || task.state !== "running") break;
      await runCycle(tabId);
      await wait(3000);
    }
  } finally { loopActive = false; }
}
