// 用 jsdom 搭出接近真实超星页面的结构，验证任务点清单、左侧目录、人脸识别检测和悬浮面板。
// 需要 jsdom（npm i jsdom）；没装时整组跳过。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { /* 未安装 jsdom */ }
const skip = !JSDOM && '需要 jsdom';
const root = path.join(__dirname, '..');
const files = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).content_scripts[0].js;

function page(url, html, { parentWindow, stored = {} } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const context = dom.getInternalVMContext();
  window.run = (code) => {
    const result = new vm.Script(code).runInContext(context);
    // jsdom 里的数组 / 对象属于另一个 realm，转成本 realm 的普通值再比较。
    return result && typeof result === 'object' && !(result instanceof window.Node) ? JSON.parse(JSON.stringify(result)) : result;
  };
  // 测试里把面板的 closed shadow root 改成 open，才能读到里面的内容。
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function () { return attach.call(this, { mode: 'open' }); };
  window.Element.prototype.getClientRects = function () { return this.style?.display === 'none' ? [] : [1]; };
  window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 100, top: 0, left: 0 });
  if (parentWindow) window.run('var __parent = null;');
  const listeners = [];
  window.chrome = {
    storage: { local: { get: async (keys) => {
      const list = typeof keys === 'string' ? [keys] : keys || Object.keys(stored);
      return Object.fromEntries(list.filter((k) => k in stored).map((k) => [k, stored[k]]));
    }, set: async (data) => Object.assign(stored, data) }, onChanged: { addListener: (fn) => listeners.push(fn) } },
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => undefined }
  };
  window.fireStorageChange = (changes) => listeners.forEach((fn) => fn(changes, 'local'));
  for (const file of files) new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file }).runInContext(context);
  return window;
}

const CARDS = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1';
const jobFrame = (data, extra = '') => `<iframe ${extra} data='${JSON.stringify(data)}' src="about:blank"></iframe>`;

test('task point list reads names, types and finished marks in page order', { skip }, () => {
  const window = page(CARDS, `<body>
    <p>学习目标</p>
    <div class="ans-attach-ct ans-job-finished"><div class="ans-job-icon" aria-label="任务点已完成"></div>
      ${jobFrame({ jobid: 'j1', name: '1-1 导论.mp4' }, 'module="insertvideo" class="ans-attach-online ans-insertvideo-online"')}</div>
    <div class="ans-attach-ct"><div class="ans-job-icon" aria-label="任务点未完成"></div>
      ${jobFrame({ jobid: 'j2', name: '1-2 案例.mp4' }, 'module="insertvideo"')}</div>
    <div class="ans-attach-ct">${jobFrame({ name: '拓展阅读.pdf', objectid: 'x' }, 'module="insertdoc"')}</div>
    <div class="ans-attach-ct"><div class="ans-job-icon"></div>${jobFrame({ _jobid: 'work-9', title: '章节测验', worktype: 'workA' }, 'module="work"')}</div>
  </body>`);
  const jobs = window.run('jobSummary()');
  assert.deepEqual(jobs.map((j) => [j.id, j.type, j.isJob, j.finished]), [
    ['j1', 'video', true, true], ['j2', 'video', true, false], ['work-9', 'quiz', true, false]]);
  assert.equal(jobs[1].name, '1-2 案例.mp4');
});

test('a player frame knows which task point it belongs to', { skip }, () => {
  const cards = page(CARDS, `<body><div class="ans-attach-ct"><div class="ans-job-icon"></div>
    ${jobFrame({ jobid: 'j7', name: 'v.mp4' }, 'id="f" module="insertvideo"')}</div></body>`);
  const frame = cards.document.getElementById('f');
  const player = page('https://mooc1.chaoxing.com/ananas/modules/video/index.html?v=1', '<body><video></video></body>');
  // ownJobId 只用到 window / parent / top / frameElement，这里换成一个指向卡片页 iframe 的桩。
  const topWindow = {}; topWindow.top = topWindow;
  player.__fakeWindow = { top: topWindow, parent: topWindow, frameElement: frame };
  assert.equal(player.run('(() => { const window = globalThis.__fakeWindow; return (' + player.run('ownJobId.toString()') + ')(); })()'), 'j7');
});

test('left catalog gives chapter ids, unfinished counts and the active chapter', { skip }, () => {
  const window = page('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1&courseId=2&clazzid=3&enc=e', `<body>
    <input id="curChapterId" value="102">
    <div class="posCatalog_select"><span class="posCatalog_name" onclick="getTeacherAjax('2','3','101')" title="1.1 绪论">1.1</span><input class="jobUnfinishCount" value="0"></div>
    <div class="posCatalog_select posCatalog_active"><span class="posCatalog_name" onclick="getTeacherAjax('2','3','102')" title="1.2 发展">1.2</span><input class="jobUnfinishCount" value="2"></div>
    <div class="posCatalog_select"><span class="posCatalog_name" onclick="getTeacherAjax('2', '3', '103')" title="1.3 展望">1.3</span><input class="jobUnfinishCount" value="1"></div>
  </body>`);
  assert.equal(window.run('chapterId()'), '102');
  assert.deepEqual(window.run('catalogSummary()').map((c) => [c.id, c.unfinished, c.active, c.name]), [
    ['101', 0, false, '1.1 绪论'], ['102', 2, true, '1.2 发展'], ['103', 1, false, '1.3 展望']]);
  assert.deepEqual(window.run('currentTreeTaskState()'), { kind: 'remaining', count: 2 });
});

test('face recognition is detected in both old and new layouts', { skip }, () => {
  const url = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1';
  assert.equal(page(url, '<body><img id="fcqrimg" src=""></body>').run('faceRecognitionVisible()'), false);
  assert.equal(page(url, '<body><img id="fcqrimg" src="https://x/qr.png"></body>').run('faceRecognitionVisible()'), true);
  assert.equal(page(url, '<body><div class="chapterVideoFaceMaskDiv" style="display:none"></div></body>').run('faceRecognitionVisible()'), false);
  assert.equal(page(url, '<body><div class="chapterVideoFaceMaskDiv" style="display:block"></div></body>').run('faceRecognitionVisible()'), true);
});

test('player error dialog is recognized as a load failure', { skip }, () => {
  const window = page('https://mooc1.chaoxing.com/ananas/modules/video/index.html', '<body><div class="vjs-modal-dialog-content">此视频暂时无法播放：网络错误导致视频下载中途失败</div></body>');
  assert.equal(window.run('mediaLoadError()'), true);
});

test('floating panel shows status, task points and to-dos inside its own shadow root', { skip }, async () => {
  const stored = { 'task:5': { state: 'running', phase: 'waiting', status: '需要人脸识别', chapterName: '1.2 发展',
    jobs: [{ name: 'a.mp4', type: 'video', state: 'done' }, { name: 'b.mp4', type: 'video', state: 'current' }] },
  todos: [{ chapterName: '1.1', type: 'quiz', reason: '章节测验需要你自己完成', url: 'https://mooc1.chaoxing.com/x' }] };
  const window = page('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1', '<body></body>', { stored });
  window.run('Panel.init(5)');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const host = window.document.getElementById('course-runner-panel');
  assert.ok(host?.shadowRoot);
  const text = host.shadowRoot.textContent;
  assert.match(text, /等你处理/);
  assert.match(text, /需要人脸识别/);
  assert.match(text, /当前小节：1\.2 发展/);
  assert.match(text, /a\.mp4/);
  assert.match(text, /待你处理（1）/);
  const statuses = [...host.shadowRoot.querySelectorAll('li')].map((li) => li.dataset.state);
  assert.deepEqual(statuses, ['done', 'current']);
  // 收起成小圆点，再点开。
  host.shadowRoot.querySelector('[data-act="min"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(host.shadowRoot.querySelector('.mini'));
  assert.equal(stored.panelView.minimized, true);
});

test('the minimized floating ball can be dragged without being treated as a click', { skip }, async () => {
  const stored = { 'task:5': { state: 'running', phase: 'page', status: '正在播放' } };
  const window = page('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1', '<body></body>', { stored });
  window.run('Panel.init(5)');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const host = window.document.getElementById('course-runner-panel');
  host.shadowRoot.querySelector('[data-act="min"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const mini = host.shadowRoot.querySelector('.mini');
  mini.style.left = '600px';
  mini.style.top = '500px';

  mini.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 620, clientY: 520 }));
  window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 700, clientY: 560 }));
  window.dispatchEvent(new window.MouseEvent('pointerup', { clientX: 700, clientY: 560 }));
  assert.equal(stored.panelView.x, 680);
  assert.equal(stored.panelView.y, 540);
  assert.equal(mini.style.left, '680px');
  assert.equal(mini.style.top, '540px');

  // 拖动松手后浏览器补发的 click 不能展开面板。
  mini.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stored.panelView.minimized, true);
  assert.ok(host.shadowRoot.querySelector('.mini'));
  // 之后再点一下才展开。
  mini.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stored.panelView.minimized, false);
  assert.ok(host.shadowRoot.querySelector('.box'));
});

test('left catalog trusts #curChapterId when the old row is still highlighted', { skip }, () => {
  const window = page('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=101&courseId=2&clazzid=3&enc=e', `<body>
    <input id="curChapterId" value="102">
    <div class="posCatalog_select posCatalog_active"><span onclick="getTeacherAjax('2','3','101')">1.1</span><input class="jobUnfinishCount" value="0"></div>
    <div class="posCatalog_select"><span onclick="getTeacherAjax('2','3','102')">1.2</span><input class="jobUnfinishCount" value="2"></div>
  </body>`);
  assert.deepEqual(window.run('catalogSummary()').map((c) => c.active), [false, true]);
  assert.deepEqual(window.run('currentTreeTaskState()'), { kind: 'remaining', count: 2 });
});

test('floating panel is not rebuilt while it is being dragged or when nothing visible changed', { skip }, async () => {
  const stored = { 'task:5': { state: 'running', phase: 'page', status: '正在播放', updatedAt: 1 } };
  const window = page('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1', '<body></body>', { stored });
  window.run('Panel.init(5)');
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
  await settle();
  const host = window.document.getElementById('course-runner-panel');
  const header = host.shadowRoot.querySelector('header');
  // 只有 updatedAt 变化：不重建。
  stored['task:5'] = { ...stored['task:5'], updatedAt: 2 };
  window.fireStorageChange({ 'task:5': {} });
  await settle();
  assert.equal(host.shadowRoot.querySelector('header'), header);
  // 按住拖动期间状态文字变了：先不重建，松开后再更新。
  host.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  stored['task:5'] = { ...stored['task:5'], status: '开始第 2 个任务点' };
  window.fireStorageChange({ 'task:5': {} });
  await settle();
  assert.equal(host.shadowRoot.querySelector('header'), header);
  window.dispatchEvent(new window.Event('pointerup'));
  await settle();
  assert.match(host.shadowRoot.textContent, /开始第 2 个任务点/);
});

test('page structure is scanned at most once per 30 seconds per address unless a log export forces it', { skip }, async () => {
  const window = page('https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1', '<body><div id="a"></div></body>');
  const logs = [];
  window.chrome.runtime.sendMessage = async (message) => { if (message.type === 'DIAG_LOG') logs.push(message.event); };
  window.run('structureDiagnostic()');
  window.document.body.append(window.document.createElement('video'));
  window.run('structureDiagnostic()');
  assert.equal(logs.length, 1);
  window.run('structureDiagnostic(true)');
  assert.equal(logs.length, 2);
});

test('directory fallback retains the starting page layout and uses fresh chapter credentials', {skip},()=>{
 const w=page('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1&courseId=2&clazzid=3&enc=old&fanyaVersion=2&hidetype=1&mooc2=1&openc=abc&cpi=student','<body></body>');
 const directory=new URL(w.run('courseDirectoryUrl()'));assert.equal(directory.searchParams.get('fanyaVersion'),'2');assert.equal(directory.searchParams.get('hidetype'),'1');
 w.run('var view=studyViewContext()');const next=new URL(w.run('preserveStudyView("https://mooc1.chaoxing.com/mooc-ans/mycourse/studentstudy?courseId=2&clazzid=3&chapterId=7&enc=fresh",view)'));
 assert.equal(next.pathname,'/mycourse/studentstudy');assert.equal(next.searchParams.get('chapterId'),'7');assert.equal(next.searchParams.get('enc'),'fresh');assert.equal(next.searchParams.get('fanyaVersion'),'2');assert.equal(next.searchParams.get('hidetype'),'1');assert.equal(next.searchParams.get('cpi'),'student');
});

test('native sidebar preference folds with the platform control and restores without removing frames', {skip}, async()=>{
 const stored={collapseCourseSidebar:true};
 const w=page('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7&courseId=8&clazzid=9',
 '<div id="selector" class="posChapter posChapter_right"><div class="switchbtn"></div><span>目录</span></div><iframe id="iframe"></iframe>',{stored});
 try {
 const button=w.document.querySelector('.switchbtn');let clicks=0;
 button.onclick=()=>{clicks++;button.classList.toggle('switchbtn_cur')};
 w.run('CourseLayout.apply()');await new Promise(r=>setTimeout(r,0));
 assert.equal(button.classList.contains('switchbtn_cur'),true);
 w.run('CourseLayout.apply()');await new Promise(r=>setTimeout(r,0));assert.equal(clicks,1);
 stored.collapseCourseSidebar=false;w.run('CourseLayout.apply()');await new Promise(r=>setTimeout(r,0));
 assert.equal(button.classList.contains('switchbtn_cur'),false);
 assert.equal(w.document.querySelectorAll('#iframe').length,1);
 }finally{w.close()}
});

test('navigation removes layout flags absent from the original study entry', {skip}, ()=>{
 const w=page('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7&courseId=8&clazzid=9', '<body></body>');
 try {
 const url=w.run(`preserveStudyView('https://mooc1.chaoxing.com/mooc-ans/mycourse/studentstudy?chapterId=10&courseId=8&clazzid=9&mooc2=1&hidetype=2&enc=new',studyViewContext())`);
 const parsed=new URL(url);assert.equal(parsed.pathname,'/mycourse/studentstudy');assert.equal(parsed.searchParams.has('mooc2'),false);assert.equal(parsed.searchParams.has('hidetype'),false);assert.equal(parsed.searchParams.get('enc'),'new');
 }finally{w.close()}
});
