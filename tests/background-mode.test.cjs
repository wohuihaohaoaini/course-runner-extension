// 后台播放与后台截图（第 10 节）：截图路径选择、调试连接释放、权限同步、标签页保护与唤醒。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const guard = { runId: 'r1', revision: 's1', kind: 'quiz', chapterId: '7', jobId: 'q', frameId: 2, frameToken: 'doc1' };
const COURSE = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7';

function fixture({ stored: extra = {}, tab = {}, window: win = {}, permission = false, attachError, screenshot = 'QUJD', tabs } = {}) {
  const stored = { aiEnabled: true, aiQuizEnabled: true, aiVideoEnabled: true, aiRevision: 's1', apiKey: 'k',
    'task:1': { state: 'running', runId: 'r1', activeChapterId: '7', currentJobId: 'q' }, ...extra };
  const listeners = [], log = [], alarms = new Map();
  const events = { onMessage: null, alarm: null, added: null, removed: null, detach: null, tabRemoved: [] };
  let granted = permission;
  const tabState = { id: 1, active: true, windowId: 1, url: COURSE, autoDiscardable: true, ...tab };
  const chrome = {
    runtime: { getManifest: () => ({ version: 'test' }), onMessage: { addListener: f => events.onMessage = f } },
    storage: { local: {
      get: async keys => { const list = keys === null || keys === undefined ? Object.keys(stored) : typeof keys === 'string' ? [keys] : keys;
        return Object.fromEntries(list.filter(k => k in stored).map(k => [k, stored[k]])); },
      set: async patch => { const changes = {}; for (const [k, v] of Object.entries(patch)) { changes[k] = { oldValue: stored[k], newValue: v }; stored[k] = v; }
        listeners.forEach(f => f(changes, 'local')); },
      remove: async k => { delete stored[k]; } }, onChanged: { addListener: f => listeners.push(f) } },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }, { frameId: 2 }] },
    tabs: {
      sendMessage: async (id, m, o) => { log.push(['message', m.type, m.hidden]); if (m.type === 'RUNNER_PULSE') return new Promise(() => {});
        return o.frameId === 0 ? { kind: 'other', chapterId: '7' } : { kind: 'quiz', active: true, aiDocument: 'doc1', jobId: 'q' }; },
      get: async () => ({ ...tabState }),
      query: async () => tabs || [{ ...tabState }],
      update: async (id, patch) => { log.push(['update', id, patch]); Object.assign(tabState, patch); return { ...tabState }; },
      captureVisibleTab: async () => { log.push(['captureVisibleTab']); return 'data:image/png;base64,VISIBLE'; },
      onRemoved: { addListener: f => events.tabRemoved.push(f) }, onUpdated: { addListener() {} }
    },
    windows: { get: async () => ({ id: 1, state: 'normal', focused: true, ...win }) },
    permissions: { contains: async () => granted, onAdded: { addListener: f => events.added = f }, onRemoved: { addListener: f => events.removed = f } },
    debugger: {
      attach: async target => { log.push(['attach', target.tabId]); if (attachError) throw new Error(attachError); },
      detach: async target => { log.push(['detach', target.tabId]); },
      sendCommand: async (target, method) => { log.push(['command', method]); return { data: screenshot }; },
      onDetach: { addListener: f => events.detach = f }
    },
    alarms: { get: async name => alarms.get(name), create: async (name, info) => { alarms.set(name, info); log.push(['alarm', info.periodInMinutes]); },
      clear: async name => { alarms.delete(name); log.push(['clearAlarm']); }, onAlarm: { addListener: f => events.alarm = f } },
    notifications: null, commands: null
  };
  const context = vm.createContext({ AbortController, setTimeout, clearTimeout, setInterval, clearInterval, TextDecoder, URL, console, chrome, fetch: async () => { throw new Error('no network'); } });
  context.importScripts = (...files) => files.forEach(f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), context, { filename: f }));
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const send = message => new Promise(resolve => events.onMessage(message, { tab: { id: 1, windowId: 1 }, frameId: 2 }, resolve));
  return { stored, log, alarms, events, send, tabState, context, setGranted: v => { granted = v; },
    settle: () => vm.runInContext('BackgroundPlayback.sync()', context) };
}
const backgroundOn = { allowBackgroundPlayback: true, allowBackgroundCapture: true };
const ofType = (log, type) => log.filter(entry => entry[0] === type);

test('selected course tab in an unfocused window still uses normal capture (separate-window workflow)', async () => {
  const f = fixture({ window: { focused: false } });
  const result = await f.send({ type: 'CAPTURE_TAB', guard });
  assert.equal(result, 'data:image/png;base64,VISIBLE');
  assert.equal(ofType(f.log, 'attach').length, 0);
});

test('background tab without background capture keeps the question and explains how to recover', async () => {
  const f = fixture({ tab: { active: false }, stored: { allowBackgroundPlayback: true } });
  const result = await f.send({ type: 'CAPTURE_TAB', guard });
  assert.match(result.error, /不在前台/);
  assert.match(result.error, /单独放在一个未最小化的窗口|后台截图答题/);
  assert.equal(ofType(f.log, 'captureVisibleTab').length + ofType(f.log, 'attach').length, 0);
});

test('minimized window is not treated as visible', async () => {
  const f = fixture({ window: { state: 'minimized' } });
  assert.match((await f.send({ type: 'CAPTURE_TAB', guard })).error, /不在前台/);
});

test('background tab with permission captures through the debugger without activating any tab, then detaches', async () => {
  const f = fixture({ tab: { active: false }, stored: backgroundOn, permission: true });
  const prepared = await f.send({ type: 'CAPTURE_PREPARE', guard, pageHidden: true });
  assert.equal(prepared.mode, 'debugger');
  const image = await f.send({ type: 'CAPTURE_TAB', guard, pageHidden: true });
  assert.equal(image, 'data:image/png;base64,QUJD');
  assert.deepEqual(ofType(f.log, 'attach').length, 1, 'prepare and capture share one connection');
  assert.deepEqual(ofType(f.log, 'command').map(e => e[1]), ['Page.captureScreenshot', 'Page.captureScreenshot'], 'warm-up then real capture');
  assert.equal(ofType(f.log, 'update').filter(e => e[2].active).length, 0);
  assert.equal(ofType(f.log, 'captureVisibleTab').length, 0);
  await f.send({ type: 'CAPTURE_RELEASE' });
  assert.equal(ofType(f.log, 'detach').length, 1);
  // 截图前后都隐藏/恢复悬浮窗。
  assert.deepEqual(f.log.filter(e => e[1] === 'CAPTURE_PANEL').map(e => e[2]), [true, false]);
});

test('occluded page (selected tab but page hidden) prefers the debugger to avoid a stale image', async () => {
  const f = fixture({ stored: backgroundOn, permission: true });
  assert.equal((await f.send({ type: 'CAPTURE_PREPARE', guard, pageHidden: true })).mode, 'debugger');
  const g = fixture({});
  assert.match((await g.send({ type: 'CAPTURE_PREPARE', guard, pageHidden: true })).error, /不在前台/);
});

test('settings on but permission revoked: no debugger use', async () => {
  const f = fixture({ tab: { active: false }, stored: backgroundOn, permission: false });
  assert.match((await f.send({ type: 'CAPTURE_TAB', guard })).error, /不在前台/);
  assert.equal(ofType(f.log, 'attach').length, 0);
});

test('devtools conflict is reported as temporarily unavailable and leaves no connection behind', async () => {
  const f = fixture({ tab: { active: false }, stored: backgroundOn, permission: true, attachError: 'Another debugger is already attached to the tab' });
  const result = await f.send({ type: 'CAPTURE_TAB', guard, pageHidden: true });
  assert.match(result.error, /后台截图暂不可用/);
  assert.match(result.error, /开发者工具/);
  assert.match(result.error, /当前题目会保留/);
  assert.equal(vm.runInContext('captureSessions.size', f.context), 0);
});

test('missing screenshot data releases the connection and keeps the question', async () => {
  const f = fixture({ tab: { active: false }, stored: backgroundOn, permission: true, screenshot: '' });
  const result = await f.send({ type: 'CAPTURE_TAB', guard, pageHidden: true });
  assert.match(result.error, /后台截图暂不可用.*当前题目会保留/);
  assert.equal(ofType(f.log, 'detach').length, 1);
});

test('stale run cannot capture: context validation runs before the debugger attaches', async () => {
  const f = fixture({ tab: { active: false }, stored: backgroundOn, permission: true });
  const result = await f.send({ type: 'CAPTURE_TAB', guard: { ...guard, runId: 'old' } });
  assert.match(result.error, /失效/);
  assert.equal(ofType(f.log, 'attach').length, 0);
});

test('turning the setting off, stopping the run or closing the tab releases the debugger connection', async () => {
  for (const stop of [
    f => f.context.chrome.storage.local.set({ allowBackgroundCapture: false }),
    f => f.context.chrome.storage.local.set({ 'task:1': { state: 'paused', runId: 'r1' } }),
    f => f.events.tabRemoved.forEach(listener => listener(1))
  ]) {
    const f = fixture({ tab: { active: false }, stored: backgroundOn, permission: true });
    await f.send({ type: 'CAPTURE_PREPARE', guard, pageHidden: true });
    assert.equal(vm.runInContext('captureSessions.size', f.context), 1);
    await stop(f);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(vm.runInContext('captureSessions.size', f.context), 0);
    assert.equal(ofType(f.log, 'detach').length, 1);
  }
});

test('closing background capture releases all course-tab sessions', async () => {
  const f = fixture({ tab: { active: false }, stored: backgroundOn, permission: true });
  f.stored['task:2'] = { ...f.stored['task:1'] };
  f.context.testGuard = guard;
  await f.send({ type: 'CAPTURE_PREPARE', guard, pageHidden: true });
  await vm.runInContext('prepareCapture({ id: 2, windowId: 1 }, testGuard, true)', f.context);
  assert.equal(vm.runInContext('captureSessions.size', f.context), 2);
  await f.context.chrome.storage.local.set({ allowBackgroundCapture: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(vm.runInContext('captureSessions.size', f.context), 0);
  assert.deepEqual(ofType(f.log, 'detach').map(e => e[1]).sort(), [1, 2]);
});

test('one capture at a time per course tab', async () => {
  const f = fixture({ tab: { active: false }, stored: backgroundOn, permission: true });
  f.context.chrome.debugger.sendCommand = () => new Promise(resolve => setTimeout(() => resolve({ data: 'QUJD' }), 30));
  const [a, b] = await Promise.all([f.send({ type: 'CAPTURE_TAB', guard }), f.send({ type: 'CAPTURE_TAB', guard })]);
  assert.equal([a, b].filter(r => r === 'data:image/png;base64,QUJD').length, 1);
  assert.match([a, b].find(r => r.error).error, /已有截图请求/);
});

test('debugger permission grants do not enable background features without the user choosing them', async () => {
  const f = fixture({ permission: true });
  await f.events.added({ permissions: ['debugger'] });
  assert.notEqual(f.stored.allowBackgroundCapture, true);
  assert.notEqual(f.stored.allowBackgroundPlayback, true);
  assert.equal(f.stored.aiRevision, 's1');
  await f.context.chrome.storage.local.set({ allowBackgroundCapture: true });
  await f.events.added({ permissions: ['debugger'] });
  assert.equal(f.stored.allowBackgroundCapture, true, 'preserve the user setting');
  await f.events.removed({ permissions: ['debugger'] });
  assert.equal(f.stored.allowBackgroundCapture, false);
});

test('stopping during debugger attachment releases a late connection without capturing', async () => {
  const f = fixture({ tab: { active: false }, stored: backgroundOn, permission: true });
  let finishAttach, beganAttach;
  const started = new Promise(resolve => { beganAttach = resolve; });
  f.context.chrome.debugger.attach = () => new Promise(resolve => { finishAttach = resolve; beganAttach(); });
  const pending = f.send({ type: 'CAPTURE_PREPARE', guard, pageHidden: true });
  await started;
  await f.context.chrome.storage.local.set({ 'task:1': { state: 'paused', runId: 'r1' } });
  finishAttach();
  const result = await pending;
  assert.ok(result.error, 'a stopped request must not report successful preparation');
  assert.equal(ofType(f.log, 'command').length, 0, 'do not capture after stopping');
  assert.equal(ofType(f.log, 'detach').length, 1, 'release the connection that arrived after cancellation');
  assert.equal(vm.runInContext('captureSessions.size', f.context), 0);
});

test('turning background capture off during attachment explains that the setting was closed', async () => {
  const f = fixture({ tab: { active: false }, stored: backgroundOn, permission: true });
  let finishAttach, beganAttach;
  const started = new Promise(resolve => { beganAttach = resolve; });
  f.context.chrome.debugger.attach = () => new Promise(resolve => { finishAttach = resolve; beganAttach(); });
  const pending = f.send({ type: 'CAPTURE_PREPARE', guard, pageHidden: true });
  await started;
  await f.context.chrome.storage.local.set({ allowBackgroundCapture: false });
  finishAttach();
  const result = await pending;
  assert.match(result.error, /后台截图设置已关闭/);
  assert.doesNotMatch(result.error, /授权/);
  assert.equal(ofType(f.log, 'command').length, 0);
  assert.equal(ofType(f.log, 'detach').length, 1);
});

test('attachment that succeeds after a timeout is detached without leaking or replacing another request', async () => {
  const f = fixture({ tab: { active: false }, stored: backgroundOn, permission: true });
  let finishAttach;
  f.context.chrome.debugger.attach = () => new Promise(resolve => { finishAttach = resolve; });
  f.context.setTimeout = (fn, ms) => setTimeout(fn, ms === 10000 ? 5 : ms);
  const result = await f.send({ type: 'CAPTURE_PREPARE', guard, pageHidden: true });
  assert.ok(result.error);
  const competing = await f.send({ type: 'CAPTURE_PREPARE', guard, pageHidden: true });
  assert.match(competing.error, /上次调试连接/);
  finishAttach();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ofType(f.log, 'detach').length, 1);
  assert.equal(ofType(f.log, 'command').length, 0);
  assert.equal(vm.runInContext('captureSessions.size + pendingCaptureAttaches.size', f.context), 0);
});

test('background playback protects the running course tab from discarding and restores it afterwards', async () => {
  const f = fixture({ stored: { allowBackgroundPlayback: true } });
  await f.settle();
  assert.equal(f.tabState.autoDiscardable, false);
  assert.equal(f.stored.backgroundPlaybackTabs['1'], true, 'original setting is remembered');
  assert.equal(f.alarms.get('course-runner-background').periodInMinutes, 0.5);
  await f.context.chrome.storage.local.set({ 'task:1': { state: 'paused', runId: 'r1' } });
  await f.settle();
  assert.equal(f.tabState.autoDiscardable, true);
  assert.deepEqual({ ...f.stored.backgroundPlaybackTabs }, {});
  assert.equal(f.alarms.size, 0);
});

test('background playback is off by default and never touches tabs', async () => {
  const f = fixture();
  await f.settle();
  assert.equal(ofType(f.log, 'update').length, 0);
  assert.equal(f.alarms.size, 0);
});

test('non-course tabs are never protected or woken', async () => {
  const f = fixture({ stored: { allowBackgroundPlayback: true }, tab: { url: 'https://example.com/' } });
  await f.settle();
  assert.equal(ofType(f.log, 'update').length, 0);
});

test('alarm wake-up does not wait for the page round (which may include an AI request)', async () => {
  const f = fixture({ stored: { allowBackgroundPlayback: true } });
  await f.settle();
  // RUNNER_PULSE 在模拟中永不应答；若被等待，下面的同步会一直挂起。
  await Promise.race([vm.runInContext('BackgroundPlayback.sync(true)', f.context),
    new Promise((_, reject) => setTimeout(() => reject(new Error('pulse blocked the sync chain')), 500))]);
  await Promise.race([f.settle(), new Promise((_, reject) => setTimeout(() => reject(new Error('blocked')), 500))]);
  assert.equal(f.log.filter(e => e[1] === 'RUNNER_PULSE').length, 1);
});
