// AI 服务：接口请求、可取消操作、跨刷新提交记录。密钥与截图不会进入诊断日志。
const API_URL = "https://api.deepseek.com/chat/completions";
const ANSWER_MODELS = new Set(["deepseek-v4-pro", "deepseek-flash"]);
const VISION_MODEL = "deepseek-flash";
const TEXT_MODEL = "deepseek-flash";
const activeAIRequests = new Set();
let aiSettingsWrites = Promise.resolve();
let aiLockWrites = Promise.resolve();
const AI_OPTION_KEYS = ["aiEnabled", "aiVideoEnabled", "aiQuizEnabled", "autoSubmit"];
const AI_REVISION_KEYS = [...AI_OPTION_KEYS, "videoAnswerMode", "apiKey", "model", "referenceText", "customPrompt", "allowBackgroundCapture", "aiRevision"];

async function assertAIRequest(tabId, guard) {
  if (!guard || !Number.isInteger(tabId) || !["quiz", "video"].includes(guard.kind)) throw new Error("AI 请求上下文已失效");
  const stored = await chrome.storage.local.get([`task:${tabId}`, ...AI_OPTION_KEYS, "aiRevision", "videoAnswerMode"]);
  if (stored.aiEnabled !== true || stored[guard.kind === "video" ? "aiVideoEnabled" : "aiQuizEnabled"] === false) throw new Error("AI 识题已关闭");
  if (guard.kind === 'video' && stored.videoAnswerMode && stored.videoAnswerMode !== 'ai') throw new Error('视频答题模式已变化');
  const task = stored[`task:${tabId}`];
  if (!task || task.state !== "running" || !guard.runId || task.runId !== guard.runId ||
      task.activeChapterId !== guard.chapterId || task.currentJobId !== guard.jobId ||
      (stored.aiRevision || "initial") !== guard.revision) throw new Error("运行或 AI 设置已变化，旧结果已失效");
}

async function validateAIContext(tabId, guard) {
  await assertAIRequest(tabId, guard);
  const frames = await inspectFrames(tabId);
  const frame = frames.find(f => f.frameId === guard.frameId);
  const main = frames.find(f => f.frameId === 0);
  if (!frame?.active || frame.aiDocument !== guard.frameToken ||
      (main?.chapterId && main.chapterId !== guard.chapterId) || frames.some(f => f.captcha || f.face)) {
    throw new Error("课程页面已变化或需要验证，旧结果已失效");
  }
}

// 顺序试答有独立校验入口；它不能取得截图、AI 请求或章节测验提交权限。
async function validateVideoTrialContext(tabId, guard) {
  if (!Number.isInteger(tabId) || !guard || guard.kind !== 'video') throw new Error('试答上下文已失效');
  const s = await chrome.storage.local.get([`task:${tabId}`, 'videoAnswerMode', 'aiRevision']);
  const task = s[`task:${tabId}`];
  if (s.videoAnswerMode !== 'trial' || (s.aiRevision || 'initial') !== guard.revision || !task || task.state !== 'running' ||
      !guard.runId || task.runId !== guard.runId || task.activeChapterId !== guard.chapterId || task.currentJobId !== guard.jobId) {
    throw new Error('运行或试答模式已变化');
  }
  const frames = await inspectFrames(tabId), frame = frames.find(f => f.frameId === guard.frameId), main = frames.find(f => f.frameId === 0);
  if (!frame?.active || !frame.mediaPage || !frame.videoQuestionSurface || frame.aiDocument !== guard.frameToken ||
      frame.jobId !== guard.jobId || (main?.chapterId && main.chapterId !== guard.chapterId) || frames.some(f => f.captcha || f.face) ||
      (guard.fingerprint && frame.videoTrialFingerprint !== guard.fingerprint)) throw new Error('课程页面或题目已变化、无法匹配或需要验证');
}

function cancelAIRequests(tabId) {
  for (const request of activeAIRequests) if (tabId === undefined || request.tabId === tabId) {
    request.cancelled = true;
    request.controller.abort();
  }
}

async function setAISettings(patch) {
  const allowed = {};
  for (const key of [...AI_OPTION_KEYS, "allowBackgroundCapture"]) if (typeof patch?.[key] === "boolean") allowed[key] = patch[key];
  for (const [key, limit] of [["apiKey", 500], ["referenceText", 24000], ["customPrompt", 500]]) {
    if (typeof patch?.[key] === "string") allowed[key] = patch[key].trim().slice(0, limit);
  }
  if (['ai', 'trial', 'manual'].includes(patch?.videoAnswerMode)) allowed.videoAnswerMode = patch.videoAnswerMode;
  if (ANSWER_MODELS.has(patch?.model)) allowed.model = patch.model;
  cancelAIRequests();
  const write = aiSettingsWrites.then(() => chrome.storage.local.set({ ...allowed, aiRevision: `${Date.now()}:${Math.random()}` }));
  aiSettingsWrites = write.catch(() => {});
  await write;
  return { ok: true };
}

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (AI_REVISION_KEYS.some(k => changes[k])) cancelAIRequests();
  for (const request of activeAIRequests) {
    const task = changes[`task:${request.tabId}`]?.newValue;
    if (changes[`task:${request.tabId}`] && (!task || task.state !== "running" || task.runId !== request.guard.runId ||
        task.activeChapterId !== request.guard.chapterId || task.currentJobId !== request.guard.jobId)) cancelAIRequests(request.tabId);
  }
});

async function claimAISubmission(tabId, guard, key, confirmation = false) {
  if (typeof key !== "string" || !key || key.length > 250) throw new Error("提交标识无效");
  const write = aiLockWrites.then(async () => {
    await validateAIContext(tabId, guard);
    const { aiSubmissionLocks = {} } = await chrome.storage.local.get("aiSubmissionLocks");
    const previous = aiSubmissionLocks[key];
    if (confirmation ? (!previous || previous.confirmed) : Boolean(previous)) return { claimed: false, record: previous };
    const next = { ...previous, at: previous?.at || Date.now(), confirmed: confirmation };
    aiSubmissionLocks[key] = next;
    // 已提交记录保留，不以过期或新一轮开始为理由自动重新提交。
    await chrome.storage.local.set({ aiSubmissionLocks });
    return { claimed: true, record: next };
  });
  aiLockWrites = write.catch(() => {});
  return write;
}

// 截图有两条路径：
// 1. 课程页是所在窗口当前选中的标签页且窗口未最小化：用 captureVisibleTab，不要求窗口获得焦点，
//    因此把课程页单独放在一个窗口里也能截图。
// 2. 课程页被切到后台、窗口最小化或被遮挡：仅在用户开启“后台截图答题”后（调试权限随安装授予），
//    通过调试接口对这个标签页单独截图，不激活标签页、不抢焦点。
const CAPTURE_FOREGROUND_MESSAGE = "课程标签页不在前台，无法截图：请回到课程页，或把课程页单独放在一个未最小化的窗口里，或开启“后台截图答题”";
const CAPTURE_SESSION_MS = 20000;
const CAPTURE_COMMAND_MS = 10000;
const DEBUGGER_SCREENSHOT_TIMEOUT = "浏览器未在限定时间内返回后台截图";
const captureSessions = new Map();
const pendingCaptureAttaches = new Map();

async function backgroundCaptureAllowed() {
  const settings = await chrome.storage.local.get(["allowBackgroundPlayback", "allowBackgroundCapture"]);
  if (settings.allowBackgroundPlayback !== true || settings.allowBackgroundCapture !== true || !chrome.debugger) return false;
  try { return await chrome.permissions.contains({ permissions: ["debugger"] }); } catch { return false; }
}

// 只看浏览器能确认的状态：标签页在窗口中被选中且窗口没有最小化。页面自报隐藏（窗口被完全遮挡）时
// 截到的可能是旧画面，不走普通截图。
async function visibleCapturePossible(tab, pageHidden) {
  const current = await chrome.tabs.get(tab.id);
  if (!current.active || pageHidden === true) return false;
  const browserWindow = chrome.windows?.get ? await chrome.windows.get(current.windowId).catch(() => null) : null;
  return browserWindow?.state !== "minimized";
}

async function captureMode(tab, pageHidden) {
  if (await visibleCapturePossible(tab, pageHidden)) return "visible";
  if (await backgroundCaptureAllowed()) return "debugger";
  throw new Error(CAPTURE_FOREGROUND_MESSAGE);
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

async function releaseCaptureSession(tabId, expected) {
  const session = captureSessions.get(tabId);
  if (!session || (expected && session !== expected)) return;
  session.cancelled = true;
  captureSessions.delete(tabId);
  clearTimeout(session.timer);
  if (session.attached) await chrome.debugger.detach({ tabId }).catch(() => {});
}

function releaseAllCaptureSessions() {
  return Promise.all([...captureSessions.keys()].map(tabId => releaseCaptureSession(tabId)));
}

// 连接调试接口会让浏览器显示调试提示条并改变页面可视高度，所以先连接、再由页面测量题目位置。
// 同一标签页只保留一个连接；到期、出错、停止任务或关闭标签页时立即释放。
async function openCaptureSession(tab, guard) {
  const existing = captureSessions.get(tab.id);
  if (existing) {
    if (existing.runId !== guard.runId) throw new Error("后台截图暂不可用：此课程页已有截图请求，请稍后重试");
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => releaseCaptureSession(tab.id), CAPTURE_SESSION_MS);
    await existing.ready;
    return existing;
  }
  if (pendingCaptureAttaches.has(tab.id)) throw new Error("后台截图暂不可用：上次调试连接尚未结束，请稍后重试");
  const session = { runId: guard.runId, attached: false, busy: false, cancelled: false, timer: null, ready: null };
  captureSessions.set(tab.id, session);
  session.timer = setTimeout(() => releaseCaptureSession(tab.id), CAPTURE_SESSION_MS);
  session.ready = (async () => {
    try {
      const current = await chrome.tabs.get(tab.id);
      if (!/^https:\/\/[^/]+\.chaoxing\.com\//.test(current.url || "")) throw new Error("课程页面已变化");
      const attaching = chrome.debugger.attach({ tabId: tab.id }, "1.3").then(async () => {
        session.attached = true;
        // attach 本身不能取消，晚到的连接也必须释放；未结束前禁止新的连接竞争同一标签页。
        if (session.cancelled || captureSessions.get(tab.id) !== session) {
          await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
          session.attached = false;
          throw new Error("截图请求已取消");
        }
      }).finally(() => { if (pendingCaptureAttaches.get(tab.id) === attaching) pendingCaptureAttaches.delete(tab.id); });
      pendingCaptureAttaches.set(tab.id, attaching);
      await withTimeout(attaching, CAPTURE_COMMAND_MS, "调试连接超时");
      await validateAIContext(tab.id, guard);
      if (session.cancelled || !await backgroundCaptureAllowed()) throw new Error("截图请求已取消");
      // 后台标签页第一次截图时浏览器会重新绘制并可能调整页面尺寸（调试提示条也会改变可视高度）。
      // 先截一张丢弃，等页面稳定后再由页面测量题目位置，避免正式截图时布局变化。
      await withTimeout(chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }),
        CAPTURE_COMMAND_MS, DEBUGGER_SCREENSHOT_TIMEOUT);
      await new Promise(resolve => setTimeout(resolve, 300));
      await validateAIContext(tab.id, guard);
      if (session.cancelled || !await backgroundCaptureAllowed()) throw new Error("截图请求已取消");
    } catch (error) {
      await releaseCaptureSession(tab.id, session);
      // 关闭开关会先触发释放，取消原因以当前设置为准，避免提示用户去检查授权。
      const cancelled = error?.message === "截图请求已取消";
      const reason = cancelled ? (await backgroundCaptureAllowed() ? "截图请求已取消" : "后台截图设置已关闭") : debuggerFailureReason(error);
      throw new Error(`后台截图暂不可用：${reason}；当前题目会保留`);
    }
  })();
  await session.ready;
  return session;
}

// 保留失败原因的类别（不含页面内容），日志才能区分“连不上调试接口”和“浏览器不给后台页绘制画面”。
function debuggerFailureReason(error) {
  const message = error?.message || "";
  if (/Another debugger|already attached/i.test(message)) return "课程页已打开开发者工具或其他调试连接，请关闭后重新读取";
  if (message === "调试连接超时") return "调试连接超时，请回到课程页重新读取";
  if (message === DEBUGGER_SCREENSHOT_TIMEOUT) return "浏览器没有为后台标签页绘制画面（截图超时），可把课程页放在单独的窗口里，或回到课程页重新读取";
  if (/课程页面已变化|需要验证|旧结果已失效|已变化/.test(message)) return "课程页面已变化，稍后重新读取";
  if (/permission|denied|Cannot access|Cannot attach/i.test(message)) return "请检查“后台截图答题”授权，或回到课程页重新读取";
  return "调试接口返回错误，请回到课程页重新读取";
}

async function prepareCapture(tab, guard, pageHidden) {
  await validateAIContext(tab.id, guard);
  const mode = await captureMode(tab, pageHidden);
  if (mode === "debugger") await openCaptureSession(tab, guard);
  return { mode };
}

async function captureWithDebugger(tab, guard) {
  const session = await openCaptureSession(tab, guard);
  if (session.busy) throw new Error("后台截图暂不可用：此课程页已有截图请求，请稍后重试");
  session.busy = true;
  try {
    await validateAIContext(tab.id, guard);
    const result = await withTimeout(chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", {
      format: "png", fromSurface: true, captureBeyondViewport: false
    }), CAPTURE_COMMAND_MS, DEBUGGER_SCREENSHOT_TIMEOUT);
    if (!await backgroundCaptureAllowed()) throw new Error("后台截图设置已关闭");
    if (typeof result?.data !== "string" || !result.data) throw new Error("浏览器未返回图像");
    return `data:image/png;base64,${result.data}`;
  } catch (error) {
    await releaseCaptureSession(tab.id);
    if (/^后台截图暂不可用/.test(error?.message || "")) throw error;
    throw new Error(`后台截图暂不可用：${error?.message === "后台截图设置已关闭" ? "后台截图设置已关闭" : debuggerFailureReason(error)}；当前题目会保留`);
  } finally { session.busy = false; }
}

async function captureTab(tab, guard, pageHidden) {
  await validateAIContext(tab.id, guard);
  let mode = await captureMode(tab, pageHidden);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_PANEL", hidden: true }, { frameId: 0 });
    await new Promise(resolve => setTimeout(resolve, 120));
    let image;
    if (mode === "visible") {
      try {
        image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        // 截图期间课程页被切走时，截到的是别的网页，必须丢弃。
        if (!await visibleCapturePossible(tab, false)) throw new Error("截图时切换了标签页，已停止识别");
      } catch (error) {
        // 缺少工具栏授权时，已开启后台截图的用户可直接改用调试接口截图。
        if (!/activeTab|not been invoked|permission|denied/i.test(error?.message || "") || !await backgroundCaptureAllowed()) throw error;
        mode = "debugger";
      }
    }
    if (mode === "debugger") image = await captureWithDebugger(tab, guard);
    await validateAIContext(tab.id, guard);
    return image;
  } catch (error) {
    if (/activeTab|not been invoked|permission|denied/i.test(error?.message || "")) {
      throw new Error("需要截图授权：点击浏览器工具栏的扩展图标授权，再在悬浮窗点击“重新读取当前题目”。跨站跳转后可能需要重新授权；也可以开启“后台截图答题”");
    }
    throw error;
  } finally {
    await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_PANEL", hidden: false }, { frameId: 0 }).catch(() => {});
  }
}

chrome.debugger?.onDetach?.addListener((source) => {
  const session = captureSessions.get(source.tabId);
  if (!session) return;
  captureSessions.delete(source.tabId);
  clearTimeout(session.timer);
});
chrome.tabs?.onRemoved?.addListener((tabId) => { releaseCaptureSession(tabId).catch(() => {}); });
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if ((changes.allowBackgroundCapture && changes.allowBackgroundCapture.newValue !== true) ||
      (changes.allowBackgroundPlayback && changes.allowBackgroundPlayback.newValue !== true)) releaseAllCaptureSessions().catch(() => {});
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith("task:")) continue;
    const tabId = Number(key.slice(5));
    if (captureSessions.has(tabId) && (change.newValue?.state !== "running" || change.newValue?.runId !== captureSessions.get(tabId).runId)) {
      releaseCaptureSession(tabId).catch(() => {});
    }
  }
});

const ANSWER_FORMAT = "只输出 JSON 对象，格式为 {\"answers\":[{\"id\":\"题目ID\",\"choices\":[\"A\"],\"blanks\":[\"第1空答案\"]}]}。单选和判断只能选一个 choices，多选可选多个 choices；填空题 type=fill 时按 blankCount 给出相同数量的纯文本 blanks，顺序与空位一致。不要输出解释或依据。";
const ANSWER_SYSTEM = `你是课程章节练习答题助手。${ANSWER_FORMAT}仅使用给出的题干、选项、对应题号的截图和参考资料。必须为每道题返回对应的 id：实在无法判断的题目也要返回 id，并把 choices 写成空数组（填空题给出等量的空字符串），不要省略 id。不要补造选项或空位。`;
const GUESS_SYSTEM = `你是课程章节练习答题助手。${ANSWER_FORMAT}这些题目上一轮未能确定答案。请结合题干、选项、对应题号的截图、参考资料和常识，为每道题给出最可能正确的答案：choices 不得为空，填空题每个空都要填写。必须为每道题返回对应的 id，不要补造选项或空位。`;

function normalizeAnswers(raw, questions) {
  if (!raw || !Array.isArray(raw.answers)) throw new Error("DeepSeek 未返回答案列表");
  if (raw.answers.length !== questions.length || new Set(raw.answers.map(e => String(e.id))).size !== raw.answers.length) throw new Error("AI 答案数量不匹配或题号重复");
  const byId = new Map(raw.answers.map((entry) => [String(entry.id), entry]));
  return questions.map((question) => {
    const entry = byId.get(String(question.id));
    if (!entry) throw new Error(`题目 ${question.id} 未返回答案，已停止填写以免错位`);
    if (question.type === "fill") {
      if (!Number.isInteger(question.blankCount) || question.blankCount < 1 || question.blankCount > 20 ||
          !Array.isArray(entry.blanks) || entry.blanks.length !== question.blankCount) {
        throw new Error(`题目 ${question.id} 的填空答案数量不匹配`);
      }
      const blanks = entry.blanks.map((blank) => typeof blank === "string" ? blank.trim() : "");
      if (blanks.some((blank) => !blank || blank.length > 500)) {
        throw new Error(`题目 ${question.id} 的填空答案为空或过长`);
      }
      return { id: question.id, blanks };
    }
    if (!Array.isArray(entry.choices)) throw new Error(`题目 ${question.id} 未返回答案，已停止填写以免错位`);
    const choices = [...new Set(entry.choices.map((choice) => String(choice).toUpperCase().trim()))];
    if (!choices.length) throw new Error(`题目 ${question.id} 没有可用答案（模型重问后仍无法判断），已停止填写`);
    const allowed = new Set(question.options.map((option) => option.id));
    if (!choices.length || choices.some((choice) => !allowed.has(choice))) {
      throw new Error(`题目 ${question.id} 的答案不在选项中`);
    }
    if (question.type !== "multiple" && choices.length !== 1) {
      throw new Error(`题目 ${question.id} 应只有一个答案`);
    }
    return { id: question.id, choices };
  });
}

function selectReference(referenceText, questions) {
  const reference = String(referenceText || "").trim().slice(0, 24000);
  if (reference.length <= 1500) return reference;
  const query = questions.map((question) => [question.stem,
    ...(question.options || []).map((option) => option.text)].join(" "))
    .join(" ").replace(/\[[^\]]*见截图[^\]]*\]/g, "").toLowerCase();
  const terms = new Set();
  for (const word of query.match(/[\p{Script=Han}a-z0-9]+/gu) || []) {
    for (let index = 0; index + 3 <= word.length; index++) terms.add(word.slice(index, index + 3));
  }
  if (!terms.size) return "";
  const chunks = [];
  let order = 0;
  for (const line of reference.split(/\n+/).map((item) => item.trim()).filter(Boolean)) {
    for (let offset = 0; offset < line.length; offset += 460) {
      const text = line.slice(offset, offset + 500);
      const lower = text.toLowerCase();
      const score = [...terms].reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      if (score) chunks.push({ order, text, score });
      order++;
    }
  }
  return chunks.sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 3).sort((a, b) => a.order - b.order)
    .map((chunk) => chunk.text).join("\n");
}

function recordApiUsage(data, kind, tabId, model) {
  const usage = data?.usage;
  if (!usage || typeof usage !== "object") return;
  const details = {
    kind,
    model: ANSWER_MODELS.has(model) ? model : undefined,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens ??
      (Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens) ?
        usage.prompt_tokens + usage.completion_tokens : undefined)
  };
  if (![details.promptTokens, details.completionTokens, details.totalTokens]
    .some((value) => Number.isSafeInteger(value) && value >= 0)) return;
  appendDiagnostic("usage", details, tabId).catch(() => {});
}

async function readAIResponse(response) {
  if (!response.headers?.get('content-type')?.includes('text/event-stream')) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '', finishReason, usage, done = false;
  function line(value) {
    if (!value.startsWith('data:')) return;
    const text = value.slice(5).trim();
    if (text === '[DONE]') { done = true; return; }
    const chunk = JSON.parse(text);
    if (chunk.error) throw new Error('答题接口返回错误，请稍后重试');
    content += chunk.choices?.[0]?.delta?.content || '';
    finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
    usage = chunk.usage || usage;
    if (content.length > 1000000) throw new Error('答题接口返回内容过长');
  }
  try {
    while (!done) {
      const part = await reader.read();
      buffer += decoder.decode(part.value, { stream: !part.done });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const value of lines) { line(value); if (done) break; }
      if (buffer.length > 1000000) throw new Error('答题接口返回内容过长');
      if (part.done) { if (buffer) line(buffer); break; }
    }
    if (!done || !finishReason) throw new Error('答题接口响应中断，请稍后重试');
    return { choices: [{ message: { content }, finish_reason: finishReason }], usage };
  } finally { await reader.cancel().catch(() => {}); }
}

async function answerQuestions(questions, images = [], tabId, guard) {
  await validateAIContext(tabId, guard);
  if (!Array.isArray(questions) || !questions.length || questions.length > 100 || new Set(questions.map(q => q.id)).size !== questions.length) throw new Error("题目数量或编号无效");
  const { apiKey, model, referenceText, customPrompt } = await chrome.storage.local.get(["apiKey", "model", "referenceText", "customPrompt"]);
  if (!apiKey) throw new Error("请先在扩展中填写答题接口密钥");
  const imageIds = new Set(images.map((item) => String(item.id)));
  if (images.length !== imageIds.size || questions.some((question) => question.needsImage !== imageIds.has(String(question.id)))) {
    throw new Error("加密题截图不完整，停止答题");
  }
  if (images.some((item) => !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(item.image || ""))) {
    throw new Error("题目截图格式无效，停止答题");
  }
  // 保存过的旧模型名或拼错的名字不再原样发送，否则接口只会回 400，而提示会误指向密钥或余额。
  const resolvedModel = images.length ? VISION_MODEL : (ANSWER_MODELS.has(model) ? model : TEXT_MODEL);
  const parsed = await requestAnswers({ apiKey, model: resolvedModel, questions, images, referenceText, customPrompt, system: ANSWER_SYSTEM, tabId, guard });
  // 模型对个别题给出空答案时，只把这几道题再问一次并要求给出最可能的答案，避免整份测验停下转人工。
  const unsure = Array.isArray(parsed?.answers)
    ? questions.filter((question) => isEmptyAnswer(question, parsed.answers.find((entry) => String(entry?.id) === String(question.id))))
    : [];
  if (unsure.length) {
    const unsureIds = new Set(unsure.map((question) => String(question.id)));
    const retry = await requestAnswers({ apiKey, model: resolvedModel, questions: unsure,
      images: images.filter((item) => unsureIds.has(String(item.id))), referenceText, customPrompt, system: GUESS_SYSTEM, tabId, guard });
    const retried = new Map((Array.isArray(retry?.answers) ? retry.answers : [])
      .filter((entry) => unsureIds.has(String(entry?.id))).map((entry) => [String(entry.id), entry]));
    parsed.answers = parsed.answers.map((entry) => retried.get(String(entry?.id)) || entry);
  }
  return normalizeAnswers(parsed, questions);
}

function isEmptyAnswer(question, entry) {
  if (!entry) return false;
  if (question.type === "fill") return Array.isArray(entry.blanks) && entry.blanks.some((blank) => typeof blank !== "string" || !blank.trim());
  return Array.isArray(entry.choices) && entry.choices.every((choice) => !String(choice ?? "").trim());
}

async function requestAnswers({ apiKey, model, questions, images, referenceText, customPrompt, system, tabId, guard }) {
  const prompt = {
    questions: questions.map(({ id, type, stem, options, blankCount }) => ({ id, type, stem, options, blankCount }))
  };
  const reference = selectReference(referenceText, questions);
  if (reference) prompt.reference = reference;
  const instruction = String(customPrompt || "").trim().slice(0, 500);
  if (instruction) prompt.instruction = instruction;
  const userContent = images.length ? [
    { type: "text", text: `请根据下列题目截图和题号作答。题干或选项标注“见截图”时，以截图为准。\n${JSON.stringify(prompt)}` },
    ...images.flatMap(({ id, image }) => [
      { type: "text", text: `题目 ID ${id} 的完整截图` },
      { type: "image_url", image_url: { url: image, detail: "original" } }
    ])
  ] : JSON.stringify(prompt);
  const controller = new AbortController();
  // 流式响应尽早返回响应头；25 秒仍未收到响应头则主动结束，避免超出 Chrome 的 fetch 等待限制。
  const headerTimeout = setTimeout(() => controller.abort(), 25000);
  const timeout = setTimeout(() => controller.abort(), 120000);
  const request = { controller, tabId, guard };
  activeAIRequests.add(request);
  // 仅在请求期间维持工作线程，并持续核对运行状态；结束时立即清理。
  const heartbeat = setInterval(() => {
    assertAIRequest(tabId, guard).catch(() => { request.cancelled = true; controller.abort(); });
  }, 15000);
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent }
        ]
      }),
      signal: controller.signal
    });
    clearTimeout(headerTimeout);
    if (!response.ok) {
      const detail = "";
      const failure = new Error(`答题接口请求失败，状态码 ${response.status}${detail}，请检查密钥、余额、模型名称或网络`);
      failure.httpStatus = response.status;
      throw failure;
    }
    let data;
    try {
      data = await readAIResponse(response);
    } catch (error) {
      if (error?.name === 'AbortError' || /^答题接口/.test(error?.message || '')) throw error;
      throw new Error(`答题接口返回了无法解析的内容（状态码 ${response.status}），请检查网络或代理`);
    }
    recordApiUsage(data, "answer", tabId, model);
    const content = data.choices?.[0]?.message?.content;
    if (!content || data.choices?.[0]?.finish_reason === "length") throw new Error("DeepSeek 返回内容不完整");
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error("DeepSeek 返回的 JSON 无法解析"); }
    await validateAIContext(tabId, guard);
    return parsed;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(request.cancelled ? "AI 操作已取消，旧结果已失效" : "答题接口等待超时，请稍后重试");
    if (error?.httpStatus) {
      appendDiagnostic("error", { source: "background", message: error.message, httpStatus: error.httpStatus }, tabId).catch(() => {});
      throw error;
    }
    if (/^答题接口/.test(error?.message || "")) throw error;
    if (/[㐀-鿿]/.test(error?.message || "")) throw error;
    throw new Error("答题接口连接失败，请检查网络后重试");
  } finally {
    // 超时定时器必须覆盖读取响应正文的阶段，否则服务端返回响应头后卡住就再也不会超时。
    clearTimeout(timeout);
    clearTimeout(headerTimeout);
    clearInterval(heartbeat);
    activeAIRequests.delete(request);
  }
}


async function runBlankEditorAction(sender, questionId, blanks, mode, guard, expected) {
  await validateAIContext(sender.tab?.id, guard);
  if (sender.frameId !== guard.frameId || !sender.documentId || typeof expected !== "string" || !expected) throw new Error("填空框架已变化");
  if (!sender.tab?.id || !Number.isInteger(sender.frameId) ||
      !Array.isArray(blanks) || blanks.length > 20 ||
      blanks.some((blank) => typeof blank !== "string" || !blank.trim() || blank.length > 500)) {
    throw new Error("填空请求无效，停止填写");
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
    world: "MAIN",
    func: blankEditorAction,
    args: [String(questionId), blanks, mode, expected]
  });
  if (results.length !== 1 || !results[0].result) throw new Error("填空编辑器未返回核对结果");
  return results[0].result;
}


async function handleAIMessage(message, sender) {
  const tabId = sender.tab?.id;
  if (message.type === "SET_AI_SETTINGS") return setAISettings(message.patch);
  if (message.type === "CANCEL_AI") { cancelAIRequests(tabId); return { ok: true }; }
  if (message.type === "VIDEO_TRIAL_VALIDATE") { await validateVideoTrialContext(tabId, message.guard); return { ok: true }; }
  if (message.type === "AI_VALIDATE") { await validateAIContext(tabId, message.guard); return { ok: true }; }
  if (message.type === "AI_CLAIM_SUBMISSION") return claimAISubmission(tabId, message.guard, message.key, message.confirmation === true);
  if (message.type === "ANSWER") return answerQuestions(message.questions, message.images, tabId, message.guard);
  if (message.type === "CAPTURE_PREPARE") return prepareCapture(sender.tab, message.guard, message.pageHidden === true);
  if (message.type === "CAPTURE_TAB") return captureTab(sender.tab, message.guard, message.pageHidden === true);
  if (message.type === "CAPTURE_RELEASE") { await releaseCaptureSession(tabId); return { ok: true }; }
  if (message.type === "FILL_BLANKS" || message.type === "VERIFY_BLANKS") {
    return runBlankEditorAction(sender, message.questionId, message.blanks, message.type === "FILL_BLANKS" ? "fill" : "verify", message.guard, message.expected);
  }
  throw new Error("未知 AI 消息类型");
}
