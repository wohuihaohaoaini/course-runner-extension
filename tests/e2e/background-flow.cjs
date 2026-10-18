// 后台播放与后台答题的真实浏览器验证（第 10 节）。
// 与 run-ai.cjs 使用同一套模拟课程，但不用 Playwright 控制页面：Playwright 会让它附着的页面始终处于“可见”状态，
// 无法模拟真正的后台标签页。这里直接启动 Chromium，通过本机 HTTPS 服务和域名映射提供模拟课程，
// 用调试协议只连接扩展的后台服务（模拟 DeepSeek、读写设置），课程页本身不被测试工具附着。
//
// 用法（需要有界面的浏览器，Linux 下用 xvfb-run）：
//   CHROMIUM_PATH=/path/to/chromium xvfb-run -a node tests/e2e/background-flow.cjs
// 可选：E2E_VISION=1 让第三道视频弹题和章节测验含加密字体，必须通过后台截图识题。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), https = require('node:https'), net = require('node:net');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');

const VISION = !!process.env.E2E_VISION;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'course-bg-e2e-'));
const output = process.env.E2E_OUTPUT || temp;
fs.mkdirSync(output, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x087b71:s=320x180:r=10:d=5', '-c:v', 'libvpx', '-an', path.join(temp, 'clip.webm')], { stdio: 'ignore' });
const site = require('./course-site.cjs')({ clip: fs.readFileSync(path.join(temp, 'clip.webm')), vision: VISION, mutedVideo: false });

// 测试用扩展副本：可选的调试权限改为安装权限，免去授权对话框；其余文件与源码一致。
const source = path.resolve(__dirname, '../..');
const extension = path.join(temp, 'extension');
fs.cpSync(source, extension, { recursive: true, filter: file => !/^(node_modules|\.git|tests|dist|docs|验证)(\/|$)/.test(path.relative(source, file)) });
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
manifest.permissions.push('debugger');
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=mooc1.chaoxing.com',
  '-keyout', path.join(temp, 'key.pem'), '-out', path.join(temp, 'cert.pem')], { stdio: 'ignore' });

function freePort() {
  return new Promise(resolve => { const server = net.createServer(); server.listen(0, () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    else listeners.forEach(listener => listener(message));
  };
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = async (method, params = {}, sessionId) => {
    await opened;
    const message = await new Promise(resolve => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result;
  };
  return { send, on: listener => listeners.push(listener), close: () => ws.close() };
}

(async () => {
  const server = https.createServer({ key: fs.readFileSync(path.join(temp, 'key.pem')), cert: fs.readFileSync(path.join(temp, 'cert.pem')) }, (req, res) => {
    const r = site.respond(new URL(req.url, 'https://mooc1.chaoxing.com'));
    res.writeHead(r.status, { 'content-type': r.contentType });
    res.end(r.body);
  });
  const sitePort = await freePort();
  await new Promise(resolve => server.listen(sitePort, '127.0.0.1', resolve));
  const debugPort = await freePort();
  const chrome = spawn(process.env.CHROMIUM_PATH || 'chromium', [
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(temp, 'profile')}`,
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    `--host-resolver-rules=MAP mooc1.chaoxing.com 127.0.0.1:${sitePort}`, '--ignore-certificate-errors', '--no-proxy-server',
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--window-size=1300,1000',
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7&courseId=8&clazzid=9'
  ], { stdio: 'ignore' });
  let browser;
  try {
    let version;
    for (let i = 0; i < 60 && !version; i++) { await sleep(500); version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r => r.json()).catch(() => null); }
    assert.ok(version, 'browser started');
    browser = connect(version.webSocketDebuggerUrl);
    let worker;
    for (let i = 0; i < 60 && !worker; i++) {
      const { targetInfos } = await browser.send('Target.getTargets');
      worker = targetInfos.find(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://') && t.url.endsWith('/background.js'));
      if (!worker) await sleep(500);
    }
    assert.ok(worker, 'extension service worker');
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    const evaluate = async (fn, ...args) => {
      const result = await browser.send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };

    // 模拟 DeepSeek：只记录请求形态，不访问外部网络。
    await evaluate(() => {
      globalThis.testRequests = [];
      globalThis.fetch = async (url, options) => {
        if (url !== 'https://api.deepseek.com/chat/completions') throw new Error('Unexpected external network');
        const body = JSON.parse(options.body);
        const content = body.messages[1].content;
        const raw = typeof content === 'string' ? content : content[0].text.slice(content[0].text.indexOf('{'));
        const data = JSON.parse(raw);
        testRequests.push({ model: body.model, image: Array.isArray(content), questionIds: data.questions.map(q => q.id),
          imageCount: Array.isArray(content) ? content.filter(c => c.type === 'image_url').length : 0,
          imageBytes: Array.isArray(content) ? content.filter(c => c.type === 'image_url').map(c => c.image_url.url.length) : [] });
        const answer = JSON.stringify({ answers: data.questions.map(q => q.type === 'fill' ? { id: q.id, blanks: ['示例答案'] } :
          { id: q.id, choices: q.id.startsWith('video-') ? (q.type === 'multiple' ? ['B', 'C'] : ['B']) : q.type === 'multiple' ? ['A', 'C'] : ['B'] }) });
        return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: null }] }) + '\n\ndata: ' +
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }) + '\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };
    });

    let tabId;
    for (let i = 0; i < 40 && !tabId; i++) {
      tabId = await evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.includes('studentstudy') && t.status === 'complete')?.id);
      if (!tabId) await sleep(500);
    }
    assert.ok(tabId, 'course tab loaded');
    await evaluate(async () => {
      await chrome.storage.local.set({ notify: false, muted: false, apiKey: 'local-test-key', aiEnabled: true, aiVideoEnabled: true, aiQuizEnabled: true,
        autoSubmit: true, videoAnswerMode: 'ai', allowBackgroundPlayback: true, allowBackgroundCapture: true, aiRevision: 'e2e' });
    });
    for (let i = 0; i < 20; i++) {
      const ready = await evaluate(async id => chrome.tabs.sendMessage(id, { type: 'PING_PANEL' }, { frameId: 0 }).then(() => true, e => !/Receiving end/.test(e.message)), tabId);
      if (ready) break; await sleep(500);
    }
    const originalDiscardable = await evaluate(async id => (await chrome.tabs.get(id)).autoDiscardable, tabId);
    const started = await evaluate(async id => chrome.tabs.sendMessage(id, { type: 'START' }, { frameId: 0 }), tabId);
    assert.equal(started?.ok, true, JSON.stringify(started));

    // 用户在同一窗口打开并切换到另一个网页，课程页成为后台标签页。
    const otherId = await evaluate(async id => {
      const course = await chrome.tabs.get(id);
      globalThis.courseActivations = 0;
      chrome.tabs.onActivated.addListener(info => { if (info.tabId === id) globalThis.courseActivations++; });
      const other = await chrome.tabs.create({ windowId: course.windowId, url: 'https://mooc1.chaoxing.com/other-site', active: true });
      return other.id;
    }, tabId);
    await sleep(1500);

    const stats = { samples: 0, courseHidden: 0, otherActive: 0, protectedWhileRunning: 0, maxDebuggerClients: 0 };
    let task, previous = '';
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const sample = await evaluate(async (id, other) => {
        const [hidden] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => document.hidden });
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const tab = await chrome.tabs.get(id);
        const targets = await chrome.debugger.getTargets();
        const t = (await chrome.storage.local.get(`task:${id}`))[`task:${id}`];
        return { hidden: hidden.result, otherActive: active?.id === other, discardable: tab.autoDiscardable,
          attached: targets.filter(x => x.tabId === id && x.attached).length, task: t };
      }, tabId, otherId);
      task = sample.task;
      stats.samples++;
      if (sample.hidden) stats.courseHidden++;
      if (sample.otherActive) stats.otherActive++;
      if (task?.state === 'running' && sample.discardable === false) stats.protectedWhileRunning++;
      stats.maxDebuggerClients = Math.max(stats.maxDebuggerClients, sample.attached);
      if (task?.status !== previous) { previous = task?.status; console.log(`${task?.state}/${task?.phase}`, previous); }
      if (task?.state !== 'running') break;
    }
    const final = await evaluate(async id => ({
      requests: globalThis.testRequests, activations: globalThis.courseActivations,
      discardable: (await chrome.tabs.get(id)).autoDiscardable,
      protectedTabs: (await chrome.storage.local.get('backgroundPlaybackTabs')).backgroundPlaybackTabs,
      alarm: await chrome.alarms.get('course-runner-background'),
      attached: (await chrome.debugger.getTargets()).filter(x => x.tabId === id && x.attached).length,
      chapter: (await chrome.scripting.executeScript({ target: { tabId: id }, func: () => document.querySelector('#curChapterId').value }))[0].result
    }), tabId);
    console.log('background', JSON.stringify(stats));
    const { events, finished } = site;
    assert.equal(task?.state, 'completed', task?.status);
    assert.deepEqual([...finished].sort(), ['q', 'v1', 'v2', 'v3']);
    assert.equal(final.chapter, '8');
    assert.equal(events.filter(e => e.type === 'video-submit').length, 3);
    assert.equal(events.filter(e => e.type === 'video-continue').length, 3);
    assert.equal(events.filter(e => e.type === 'video-resumed').length, 3);
    assert.equal(events.filter(e => e.type === 'quiz-submit').length, 1);
    assert.equal(events.filter(e => e.type === 'quiz-confirm').length, 1);
    assert.equal(events.filter(e => e.type === 'quiz-cancel').length, 0);
    assert.equal(final.requests.length, 4);
    assert.equal(new Set(final.requests.slice(0, 3).flatMap(r => r.questionIds)).size, 3);
    if (VISION) {
      assert.equal(final.requests[2].image, true); assert.equal(final.requests[2].imageCount, 1);
      assert.equal(final.requests[3].image, true); assert.equal(final.requests[3].imageCount, 5);
      assert.ok(final.requests.flatMap(r => r.imageBytes).every(n => n > 1000), 'captured images are not empty');
      assert.ok(stats.maxDebuggerClients <= 1);
    }
    assert.equal(stats.courseHidden, stats.samples, 'course page stayed in the background for the whole run');
    assert.equal(stats.otherActive, stats.samples, 'the user\'s tab stayed active');
    assert.equal(final.activations, 0, 'course tab was never activated');
    assert.ok(stats.protectedWhileRunning > 0, 'course tab protected from discarding while running');
    assert.equal(final.discardable, originalDiscardable, 'tab discard setting restored after completion');
    assert.deepEqual(final.protectedTabs || {}, {});
    assert.equal(final.alarm, undefined, 'wake-up alarm cleared after completion');
    assert.equal(final.attached, 0, 'no debugger connection left behind');
    const report = { status: 'passed', vision: VISION, stats, events, requests: final.requests.map(({ imageBytes, ...r }) => r) };
    fs.writeFileSync(path.join(output, 'background-result.json'), JSON.stringify(report, null, 2));
    console.log('PASS', JSON.stringify(report));
  } finally {
    browser?.close();
    chrome.kill();
    server.close();
    await sleep(500);
    if (!process.env.E2E_OUTPUT) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
