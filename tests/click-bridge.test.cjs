// 点击 javascript: 链接：隔离环境直接点会被扩展 CSP 拦截，改由页面主环境的点击桥完成。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const bridgeSource = fs.readFileSync(path.join(root, 'content/click-bridge.js'), 'utf8');
const commonSource = fs.readFileSync(path.join(root, 'content/common.js'), 'utf8');

const html = `<!doctype html><html><body>
  <a id="void" href="javascript:void(0);"><span id="inner">下一节</span></a>
  <a id="call" href=" JavaScript:getTeacherAjax('1','2','3')">小节</a>
  <a id="plain" href="#top">普通链接</a>
  <button id="button">按钮</button>
</body></html>`;

function page({ bridge = true } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' });
  const { window } = dom;
  const bridged = [];
  const clicks = [];
  // 只有点击桥保存的那份 click 会记账，用来区分“页面主环境点的”和“内容脚本直接点的”。
  const native = window.HTMLElement.prototype.click;
  window.HTMLElement.prototype.click = function recorded() { bridged.push(this.id); return native.call(this); };
  if (bridge) window.eval(bridgeSource);
  window.HTMLElement.prototype.click = native;
  window.document.addEventListener('click', (event) => clicks.push(event.target.id));
  // 内容脚本在另一个环境里运行，只共享 DOM。
  const content = vm.createContext({ window, document: window.document, location: window.location, getComputedStyle: window.getComputedStyle });
  vm.runInContext(commonSource, content, { filename: 'content/common.js' });
  const click = (id) => vm.runInContext(`pageClick(document.getElementById(${JSON.stringify(id)}))`, content);
  return { window, bridged, clicks, click };
}

test('manifest injects the click bridge into the page world of every course frame', () => {
  const entry = manifest.content_scripts.find(item => item.js.includes('content/click-bridge.js'));
  assert.equal(entry.world, 'MAIN');
  assert.equal(entry.run_at, 'document_start');
  assert.equal(entry.all_frames, true);
  assert.deepEqual(entry.matches, ['https://*.chaoxing.com/*']);
  assert.ok(!manifest.content_scripts[0].js.includes('content/click-bridge.js'), 'bridge stays out of the isolated world');
});

test('javascript: links, and elements inside them, are clicked once from the page world', () => {
  const { bridged, clicks, click } = page();
  click('void');
  click('call');
  click('inner');
  assert.deepEqual(bridged, ['void', 'call', 'inner']);
  assert.deepEqual(clicks, ['void', 'call', 'inner']);
});

test('ordinary links and buttons are still clicked directly by the content script', () => {
  const { bridged, clicks, click } = page();
  click('plain');
  click('button');
  assert.deepEqual(bridged, []);
  assert.deepEqual(clicks, ['plain', 'button']);
});

test('without the bridge a javascript: link still gets exactly one direct click', () => {
  const { bridged, clicks, click } = page({ bridge: false });
  click('void');
  assert.deepEqual(bridged, []);
  assert.deepEqual(clicks, ['void']);
});

test('page scripts replacing HTMLElement.prototype.click do not change what the bridge calls', () => {
  const { window, bridged, clicks, click } = page();
  window.HTMLElement.prototype.click = () => { throw new Error('page override'); };
  click('call');
  assert.deepEqual(bridged, ['call']);
  assert.deepEqual(clicks, ['call']);
});
