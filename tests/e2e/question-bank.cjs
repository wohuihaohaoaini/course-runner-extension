// 加载真实扩展，使用本地模拟课程验证题库录入、导入和 AI 关闭后的完整答题链路。
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const extension = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'course-bank-e2e-'));
const output = process.env.E2E_OUTPUT || temp;
fs.mkdirSync(output, { recursive: true });
execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x087b71:s=320x180:r=10:d=5', '-c:v', 'libvpx', '-an', path.join(temp, 'clip.webm')], { stdio: 'ignore' });
const site = require('./course-site.cjs')({ clip: fs.readFileSync(path.join(temp, 'clip.webm')), vision: false });
const bank = [
  { type: 'single', stem: '二加三等于多少？', options: ['六', '四', '五'], choices: ['C'] },
  { type: 'multiple', stem: '示例题干 909', options: ['选项3', '选项1', '选项2'], choices: ['A', 'C'] },
  ...['101', '102'].map(id => ({ type: 'single', stem: `示例题干 ${id}`, options: ['选项3', '选项1', '选项2'], choices: ['C'] })),
  ...['103', '104'].map(id => ({ type: 'judgment', stem: `示例题干 ${id}`, options: ['正确', '错误'], choices: ['B'] })),
  { type: 'multiple', stem: '示例题干 105', options: ['选项3', '选项1', '选项2'], choices: ['A', 'B'] },
  { type: 'fill', stem: '填写：示例答案', blanks: ['示例答案'] }
];
(async () => {
  const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    channel: 'chromium', headless: true, viewport: { width: 1300, height: 1000 }, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required']
  });
  try {
    await context.route('https://mooc1.chaoxing.com/**', route => route.fulfill(site.respond(new URL(route.request().url()))));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
      globalThis.bankTestRequests = 0;
      globalThis.fetch = async () => { bankTestRequests++; throw new Error('题库模式不应调用 AI 或其他网络接口'); };
    });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const page = await context.newPage();
    await page.goto('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=7&courseId=8&clazzid=9');
    await page.waitForSelector('#course-runner-panel', { state: 'attached' });
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.includes('studentstudy')).id);
    const base = `chrome-extension://${new URL(worker.url()).host}/`;
    const popup = await context.newPage(); await popup.goto(base + 'popup.html');
    const opened = context.waitForEvent('page'); await popup.locator('#openQuestionBank').click();
    const manager = await opened; await manager.waitForURL(base + 'question-bank.html');
    await manager.locator('#stem').fill('录入验证题');
    await manager.locator('#options').fill('A. 答案一\nB. 答案二');
    await manager.locator('#answer').fill('A'); await manager.locator('#save').click();
    await manager.waitForFunction(() => document.getElementById('total').textContent === '1');
    await manager.locator('.entry button').filter({ hasText: '编辑' }).click();
    await manager.locator('#answer').fill('B'); await manager.locator('#save').click();
    await manager.waitForFunction(() => document.querySelector('.entry small').textContent.includes('B. 答案二'));
    await manager.locator('.entry button').filter({ hasText: '删除' }).click();
    await manager.waitForFunction(() => document.getElementById('total').textContent === '0');
    await manager.locator('#importBox').evaluate(element => { element.open = true; });
    await manager.locator('#file').setInputFiles({ name: '模拟题库.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ questions: bank })) });
    await manager.waitForFunction(() => document.getElementById('total').textContent === '8');
    await manager.locator('#search').fill('909'); assert.equal(await manager.locator('.entry').count(), 1);
    await manager.locator('#search').fill(''); await manager.locator('#filter').selectOption('fill'); assert.equal(await manager.locator('.entry').count(), 1);
    await manager.locator('#filter').selectOption('');
    const downloadEvent = manager.waitForEvent('download'); await manager.locator('#export').click();
    const download = await downloadEvent; const exportedPath = path.join(output, 'exported-bank.json'); await download.saveAs(exportedPath);
    assert.equal(JSON.parse(fs.readFileSync(exportedPath, 'utf8')).questions.length, 8);
    await manager.locator('#enabled').check();
    await manager.waitForFunction(() => document.getElementById('message').textContent.includes('已开启'));
    await manager.screenshot({ path: path.join(output, 'question-bank.png'), fullPage: true });
    await manager.setViewportSize({ width: 390, height: 844 });
    assert.equal(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await manager.screenshot({ path: path.join(output, 'question-bank-mobile.png'), fullPage: true });
    await popup.reload(); await popup.locator('#autoSubmit').check();
    const settings = await worker.evaluate(() => chrome.storage.local.get(['aiEnabled', 'apiKey', 'questionBankEnabled', 'questionBankCount']));
    assert.notEqual(settings.aiEnabled, true); assert.ok(!settings.apiKey); assert.equal(settings.questionBankEnabled, true); assert.equal(settings.questionBankCount, 8);
    await popup.close(); await manager.close(); await page.bringToFront();
    await worker.evaluate(() => chrome.storage.local.set({ notify: false, muted: true }));
    assert.equal((await worker.evaluate(id => chrome.tabs.sendMessage(id, { type: 'START' }, { frameId: 0 }), tabId)).ok, true);
    let task, previous = ''; const deadline = Date.now() + 140000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(700);
      task = await worker.evaluate(async id => (await chrome.storage.local.get(`task:${id}`))[`task:${id}`], tabId);
      if (task?.status !== previous) { previous = task?.status; console.log(task?.state + '/' + task?.phase, previous); }
      if (task?.state !== 'running') break;
    }
    assert.equal(task?.state, 'completed'); assert.deepEqual([...site.finished].sort(), ['q', 'v1', 'v2', 'v3']);
    for (const [type, expected] of [['video-submit', 3], ['video-continue', 3], ['video-resumed', 3], ['quiz-submit', 1], ['quiz-confirm', 1], ['quiz-cancel', 0]]) {
      assert.equal(site.events.filter(event => event.type === type).length, expected, type);
    }
    const requests = await worker.evaluate(() => bankTestRequests); assert.equal(requests, 0); assert.deepEqual(errors, []);
    assert.equal(await page.locator('#curChapterId').inputValue(), '8');
    await page.screenshot({ path: path.join(output, 'completed.png') });
    const report = { status: 'passed', manualCRUD: true, fileImport: true, searchAndFilter: true, export: true, responsive: true, aiEnabled: false, apiKey: false, apiRequests: requests, finished: [...site.finished], events: site.events, errors };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log('PASS', JSON.stringify(report));
  } finally { await context.close(); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
