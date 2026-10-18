// 任务点清单（思路借鉴自 OCS 网课助手的 searchJob）。
//
// 学习页每张卡片（knowledge/cards）里，每个任务点都是一个带 data 属性的 iframe，data 是 JSON，
// 里面有 jobid 和名称；iframe 外层容器里有 .ans-job-icon 说明它是任务点，容器带 ans-job-finished
// 说明平台已确认完成。0.1.29 只盯“页面上第一个视频”，一页有两个视频时第一个看完就卡住；
// 现在先列出本页所有任务点，再逐个处理未完成的。

function parseFrameData(frame) {
  const raw = frame?.getAttribute?.("data");
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function frameJobId(data) {
  const value = data.jobid || data._jobid || data.property?.jobid || data.property?._jobid;
  return value === undefined || value === null || value === "" ? null : String(value);
}

function jobType(frame, data) {
  const module = clean(frame.getAttribute("module")).toLowerCase();
  const src = frame.getAttribute("src") || "";
  const className = String(frame.className || "");
  if (/video/.test(module) || /\/modules\/video\//i.test(src) || /insertvideo/i.test(className)) return "video";
  if (/audio/.test(module) || /\/modules\/audio\//i.test(src) || /insertaudio/i.test(className)) return "audio";
  if (/work/.test(module) || /\/work\b|\/api\/work/i.test(src) || data.worktype || data.workid) return "quiz";
  if (/doc|pdf|ppt/.test(module) || /\/modules\/pdf\/|\/screen\//i.test(src)) return "document";
  if (/book|read/.test(module) || /\/readsvr\//i.test(src)) return "book";
  if (/link|hyper/.test(module)) return "link";
  return "other";
}

function jobContainer(frame) {
  return frame.closest(".ans-attach-ct") || frame.parentElement;
}

// 有 .ans-attach-ct 时图标在容器里；没有时只认紧挨着 iframe 的图标，避免一个父元素里
// 放了多个任务点时把别人的图标算到自己头上。
function jobIcon(frame, container) {
  if (container?.classList.contains("ans-attach-ct")) return container.querySelector(".ans-job-icon");
  for (let node = frame.previousElementSibling; node; node = node.previousElementSibling) {
    if (node.classList.contains("ans-job-icon")) return node;
    if (node.tagName === "IFRAME") break;
  }
  return null;
}

// 只在卡片页运行。返回本页任务点，顺序与页面上从上到下一致。
function pageJobs() {
  if (!CARDS_URL.test(location.pathname)) return [];
  const jobs = [];
  for (const frame of document.querySelectorAll("iframe")) {
    const data = parseFrameData(frame);
    const container = jobContainer(frame);
    const icon = jobIcon(frame, container);
    const id = frameJobId(data);
    if (!id && !icon) continue;
    // 完成标记加在任务点图标的父元素上（通常就是 .ans-attach-ct）。
    const marked = icon?.parentElement || container;
    jobs.push({
      id: id || `#${jobs.length}`,
      name: clean(data.name || data.title || data.bookname || "").slice(0, 60),
      type: jobType(frame, data),
      isJob: Boolean(icon),
      finished: Boolean(marked?.classList.contains("ans-job-finished")),
      frame
    });
  }
  return jobs;
}

function jobSummary() {
  return pageJobs().map(({ id, name, type, isJob, finished }) => ({ id, name, type, isJob, finished }));
}

function jobFrame(id) {
  return pageJobs().find((job) => job.id === id)?.frame || null;
}

// 视频 / 音频 / 测验 / 文档这些内嵌页通过 frameElement 找到自己在卡片页里的 iframe，
// 从而知道自己属于哪个任务点。跨域时 frameElement 为 null，此时返回 null，由运行器按顺序兜底。
function ownJobId() {
  if (window === top) return null;
  try {
    for (let current = window; current !== current.top; current = current.parent) {
      const frame = current.frameElement;
      if (!frame) return null;
      const id = frameJobId(parseFrameData(frame));
      if (id) return id;
    }
  } catch { /* 跨域父框架 */ }
  return null;
}
