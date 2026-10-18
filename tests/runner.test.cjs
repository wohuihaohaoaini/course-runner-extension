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
    document: { querySelector: () => null, querySelectorAll: () => [] },
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

test('picks the first unfinished task point, not the first video on the page', async () => {
  const r = runner([main(), cards([job('a', 'video', { finished: true }), job('b', 'video')]),
    player(3, 'a', { paused: false, ended: true, ready: true, time: 600, duration: 600 }),
    player(4, 'b', { paused: true, ready: true, time: 0, duration: 300 })]);
  await r.tick();
  assert.equal(r.task().currentJobId, 'b');
  assert.match(r.task().status, /第 2 个任务点/);
  await r.tick();
  const play = r.sent.find((m) => m.command === 'PLAY');
  assert.equal(play?.frameId, 4);
});

test('without readable job ids the n-th media task maps to the n-th player', async () => {
  const r = runner([main(), cards([job('a', 'video', { finished: true }), job('b', 'audio')]),
    player(3, null, { paused: false, ended: true, ready: true, time: 600, duration: 600 }),
    player(4, null, { paused: true, ready: true, time: 10, duration: 300 })], { currentJobId: 'b' });
  await r.tick();
  assert.equal(r.sent.find((m) => m.command === 'PLAY')?.frameId, 4);
});

test('progress is reported with the task point name', async () => {
  const r = runner([main(), cards([job('a', 'video')]), player(3, 'a', { paused: false, ready: true, time: 65, duration: 300 })],
    { currentJobId: 'a', lastVideoTime: 10 });
  await r.tick();
  assert.match(r.task().status, /任务a.*1:05 \/ 5:00/);
  assert.equal(r.task().log.at(-1).text, r.task().status);
});

test('intro tab without task points moves on to the next tab after a short wait', async () => {
  const r = runner([main({ tabs: [{ index: 0, kind: 'other', active: true }, { index: 1, kind: 'quiz', active: false }, { index: 2, kind: 'video', active: false }] })],
    { tabOpenedAt: Date.now() - 9000 });
  await r.tick();
  const open = r.sent.find((m) => m.command === 'OPEN_TAB');
  assert.equal(open?.data.index, 2);
  assert.deepEqual([...r.task().visitedTabs].sort(), [0, 2]);
});

test('an empty card that just opened is given time to insert its task points', async () => {
  const r = runner([main({ tabs: [{ index: 0, kind: 'video', active: true }, { index: 1, kind: 'quiz', active: false }] }), cards([])]);
  await r.tick();
  assert.deepEqual(commands(r.sent), []);
  assert.match(r.task().status, /等待本节内容加载/);
});

test('in-video question waits for the user, never answers, and notifies once', async () => {
  const frames = [main(), cards([job('a', 'video')]),
    player(3, 'a', { paused: true, ready: true, time: 120, duration: 600 }, { videoQuestionSurface: true, videoQuestionFeedback: 'open' })];
  const r = runner(frames, { currentJobId: 'a' });
  await r.tick();
  assert.equal(r.task().phase, 'waiting');
  assert.equal(r.task().waitReason, 'videoQuestion');
  await r.tick();
  assert.deepEqual(commands(r.sent), []);
  assert.deepEqual(notices(r.sent), ['videoQuestion']);
});

test('closing the question only reports success after actual playback progress', async () => {
  let surface = true;
  const info = { paused: true, ready: true, time: 120, duration: 600 };
  const r = runner(() => [main(), cards([job('a', 'video')]),
    player(3, 'a', info,
      { videoQuestionSurface: surface, videoQuestionFeedback: surface ? 'continue' : 'closed' })],
  { phase: 'waiting', waitReason: 'videoQuestion', currentJobId: 'a' });
  await r.tick();
  assert.deepEqual(commands(r.sent), ['CONTINUE_VIDEO_QUESTION']);
  surface = false;
  await r.tick();
  assert.equal(r.task().phase, 'waiting');
  await r.tick();
  assert.equal(r.task().phase, 'waiting');
  assert.deepEqual(commands(r.sent), ['CONTINUE_VIDEO_QUESTION', 'PLAY']);
  await r.tick();
  assert.equal(commands(r.sent).filter(c => c === 'PLAY').length, 1);
  assert.equal(r.task().phase, 'waiting');
  info.paused = false; info.time = 121;
  await r.tick();
  assert.equal(r.task().phase, 'page');
  assert.match(r.task().status, /播放已恢复/);
  assert.equal(r.task().playRetries, 0);
});

// 平台关闭弹题后常会把视频再暂停一次：一次 PLAY 不够，也不能因此把整节记入待办跳过。
test('after a closed question the video is re-played a few times and the section is never skipped', async () => {
  const info = { paused: true, ready: true, time: 120, duration: 600 };
  const r = runner(() => [main(), cards([job('a', 'video')]), player(3, 'a', info)],
    { phase: 'waiting', waitReason: 'videoQuestion', currentJobId: 'a' });
  await r.tick();
  const plays = () => commands(r.sent).filter(c => c === 'PLAY').length;
  for (let i = 1; i <= 3; i++) {
    r.stored['task:1'].questionResumePlayAt = Date.now() - 4000;
    await r.tick();
    assert.equal(plays(), i);
  }
  r.stored['task:1'].questionResumePlayAt = Date.now() - 4000;
  await r.tick();
  assert.equal(plays(), 3, 'at most three resume attempts while waiting');
  r.stored['task:1'].questionClosedAt = Date.now() - 16000;
  await r.tick();
  assert.equal(r.task().phase, 'page');
  assert.equal(r.task().waitReason, null);
  assert.equal(r.stored.todos, undefined);
  assert.deepEqual(r.task().skippedJobs, []);
  assert.ok(!commands(r.sent).includes('OPEN_CHAPTER'));
  // 回到正常播放流程后继续尝试播放。
  await r.tick();
  assert.equal(plays(), 4);
});

test('progress after a closed question counts as resumed even when the sample is paused', async () => {
  const info = { paused: true, ready: true, time: 120, duration: 600 };
  const r = runner(() => [main(), cards([job('a', 'video')]), player(3, 'a', info)],
    { phase: 'waiting', waitReason: 'videoQuestion', currentJobId: 'a' });
  await r.tick();
  info.time = 126;
  await r.tick();
  assert.equal(r.task().phase, 'page');
  assert.match(r.task().status, /播放已恢复/);
});

test('face recognition and captcha pause the run until they are gone', async () => {
  let face = true;
  let captcha = false;
  const r = runner(() => [main({ face, captcha }), cards([job('a', 'video')]),
    player(3, 'a', { paused: true, ready: true, time: 5, duration: 600 })], { currentJobId: 'a' });
  await r.tick();
  assert.equal(r.task().waitReason, 'face');
  face = false; captcha = true;
  await r.tick();
  assert.equal(r.task().waitReason, 'captcha');
  captcha = false;
  await r.tick();
  assert.equal(r.task().phase, 'page');
  assert.deepEqual(commands(r.sent), []);
  assert.deepEqual(notices(r.sent), ['face', 'captcha']);
});

test('paused samples with advancing time reset retries instead of skipping unfinished video', async () => {
  const info = { paused: true, ready: true, time: 414, duration: 938 };
  const r = runner(() => [main(), cards([job('a', 'video')]), player(3, 'a', info)],
    { currentJobId: 'a', playRetries: 3, lastVideoTime: 410 });
  for (let i = 0; i < 5; i++) {
    await r.tick();
    assert.equal(r.task().phase, 'page');
    assert.equal(r.task().lastVideoTime, info.time);
    assert.equal(r.task().playRetries, 1);
    info.time += 3;
  }
  assert.deepEqual(commands(r.sent), Array(5).fill('PLAY'));
  assert.equal(r.stored.todos, undefined);
});

test('repeated pauses without progress wait in the same section, even after 30 seconds', async () => {
  const info = { paused: true, ready: true, time: 414, duration: 938 };
  const r = runner(() => [main(), cards([job('a', 'video')]), player(3, 'a', info)],
    { currentJobId: 'a', lastVideoTime: 414 });
  for (let i = 0; i < 4; i++) await r.tick();
  assert.equal(r.task().phase, 'waiting');
  assert.equal(r.task().waitReason, 'paused');
  r.stored['task:1'].waitingSince = Date.now() - 60000;
  await r.tick();
  assert.equal(r.task().phase, 'waiting');
  assert.equal(r.task().activeChapterId, '7');
  assert.deepEqual(commands(r.sent), ['PLAY', 'PLAY', 'PLAY']);
  assert.deepEqual(notices(r.sent), ['paused']);
  assert.equal(r.stored.todos, undefined);
  info.paused = false;
  await r.tick();
  assert.equal(r.task().phase, 'waiting', 'playing flag alone does not prove progress');
  info.time = 417;
  await r.tick();
  assert.equal(r.task().phase, 'page');
  assert.equal(r.task().playRetries, 0);
  assert.equal(r.task().lastVideoTime, 417);
});

test('chapter quiz is skipped into the to-do list by default and never answered', async () => {
  const r = runner([main(), cards([job('q', 'quiz')])], { currentJobId: 'q' });
  await r.tick();
  assert.deepEqual(r.task().skippedJobs, ['q']);
  assert.equal(r.stored.todos.length, 1);
  assert.equal(r.stored.todos[0].chapterName, '1.2');
  assert.match(r.stored.todos[0].url, /chapterId=7/);
  assert.equal(r.sent.some((m) => m.type === 'ANSWER'), false);
  // 本页没有其他任务点了：进入目录里下一个未完成小节。
  await r.tick();
  const open = r.sent.find((m) => m.command === 'OPEN_CHAPTER');
  assert.equal(open?.data.id, '8');
  assert.equal(r.task().phase, 'switchingChapter');
  assert.deepEqual(r.task().processedChapters, ['7']);
});

test('AI quiz opens an unvisited quiz tab even after the platform marks the section complete', async () => {
  const r = runner([main({ treeTask: { kind: 'complete', count: 0 },
    tabs: [{ index: 1, kind: 'video', active: true }, { index: 2, kind: 'quiz', active: false }] })],
  { visitedTabs: [1] }, { aiEnabled: true, aiQuizEnabled: true });
  await r.tick();
  const open = r.sent.find((m) => m.command === 'OPEN_TAB');
  assert.equal(open?.data.index, 2);
  assert.notEqual(r.task().state, 'completed');
});

test('AI quiz waits for a just-opened quiz tab to load before completing the section', async () => {
  const frames = [main({ treeTask: { kind: 'complete', count: 0 },
    tabs: [{ index: 2, kind: 'quiz', active: true }] })];
  const r = runner(frames, { tabOpenedAt: Date.now() }, { aiEnabled: true, aiQuizEnabled: true });
  await r.tick();
  assert.match(r.task().status, /等待章节测验加载/);
  assert.equal(r.task().phase, 'page');
  // 等太久还没加载出测验任务点时，仍然按原有流程结束本节，避免卡死。
  r.task().tabOpenedAt = Date.now() - 20000;
  await r.tick();
  assert.notEqual(r.task().phase, 'page');
});

test('with AI quiz off an unvisited quiz tab is still skipped when the section is complete', async () => {
  const r = runner([main({ treeTask: { kind: 'complete', count: 0 },
    tabs: [{ index: 1, kind: 'video', active: true }, { index: 2, kind: 'quiz', active: false }] })],
  { visitedTabs: [1] }, { aiEnabled: false });
  await r.tick();
  assert.equal(r.sent.some((m) => m.command === 'OPEN_TAB'), false);
  assert.equal(r.task().phase, 'switchingChapter');
});

test('turning AI quiz on retries a chapter quiz that was skipped earlier', async () => {
  const tabs = [{ index: 1, kind: 'video', active: true }, { index: 2, kind: 'quiz', active: false }];
  const r = runner([main({ tabs }), cards([job('q', 'quiz')])],
    { currentJobId: 'q', skippedJobs: ['q'], visitedTabs: [1, 2] }, { aiEnabled: true, aiQuizEnabled: true });
  await r.tick();
  assert.deepEqual(r.task().skippedJobs, []);
  assert.deepEqual(r.task().visitedTabs, [1]);
  assert.equal(r.task().currentJobId, 'q');
  assert.equal(r.sent.some((m) => m.command === 'OPEN_CHAPTER'), false);
});

test('quiz wait mode holds until the platform marks it finished', async () => {
  let finished = false;
  const r = runner(() => [main(), cards([job('q', 'quiz', { finished })])], { currentJobId: 'q' }, { quizMode: 'wait' });
  await r.tick();
  assert.equal(r.task().waitReason, 'quiz');
  await r.tick();
  assert.equal(r.task().phase, 'waiting');
  finished = true;
  await r.tick();
  assert.equal(r.task().phase, 'page');
  assert.equal(r.stored.todos, undefined);
});

test('stop jump mode finishes after the current chapter', async () => {
  const r = runner([main({ treeTask: { kind: 'complete', count: 0 } }), cards([job('a', 'video', { finished: true })])], {}, { jumpMode: 'stop' });
  await r.tick();
  assert.equal(r.task().state, 'completed');
  assert.deepEqual(commands(r.sent), []);
  assert.deepEqual(notices(r.sent), ['done']);
});

test('broken player is reloaded once, then skipped into the to-do list', async () => {
  const frames = [main(), cards([job('a', 'video'), job('b', 'video')]), player(3, 'a', null, { mediaError: true })];
  const r = runner(frames, { currentJobId: 'a' });
  await r.tick();
  assert.deepEqual(commands(r.sent), ['RELOAD_MEDIA']);
  await r.tick();
  assert.deepEqual(r.task().skippedJobs, ['a']);
  assert.match(r.stored.todos[0].reason, /报错/);
  await r.tick();
  assert.equal(r.task().currentJobId, 'b');
});

test('video that ended without platform confirmation is skipped after 30 seconds', async () => {
  const r = runner([main(), cards([job('a', 'video')]), player(3, 'a', { paused: true, ended: true, ready: true, time: 600, duration: 600 })],
    { currentJobId: 'a', videoEndedAt: Date.now() - 31000 });
  await r.tick();
  assert.deepEqual(r.task().skippedJobs, ['a']);
  assert.equal(r.task().state, 'running');
});

test('arriving at the target chapter resets per-chapter state', async () => {
  const r = runner([main({ chapterId: '8' })], { phase: 'switchingChapter', targetChapterId: '8', previousChapterId: '7',
    switchStartedAt: Date.now(), skippedJobs: ['q'], currentJobId: 'q' });
  await r.tick();
  assert.equal(r.task().phase, 'page');
  assert.equal(r.task().activeChapterId, '8');
  assert.deepEqual(r.task().skippedJobs, []);
  assert.equal(r.task().chapterEntries['8'], 1);
});

test('entering the same chapter a fourth time stops with a breaking-mode hint', async () => {
  const r = runner([main({ chapterId: '8' })], { phase: 'switchingChapter', targetChapterId: '8', switchStartedAt: Date.now(),
    chapterEntries: { 8: 3 } });
  await r.tick();
  assert.equal(r.task().state, 'paused');
  assert.match(r.task().status, /闯关/);
});

test('user switching to another chapter is followed instead of stopping the run', async () => {
  const r = runner([main({ chapterId: '6' }), cards([job('a', 'video')])]);
  await r.tick();
  assert.equal(r.task().state, 'running');
  assert.equal(r.task().activeChapterId, '6');
});

test('when no catalog chapter is left the run completes and reports the to-do count', async () => {
  const r = runner([main({ treeTask: { kind: 'complete', count: 0 }, catalog: [{ id: '7', name: '1.2', unfinished: 0, active: true }] }),
    cards([job('a', 'video', { finished: true })])], {}, { todos: [{ key: 'x' }] });
  await r.tick();
  assert.equal(r.task().state, 'completed');
  assert.match(r.task().status, /还有 1 项/);
});

test('without a catalog it falls back to the next-chapter button', async () => {
  const r = runner([main({ catalog: [], hasNext: true, treeTask: { kind: 'complete', count: 0 } }), cards([])]);
  await r.tick();
  assert.deepEqual(commands(r.sent), ['NEXT']);
  assert.equal(r.task().phase, 'switchingChapter');
});

test('panel job list is stored with the task', async () => {
  const r = runner([main(), cards([job('a', 'video', { finished: true }), job('b', 'quiz'), { ...job('c', 'other'), isJob: false }])],
    { currentJobId: 'b', skippedJobs: [] });
  await r.tick();
  assert.deepEqual(r.task().jobs.map((j) => j.state), ['done', 'current']);
  assert.equal(r.task().chapterName, '1.2');
});

// ---- 0.2.1 修复的回归测试 ----

test('a catalog without readable unfinished counts is not used to declare the course done', async () => {
  const r = runner([main({ hasNext: true, treeTask: { kind: 'complete', count: 0 }, catalog: [
    { id: '7', name: '1.2', unfinished: null, active: true }, { id: '8', name: '1.3', unfinished: null, active: false }] }), cards([])]);
  await r.tick();
  assert.notEqual(r.task().state, 'completed');
  assert.deepEqual(commands(r.sent), ['NEXT']);
});

test('chapters whose unfinished count cannot be read stop the run instead of reporting completion', async () => {
  const r = runner([main({ treeTask: { kind: 'complete', count: 0 }, catalog: [
    { id: '7', name: '1.2', unfinished: 0, active: true }, { id: '8', name: '1.3', unfinished: null, active: false }] }), cards([])]);
  await r.tick();
  assert.equal(r.task().state, 'paused');
  assert.match(r.task().status, /1 个小节读不到完成数/);
});

test('a to-do is removed once the platform marks that task point finished', async () => {
  const r = runner([main(), cards([job('q', 'quiz', { finished: true }), job('v', 'video')])], {},
    { todos: [{ key: '7:q', chapterId: '7' }, { key: '6:q', chapterId: '6' }] });
  await r.tick();
  assert.deepEqual(r.stored.todos.map((t) => t.key), ['6:q']);
});

// 0.2.7：无法播放时留下待办并离开本节，而不是无限等待。
test('initial playback timeout defers the section and navigates to the next chapter', async () => {
 const r=runner([main(),cards([job('a','video')]),player(3,'a',{paused:true,ready:false,time:0,duration:0})],
 {currentJobId:'a',initialPlayAttemptedAt:Date.now()-35000,initialPlayWaitingAt:Date.now()-35000,playRetries:1});
 await r.tick();
 assert.equal(r.task().state,'running');
 assert.equal(r.task().phase,'switchingChapter');
 assert.equal(r.task().targetChapterId,'8');
 assert.equal(r.stored.todos[0].chapterId,'7');
 assert.match(r.stored.todos[0].reason,/播放|加载/);
});
test('stalled playback leaves the section without pretending its task is finished', async () => {
 const r=runner([main(),cards([job('a','video')]),player(3,'a',{paused:false,ready:true,time:50,duration:600})],
 {currentJobId:'a',lastVideoTime:50,jobStartedAt:Date.now()-70000,lastProgressAt:Date.now()-60000});
 await r.tick();
 assert.equal(r.task().phase,'switchingChapter');
 assert.equal(r.task().targetChapterId,'8');
 assert.equal(r.task().jobs[0].state,'current');
 assert.equal(r.stored.todos.length,1);
});
test('switching away from a failed question is not intercepted by its old visible popup', async () => {
 const r=runner([main(),cards([job('a','video')]),player(3,'a',{paused:true,time:50},{videoQuestionSurface:true,videoQuestionFeedback:'incorrect'})],
 {phase:'switchingChapter',currentJobId:'a',targetChapterId:'8',previousChapterId:'7',switchStartedAt:Date.now(),deferredChapters:['7']});
 await r.tick();
 assert.equal(r.task().phase,'switchingChapter');
 assert.equal(r.task().targetChapterId,'8');
 assert.deepEqual(commands(r.sent),[]);
});
test('first chapter arrival from the course directory records its original learning view', async () => {
 const r=runner([main()],{phase:'enteringChapter',directoryEnteredAt:Date.now()});
 await r.tick();
 assert.equal(r.task().studyView?.pathname,'/mooc-ans/mycourse/studentstudy');
 assert.equal(r.task().studyView?.courseId,'8');
});
