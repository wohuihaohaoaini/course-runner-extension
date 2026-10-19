// 后台播放：页面主环境的可见性处理只在“允许后台播放”开启时生效，关闭后恢复真实状态。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const loadContent = require('./load-content.cjs');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const shimSource = fs.readFileSync(path.join(root, 'content/visibility-shim.js'), 'utf8');

function page() {
  const dom = new JSDOM('<!doctype html><html><body><video></video></body></html>', { runScripts: 'outside-only', url: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html' });
  const { window } = dom;
  // jsdom 默认“可见”，模拟课程页被切到后台。
  const proto = window.Document.prototype;
  Object.defineProperty(proto, 'hidden', { configurable: true, enumerable: true, get: () => true });
  Object.defineProperty(proto, 'visibilityState', { configurable: true, enumerable: true, get: () => 'hidden' });
  proto.hasFocus = () => false;
  window.eval(shimSource);
  return window;
}
const pageEvents = (window) => {
  const seen = [];
  for (const type of ['visibilitychange', 'blur', 'mouseout']) {
    window.addEventListener(type, () => seen.push(type));
    window.document.addEventListener(type, () => seen.push(`doc:${type}`));
  }
  window.onblur = () => seen.push('onblur');
  return seen;
};
const fire = (window) => {
  window.document.dispatchEvent(new window.Event('visibilitychange', { bubbles: true }));
  window.dispatchEvent(new window.FocusEvent('blur'));
  window.document.documentElement.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
};

test('manifest injects the shim into the page world of every course frame before page scripts run', () => {
  const entry = manifest.content_scripts.find(item => item.js.includes('content/visibility-shim.js'));
  assert.equal(entry.world, 'MAIN');
  assert.equal(entry.run_at, 'document_start');
  assert.equal(entry.all_frames, true);
  assert.deepEqual(entry.matches, ['https://*.chaoxing.com/*']);
  assert.ok(manifest.content_scripts[0].js.includes('content/visibility.js'));
  assert.ok(!manifest.content_scripts[0].js.includes('content/visibility-shim.js'), 'shim stays out of the isolated world');
});

test('without the background setting the page still sees its real visibility and events', () => {
  const window = page();
  const seen = pageEvents(window);
  assert.equal(window.document.hidden, true);
  assert.equal(window.document.visibilityState, 'hidden');
  assert.equal(window.document.hasFocus(), false);
  fire(window);
  assert.ok(seen.includes('doc:visibilitychange'));
  assert.ok(seen.includes('blur') && seen.includes('onblur'));
  assert.ok(seen.includes('mouseout'));
});

test('with background playback on, the player sees a visible focused page and no switch-away events', () => {
  const window = page();
  const seen = pageEvents(window);
  window.document.documentElement.setAttribute('data-course-runner-background', '1');
  assert.equal(window.document.hidden, false);
  assert.equal(window.document.visibilityState, 'visible');
  assert.equal(window.document.hasFocus(), true);
  fire(window);
  assert.deepEqual(seen, []);
  // 页面内的鼠标移动（有 relatedTarget）和输入框失焦不受影响。
  const body = window.document.body;
  body.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: window.document.querySelector('video') }));
  assert.deepEqual(seen.sort(), ['doc:mouseout', 'mouseout']);
  // 关闭开关后立即恢复真实状态。
  window.document.documentElement.removeAttribute('data-course-runner-background');
  assert.equal(window.document.hidden, true);
  assert.equal(window.document.hasFocus(), false);
});

test('a parent frame reads its own setting when an inner frame checks top.document', () => {
  const window = page();
  const other = window.document.implementation.createHTMLDocument('x');
  other.documentElement.setAttribute('data-course-runner-background', '1');
  assert.equal(other.hidden, false);
  assert.equal(window.document.hidden, true);
});

test('isolated script mirrors the background setting onto the page and follows changes', async () => {
  const listeners = [];
  const attrs = new Map();
  const w = {}; w.top = w;
  const context = vm.createContext({ window: w, top: w, URL, URLSearchParams, setTimeout, clearTimeout,
    HTMLMediaElement: function HTMLMediaElement() {},
    location: { pathname: '/ananas/modules/video/index.html', search: '' },
    document: { documentElement: { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) },
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    chrome: { storage: { local: { get: async () => ({ allowBackgroundPlayback: true }), set: async () => {} }, onChanged: { addListener: (fn) => listeners.push(fn) } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => undefined } } });
  loadContent(context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attrs.get('data-course-runner-background'), '1');
  listeners.forEach((fn) => fn({ allowBackgroundPlayback: { newValue: false } }, 'local'));
  assert.equal(attrs.has('data-course-runner-background'), false);
});
