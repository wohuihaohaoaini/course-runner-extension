// 后台播放（隔离环境）：把“允许后台播放”开关同步成页面上的标记，供 visibility-shim.js 读取。
// 标记只表示开关状态，不含任何课程信息；关闭开关后立即移除，页面恢复读取真实可见状态。
const BackgroundVisibility = (() => {
  const ATTRIBUTE = 'data-course-runner-background';

  function set(value) {
    const root = document.documentElement;
    if (!root) return;
    if (value === true) root.setAttribute(ATTRIBUTE, '1');
    else root.removeAttribute(ATTRIBUTE);
  }

  function init() {
    if (typeof document === 'undefined' || !document.documentElement?.setAttribute) return;
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    chrome.storage.local.get('allowBackgroundPlayback').then(({ allowBackgroundPlayback }) => set(allowBackgroundPlayback)).catch(() => {});
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && 'allowBackgroundPlayback' in changes) set(changes.allowBackgroundPlayback.newValue);
    });
  }

  return { init, set };
})();

BackgroundVisibility.init();
