// 后台播放：只对开启“允许后台播放”且正在运行的学习通课程标签页生效。
// - 关闭自动丢弃，避免浏览器在内存紧张时卸载课程页；停止、暂停、关闭功能或离开课程后恢复原设置。
// - 用浏览器的定时唤醒（alarms）补充页面计时器：后台页面的计时器会被节流，唤醒只请求页面执行一轮检查，
//   页面内与自身定时器互斥，不会重复识题、提交或换节。
// - 页面可见性由 content/visibility-shim.js 处理（播放器不再因切屏暂停）；不伪造心跳或学习时长。
const BackgroundPlayback = (() => {
  const ALARM = 'course-runner-background';
  const KEY = 'backgroundPlaybackTabs';
  const COURSE_URL = /^https:\/\/([^/]+\.)?chaoxing\.com\//;
  let writes = Promise.resolve();
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  async function reconcile(pulse = false) {
    const stored = await chrome.storage.local.get(null);
    const tabs = await chrome.tabs.query({});
    const previous = stored[KEY] || {};
    const next = {};
    const running = [];
    for (const tab of tabs) {
      const active = stored.allowBackgroundPlayback === true && stored[`task:${tab.id}`]?.state === 'running' && COURSE_URL.test(tab.url || '');
      if (active) {
        // 先保存原设置再修改，服务进程中断后下次启动仍能恢复。
        next[tab.id] = has(previous, tab.id) ? previous[tab.id] : tab.autoDiscardable !== false;
        running.push(tab);
      } else if (has(previous, tab.id)) {
        try { await chrome.tabs.update(tab.id, { autoDiscardable: previous[tab.id] }); }
        catch { next[tab.id] = previous[tab.id]; }
      }
    }
    // 已关闭的标签页无需恢复，直接从记录中移除。
    if (JSON.stringify(next) !== JSON.stringify(previous)) await chrome.storage.local.set({ [KEY]: next });
    for (const tab of running) {
      try { if (tab.autoDiscardable !== false) await chrome.tabs.update(tab.id, { autoDiscardable: false }); }
      catch { /* 页面可能正在换节或关闭，下次检查恢复。 */ }
      // 不等待页面执行完一轮（可能包含 AI 请求），避免阻塞后续的恢复与清理。
      if (pulse) chrome.tabs.sendMessage(tab.id, { type: 'RUNNER_PULSE' }, { frameId: 0 }).catch(() => {});
    }
    if (running.length) {
      const existing = await chrome.alarms.get(ALARM);
      if (!existing) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    } else await chrome.alarms.clear(ALARM);
    return { running: running.map(tab => tab.id) };
  }

  function sync(pulse = false) {
    const pending = writes.then(() => reconcile(pulse));
    writes = pending.catch(() => {});
    return pending;
  }

  // debugger 随安装授予；取得权限不代表用户选择开启功能。
  // 仅在权限失效时关闭截图，开启操作交给设置页。
  async function permissionChanged(permissions, granted) {
    if (!permissions?.permissions?.includes('debugger') || granted) return;
    if (typeof setAISettings === 'function') await setAISettings({ allowBackgroundCapture: false });
    else await chrome.storage.local.set({ allowBackgroundCapture: false });
  }

  function init() {
    if (!chrome.alarms || !chrome.tabs?.query) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && ('allowBackgroundPlayback' in changes ||
          Object.entries(changes).some(([key, change]) => key.startsWith('task:') &&
            (change.oldValue?.state !== change.newValue?.state || change.oldValue?.runId !== change.newValue?.runId)))) sync().catch(() => {});
    });
    chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) sync(true).catch(() => {}); });
    chrome.tabs.onRemoved.addListener(() => sync().catch(() => {}));
    chrome.tabs.onUpdated.addListener((id, change) => { if (change.url || change.discarded === false) sync().catch(() => {}); });
    chrome.permissions?.onAdded?.addListener(p => permissionChanged(p, true).catch(() => {}));
    chrome.permissions?.onRemoved?.addListener(p => permissionChanged(p, false).catch(() => {}));
    sync().catch(() => {});
  }
  return { init, sync, reconcile, permissionChanged };
})();
BackgroundPlayback.init();
