// 页面状态识别：视频、任务点、目录树、文档、课程目录。只读 DOM，不做任何点击。

// ---- 视频 ----
function currentVideo() {
  const player = document.querySelector("#video_html5_api");
  if (visible(player)) return player;
  const visibleVideo = [...document.querySelectorAll(isMediaPage() ? "video, audio" : "video")].find((video) => visible(video));
  if (visibleVideo) return visibleVideo;
  // 视频模块页偶尔把播放器放在尚未完成布局或隐藏的容器里，此时按是否已加载媒体数据判断，
  // 避免整节视频被误判为“没有播放器”。只在视频模块页生效，避免误选学习页上的其它 video。
  if (!isMediaPage()) return null;
  return [...document.querySelectorAll("video, audio")].find((video) =>
    (video.currentSrc || video.getAttribute("src")) && video.readyState >= 1) || null;
}

function videoInfo() {
  const video = currentVideo();
  if (!video) return null;
  return {
    kind: "video",
    paused: video.paused,
    ended: video.ended,
    time: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    ready: video.readyState >= 2,
    error: video.error?.message || null
  };
}

function initialPlayButton() {
  if (!isMediaPage()) return null;
  const button = document.querySelector(".vjs-big-play-button");
  return visible(button) ? button : null;
}

// ---- 本节剩余任务数（左侧目录当前节） ----
function currentTreeTaskState() {
  if (!RUNNER_URL.test(location.pathname)) return null;
  const active = catalogChapters().find((chapter) => chapter.active);
  if (active && active.unfinished !== null) return { kind: active.unfinished ? "remaining" : "complete", count: active.unfinished };
  const node = document.querySelector("#coursetree h4.currents, #coursetree h5.currents");
  if (!node) return null;
  const own = (selector) => [...node.querySelectorAll(selector)]
    .filter((element) => element.closest("h4, h5") === node);
  const badges = own("span.jobCount, span.roundpointStudent, span.roundpoint");
  const inputs = own("input.jobUnfinishCount");
  if (badges.length > 1 || inputs.length > 1) return { kind: "unknown", count: null };
  const badge = badges[0];
  const countInput = inputs[0];
  const rawCount = countInput?.value;
  const count = rawCount !== undefined && /^\d+$/.test(String(rawCount)) ? Number(rawCount) : null;
  const badgeKind = !badge ? null : badge.classList.contains("noJob") ||
    /jobfinished\.png/i.test(getComputedStyle(badge).backgroundImage) ? "complete" :
    badge.classList.contains("orange01") || badge.classList.contains("jobCount") ? "remaining" : "unknown";
  if (count !== null && badgeKind && badgeKind !== (count ? "remaining" : "complete")) {
    return { kind: "unknown", count: null };
  }
  if (count !== null) return { kind: count ? "remaining" : "complete", count };
  if (badgeKind === "complete") return { kind: "complete", count: 0 };
  if (badgeKind === "remaining") {
    const value = clean(badge.textContent);
    return { kind: "remaining", count: /^\d+$/.test(value) ? Number(value) : null };
  }
  return { kind: "unknown", count: null };
}

function jobFinishBlocked() {
  if (!RUNNER_URL.test(location.pathname)) return false;
  return visible(document.querySelector("#jobFinishTip")) ||
    visible(document.querySelector(".maskDiv.jobFinishTip")) ||
    visible(document.querySelector("#freezePageInfo"));
}

// ---- 文档 ----
function documentReader() {
  if (!SCREEN_URL.test(location.pathname) || !frameVisible()) return null;
  if (document.querySelectorAll("img").length < 2) return null;
  const elements = [...new Set([
    document.scrollingElement, document.documentElement, document.body,
    ...document.querySelectorAll("div, section, main")
  ])].filter((element) => element && element.clientHeight > 100 &&
    element.scrollHeight > element.clientHeight + 20 && element.querySelectorAll("img").length >= 2);
  elements.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  const element = elements[0];
  if (!element) return null;
  return { element, state: {
    atBottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 4,
    pageCount: document.querySelectorAll("img").length
  } };
}

// ---- 课程目录 ----
// 新版学习页用 getTeacherAjax 局部刷新换节，地址栏的 chapterId 不一定跟着变，
// 所以优先读页面上的 #curChapterId（OCS 也是这样取的）。
function chapterId() {
  if (!RUNNER_URL.test(location.pathname)) return null;
  const current = clean(document.querySelector("#curChapterId")?.value);
  return current || new URLSearchParams(location.search).get("chapterId");
}

// ---- 左侧目录（借鉴 OCS 的 getChapterInfos）----
// 每个小节是一个 onclick="getTeacherAjax('课程','班级','小节')" 的元素，旁边的 input.jobUnfinishCount
// 是这一节还没完成的任务点数。读到它就能直接在学习页里换节，不必每节都退回课程目录页。
function catalogChapters() {
  if (!RUNNER_URL.test(location.pathname)) return [];
  const pageCurrent = clean(document.querySelector("#curChapterId")?.value);
  const urlCurrent = new URLSearchParams(location.search).get("chapterId");
  const items = [...document.querySelectorAll("[onclick^='getTeacherAjax']")].map((element) => {
    const id = element.getAttribute("onclick").match(/getTeacherAjax\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'([^']+)'/)?.[1];
    if (!id) return null;
    const row = element.closest(".posCatalog_select, h4, h5, li") || element.parentElement;
    const input = row?.querySelector("input.jobUnfinishCount") || element.parentElement?.querySelector("input.jobUnfinishCount");
    const raw = clean(input?.value);
    return {
      id,
      element,
      name: clean(element.getAttribute("title") || textOf(element)).slice(0, 60),
      unfinished: /^\d+$/.test(raw) ? Number(raw) : null,
      highlighted: Boolean(row?.classList.contains("posCatalog_active") || row?.classList.contains("currents"))
    };
  }).filter(Boolean);
  // 当前小节只认一个来源：页内换节时高亮样式和 #curChapterId 不一定同时更新，
  // 两行同时算“当前”会读到上一节的完成数，把本节误判为已完成。
  // 优先 #curChapterId，其次高亮样式，最后才是地址栏（页内换节后地址栏可能还是旧的）。
  const anyHighlighted = items.some((item) => item.highlighted);
  return items.map(({ highlighted, ...item }) => ({ ...item,
    active: pageCurrent ? item.id === pageCurrent : anyHighlighted ? highlighted : item.id === urlCurrent }));
}

function catalogSummary() {
  return catalogChapters().map(({ id, name, unfinished, active }) => ({ id, name, unfinished, active }));
}

// 闯关 / 解锁模式：目录里有小旗帜图标。
function catalogLocked() {
  return Boolean(document.querySelector(".catalog_points_sa, .catalog_points_er"));
}

// ---- 需要用户处理的情况（人脸识别、验证码、播放器报错）----
// 人脸识别的两种结构来自 OCS：旧版 #fcqrimg 带 src 时显示二维码，新版 .chapterVideoFaceMaskDiv 显示中。
function faceRecognitionVisible() {
  if (!RUNNER_URL.test(location.pathname)) return false;
  const qr = [...document.querySelectorAll("#fcqrimg")].some((image) => image.getAttribute("src") && visible(image));
  const mask = [...document.querySelectorAll(".chapterVideoFaceMaskDiv")].some((element) => element.style?.display !== "none" && visible(element));
  return qr || mask;
}

// 只检测，不填写。验证码由用户自己输入。
function captchaVisible() {
  return RUNNER_URL.test(location.pathname) && visible(document.querySelector("#chapterVerificationCode"));
}

const MEDIA_ERROR_TEXT = /视频文件损坏|网络错误|下载中途失败|格式不支持|无法加载|加载失败/;
function mediaLoadError() {
  if (!isVideoPage() && !/\/modules\/audio\//i.test(location.pathname)) return false;
  const dialog = document.querySelector(".vjs-modal-dialog-content");
  return Boolean(dialog && visible(dialog) && MEDIA_ERROR_TEXT.test(textOf(dialog)));
}

function courseDirectoryUrl() {
  if (!RUNNER_URL.test(location.pathname) && !DIRECTORY_URL.test(location.pathname)) return null;
  const source = new URL(location.href);
  // 必须保留页面实际使用的路径前缀：/mycourse/... 的部署下写死 /mooc-ans/mycourse/... 会跳到不存在的地址。
  const url = new URL(location.pathname.replace(/studentstudy/i, "studentcourse"), source.origin);
  for (const name of ["courseId", "clazzid", "enc"]) {
    const value = source.searchParams.get(name);
    if (!value) return null;
    url.searchParams.set(name, value);
  }
  for (const name of ['cpi', 'fanyaVersion', 'hidetype', 'mooc2', 'openc']) {
    if (source.searchParams.has(name)) url.searchParams.set(name, source.searchParams.get(name));
  }
  return url.href;
}

// 目录里的旧链接可能切到另一套学习页模板。换节时保留本轮开始时的路径及界面参数。
function studyViewContext() {
  const url = new URL(location.href);
  if (!RUNNER_URL.test(url.pathname)) return null;
  return { origin: url.origin, pathname: url.pathname,
    courseId: url.searchParams.get('courseId'), clazzid: url.searchParams.get('clazzid'),
    parameters: Object.fromEntries(['cpi', 'fanyaVersion', 'hidetype', 'mooc2', 'openc']
      .filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)])) };
}

function preserveStudyView(href, view) {
  const url = new URL(href, location.href);
  if (!view || url.origin !== view.origin || !RUNNER_URL.test(view.pathname) || !RUNNER_URL.test(url.pathname) ||
      url.searchParams.get('courseId') !== view.courseId || url.searchParams.get('clazzid') !== view.clazzid) return url.href;
  url.pathname = view.pathname;
  for (const key of ['cpi', 'fanyaVersion', 'hidetype', 'mooc2', 'openc']) {
    if (Object.hasOwn(view.parameters || {}, key)) url.searchParams.set(key, view.parameters[key]);
    else if (key !== 'cpi') url.searchParams.delete(key);
  }
  return url.href;
}

// 最近一次目录扫描的统计，只用于日志和提示文字（不含课程名或链接）。
let lastDirectoryScan = { rows: 0, evaluated: 0, candidates: 0 };

function directoryCandidates() {
  if (!DIRECTORY_URL.test(location.pathname)) return null;
  const rows = document.querySelectorAll("div.timeline div.units div.leveltwo h3.clearfix");
  const candidates = [];
  let evaluated = 0;
  for (const row of rows) {
    const link = row.querySelector("a[href]");
    const href = link?.getAttribute("href") || "";
    if (!href || /^javascript:/i.test(href)) continue;
    let target;
    try { target = new URL(href, location.href); } catch { continue; }
    if (target.origin !== location.origin || !RUNNER_URL.test(target.pathname)) continue;
    const chapter = target.searchParams.get("chapterId");
    if (!chapter) continue;
    // 完成标记不一定是 em：部分课程用 span.jobCount / span.roundpointStudent 等。
    // 旧版只认 em，取不到标记就跳过整行，结果所有小节都被当成“已完成”，点开始后毫无反应。
    const badge = row.querySelector("em, span.jobCount, span.roundpointStudent, span.roundpoint");
    if (!badge) continue;
    evaluated++;
    const background = getComputedStyle(badge).backgroundImage;
    if (/jobfinished\.png/i.test(background)) continue;
    if (/bg\.png/i.test(background) && getComputedStyle(badge).backgroundPosition === "-18px 0px") continue;
    candidates.push({ link, chapter });
  }
  lastDirectoryScan = { rows: rows.length, evaluated, candidates: candidates.length };
  return candidates;
}

function directoryTarget(excluded = []) {
  return directoryCandidates()?.find((candidate) => !excluded.includes(candidate.chapter)) || null;
}

function directoryStatus() {
  const rows = [...document.querySelectorAll("div.timeline div.units div.leveltwo h3.clearfix")];
  let locked = false;
  let unknown = false;
  for (const row of rows) {
    const href = row.querySelector("a[href]")?.getAttribute("href") || "";
    if (/^javascript:/i.test(href)) {
      locked = true;
      continue;
    }
    // 与 directoryCandidates 使用同一套完成标记选择器，否则带 span 标记的课程会被误判为“未识别”。
    const badge = row.querySelector("em, span.jobCount, span.roundpointStudent, span.roundpoint");
    try {
      const target = new URL(href, location.href);
      if (!href || target.origin !== location.origin || !RUNNER_URL.test(target.pathname) ||
          !target.searchParams.get("chapterId") || !badge) unknown = true;
    } catch { unknown = true; }
  }
  return { rows: rows.length, locked, unknown };
}

