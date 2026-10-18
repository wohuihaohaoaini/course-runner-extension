const $ = (id) => document.getElementById(id);
const JOB_TYPE = { video: "视频", audio: "音频", document: "文档", quiz: "测验", book: "阅读", link: "链接", other: "其他" };
let tabId;
let timer;

function displayError(error) {
  const message = error?.message || String(error);
  if (/Could not establish connection|Receiving end does not exist|message port closed/i.test(message)) {
    return "扩展与课程页连接已断开，请刷新课程标签页后重试";
  }
  return /[㐀-鿿]/.test(message) ? message : "操作失败，请导出日志并反馈";
}

async function currentTask() {
  if (!tabId) return null;
  const key = `task:${tabId}`;
  return (await chrome.storage.local.get(key))[key] || null;
}

async function render() {
  const task = await currentTask();
  const state = task?.state || "idle";
  const waiting = state === "running" && task?.phase === "waiting";
  $("indicator").textContent = waiting ? "等你处理" : ({ running: "运行中", paused: "已暂停", error: "需处理", completed: "已完成" })[state] || "待启动";
  $("status").textContent = task?.status ? displayError({ message: task.status }) : "打开超星课程目录或章节学习页后开始。学习页右下角也有悬浮面板。";
  $("start").disabled = state === "running";
  $("pause").disabled = state !== "running";
  const stored = await chrome.storage.local.get(["muted", "todos"]);
  renderMute(stored.muted === true);
  renderTodos(Array.isArray(stored.todos) ? stored.todos : []);
  await renderAISwitches();
}

function renderTodos(todos) {
  $("todoCount").textContent = String(todos.length);
  const list = $("todos");
  if (!list.replaceChildren) return;
  list.replaceChildren(...todos.slice().reverse().map((item) => {
    const row = document.createElement("li");
    const title = document.createElement(item.url ? "a" : "span");
    title.textContent = item.chapterName || "某一节";
    if (item.url) {
      title.href = item.url;
      title.addEventListener("click", (event) => {
        event.preventDefault();
        chrome.tabs.update(tabId, { url: item.url }).catch(showError);
      });
    }
    row.append(title, document.createTextNode(`：${JOB_TYPE[item.type] || ""}${item.jobName ? ` ${item.jobName}` : ""}（${item.reason}）`));
    return row;
  }));
}

async function sendToPage(type) {
  if (!tabId) throw new Error("未找到当前标签页");
  const result = await chrome.tabs.sendMessage(tabId, { type }, { frameId: 0 });
  if (result?.error) throw new Error(result.error);
  if (result?.ok !== true) throw new Error("课程页未确认操作，请打开课程目录或学习页，刷新页面后重试");
  await render();
}

function showError(error) {
  const message = error.message || String(error);
  chrome.runtime.sendMessage({ type: "DIAG_LOG", event: "error", tabId, details: { source: "popup", message } }).catch(() => {});
  $("message").textContent = displayError(error);
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
    const settings = await chrome.storage.local.get(["jumpMode", "quizMode", "notify", "collapseCourseSidebar"]);
    $("jumpMode").value = settings.jumpMode === "stop" ? "stop" : "unfinished";
    $("quizMode").value = settings.quizMode === "wait" ? "wait" : "skip";
    $("notify").checked = settings.notify !== false;
    $("collapseCourseSidebar").checked = settings.collapseCourseSidebar === true;
    await renderAISettings();
    await renderBackgroundSettings();
    timer = setInterval(render, 1500);
  } catch (error) { showError(error); }
});

function renderMute(muted) {
  $("mute").setAttribute?.("aria-pressed", String(muted));
  $("mute").textContent = muted ? "🔇 已静音" : "🔊 静音";
}

async function toggleMute() {
  const { muted } = await chrome.storage.local.get("muted");
  const next = muted !== true;
  await chrome.storage.local.set({ muted: next });
  renderMute(next);
}

window.addEventListener("unload", () => clearInterval(timer));
$("start").addEventListener("click", () => sendToPage("START").then(() => window.close()).catch(showError));
$("pause").addEventListener("click", () => sendToPage("PAUSE").catch(showError));
$("mute").addEventListener("click", () => toggleMute().catch(showError));
$("jumpMode").addEventListener("change", () => chrome.storage.local.set({ jumpMode: $("jumpMode").value }));
$("quizMode").addEventListener("change", () => chrome.storage.local.set({ quizMode: $("quizMode").value }));
$("collapseCourseSidebar").addEventListener("change", () => chrome.storage.local.set({ collapseCourseSidebar: $("collapseCourseSidebar").checked }));
$("videoAnswerMode").addEventListener("change", () => saveAISettings({ videoAnswerMode: $("videoAnswerMode").value }).catch(showError));
async function hasDebuggerPermission() {
  try { return await chrome.permissions.contains({ permissions: ["debugger"] }); } catch { return false; }
}

// 设置与实际权限保持一致：权限被撤销时取消勾选。
async function renderBackgroundSettings() {
  const settings = await chrome.storage.local.get(["allowBackgroundPlayback", "allowBackgroundCapture"]);
  const granted = await hasDebuggerPermission();
  if (settings.allowBackgroundCapture === true && !granted) await saveAISettings({ allowBackgroundCapture: false });
  $("allowBackgroundPlayback").checked = settings.allowBackgroundPlayback === true;
  $("allowBackgroundCapture").checked = settings.allowBackgroundCapture === true && granted;
}

async function disableBackgroundCapture() {
  await saveAISettings({ allowBackgroundCapture: false });
  $("allowBackgroundCapture").checked = false;
}

$("allowBackgroundCapture").addEventListener("change", async () => {
  const requested = $("allowBackgroundCapture").checked;
  try {
    if (requested) {
      // Chrome 不允许把“调试程序”列为可选权限，它随安装授予；功能是否使用仍只由这个开关决定。
      if (!(await hasDebuggerPermission())) throw new Error("浏览器未提供调试程序权限：文字题仍可后台处理，图片题请回到课程页或把课程页单独放在一个窗口里");
      await chrome.storage.local.set({ allowBackgroundPlayback: true });
      await saveAISettings({ allowBackgroundCapture: true });
      $("allowBackgroundPlayback").checked = true;
      $("message").textContent = "后台截图答题已开启；图片题仍需开启 AI 并保存你自己的密钥";
    } else {
      await disableBackgroundCapture();
      $("message").textContent = "后台截图答题已关闭，不会再连接课程标签页";
    }
  } catch (error) {
    await renderBackgroundSettings().catch(() => {});
    showError(error);
  }
});
$("allowBackgroundPlayback").addEventListener("change", async () => {
  const enabled = $("allowBackgroundPlayback").checked;
  try {
    await chrome.storage.local.set({ allowBackgroundPlayback: enabled });
    // 后台截图依赖后台播放；关闭后台播放时一并关闭截图并撤销权限。
    if (!enabled && $("allowBackgroundCapture").checked) await disableBackgroundCapture();
    $("message").textContent = enabled ? "已允许后台播放" : "已关闭后台播放，课程页需保持在前台";
  } catch (error) { showError(error); }
});
$("notify").addEventListener("change", () => chrome.storage.local.set({ notify: $("notify").checked }));
$("clearTodos").addEventListener("click", async () => {
  await chrome.storage.local.remove("todos");
  $("message").textContent = "“待你处理”清单已清空";
  await render();
});
$("exportLogs").addEventListener("click", async () => {
  try {
    let snapshot = null;
    if (tabId) snapshot = await chrome.runtime.sendMessage({ type: "DIAG_SNAPSHOT", tabId });
    if (snapshot?.error) throw new Error(snapshot.error);
    const report = await chrome.runtime.sendMessage({ type: "DIAG_EXPORT" });
    if (report?.error) throw new Error(report.error);
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `course-runner-log-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $("message").textContent = snapshot && snapshot.respondingFrames === 0 ?
      `已导出 ${report.records.length} 条日志；但当前页面没有检测到课程页脚本，请刷新课程页后重试` :
      `已导出 ${report.records.length} 条日志`;
  } catch (error) { showError(error); }
});
$("clearLogs").addEventListener("click", async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: "DIAG_CLEAR" });
    if (result?.error) throw new Error(result.error);
    $("message").textContent = "本机诊断日志已清除";
  } catch (error) { showError(error); }
});

async function renderAISwitches() {
  const values = await chrome.storage.local.get(["aiEnabled", "aiVideoEnabled", "aiQuizEnabled", "autoSubmit", "videoAnswerMode"]);
  $("videoAnswerMode").value = ["trial", "manual"].includes(values.videoAnswerMode) ? values.videoAnswerMode : "ai";
  $("aiEnabled").checked = values.aiEnabled === true;
  $("aiVideoEnabled").checked = values.aiVideoEnabled !== false;
  $("aiQuizEnabled").checked = values.aiQuizEnabled !== false;
  $("autoSubmit").checked = values.autoSubmit === true;
  $("aiHint").textContent = values.aiEnabled === true
    ? `AI 已开启。${values.aiQuizEnabled === false ? "“章节测验”分项未勾选，遇到测验仍按“AI 关闭时”的规则处理。" : ""}运行中关闭会取消尚未完成的 AI 操作；已提交的内容无法撤回。`
    : "AI 已关闭。视频顺序试答仍可独立运行；请在“运行设置”选择。章节测验默认仅填写。";
}
async function renderAISettings() {
  const values = await chrome.storage.local.get(["apiKey", "model", "referenceText", "customPrompt"]);
  $("apiKey").placeholder = values.apiKey ? "已保存（输入新值可替换）" : "sk-…";
  $("model").value = ["deepseek-v4-pro", "deepseek-flash"].includes(values.model) ? values.model : "deepseek-flash";
  $("reference").value = values.referenceText || "";
  $("customPrompt").value = values.customPrompt || "";
  await render();
}
async function saveAISettings(patch) {
  const result = await chrome.runtime.sendMessage({ type: "SET_AI_SETTINGS", patch });
  if (result?.error) throw new Error(result.error);
  if (!result?.ok) throw new Error("AI 设置未保存，请重新加载扩展");
  await renderAISwitches();
}
for (const key of ["aiEnabled", "aiVideoEnabled", "aiQuizEnabled", "autoSubmit"]) {
  $(key).addEventListener("change", () => saveAISettings({ [key]: $(key).checked }).catch(showError));
}
$("model").addEventListener("change", () => saveAISettings({ model: $("model").value }).catch(showError));
$("saveKey").addEventListener("click", async () => {
  try {
    const apiKey = $("apiKey").value.trim();
    if (!apiKey) throw new Error("请填写接口密钥");
    await saveAISettings({ apiKey }); $("apiKey").value = "";
    $("apiKey").placeholder = "已保存（输入新值可替换）";
    $("message").textContent = "接口密钥已保存到本机";
  } catch (error) { showError(error); }
});
$("clearKey").addEventListener("click", () => saveAISettings({ apiKey: "" }).then(() => {
  $("apiKey").value = ""; $("apiKey").placeholder = "sk-…"; $("message").textContent = "本机接口密钥已删除";
}).catch(showError));
$("saveReference").addEventListener("click", () => saveAISettings({ referenceText: $("reference").value }).then(() => { $("message").textContent = "课程资料已保存"; }).catch(showError));
$("savePrompt").addEventListener("click", () => saveAISettings({ customPrompt: $("customPrompt").value }).then(() => { $("message").textContent = "提示词已保存"; }).catch(showError));
