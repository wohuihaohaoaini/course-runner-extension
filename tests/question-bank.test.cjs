const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const single = { type: 'single', stem: '一加一等于几？', options: ['二', '三'], choices: ['A'] };
const question = { id: 'page-q1', ...single, options: [{ id: 'A', text: '三' }, { id: 'B', text: '二' }], needsImage: false };
const guard = { source: 'bank', runId: 'r1', revision: 's1', kind: 'quiz', chapterId: '7', jobId: 'q', frameId: 2, frameToken: 'doc1' };
function fixture() {
  const stored = { questionBankEnabled: true, aiEnabled: false, aiRevision: 's1', 'task:1': { state: 'running', runId: 'r1', activeChapterId: '7', currentJobId: 'q' } };
  let listener, calls = 0;
  const listeners = [];
  const context = vm.createContext({ TextEncoder, TextDecoder, AbortController, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => { calls++; throw new Error('题库模式不应请求网络'); },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: {
        get: async keys => Object.fromEntries((typeof keys === 'string' ? [keys] : keys || Object.keys(stored)).map(key => [key, stored[key]])),
        set: async patch => { const changes = {}; for (const [key, value] of Object.entries(patch)) { changes[key] = { oldValue: stored[key], newValue: value }; stored[key] = value; } listeners.forEach(fn => fn(changes, 'local')); }
      }, onChanged: { addListener: fn => listeners.push(fn) } },
      webNavigation: { getAllFrames: async () => [{ frameId: 0 }, { frameId: 2 }] },
      tabs: { sendMessage: async (id, msg, options) => options.frameId === 0 ? { kind: 'other', chapterId: '7' } : { kind: 'quiz', active: true, aiDocument: 'doc1' } }
    }
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  const send = message => new Promise(resolve => listener(message, { tab: { id: 1 }, frameId: 0 }, resolve));
  const lookup = (questions, entries) => JSON.parse(JSON.stringify(run(`QuestionBank.lookup(${JSON.stringify(questions)}, QuestionBank.parse(${JSON.stringify(entries)}))`)));
  return { stored, send, run, lookup, calls: () => calls };
}
test('local bank maps the answer by option text after page choices are shuffled', () => {
  const f = fixture(); const found = f.lookup([question], [single]);
  assert.deepEqual(found.answers, [{ id: 'page-q1', choices: ['B'] }]); assert.equal(found.hits, 1);
});
test('multiple choice, judgment aliases and ordered blanks all match without AI', () => {
  const f = fixture(); const entries = [
    { type: 'multiple', stem: '选偶数', options: ['一', '二', '四'], choices: ['B', 'C'] },
    { type: 'judgment', stem: '地球绕太阳公转', options: ['对', '错'], choices: ['A'] },
    { type: 'fill', stem: '两种气体', blanks: ['氧气', '氮气'] }
  ];
  const found = f.lookup([
    { id: 'm', type: 'multiple', stem: '选偶数', options: [{ id: 'A', text: '四' }, { id: 'B', text: '一' }, { id: 'C', text: '二' }] },
    { id: 'j', type: 'judgment', stem: '地球绕太阳公转', options: [{ id: 'A', text: '错误' }, { id: 'B', text: '正确' }] },
    { id: 'f', type: 'fill', stem: '两种气体', blankCount: 2 }
  ], entries);
  assert.deepEqual(found.answers, [{ id: 'm', choices: ['A', 'C'] }, { id: 'j', choices: ['B'] }, { id: 'f', blanks: ['氧气', '氮气'] }]);
});
test('bank tolerates platform numbering, type labels and repeated whitespace but preserves negation and punctuation', () => {
  const f = fixture();
  assert.equal(f.lookup([{ ...question, stem: '1 【单选题】 一加一等于几？' }], [single]).hits, 1);
  assert.equal(f.lookup([{ ...question, stem: '一加一不等于几？' }], [single]).hits, 0);
  assert.equal(f.lookup([{ ...question, stem: '一加一等于几？!' }], [single]).hits, 0);
});
test('case, superscripts and word boundaries retain their meaning when matching', () => {
  const f = fixture();
  for (const [original, different] of [['CO', 'Co'], ['2²', '22'], ['not able', 'notable']]) {
    assert.equal(f.lookup([{ ...question, stem: different }], [{ ...single, stem: original }]).hits, 0);
  }
});
test('different options, wrong type, duplicate options, images and wrong blank counts do not match', () => {
  const f = fixture();
  for (const patch of [
    { options: [{ id: 'A', text: '二' }, { id: 'B', text: '四' }] },
    { type: 'multiple' }, { options: [{ id: 'A', text: '二' }, { id: 'B', text: '二' }] }, { needsImage: true }
  ]) assert.equal(f.lookup([{ ...question, ...patch }], [single]).hits, 0);
  assert.equal(f.lookup([{ id: 'f', type: 'fill', stem: '填空', blankCount: 2 }], [{ type: 'fill', stem: '填空', blanks: ['一个空'] }]).hits, 0);
});
test('conflicting matching answers are reported instead of picking an arbitrary record', () => {
  const f = fixture(); const found = f.lookup([question], [single, { ...single, choices: ['B'] }]);
  assert.equal(found.hits, 0); assert.match(found.missing[0].reason, /冲突/);
});
test('JSON imports are atomic, deduplicate shuffled entries, and retain the old bank on errors', async () => {
  const f = fixture();
  const send = entries => f.send({ type: 'BANK_IMPORT', text: JSON.stringify({ questions: entries }) });
  assert.equal((await send([single])).added, 1); assert.equal(f.stored.questionBankCount, 1);
  const id = f.stored.questionBank[0].id;
  assert.equal((await send([{ ...single, options: ['三', '二'], choices: ['B'] }])).skipped, 1);
  assert.match((await send([{ ...single, choices: ['B'] }])).error, /冲突|不同/);
  assert.match((await send([{ ...single, stem: '新题' }, { type: 'invalid' }])).error, /第 2 题/);
  assert.equal(f.stored.questionBank.length, 1); assert.equal(f.stored.questionBank[0].id, id);
  assert.equal((await f.send({ type: 'BANK_IMPORT', text: '\ufeff' + JSON.stringify([single]) })).skipped, 1);
});
test('manual editing and deletion update counts and invalidate in-flight answer revisions', async () => {
  const f = fixture(); const result = await f.send({ type: 'BANK_SAVE', entry: single }); assert.equal(result.ok, true);
  const id = f.stored.questionBank[0].id, revision = f.stored.aiRevision;
  assert.equal((await f.send({ type: 'BANK_SAVE', entry: { ...single, id, choices: ['B'] } })).ok, true);
  assert.notEqual(f.stored.aiRevision, revision); assert.deepEqual([...f.stored.questionBank[0].choices], ['B']);
  assert.equal((await f.send({ type: 'BANK_DELETE', id })).total, 0); assert.equal(f.stored.questionBankCount, 0);
  assert.match((await f.send({ type: 'BANK_SAVE', entry: { ...single, id } })).error, /删除/);
});
test('concurrent bank edits are serialized without losing an imported question', async () => {
  const f = fixture();
  await Promise.all([f.send({ type: 'BANK_SAVE', entry: single }), f.send({ type: 'BANK_SAVE', entry: { ...single, stem: '另一道题' } })]);
  assert.equal(f.stored.questionBankCount, 2);
});
test('a rejected conflicting import leaves the current answer request running', async () => {
  const f = fixture(); await f.send({ type: 'BANK_SAVE', entry: single });
  f.run('var bankAbortCount = 0; activeAIRequests.add({controller:{abort(){bankAbortCount++}}})');
  assert.match((await f.send({ type: 'BANK_IMPORT', text: JSON.stringify([{ ...single, choices: ['B'] }]) })).error, /不同|冲突/);
  assert.equal(f.run('bankAbortCount'), 0);
});
test('bank lookup works with AI off and no key, and its guard cannot call the paid API', async () => {
  const f = fixture(); await f.send({ type: 'BANK_SAVE', entry: single });
  const current = { ...guard, revision: f.stored.aiRevision };
  assert.equal((await f.send({ type: 'BANK_LOOKUP', questions: [question], guard: current })).hits, 1);
  assert.match((await f.send({ type: 'ANSWER', questions: [question], guard: current })).error, /不能调用/);
  assert.equal(f.calls(), 0);
});
test('disabled bank, old revision, pause and captcha prevent bank results from being applied', async () => {
  const f = fixture();
  assert.match((await f.send({ type: 'BANK_LOOKUP', questions: [question], guard: { ...guard, source: 'ai' } })).error, /来源/);
  for (const patch of [{ questionBankEnabled: false }, { aiRevision: 'new' }, { 'task:1': { state: 'paused' } }]) {
    const before = { ...f.stored }; Object.assign(f.stored, patch);
    assert.ok((await f.send({ type: 'BANK_LOOKUP', questions: [question], guard })).error);
    Object.assign(f.stored, before);
  }
  f.run("chrome.tabs.sendMessage=async()=>({kind:'quiz',active:true,aiDocument:'doc1',captcha:true})");
  assert.match((await f.send({ type: 'BANK_LOOKUP', questions: [question], guard })).error, /验证/);
});
test('bank submission locks keep their source and prevent a second submit after restart', async () => {
  const f = fixture();
  const first = await f.send({ type: 'AI_CLAIM_SUBMISSION', key: 'bank-question', guard });
  assert.equal(first.claimed, true); assert.equal(first.record.source, 'bank');
  const second = await f.send({ type: 'AI_CLAIM_SUBMISSION', key: 'bank-question', guard });
  assert.equal(second.claimed, false); assert.equal(second.record.source, 'bank');
});
test('invalid and oversized imports do not save partial data', async () => {
  const f = fixture();
  for (const text of ['invalid', '[]', JSON.stringify([{ ...single, choices: ['Z'] }]), 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    assert.ok((await f.send({ type: 'BANK_IMPORT', text })).error);
    assert.equal(f.stored.questionBank, undefined);
  }
});
