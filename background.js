if (typeof importScripts === "function") importScripts("content/blank-editor.js", "background-ai.js");
const DIAGNOSTIC_KEY = "diagnostics";
const DIAGNOSTIC_LIMIT = 300;
const DIAGNOSTIC_EVENTS = new Set(["start", "pause", "state", "snapshot", "command", "error", "structure", "notify", "usage"]);
const DIAGNOSTIC_PHASES = new Set(["directory", "enteringChapter", "returningDirectory", "page", "waiting", "switchingChapter", "advancing"]);
const DIAGNOSTIC_STATES = new Set(["running", "paused", "error", "completed"]);
const DIAGNOSTIC_COMMANDS = new Set(["PLAY", "INITIAL_PLAY", "RELOAD_MEDIA", "CONTINUE_VIDEO_QUESTION", "OPEN_TAB", "DISMISS_INTRO", "REVEAL_JOB", "SCROLL_DOCUMENT", "OPEN_CHAPTER", "NEXT", "READ_QUIZ", "CAPTURE_QUESTION", "FILL_QUIZ", "VERIFY_QUIZ", "SUBMIT_QUIZ", "CONFIRM_SUBMIT", "CONFIRM_TOP_SUBMIT", "READ_VIDEO_QUESTION", "CAPTURE_VIDEO_QUESTION", "FILL_VIDEO_QUESTION", "SUBMIT_VIDEO_QUESTION"]);
const WAIT_REASONS = new Set(["videoQuestion", "face", "captcha", "quiz", "paused"]);
const JOB_TYPES = new Set(["video", "audio", "document", "quiz", "book", "link", "other"]);
const VIDEO_QUESTION_FEEDBACK = new Set(["open", "submitting", "incorrect", "correct", "continue", "closed"]);
let diagnosticWrites = Promise.resolve();

function errorCategory(message) {
  const value = String(message || "");
  if (/超时|timeout|aborted|AbortError/i.test(value)) return "timeout";
  if (/Could not establish connection|Receiving end does not exist|message port closed/i.test(value)) return "connection";
  if (/验证码|captcha/i.test(value)) return "captcha";
  if (/视频|播放器|播放/i.test(value)) return "video";
  if (/测验|题目|选项|提交|答案/i.test(value)) return "quiz";
  if (/目录|章节|下一节|翻页/i.test(value)) return "navigation";
  return "other";
}

function sanitizeDiagnostic(event, details, tabId) {
  if (!DIAGNOSTIC_EVENTS.has(event)) return null;
  const data = details && typeof details === "object" ? details : {};
  const record = { at: new Date().toISOString(), event };
  if (Number.isInteger(tabId) && tabId >= 0) record.tab = tabId;
  if (DIAGNOSTIC_PHASES.has(data.phase)) record.phase = data.phase;
  if (DIAGNOSTIC_STATES.has(data.state)) record.state = data.state;
  if (event === "snapshot") {
    record.page = ["directory", "document", "video", "quiz", "other"].includes(data.page) ? data.page : "other";
    record.videoPaused = data.videoPaused === true;
    record.videoReady = data.videoReady === true;
    record.videoEnded = data.videoEnded === true;
    for (const field of ["videoSeconds", "videoDuration", "remainingTasks", "jobCount", "jobIndex", "frameCount"]) {
      if (Number.isFinite(data[field])) record[field] = Math.max(0, Math.min(100000, Math.floor(data[field])));
    }
    if (JOB_TYPES.has(data.jobType)) record.jobType = data.jobType;
    if (WAIT_REASONS.has(data.waitReason)) record.waitReason = data.waitReason;
    if (VIDEO_QUESTION_FEEDBACK.has(data.videoQuestionFeedback)) record.videoQuestionFeedback = data.videoQuestionFeedback;
  }
  if (event === "command") {
    record.command = DIAGNOSTIC_COMMANDS.has(data.command) ? data.command : "UNKNOWN";
    record.ok = data.ok === true;
  }
  if (event === "error") {
    record.code = errorCategory(data.message);
    record.source = ["content", "popup", "background"].includes(data.source) ? data.source : "unknown";
  }
  if (event === "usage") {
    record.kind = "answer";
    if (["deepseek-flash", "deepseek-v4-pro"].includes(data.model)) record.model = data.model;
    for (const key of ["promptTokens", "completionTokens", "totalTokens"]) if (Number.isSafeInteger(data[key]) && data[key] >= 0) record[key] = data[key];
  }
  if (event === "notify" && WAIT_REASONS.has(data.waitReason)) record.waitReason = data.waitReason;
  if (event === "structure") {
    record.kind = "page-structure";
    record.frame = Number.isInteger(data.frame) && data.frame >= -1 ? Math.min(10000, data.frame) : -1;
    if (typeof data.active === "boolean") record.active = data.active;
    for (const field of ["pathDepth", "imageCount", "videoCount", "jobFrames", "catalogChapters", "visibleButtons", "iframes", "respondingFrames", "questionCount"]) {
      if (Number.isSafeInteger(data[field]) && data[field] >= 0 && data[field] <= 100000) record[field] = data[field];
    }
    for (const field of ["urlKind", "bodyClassKind", "videoSelector", "videoQuizSelector", "catalogSelector", "documentSelector", "taskSelector", "quizSelector", "attentionSelector", "visibleTextKinds", "pathPattern", "queryKeys", "hostKind", "note", "submitConfirmKind"]) {
      if (typeof data[field] === "string" && data[field].length <= 300) record[field] = data[field];
    }
    if (Array.isArray(data.selectorHints)) {
      record.selectorHints = data.selectorHints
        .filter((value) => typeof value === "string" && /^[.#][A-Za-z_-][A-Za-z0-9_-]*$/.test(value) && value.length <= 60)
        .slice(0, 100);
    }
  }
  return record;
}

function appendDiagnostic(event, details, tabId) {
  const record = sanitizeDiagnostic(event, details, tabId);
  if (!record) return Promise.resolve({ error: "无效日志事件" });
  const write = diagnosticWrites.then(async () => {
    const stored = await chrome.storage.local.get(DIAGNOSTIC_KEY);
    const records = Array.isArray(stored[DIAGNOSTIC_KEY]) ? stored[DIAGNOSTIC_KEY] : [];
    records.push(record);
    await chrome.storage.local.set({ [DIAGNOSTIC_KEY]: records.slice(-DIAGNOSTIC_LIMIT) });
    return { ok: true };
  });
  diagnosticWrites = write.catch(() => {});
  return write;
}

async function exportDiagnostics() {
  await diagnosticWrites;
  const stored = await chrome.storage.local.get(DIAGNOSTIC_KEY);
  const records = Array.isArray(stored[DIAGNOSTIC_KEY]) ? stored[DIAGNOSTIC_KEY] : [];
  return {
    format: "course-runner-diagnostics-v2",
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    说明: "仅含运行状态、脱敏页面结构线索和错误类别，不含任务点名称、课程链接或页面原文。",
    字段说明: {
      at: "记录时间", event: "事件类型", tab: "浏览器标签编号", phase: "运行阶段",
      state: "任务状态", page: "当前页面类型", videoPaused: "视频是否暂停",
      videoReady: "视频是否加载", videoEnded: "视频是否结束",
      videoSeconds: "已播放秒数", videoDuration: "视频总秒数",
      remainingTasks: "当前小节剩余任务点数",
      jobCount: "本页任务点数", jobIndex: "当前处理第几个任务点（从 0 开始）", jobType: "当前任务点类型",
      waitReason: "等待用户处理的原因", frameCount: "页面框架数量",
      videoQuestionFeedback: "视频弹题的页面反馈状态", command: "执行的操作",
      ok: "操作是否成功", code: "错误类别", source: "错误来源",
      kind: "结构记录类型（structure）",
      frame: "页面框架编号（0=最外层页面，-1=未能确定编号的内嵌页）",
      active: "该框架是否被判定为可见；false 可能表示内嵌页被隐藏，也可能表示无法判断",
      pathDepth: "页面路径层级",
      pathPattern: "脱敏后的页面路由形状（数字已替换为 #，不含查询参数值）",
      queryKeys: "页面查询参数的名称列表（不含取值）",
      hostKind: "页面域名类别（chaoxing/other）",
      imageCount: "图片元素数量", videoCount: "视频元素数量", jobFrames: "本页识别到的任务点框架数",
      catalogChapters: "左侧目录识别到的小节数",
      visibleButtons: "可见按钮数量", iframes: "内嵌框架数量", urlKind: "页面类型而非网址",
      bodyClassKind: "body class 的类别摘要", videoSelector: "视频选择器命中情况",
      catalogSelector: "目录选择器命中情况", documentSelector: "文档选择器命中情况",
      attentionSelector: "人脸识别 / 验证码 / 播放器报错选择器命中情况",
      taskSelector: "任务点选择器命中情况", visibleTextKinds: "可见按钮文字的类别摘要",
      selectorHints: "脱敏后的 ID/class 选择器候选，不含元素文字或属性值",
      respondingFrames: "导出时响应结构探测的课程页框架数量",
      note: "固定说明文字，不含页面原文",
      仅部分记录包含的字段: "videoSeconds、videoDuration、remainingTasks、jobType、waitReason、pathPattern、queryKeys、hostKind 等只在对应记录里出现"
    },
    usage: records.filter(r => r.event === "usage").reduce((sum, r) => ({ requests: sum.requests + 1, totalTokens: sum.totalTokens + (r.totalTokens || 0) }), { requests: 0, totalTokens: 0 }),
    records
  };
}

async function clearDiagnostics() {
  await diagnosticWrites;
  await chrome.storage.local.remove(DIAGNOSTIC_KEY);
  return { ok: true };
}

// 只有超星域名下的框架注入了内容脚本；about:blank、广告、第三方播放器等框架直接跳过，
// 不必每 3 秒给它们发一次注定失败的消息。
const COURSE_FRAME_URL = /^https:\/\/([^/]+\.)?chaoxing\.com\//i;

async function inspectFrames(tabId, fullScan = false) {
  const frames = ((await chrome.webNavigation.getAllFrames({ tabId })) || [])
    .filter((frame) => !frame.url || COURSE_FRAME_URL.test(frame.url));
  const results = await Promise.all(frames.map(async (frame) => {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: "INSPECT", fullScan }, { frameId: frame.frameId });
      if (!result || result.error || typeof result.kind !== "string") return null;
      return { frameId: frame.frameId, ...result };
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}

async function commandFrame(tabId, frameId, command, data) {
  return chrome.tabs.sendMessage(tabId, { type: "FRAME_COMMAND", command, data }, { frameId });
}

// 需要用户处理时的桌面通知。同一标签页同一原因只保留一条，点击通知回到课程标签页。
const NOTIFY_TITLES = {
  videoQuestion: "视频里出现了答题", face: "需要人脸识别", captcha: "需要输入验证码",
  quiz: "有章节测验等你完成", paused: "视频被暂停了", done: "课程已完成", error: "运行停止了"
};

async function notify(tabId, reason, message) {
  const { notify: enabled } = await chrome.storage.local.get("notify");
  if (enabled === false || !chrome.notifications) return { ok: false };
  const id = `course-runner:${tabId}:${reason}`;
  await chrome.notifications.create(id, {
    type: "basic", iconUrl: "icons/icon128.png", priority: 2, requireInteraction: reason !== "done",
    title: NOTIFY_TITLES[reason] || "课程流程助手", message: String(message || "").slice(0, 200)
  });
  appendDiagnostic("notify", { waitReason: reason }, tabId).catch(() => {});
  return { ok: true };
}

chrome.notifications?.onClicked.addListener(async (id) => {
  const tabId = Number(id.split(":")[1]);
  if (!Number.isInteger(tabId)) return;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } catch { /* 标签页已关闭 */ }
  chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (["SET_AI_SETTINGS", "CANCEL_AI", "AI_VALIDATE", "VIDEO_TRIAL_VALIDATE", "AI_CLAIM_SUBMISSION", "ANSWER", "CAPTURE_TAB", "FILL_BLANKS", "VERIFY_BLANKS"].includes(message.type)) return handleAIMessage(message, sender);
    if (message.type === "OPEN_AI_SETTINGS") {
      if (chrome.action?.openPopup) {
        try { await chrome.action.openPopup(); return { ok: true }; } catch { /* 旧浏览器不允许由内容脚本打开弹窗 */ }
      }
      throw new Error("请点击浏览器工具栏的课程流程助手图标，展开 AI 识题设置");
    }
    if (message.type === "DIAG_LOG") {
      const details = message.details && typeof message.details === "object" ?
        { ...message.details, frame: Number.isInteger(sender.frameId) ? sender.frameId : message.details.frame } : message.details;
      return appendDiagnostic(message.event, details, sender.tab?.id ?? message.tabId);
    }
    if (message.type === "DIAG_SNAPSHOT") {
      if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error("无法识别当前课程标签页");
      const frames = await inspectFrames(message.tabId, true);
      const respondingFrames = frames.length;
      if (!respondingFrames) {
        // 不能在这里直接报错，否则用户根本导不出日志；先把“没有任何框架响应”写进日志，
        // 再把数量返回给弹窗提示，这样空日志和“页面未连接”可以区分开。
        await appendDiagnostic("structure", {
          frame: -1, active: false, respondingFrames: 0, urlKind: "no-frame-response",
          note: "没有任何课程页框架响应结构探测：扩展可能未在此页面生效，或需要刷新课程页后重试"
        }, message.tabId);
      }
      return { ok: true, respondingFrames };
    }
    if (message.type === "DIAG_EXPORT") return exportDiagnostics();
    if (message.type === "DIAG_CLEAR") return clearDiagnostics();
    if (message.type === "TAB_ID") return sender.tab?.id;
    if (message.type === "INSPECT_FRAMES") return inspectFrames(sender.tab.id);
    if (message.type === "COMMAND_FRAME") {
      return commandFrame(sender.tab.id, message.frameId, message.command, message.data);
    }
    if (message.type === "NOTIFY") return notify(sender.tab?.id, String(message.reason || ""), message.message);
    throw new Error("未知消息类型");
  })().then(sendResponse, (error) => {
    if (!["DIAG_LOG", "DIAG_EXPORT", "DIAG_CLEAR"].includes(message.type)) {
      appendDiagnostic("error", { source: "background", message: error.message || String(error) }, sender.tab?.id).catch(() => {});
    }
    sendResponse({ error: error.message || String(error) });
  });
  return true;
});

// 一键静音快捷键（默认 Alt+M，可在 chrome://extensions/shortcuts 修改）。
// 只切换 storage 里的 muted 开关，各课程页框架监听到变化后自行静音或恢复。
async function toggleMute() {
  const { muted } = await chrome.storage.local.get("muted");
  await chrome.storage.local.set({ muted: muted !== true });
}
chrome.commands?.onCommand.addListener((command) => {
  if (command === "toggle-mute") toggleMute().catch(() => {});
});
