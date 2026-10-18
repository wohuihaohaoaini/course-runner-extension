const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function popup(response) {
  const elements = new Map();
  let closed = false;
  const context = vm.createContext({
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { addEventListener() {}, textContent: '' });
      return elements.get(id);
    }, addEventListener() {} },
    window: { addEventListener() {}, close() { closed = true; } },
    chrome: { tabs: { sendMessage: async () => response },
      storage: { local: { get: async () => ({}) } },
      runtime: { sendMessage: async () => ({ ok: true }) } },
    setInterval, clearInterval
  });
  vm.runInContext(source('popup.js'), context);
  vm.runInContext('tabId = 1', context);
  return { context, elements, closed: () => closed };
}

test('missing startup acknowledgement keeps popup open and displays failure', async () => {
  const fixture = popup(undefined);
  await vm.runInContext('sendToPage("START").then(() => window.close()).catch(showError)', fixture.context);
  assert.equal(fixture.closed(), false);
  assert.ok(fixture.elements.get('message').textContent.length > 0);
});

test('acknowledged startup can close popup', async () => {
  const fixture = popup({ ok: true });
  await vm.runInContext('sendToPage("START").then(() => window.close()).catch(showError)', fixture.context);
  assert.equal(fixture.closed(), true);
});

test('unsupported top-level page returns explicit startup error', () => {
  let listener;
  const browserWindow = {};
  const context = vm.createContext({ window: browserWindow, top: browserWindow,
    location: { pathname: '/unsupported' }, setTimeout,
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } } });
  require('./load-content.cjs')(context);
  let response;
  listener({ type: 'START' }, {}, value => { response = value; });
  assert.ok(response?.error);
});

test('unsupported page keeps the popup open instead of closing silently', () => {
  // 旧版在这里直接 return，弹窗收到 undefined 后仍会关闭，用户看不到任何提示。
  let listener;
  const browserWindow = {};
  const context = vm.createContext({ window: browserWindow, top: browserWindow,
    location: { pathname: '/unsupported' }, setTimeout,
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } } });
  require('./load-content.cjs')(context);
  let called = false;
  listener({ type: 'START' }, {}, () => { called = true; });
  assert.equal(called, true);
});

test('snapshot with no responding page still exports a log that explains it', async () => {
  const stored = {};
  const context = vm.createContext({ chrome: {
    runtime: { onMessage: { addListener(fn) { context.listeners = fn; } } },
    storage: { local: { get: async () => stored, set: async value => Object.assign(stored, value) } },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
    tabs: { sendMessage: async () => undefined }
  } });
  vm.runInContext(source('background.js'), context);
  const listener = context.listeners;
  const response = await new Promise(resolve => listener({ type: 'DIAG_SNAPSHOT', tabId: 1 }, {}, resolve));
  // 必须仍然可以导出（不抛错），否则用户拿不到任何证据。
  assert.equal(response?.ok, true);
  assert.equal(response?.respondingFrames, 0);
  await vm.runInContext('diagnosticWrites', context);
  assert.equal(stored.diagnostics?.[0]?.event, 'structure');
  assert.equal(stored.diagnostics?.[0]?.urlKind, 'no-frame-response');
  assert.ok(String(stored.diagnostics?.[0]?.note || '').length > 0);
});

test('frame inspection only messages course frames, not about:blank or third-party frames', async () => {
  const asked = [];
  const context = vm.createContext({ chrome: {
    runtime: { onMessage: { addListener(fn) { context.listeners = fn; } } },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    webNavigation: { getAllFrames: async () => [
      { frameId: 0, url: 'https://mooc1.chaoxing.com/mooc-ans/mycourse/studentstudy?chapterId=1' },
      { frameId: 3, url: 'about:blank' }, { frameId: 4, url: 'https://ads.example.com/x' },
      { frameId: 5, url: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html' }] },
    tabs: { sendMessage: async (tabId, message, options) => { asked.push(options.frameId); return { kind: 'other' }; } }
  } });
  vm.runInContext(source('background.js'), context);
  const frames = await new Promise(resolve => context.listeners({ type: 'INSPECT_FRAMES' }, { tab: { id: 1 } }, resolve));
  assert.deepEqual(asked, [0, 5]);
  assert.deepEqual([...frames].map(f => f.frameId), [0, 5]);
});
