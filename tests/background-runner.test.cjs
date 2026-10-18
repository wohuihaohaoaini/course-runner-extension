// 后台播放调度（第 10 节）：后台播放受阻时保留当前小节、回到前台重置计时、唤醒与页面轮询互斥。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const loadContent = require('./load-content.cjs');

// 运行器桩：INSPECT_FRAMES 返回给定的框架状态，记录发出的所有消息。
function runner(frames, taskPatch = {}, extra = {}) {
  const task = { state: 'running', phase: 'page', activeChapterId: '7', jobStartedAt: Date.now() - 1000,
    chapterEnteredAt: Date.now() - 1000, tabOpenedAt: Date.now() - 1000, skippedJobs: [], ...taskPatch };
  const stored = { 'task:1': task, ...extra };
  const sent = [];
  const w = {}; w.top = w;
  const context = vm.createContext({ window: w, top: w, URL, URLSearchParams, setTimeout, clearTimeout,
    location: { pathname: '/mooc-ans/mycourse/studentstudy', href: 'https://mooc1.chaoxing.com/mooc-ans/mycourse/studentstudy?chapterId=7&courseId=8&clazzid=9&enc=e',
      search: '?chapterId=7&courseId=8&clazzid=9&enc=e', assign() {}, reload() {} },
    document: { hidden: true, querySelector: () => null, querySelectorAll: () => [] },
    chrome: { storage: { local: {
      get: async (keys) => {
        if (typeof keys === 'string') keys = [keys];
        return Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(stored)).filter((k) => k in stored).map((k) => [k, stored[k]]));
      },
      set: async (data) => Object.assign(stored, JSON.parse(JSON.stringify(data))) } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async (message) => {
        if (message.type === 'INSPECT_FRAMES') return typeof frames === 'function' ? frames() : frames;
        sent.push(message);
        return message.type === 'COMMAND_FRAME' ? { ok: true } : undefined;
      } } }
  });
  loadContent(context);
  const tick = () => vm.runInContext(`tick(1, ${JSON.stringify(stored['task:1'])})`, context);
  return { context, stored, sent, tick, task: () => stored['task:1'] };
}

const commands = (sent) => sent.filter((m) => m.type === 'COMMAND_FRAME').map((m) => m.command);
const notices = (sent) => sent.filter((m) => m.type === 'NOTIFY').map((m) => m.reason);
const main = (patch = {}) => ({ frameId: 0, active: true, kind: 'other', chapterId: '7', tabs: [], catalog: [
  { id: '6', name: '1.1', unfinished: 0, active: false }, { id: '7', name: '1.2', unfinished: 2, active: true },
  { id: '8', name: '1.3', unfinished: 1, active: false }], ...patch });
const cards = (jobs) => ({ frameId: 2, active: true, kind: 'other', jobs });
const job = (id, type, patch = {}) => ({ id, name: `任务${id}`, type, isJob: true, finished: false, ...patch });
const player = (frameId, jobId, video, patch = {}) => ({ frameId, active: true, kind: 'video', mediaPage: true, jobId, video, ...patch });

const BG = { allowBackgroundPlayback: true };
const old = (ms) => Date.now() - ms;

test('background: player that never loads keeps the section instead of skipping it', async () => {
  const r = runner([main(), cards([job('a', 'video')])], { currentJobId: 'a', jobStartedAt: old(30000), jobRevealedAt: old(30000) }, BG);
  await r.tick();
  assert.equal(r.task().waitReason, 'background');
  assert.deepEqual(r.task().skippedJobs, []);
  assert.equal(r.stored.todos, undefined);
  assert.ok(notices(r.sent).includes('background'));
});

test('without the setting the old foreground rule (record and move on) is unchanged', async () => {
  const r = runner([main(), cards([job('a', 'video')])], { currentJobId: 'a', jobStartedAt: old(30000), jobRevealedAt: old(30000) });
  await r.tick();
  assert.deepEqual(r.task().skippedJobs, ['a']);
});

test('background: repeated pauses and stalled progress never defer an unfinished video', async () => {
  for (const [patch, video] of [
    [{ playRetries: 3, lastVideoTime: 30 }, { paused: true, ready: true, time: 30, duration: 300 }],
    [{ lastVideoTime: 30, lastProgressAt: old(60000), jobStartedAt: old(60000) }, { paused: false, ready: true, time: 30, duration: 300 }],
    [{ initialPlayWaitingAt: old(30000), initialPlayAttemptedAt: old(30000), playRetries: 1 }, { paused: true, ready: false, time: 0, duration: 0 }]
  ]) {
    const r = runner([main(), cards([job('a', 'video')]), player(3, 'a', video)], { currentJobId: 'a', backgroundWasHidden: true, ...patch }, BG);
    await r.tick();
    assert.equal(r.task().waitReason, 'background', JSON.stringify(patch));
    assert.equal(r.stored.todos, undefined);
    assert.ok(!commands(r.sent).includes('OPEN_CHAPTER'));
  }
});

test('background wait resumes by itself when real progress is seen', async () => {
  const r = runner([main(), cards([job('a', 'video')]), player(3, 'a', { paused: false, ready: true, time: 50, duration: 300 })],
    { phase: 'waiting', waitReason: 'background', currentJobId: 'a', lastVideoTime: 30, waitingSince: old(5000), backgroundWasHidden: true }, BG);
  await r.tick();
  assert.equal(r.task().phase, 'page');
  assert.match(r.task().status, /后台播放已恢复/);
});

test('background wait tries normal playback at most once a minute and never skips', async () => {
  const frames = [main(), cards([job('a', 'video')]), player(3, 'a', { paused: true, ready: true, time: 30, duration: 300 })];
  const r = runner(frames, { phase: 'waiting', waitReason: 'background', currentJobId: 'a', lastVideoTime: 30, waitingSince: old(70000), backgroundWasHidden: true }, BG);
  await r.tick();
  await r.tick();
  assert.equal(commands(r.sent).filter(c => c === 'PLAY').length, 1);
  assert.equal(r.task().phase, 'waiting');
});

test('returning to the foreground leaves the background wait and resets throttled timers', async () => {
  const r = runner([main(), cards([job('a', 'video')]), player(3, 'a', { paused: true, ready: true, time: 30, duration: 300 })],
    { phase: 'waiting', waitReason: 'background', currentJobId: 'a', lastVideoTime: 30, lastProgressAt: old(600000), jobStartedAt: old(600000), playRetries: 3, backgroundWasHidden: true }, BG);
  r.context.document.hidden = false;
  await r.tick();
  assert.equal(r.task().phase, 'page');
  assert.equal(r.task().backgroundWasHidden, false);
  assert.ok(Date.now() - r.task().lastProgressAt < 5000, 'stale background timestamps no longer count');
  // 回到前台后第一轮只尝试播放，不因旧超时立刻换节。
  await r.tick();
  assert.equal(r.stored.todos, undefined);
  assert.ok(commands(r.sent).includes('PLAY'));
});

test('background: a closed video question whose video stays paused keeps the section', async () => {
  const r = runner([main(), cards([job('a', 'video')]), player(3, 'a', { paused: true, ready: true, time: 40, duration: 300 })],
    { phase: 'waiting', waitReason: 'videoQuestion', currentJobId: 'a', questionClosedAt: old(20000), questionResumePlayAt: old(18000), questionResumeTime: 40, backgroundWasHidden: true }, BG);
  await r.tick();
  assert.equal(r.task().waitReason, 'background');
  assert.equal(r.stored.todos, undefined);
});

test('page timer and wake-up never run two rounds at once', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let inspections = 0;
  const r = runner(async () => { inspections++; await gate; return [main(), cards([job('a', 'video')]), player(3, 'a', { paused: false, ready: true, time: 50, duration: 300 })]; },
    { currentJobId: 'a', runId: 'r1' }, BG);
  const first = vm.runInContext('runCycle(1)', r.context);
  const second = vm.runInContext('runCycle(1)', r.context);
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await Promise.all([first, second]);
  assert.equal(inspections, 1);
});

test('verification prompts still wait for the user while in the background', async () => {
  const r = runner([main({ captcha: true }), cards([job('a', 'video')]), player(3, 'a', { paused: true, ready: true, time: 40, duration: 300 })],
    { currentJobId: 'a', backgroundWasHidden: true }, BG);
  await r.tick();
  assert.equal(r.task().waitReason, 'captcha');
  assert.ok(notices(r.sent).includes('captcha'));
});
