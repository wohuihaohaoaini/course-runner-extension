// 后台播放（页面主环境）：学习通播放器在页面不可见、失去焦点或鼠标移出窗口时会暂停视频，
// 并会定时检查 document.hidden / hasFocus()，导致后台视频每隔几秒就被暂停一次。
// 仅当内容脚本在本页标记“允许后台播放”时生效：让页面读到“可见、有焦点”，并拦截切屏相关事件。
// 只影响页面自己的脚本；插件内容脚本运行在隔离环境，仍能读到真实的可见状态。
(() => {
  if (window.__courseRunnerVisibilityShim) return;
  Object.defineProperty(window, '__courseRunnerVisibilityShim', { value: true });
  const ATTRIBUTE = 'data-course-runner-background';
  const enabledFor = (doc) => {
    try { return doc?.documentElement?.getAttribute(ATTRIBUTE) === '1'; } catch { return false; }
  };
  const enabled = () => enabledFor(document);
  const proto = Document.prototype;

  function override(name, value) {
    const original = Object.getOwnPropertyDescriptor(proto, name);
    if (!original?.get) return;
    Object.defineProperty(proto, name, {
      configurable: true, enumerable: original.enumerable,
      get() { return enabledFor(this) ? value : original.get.call(this); }
    });
  }
  override('hidden', false);
  override('webkitHidden', false);
  override('visibilityState', 'visible');
  override('webkitVisibilityState', 'visible');
  const hasFocus = proto.hasFocus;
  if (typeof hasFocus === 'function') {
    Object.defineProperty(proto, 'hasFocus', {
      configurable: true, writable: true,
      value: function hasFocus_() { return enabledFor(this) || hasFocus.call(this); }
    });
  }

  // 捕获阶段最先拦截：页面通过 addEventListener 或 onblur / onvisibilitychange 注册的处理都收不到。
  const block = (event) => { if (enabled()) event.stopImmediatePropagation(); };
  for (const type of ['visibilitychange', 'webkitvisibilitychange']) {
    window.addEventListener(type, block, true);
    document.addEventListener(type, block, true);
  }
  // 只拦截整个窗口失焦，不影响页面内输入框之间的焦点切换。
  window.addEventListener('blur', (event) => { if (event.target === window) block(event); }, true);
  // 鼠标移出窗口（relatedTarget 为空）时平台也会暂停视频；页面内移动不受影响。
  for (const type of ['mouseout', 'mouseleave']) {
    window.addEventListener(type, (event) => { if (!event.relatedTarget) block(event); }, true);
  }
})();
