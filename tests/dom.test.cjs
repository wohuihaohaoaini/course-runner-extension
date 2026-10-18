const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

// 最小 DOM 桩：只为验证 frameVisible() 与 directoryCandidates() 这两个本次修复点。
function contentContext({ window: browserWindow, document, getComputedStyle }) {
  const context = vm.createContext({
    window: browserWindow,
    top: browserWindow.top,
    document,
    location: { pathname: '/x', href: 'https://mooc1.chaoxing.com/x', search: '', origin: 'https://mooc1.chaoxing.com' },
    URL, URLSearchParams, getComputedStyle: getComputedStyle || (() => ({ backgroundImage: '', backgroundPosition: '' })),
    setTimeout, clearTimeout,
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) },
      storage: { local: { get: async () => ({}), set: async () => {} } } }
  });
  require('./load-content.cjs')(context);
  return context;
}

test('cross-origin parent frame is treated as visible instead of hiding the whole iframe', () => {
  const topWindow = {};
  topWindow.top = topWindow;
  const child = { top: topWindow, parent: topWindow, frameElement: null };
  const context = contentContext({ window: child, document: { querySelectorAll: () => [], querySelector: () => null } });
  // 旧版把 null 当成不可见，跨域内嵌的视频/测验页会被整体判为不可见。
  assert.equal(vm.runInContext('frameVisible()', context), true);
});

test('same-origin hidden parent frame is still reported as invisible', () => {
  const topWindow = {};
  topWindow.top = topWindow;
  const hiddenFrame = { getClientRects: () => [] };
  const child = { top: topWindow, parent: topWindow, frameElement: hiddenFrame };
  const context = contentContext({ window: child, document: { querySelectorAll: () => [], querySelector: () => null } });
  assert.equal(vm.runInContext('frameVisible()', context), false);
});

test('directory scan recognizes span badges, not only em', () => {
  const finished = { getClientRects: () => [{}], classList: { contains: () => false } };
  const pending = { getClientRects: () => [{}], classList: { contains: () => false } };
  const badgeSelectors = [];
  const row = (chapter, badge) => ({ querySelector: (selector) => {
    if (selector === 'a[href]') return { getAttribute: () => `/mooc-ans/mycourse/studentstudy?chapterId=${chapter}&courseId=2&clazzid=3&enc=abc` };
    badgeSelectors.push(selector);
    return badge;
  } });
  const rows = [row(1, pending), row(9, finished)];
  const styles = new Map([
    [pending, { backgroundImage: 'url("bg.png")', backgroundPosition: '-18px 0px' }],
    [finished, { backgroundImage: 'url("jobfinished.png")', backgroundPosition: '0px 0px' }]
  ]);
  const context = contentContext({
    window: (() => { const w = {}; w.top = w; return w; })(),
    document: { querySelectorAll: (selector) => selector === 'div.timeline div.units div.leveltwo h3.clearfix' ? rows : [],
      querySelector: () => null },
    getComputedStyle: (element) => styles.get(element) || { backgroundImage: '', backgroundPosition: '' }
  });
  context.location.pathname = '/mooc-ans/mycourse/studentcourse';
  const result = vm.runInContext('JSON.stringify({ candidates: directoryCandidates().length, scan: lastDirectoryScan })', context);
  const parsed = JSON.parse(result);
  // 两个小节都能读到完成标记（旧版只认 em，span 会被跳过，最后报“全部完成”）。
  assert.equal(parsed.scan.rows, 2);
  assert.equal(parsed.scan.evaluated, 2);
  assert.equal(parsed.candidates, 0);
  assert.ok(badgeSelectors.every((selector) => /em/.test(selector) && /span\.jobCount/.test(selector)),
    `完成标记选择器应包含 em 与 span.jobCount，实际为 ${badgeSelectors[0]}`);
});

test('both chaoxing path prefixes are accepted', () => {
  const context = contentContext({
    window: (() => { const w = {}; w.top = w; return w; })(),
    document: { querySelectorAll: () => [], querySelector: () => null }
  });
  const check = (expression) => vm.runInContext(expression, context);
  // mooc1 旧版学习页：/mycourse/studentstudy（截图里的真实地址）
  assert.equal(check("RUNNER_URL.test('/mycourse/studentstudy')"), true);
  assert.equal(check("RUNNER_URL.test('/mooc-ans/mycourse/studentstudy')"), true);
  assert.equal(check("DIRECTORY_URL.test('/mycourse/studentcourse')"), true);
  assert.equal(check("DIRECTORY_URL.test('/mooc-ans/mycourse/studentcourse')"), true);
  assert.equal(check("QUIZ_URL.test('/mooc-ans/api/work')"), true);
  assert.equal(check("QUIZ_URL.test('/api/work')"), true);
  assert.equal(check("QUIZ_URL.test('/work/doHomeWorkNew')"), true);
  assert.equal(check("QUIZ_URL.test('/mooc-ans/work/doHomeWorkNew')"), true);
  assert.equal(check("QUIZ_URL.test('/mycourse/studentstudy')"), false);
  assert.equal(check("CARDS_URL.test('/knowledge/cards')"), true);
});

test('course directory url keeps the prefix used by the current page', () => {
  const context = contentContext({
    window: (() => { const w = {}; w.top = w; return w; })(),
    document: { querySelectorAll: () => [], querySelector: () => null }
  });
  const directory = (pathname) => {
    context.location.pathname = pathname;
    context.location.href = `https://mooc1.chaoxing.com${pathname}?courseId=1&clazzid=2&enc=abc`;
    return vm.runInContext('courseDirectoryUrl()', context);
  };
  // 旧版写死 /mooc-ans/mycourse/studentcourse，在 /mycourse/... 的部署下会跳到不存在的地址。
  assert.equal(directory('/mycourse/studentstudy'),
    'https://mooc1.chaoxing.com/mycourse/studentcourse?courseId=1&clazzid=2&enc=abc');
  assert.equal(directory('/mooc-ans/mycourse/studentstudy'),
    'https://mooc1.chaoxing.com/mooc-ans/mycourse/studentcourse?courseId=1&clazzid=2&enc=abc');
});

test('path pattern and query keys are masked before being logged', () => {
  const context = contentContext({
    window: (() => { const w = {}; w.top = w; return w; })(),
    document: { querySelectorAll: () => [], querySelector: () => null }
  });
  context.location.pathname = '/mooc-ans/mycourse/studentstudy';
  context.location.search = '?chapterId=12345678&courseId=99&enc=abcdef0123456789';
  assert.equal(vm.runInContext('pathPattern()', context), '/mooc-ans/mycourse/studentstudy');
  assert.equal(vm.runInContext('queryKeys()', context), 'chapterId,courseId,enc');
  context.location.pathname = '/mooc-ans/api/work/1234567890';
  assert.equal(vm.runInContext('pathPattern()', context), '/mooc-ans/api/work/#');
});
