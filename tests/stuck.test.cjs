const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const loadContent = require('./load-content.cjs');

// 等待用户处理的统一兜底（content/stuck.js）：同一任务点等太久就记入待办、跳到下一个任务点。
function runner(frames, taskPatch = {}, extra = {}, hidden = false) {
  const task = { state: 'running', phase: 'page', activeChapterId: '7', jobStartedAt: Date.now() - 1000,
    chapterEnteredAt: Date.now() - 1000, tabOpenedAt: Date.now() - 1000, skippedJobs: [], ...taskPatch };
  const stored = { 'task:1': task, ...extra };
  const sent = [];
  const w = {}; w.top = w;
  const context = vm.createContext({ window: w, top: w, URL, URLSearchParams, setTimeout, clearTimeout,
    location: { pathname: '/mooc-ans/mycourse/studentstudy', href: 'https://mooc1.chaoxing.com/mooc-ans/mycourse/studentstudy?chapterId=7&courseId=8&clazzid=9&enc=e',
      search: '?chapterId=7&courseId=8&clazzid=9&enc=e', assign() {}, reload() {} },
    document: { hidden, querySelector: () => null, querySelectorAll: () => [] },
    chrome: { storage: { local: {
      get: async (keys) => {
        if (typeof keys === 'string') keys = [keys];
        return Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(stored)).filter((k) => k in stored).map((k) => [k, stored[k]]));
      },
      set: async (data) => Object.assign(stored, JSON.parse(JSON.stringify(data))) } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async (message) => {
        if (message.type === 'INSPECT_FRAMES') return frames;
        sent.push(message);
        return message.type === 'COMMAND_FRAME' ? { ok: true } : undefined;
      } } }
  });
  loadContent(context);
  const tick = () => vm.runInContext(`tick(1, ${JSON.stringify(stored['task:1'])})`, context);
  return { stored, sent, tick, task: () => stored['task:1'] };
}

const MIN = 60000;
const main = () => ({ frameId: 0, active: true, kind: 'other', chapterId: '7', tabs: [], catalog: [
  { id: '7', name: '1.2', unfinished: 2, active: true }, { id: '8', name: '1.3', unfinished: 1, active: false }] });
const cards = (jobs) => ({ frameId: 2, active: true, kind: 'other', jobs });
const job = (id, type, patch = {}) => ({ id, name: `任务${id}`, type, isJob: true, finished: false, ...patch });
const player = (frameId, jobId, video, patch = {}) => ({ frameId, active: true, kind: 'video', mediaPage: true, jobId, video, ...patch });
const stuckFor = (key, ms, limit = 3 * MIN) => ({ key, since: Date.now() - ms, until: Date.now() - ms + limit });
const notices = (sent) => sent.filter((m) => m.type === 'NOTIFY').map((m) => m.reason);

test('the first waiting tick starts the skip timer without skipping', async () => {
  const r = runner([main(), cards([job('a', 'video'), job('b', 'document')]), player(3, 'a', { paused: true, ready: true, time: 50, duration: 600 })],
    { phase: 'waiting', waitReason: 'paused', currentJobId: 'a', lastVideoTime: 50 });
  await r.tick();
  assert.equal(r.task().phase, 'waiting');
  assert.equal(r.task().stuck.key, '7:a');
  assert.equal(r.task().stuck.until - r.task().stuck.since, 3 * MIN);
});

test('a video that stays paused is paused, recorded as a todo and the next task point starts', async () => {
  const r = runner([main(), cards([job('a', 'video'), job('b', 'document')]), player(3, 'a', { paused: true, ready: true, time: 50, duration: 600 })],
    { phase: 'waiting', waitReason: 'paused', currentJobId: 'a', lastVideoTime: 50, stuck: stuckFor('7:a', 3 * MIN + 1000) });
  await r.tick();
  assert.equal(r.task().phase, 'page');
  assert.equal(r.task().waitReason, null);
  assert.deepEqual(r.task().skippedJobs, ['a']);
  assert.equal(r.task().stuck, null);
  assert.ok(r.sent.some((m) => m.command === 'PAUSE_MEDIA' && m.frameId === 3));
  assert.match(r.stored.todos[0].reason, /视频一直暂停等待 3 分钟/);
  assert.deepEqual(notices(r.sent), ['skipped']);
  await r.tick();
  assert.equal(r.task().currentJobId, 'b');
});

test('a quiz stuck on a background screenshot is skipped and not retried by AI', async () => {
  const frames = [main(), cards([job('q', 'quiz')])];
  const r = runner(frames, { phase: 'waiting', waitReason: 'quiz', currentJobId: 'q',
    ai: { kind: 'quiz', stage: 'foreground', revision: 'initial', retryAt: null }, stuck: stuckFor('7:q', 3 * MIN + 1000) },
  { aiEnabled: true, aiQuizEnabled: true }, true);
  await r.tick();
  assert.equal(r.task().phase, 'page');
  assert.deepEqual(r.task().skippedJobs, ['q']);
  assert.deepEqual(r.task().aiSkippedJobs, ['q']);
  assert.match(r.stored.todos[0].reason, /章节测验等待 3 分钟/);
  assert.ok(r.sent.some((m) => m.type === 'CANCEL_AI'));
});

test('timer keeps running across retries of the same task point', async () => {
  const r = runner([main(), cards([job('q', 'quiz')])], { phase: 'waiting', waitReason: 'quiz', currentJobId: 'q',
    ai: { kind: 'quiz', stage: 'foreground', revision: 'initial', retryAt: null }, stuck: stuckFor('7:q', 2 * MIN) },
  { aiEnabled: true, aiQuizEnabled: true }, true);
  const before = r.task().stuck.since;
  await r.tick();
  assert.equal(r.task().phase, 'waiting');
  assert.equal(r.task().stuck.since, before);
});

test('quizzes the user chose to do themselves get ten minutes', async () => {
  const r = runner([main(), cards([job('q', 'quiz')])], { phase: 'waiting', waitReason: 'quiz', currentJobId: 'q',
    stuck: stuckFor('7:q', 4 * MIN) }, { quizMode: 'wait' });
  await r.tick();
  assert.equal(r.task().phase, 'waiting');
  assert.equal(r.task().stuck.until - r.task().stuck.since, 10 * MIN);
  assert.equal(r.stored.todos, undefined);
});

test('captcha is never skipped because it blocks every task point', async () => {
  const r = runner([main(), cards([job('a', 'video')]), { frameId: 5, active: true, captcha: true }],
    { phase: 'waiting', waitReason: 'captcha', currentJobId: 'a', stuck: stuckFor('7:a', 30 * MIN) });
  await r.tick();
  assert.equal(r.task().phase, 'waiting');
  assert.equal(r.stored.todos, undefined);
});

test('a skipped video whose question is still on screen does not pull the runner back', async () => {
  const r = runner([main(), cards([job('a', 'video'), job('b', 'document')]),
    player(3, 'a', { paused: true, ready: true, time: 50, duration: 600 }, { videoQuestionSurface: true, videoQuestionFeedback: 'open' })],
  { skippedJobs: ['a'] }, { aiEnabled: true });
  await r.tick();
  assert.equal(r.task().phase, 'page');
  assert.equal(r.task().currentJobId, 'b');
});

test('paused video in a hidden tab without background playback says how to fix it', async () => {
  const r = runner([main(), cards([job('a', 'video')]), player(3, 'a', { paused: true, ready: true, time: 50, duration: 600 })],
    { currentJobId: 'a', lastVideoTime: 50, playRetries: 3 }, {}, true);
  await r.tick();
  assert.equal(r.task().waitReason, 'paused');
  assert.match(r.task().status, /允许后台播放/);
});
