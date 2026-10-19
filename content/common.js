// 公共常量与工具函数。content/ 下的脚本按 manifest.json 中的顺序注入同一个隔离环境，
// 顶层声明彼此可见，所以这里的函数可以被后续文件直接调用。

// 超星有两套部署路径：/mooc-ans/mycourse/... 和 /mycourse/...（例如 mooc1.chaoxing.com/mycourse/studentstudy）。
const RUNNER_URL = /(?:\/mooc-ans)?\/mycourse\/studentstudy/i;
const DIRECTORY_URL = /(?:\/mooc-ans)?\/mycourse\/studentcourse/i;
const QUIZ_URL = /\/(?:mooc-ans\/)?(?:api\/)?work\b/i;
const CARDS_URL = /(?:\/mooc-ans)?\/knowledge\/cards/i;
const VIDEO_URL = /\/ananas\/modules\/video\/index\.html/i;
const AUDIO_URL = /\/ananas\/modules\/audio\/index\.html/i;
const DOCUMENT_URL = /\/ananas\/modules\/pdf\/index\.html/i;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const AI_DOCUMENT = `${Date.now()}:${Math.random()}`;
const SCREEN_URL = /^\/screen\//i;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const visible = (element) => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
const textOf = (element) => clean(element?.innerText || element?.textContent);
const isRunnerPage = () => RUNNER_URL.test(location.pathname);
const isVideoPage = () => VIDEO_URL.test(location.pathname);
const isMediaPage = () => VIDEO_URL.test(location.pathname) || AUDIO_URL.test(location.pathname);

// 只在课程目录页和章节学习页的最外层运行运行器和悬浮面板。
function isStartablePage() {
  const path = location.pathname;
  return RUNNER_URL.test(path) || DIRECTORY_URL.test(path);
}

// 跨域父框架读取 frameElement 会得到 null（不抛错）。null 只说明无法判断，按可见处理。
function frameVisible() {
  for (let current = window; current !== current.top; current = current.parent) {
    const frame = current.frameElement;
    if (frame && !visible(frame)) return false;
  }
  return true;
}

function findButton(pattern, root = document) {
  return [...root.querySelectorAll("button, a, input[type='button'], input[type='submit']")]
    // 先比文字再算可见性：getComputedStyle 比文字匹配贵得多，每轮探测都会调用。
    .find((element) => pattern.test(textOf(element) || element.value || "") && visible(element));
}

// 隔离环境里点到 javascript: 链接（或其中的子元素）会被扩展 CSP 拦截，交给页面主环境的
// click-bridge.js 去点；其他元素以及点击桥不在时照常直接点击。
const JAVASCRIPT_URL = /^\s*javascript:/i;
function pageClick(element) {
  const link = element.closest?.("a[href], area[href]");
  if (link && JAVASCRIPT_URL.test(link.getAttribute("href"))) {
    const view = element.ownerDocument?.defaultView;
    const EventType = view?.CustomEvent || CustomEvent;
    if (!element.dispatchEvent(new EventType("course-runner-click", { cancelable: true }))) return;
  }
  element.click();
}

function displayError(error) {
  const message = error?.message || String(error);
  if (/Could not establish connection|Receiving end does not exist|message port closed/i.test(message)) {
    return "扩展与课程页连接已断开，请刷新课程页后重试";
  }
  return /[㐀-鿿]/.test(message) ? message : "运行时发生错误，请导出日志并反馈";
}

// ---- 脱敏诊断 ----

// 脱敏后的页面路径：只保留路由形状，数字和长十六进制段替换为 #，不含查询参数。
function pathPattern() {
  return location.pathname.toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "#")
    .replace(/\d+/g, "#")
    .replace(/[^a-z0-9#/._-]/g, "")
    .slice(0, 120);
}

function queryKeys() {
  return [...new Set([...new URLSearchParams(location.search).keys()])]
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(key))
    .sort().slice(0, 20).join(",");
}

function recordDiagnostic(event, details = {}) {
  try {
    return chrome.runtime.sendMessage({ type: "DIAG_LOG", event, details }).catch(() => {});
  } catch { /* extension may have been reloaded */
    return Promise.resolve();
  }
}

function safeSelectorHints() {
  const structural = /video|player|quiz|work|question|answer|option|choice|timu|title|job|chapter|course|class|unit|document|pdf|screen|iframe|submit|next|content|main|root|topic|ans/i;
  const values = new Set();
  for (const element of document.querySelectorAll("[id], [class]")) {
    if (element.id && structural.test(element.id)) values.add(`#${element.id}`);
    for (const name of element.classList || []) if (structural.test(name)) values.add(`.${name}`);
  }
  return [...values]
    .filter((value) => value.length <= 60 && /^[.#][A-Za-z_-][A-Za-z0-9_-]*$/.test(value) && !/\d{4,}/.test(value))
    .sort()
    .slice(0, 100);
}

function urlKind(path = location.pathname.toLowerCase()) {
  return RUNNER_URL.test(path) ? "runner" : DIRECTORY_URL.test(path) ? "directory" :
    QUIZ_URL.test(path) ? "quiz" : VIDEO_URL.test(path) ? "video" : AUDIO_URL.test(path) ? "audio" :
    CARDS_URL.test(path) ? "cards" :
    DOCUMENT_URL.test(path) ? "document" : SCREEN_URL.test(path) ? "screen" : "other";
}

const selectorCounts = (selectors) =>
  selectors.map((selector) => `${selector}:${document.querySelectorAll(selector).length}`).join(",");

let lastStructureSignature = "";
let lastStructureScan = { at: 0, href: "" };
const STRUCTURE_SCAN_INTERVAL = 30000;
// 结构记录要遍历整页元素，运行器每 3 秒向每一层框架探测一次，每次都扫太浪费。
// 同一地址 30 秒内只扫一次；导出日志时 force 强制重扫，保证日志是最新结构。
function structureDiagnostic(force = false) {
  if (!force && lastStructureScan.href === location.href && Date.now() - lastStructureScan.at < STRUCTURE_SCAN_INTERVAL) {
    return Promise.resolve();
  }
  lastStructureScan = { at: Date.now(), href: location.href };
  const path = location.pathname.toLowerCase();
  const summary = {
    frame: window === top ? 0 : -1,
    active: frameVisible(),
    pathDepth: path.split("/").filter(Boolean).length,
    pathPattern: pathPattern(),
    queryKeys: queryKeys(),
    hostKind: /\.chaoxing\.com$/i.test(location.hostname) ? "chaoxing" : "other",
    imageCount: document.images.length,
    videoCount: document.querySelectorAll("video").length,
    jobFrames: CARDS_URL.test(path) ? pageJobs().length : 0,
    catalogChapters: window === top ? catalogChapters().length : 0,
    visibleButtons: [...document.querySelectorAll("button, a, input[type='button'], input[type='submit']")].filter(visible).length,
    iframes: document.querySelectorAll("iframe").length,
    urlKind: urlKind(path),
    bodyClassKind: [...(document.body?.classList || [])].filter((name) => /^[A-Za-z_-][A-Za-z0-9_-]{0,50}$/.test(name)).slice(0, 20).join(","),
    videoSelector: selectorCounts(["#video_html5_api", ".vjs-big-play-button", "video"]),
    videoQuizSelector: selectorCounts(VIDEO_QUESTION_SELECTORS),
    tabSelector: selectorCounts(["[id^='dct']", ".prev_ul li", ".prev_tab"]),
    catalogSelector: selectorCounts(["[onclick^='getTeacherAjax']", ".posCatalog_select", ".posCatalog_active", "#coursetree", "input.jobUnfinishCount", "#curChapterId"]),
    attentionSelector: selectorCounts(["#fcqrimg", ".chapterVideoFaceMaskDiv", "#chapterVerificationCode", ".vjs-modal-dialog-content", ".vjs-error"]),
    documentSelector: selectorCounts(["#dct1", "#dct2", "img"]),
    taskSelector: selectorCounts([".ans-job-icon", ".ans-job-video", ".ans-job-finished", ".ans-attach-ct", "iframe[data]", "iframe[module]"]),
    quizSelector: selectorCounts(['.TiMu', '.newTiMu', '.singleQuesId', '.num_option', '.num_option_dx', "input[type='radio']", "input[type='checkbox']", "input[type='hidden'][name^='answer']"]),
    questionCount: QUIZ_URL.test(path) ? getQuestionElements().length : 0,
    submitConfirmKind: quizSubmitConfirmation() ? 'quiz' : topSubmitConfirmation() ? 'top' : document.querySelector('#workpop') ? 'top-hidden' : 'none',
    visibleTextKinds: [...document.querySelectorAll("button, a")].filter(visible).map((item) => {
      const text = textOf(item);
      return /提交|交卷/.test(text) ? "submit" : /下一节|下一章/.test(text) ? "next" : /视频/.test(text) ? "video" : /测验|练习|测试/.test(text) ? "quiz" : "other";
    }).filter((value, index, list) => list.indexOf(value) === index).join(","),
    selectorHints: safeSelectorHints()
  };
  const signature = JSON.stringify(summary);
  if (signature === lastStructureSignature) return Promise.resolve();
  lastStructureSignature = signature;
  return recordDiagnostic("structure", summary);
}
