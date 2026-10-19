// 一键静音。开关保存在 chrome.storage.local 的 muted 字段，弹窗按钮和快捷键（默认 Alt+M）都会改它。
// 每个框架（包括视频内嵌页）都会监听这个开关，并把当前及之后新出现的 <video>/<audio> 设为静音。
// 静音还有个附带好处：浏览器允许静音视频自动播放，“请手动点击播放按钮”的情况会少很多。
// 开启“允许后台播放”时改由后台服务把整个标签页静音（background-playback.js），这里不再把视频元素设为静音：
// 元素静音的页面在浏览器看来“没有声音”，切到后台 5 分钟后计时器会被压到约每分钟一次，还可能被节能模式冻结；
// 标签页静音时页面仍在“出声”，不受这两项限制，用户也听不到声音。

const Mute = (() => {
  let enabled = false;
  let muted = false;
  let tabLevel = false;
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

  function set(patch) {
    if ("muted" in patch) muted = patch.muted === true;
    if ("allowBackgroundPlayback" in patch) tabLevel = patch.allowBackgroundPlayback === true;
    enabled = muted && !tabLevel;
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
    chrome.storage.local.get(["muted", "allowBackgroundPlayback"])
      .then(({ muted, allowBackgroundPlayback }) => set({ muted, allowBackgroundPlayback })).catch(() => {});
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      const patch = {};
      for (const key of ["muted", "allowBackgroundPlayback"]) if (key in changes) patch[key] = changes[key].newValue;
      if (Object.keys(patch).length) set(patch);
    });
  }

  // 面板显示“已静音”看的是用户开关，与静音落在元素上还是标签页上无关。
  return { init, isEnabled: () => muted };
})();

Mute.init();
