// 入口：响应后台页、弹窗和悬浮面板的消息，并在页面刷新后恢复正在运行的任务。

// 每个框架回报自己的状态，运行器据此决定下一步。
function inspectPayload(sender) {
  const active = frameVisible();
  const video = active ? videoInfo() : null;
  const onMediaPage = active && isMediaPage();
  const top = window === window.top;
  const questionCount = active && QUIZ_URL.test(location.pathname) ? getQuestionElements().length : 0;
  const questionSurface = active && isVideoPage() && videoQuestionSurfaceVisible();
  const questionFeedback = questionSurface ? videoQuestionFeedback() : null;
  let videoQuestionFingerprint = null, trial = null;
  if (questionSurface) {
    try { videoQuestionFingerprint = videoAIEnvelope().fingerprint; } catch { /* unsupported questions remain manual */ }
  }
  if (questionSurface) { try { trial = videoTrialEnvelope(); } catch { /* unsupported for trial */ } }
  return {
    videoTrialFingerprint: trial?.fingerprint || null, videoTrialCanRetry: trial?.canRetry || false, videoTrialResult: videoTrialFeedback(),
    frameId: sender?.frameId,
    aiDocument: AI_DOCUMENT,
    quizPageVisible: questionCount > 0,
    questionCount,
    hasSubmitConfirm: active && Boolean(quizSubmitConfirmation()),
    topSubmitConfirm: top && active && Boolean(topSubmitConfirmation()),
    active,
    pathPattern: pathPattern(),
    kind: video?.kind || "other",
    mediaPage: onMediaPage,
    jobId: top ? null : ownJobId(),
    video,
    hasInitialPlayButton: active && Boolean(initialPlayButton()),
    mediaError: onMediaPage && mediaLoadError(),
    videoQuestionSurface: questionSurface,
    videoQuestionFeedback: questionFeedback,
    videoQuestionFingerprint,
    // 事件身份只在题目待作答时被使用（新题判定、AI 请求守卫）；提交后的轮询不再重复计算。
    // 指纹在提交后的核对和“继续”校验中仍会用到，因此保持每轮计算。
    videoQuestionIdentity: questionFeedback === 'open' ? videoQuestionIdentity() : null,
    documentReader: active ? documentReader()?.state || null : null,
    jobs: active && CARDS_URL.test(location.pathname) ? jobSummary() : null,
    tabs: chapterTabs().map(({ index, kind, active: current }) => ({ index, kind, active: current })),
    introDismissible: active && Boolean(introDismissButton()),
    catalog: top ? catalogSummary() : null,
    catalogLocked: top && catalogLocked(),
    treeTask: currentTreeTaskState(),
    jobBlocked: jobFinishBlocked(),
    chapterId: chapterId(),
    hasNext: Boolean(findNextButton()),
    captcha: captchaVisible(),
    face: faceRecognitionVisible(),
    muted: Mute.isEnabled()
  };
}

async function pauseTask(key, previous) {
  await chrome.runtime.sendMessage({ type: "CANCEL_AI" }).catch(() => {});
  await chrome.storage.local.set({ [key]: { ...previous, state: "paused", status: "已由用户暂停", updatedAt: Date.now() } });
  recordDiagnostic("pause", { phase: previous?.phase, state: "paused" });
  return { ok: true };
}

async function retryAI(tabId, key, previous) {
  if (previous?.state !== 'running' || previous?.ai?.stage !== 'error') throw new Error('当前没有可重新读取的 AI 题目');
  await chrome.runtime.sendMessage({ type: 'CANCEL_AI' });
  const latest = (await chrome.storage.local.get(key))[key];
  if (latest?.runId !== previous.runId || latest?.state !== 'running') throw new Error('运行状态已变化，请重新开始');
  await saveTask(tabId, { phase: 'page', ai: null, aiAttempts: 0, waitReason: null, questionClosedAt: null, questionContinueClickedAt: null,
    status: '正在重新定位并读取当前题目' });
  startLoop(tabId);
  return { ok: true };
}

async function startFromDirectory(tabId, key, target) {
  const directoryUrl = courseDirectoryUrl();
  if (!directoryUrl) throw new Error("课程目录链接缺少必要参数，无法连续运行");
  if (!target) {
    const { rows, locked, unknown } = directoryStatus();
    if (!rows) throw new Error("课程目录尚未加载，无法识别待完成小节");
    const scan = lastDirectoryScan;
    // 扫描不出任何可做小节时也要写日志，否则导出的日志是空的。
    const unreadable = scan.rows > 0 && scan.evaluated < scan.rows;
    const undecided = unknown || unreadable;
    recordDiagnostic("state", { phase: "directory", state: locked || undecided ? "paused" : "completed" });
    recordDiagnostic("structure", { frame: 0, urlKind: "directory", note:
      `目录行数 ${rows}，可读取完成标记 ${scan.evaluated}，识别为未完成 ${scan.candidates}，锁定 ${locked ? "有" : "无"}，未识别 ${unknown ? "有" : "无"}` });
    await chrome.storage.local.set({ [key]: {
      state: locked || undecided ? "paused" : "completed", phase: "directory", directoryUrl,
      startedAt: Date.now(), updatedAt: Date.now(),
      status: unknown ? "课程目录有未识别的小节状态，请导出日志核对" :
        unreadable ? `课程目录有 ${rows - scan.evaluated} 个小节读不到完成标记，无法判断是否已完成；请导出日志核对` :
        locked ? "当前没有可做的小节，但目录仍有锁定内容" : "当前课程目录的可做小节已全部完成"
    } });
    return { ok: true };
  }
  const task = {
    state: "running", runId: `${Date.now()}:${Math.random()}`, phase: "directory", directoryUrl, deferredChapters: [], processedChapters: [],
    targetChapterId: target.chapter, startedAt: Date.now(), updatedAt: Date.now(), log: [],
    status: "已找到首个未完成小节，准备进入学习页"
  };
  await chrome.storage.local.set({ [key]: task });
  recordDiagnostic("start", { phase: task.phase, state: task.state });
  startLoop(tabId);
  return { ok: true };
}

async function startInChapter(tabId, key, chapter) {
  const task = {
    ...chapterReset(chapter, chapterTabs().map(({ index, active }) => ({ index, active }))),
    state: "running", runId: `${Date.now()}:${Math.random()}`, startedAt: Date.now(), updatedAt: Date.now(),
    directoryUrl: courseDirectoryUrl(), studyView: studyViewContext(), deferredChapters: [], processedChapters: [], chapterEntries: { [chapter]: 1 },
    status: "已开始，正在读取本节任务点", log: [{ at: Date.now(), text: "已开始，正在读取本节任务点" }]
  };
  await chrome.storage.local.set({ [key]: task });
  recordDiagnostic("start", { phase: task.phase, state: task.state });
  startLoop(tabId);
  return { ok: true };
}

async function handleStartOrPause(type) {
  const tabId = await chrome.runtime.sendMessage({ type: "TAB_ID" });
  if (!tabId) throw new Error("无法识别当前标签页");
  const key = `task:${tabId}`;
  const previous = (await chrome.storage.local.get(key))[key];
  if (type === "PAUSE") return pauseTask(key, previous);
  if (type === 'RETRY_AI') return retryAI(tabId, key, previous);
  if (DIRECTORY_URL.test(location.pathname)) return startFromDirectory(tabId, key, directoryTarget());
  if (!isRunnerPage()) throw new Error("请在课程目录页或章节学习页点开始");
  const chapter = chapterId();
  if (!chapter) throw new Error("无法识别当前小节，请从课程目录进入任意小节后再开始");
  return startInChapter(tabId, key, chapter);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CAPTURE_PANEL" && window === top) {
    Panel.captureHidden(message.hidden === true);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "INSPECT") {
    // 结构记录必须先落盘再回应，否则导出日志时这条记录经常还没写完。
    const structureWrite = structureDiagnostic(message.fullScan === true);
    const payload = inspectPayload(sender);
    Promise.resolve(structureWrite).then(() => sendResponse(payload), () => sendResponse(payload));
    return true;
  }
  if (message.type === "FRAME_COMMAND") {
    runFrameCommand(message.command, message.data).then(sendResponse, (error) => sendResponse({ error: error.message || String(error) }));
    return true;
  }
  if (!["START", "PAUSE", "RETRY_AI"].includes(message.type)) return;
  if (window !== top) return;
  if (!isStartablePage()) {
    sendResponse({ error: `当前页面（${pathPattern()}）不是受支持的课程页面，请从课程目录或章节学习页开始` });
    return;
  }
  handleStartOrPause(message.type).then(sendResponse, (error) => sendResponse({ error: error.message || String(error) }));
  return true;
});

if (window === top && isStartablePage()) {
  chrome.runtime.sendMessage({ type: "TAB_ID" }).then(async (tabId) => {
    if (!tabId) return;
    const key = `task:${tabId}`;
    const task = (await chrome.storage.local.get(key))[key];
    if (task?.state === "running") startLoop(tabId);
    CourseLayout.init();
    Panel.init(tabId);
  }).catch(() => {});
}
