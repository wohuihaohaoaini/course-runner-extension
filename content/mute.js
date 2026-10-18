// 一键静音。开关保存在 chrome.storage.local 的 muted 字段，弹窗按钮和快捷键（默认 Alt+M）都会改它。
// 每个框架（包括视频内嵌页）都会监听这个开关，并把当前及之后新出现的 <video>/<audio> 设为静音。
// 静音还有个附带好处：浏览器允许静音视频自动播放，“请手动点击播放按钮”的情况会少很多。

const Mute = (() => {
  let enabled = false;
  const mutedByUs = new WeakSet();

  function applyTo(media) {
    if (enabled) {
      if (!media.muted) {
        media.muted = true;
        mutedByUs.add(media);
      }
    } else if (mutedByUs.has(media)) {
      media.muted = false;
      mutedByUs.delete(media);
    }
  }

  function applyAll() {
    for (const media of document.querySelectorAll("video, audio")) applyTo(media);
  }

  function set(value) {
    enabled = value === true;
    applyAll();
  }

  function init() {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    // 媒体事件不冒泡，但能在捕获阶段于 document 上收到。播放器换源、重新加载或自己恢复音量时再静音一次。
    for (const type of ["play", "loadedmetadata", "volumechange"]) {
      document.addEventListener(type, (event) => {
        const media = event.target;
        if (enabled && media instanceof HTMLMediaElement && !media.muted) applyTo(media);
      }, true);
    }
    chrome.storage.local.get("muted").then(({ muted }) => set(muted)).catch(() => {});
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === "local" && "muted" in changes) set(changes.muted.newValue);
    });
  }

  return { init, isEnabled: () => enabled };
})();

Mute.init();
