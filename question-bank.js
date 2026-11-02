const $ = id => document.getElementById(id);
const TYPE_LABELS = { single: '单选', multiple: '多选', judgment: '判断', fill: '填空' };
const PAGE_SIZE = 20;
let entries = [], page = 0, busy = false, loadVersion = 0;

function message(value, error = false) { $('message').textContent = value; $('message').dataset.error = String(error); }
async function send(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (result?.error) throw new Error(result.error);
  if (!result) throw new Error('题库未连接，请重新加载扩展后再试');
  return result;
}
async function run(operation) {
  if (busy) return;
  busy = true;
  try { await operation(); } catch (error) { message(error.message || '题库操作失败', true); }
  finally { busy = false; }
}
async function load() {
  const version = ++loadVersion;
  const [result, settings] = await Promise.all([send('BANK_LIST'), chrome.storage.local.get('questionBankEnabled')]);
  if (version !== loadVersion) return;
  entries = result.entries || [];
  $('enabled').checked = settings.questionBankEnabled === true;
  render();
}
function render() {
  $('total').textContent = String(entries.length);
  const query = $('search').value.trim().toLowerCase(), type = $('filter').value;
  const filtered = entries.filter(item => (!type || item.type === type) && (!query || [item.stem, ...item.options.map(option => option.text)].join(' ').toLowerCase().includes(query)));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  $('previous').disabled = page === 0; $('next').disabled = page + 1 >= pages;
  $('pageInfo').textContent = `${page + 1} / ${pages} 页 · ${filtered.length} 题`;
  const rows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(item => {
    const row = document.createElement('article'); row.className = 'entry';
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = TYPE_LABELS[item.type];
    const stem = document.createElement('p'); stem.textContent = item.stem;
    const answer = document.createElement('small'); answer.textContent = `答案：${item.type === 'fill' ? item.blanks.join('；') : item.choices.map(choice => `${choice}. ${item.options.find(option => option.id === choice)?.text || ''}`).join('；')}`;
    const buttons = document.createElement('div'); buttons.className = 'buttons';
    const edit = document.createElement('button'); edit.textContent = '编辑'; edit.addEventListener('click', () => editEntry(item));
    const remove = document.createElement('button'); remove.textContent = '删除'; remove.className = 'danger';
    remove.addEventListener('click', () => run(async () => {
      await send('BANK_DELETE', { id: item.id });
      if ($('entryId').value === item.id) resetEditor();
      await load(); message('题目已删除');
    }));
    buttons.append(edit, remove); row.append(badge, stem, answer, buttons); return row;
  });
  if (!rows.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = entries.length ? '没有匹配的题目' : '还没有题目，先录入一道或导入 JSON 题库'; rows.push(empty); }
  $('entries').replaceChildren(...rows);
}
function updateType() {
  const fill = $('type').value === 'fill';
  $('optionsBox').hidden = fill;
  $('answerLabel').textContent = fill ? '每个空的答案（每行一个，按空位顺序）' : '答案编号';
  $('answer').placeholder = fill ? '第一个空的答案\n第二个空的答案' : '单选：A；多选：A,C';
  $('answerHint').textContent = fill ? '空位数量必须与课程题目一致。每行填写一个完整答案。' : '选项编号可以省略，将按 A、B、C… 自动编号。匹配时会按选项内容对应页面编号。';
  if ($('type').value === 'judgment' && !$('options').value.trim()) $('options').value = 'A. 对\nB. 错';
}
function resetEditor() {
  $('editor').reset(); $('entryId').value = ''; $('editorTitle').textContent = '录入新题'; updateType();
}
function editEntry(item) {
  $('entryId').value = item.id; $('type').value = item.type; $('stem').value = item.stem;
  $('options').value = item.options.map(option => `${option.id}. ${option.text}`).join('\n');
  $('answer').value = item.type === 'fill' ? item.blanks.join('\n') : item.choices.join(',');
  $('editorTitle').textContent = '编辑题目'; updateType(); $('stem').focus();
}
function formEntry() {
  const item = { type: $('type').value, stem: $('stem').value };
  if ($('entryId').value) item.id = $('entryId').value;
  if (item.type === 'fill') item.blanks = $('answer').value.split(/\r?\n/).map(line => line.trim());
  else {
    item.options = $('options').value.trim().split(/\r?\n/).map((line, index) => {
      const match = line.trim().match(/^([A-Z])[.、．:：]\s*(.*)$/i);
      return { id: match ? match[1].toUpperCase() : String.fromCharCode(65 + index), text: match ? match[2] : line.trim() };
    });
    const answer = $('answer').value.trim().toUpperCase();
    if (!/^[A-Z\s,，、;；]+$/.test(answer)) throw new Error('请用选项编号录入答案，例如 A 或 A,C');
    item.choices = answer.match(/[A-Z]/g);
  }
  return item;
}
async function importText(text) {
  const result = await send('BANK_IMPORT', { text });
  await load(); message(`已导入 ${result.added} 题，跳过 ${result.skipped} 道重复题；共 ${result.total} 题`);
}
function download(name, questions) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'course-runner-question-bank-v1', questions }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
$('editor').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const result = await send('BANK_SAVE', { entry: formEntry() });
  resetEditor(); await load(); message(result.skipped ? '该题已在题库中，无需重复录入' : '题目已保存到本机');
}); });
$('enabled').addEventListener('change', () => run(async () => {
  try {
    await send('SET_AI_SETTINGS', { patch: { questionBankEnabled: $('enabled').checked } });
    message($('enabled').checked ? '本地题库答题已开启，无需开启 AI' : '本地题库答题已关闭');
  } finally { await load(); }
}));
$('type').addEventListener('change', updateType);
$('newEntry').addEventListener('click', () => { resetEditor(); $('stem').focus(); });
$('showImport').addEventListener('click', () => { $('importBox').open = true; $('importBox').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('cancel').addEventListener('click', resetEditor);
for (const id of ['search', 'filter']) $(id).addEventListener('input', () => { page = 0; render(); });
$('previous').addEventListener('click', () => { page--; render(); });
$('next').addEventListener('click', () => { page++; render(); });
$('chooseFile').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', () => run(async () => {
  const file = $('file').files[0];
  try {
    if (!file) return;
    if (!/\.json$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error('请选择不超过 2 MB 的 JSON 题库文件');
    await importText(await file.text());
  } finally { $('file').value = ''; }
}));
$('importTextButton').addEventListener('click', () => run(async () => { await importText($('importText').value); $('importText').value = ''; }));
$('export').addEventListener('click', () => {
  if (!entries.length) return message('题库为空，请先录入题目', true);
  download('课程流程助手-本地题库.json', entries.map(({ id, ...item }) => item)); message('题库已导出');
});
$('template').addEventListener('click', () => download('课程流程助手-题库模板.json', [
  { type: 'single', stem: '一加一等于几？', options: ['二', '三'], choices: ['A'] },
  { type: 'multiple', stem: '下列哪些是偶数？', options: ['一', '二', '四'], choices: ['B', 'C'] },
  { type: 'judgment', stem: '地球绕太阳公转。', options: ['对', '错'], choices: ['A'] },
  { type: 'fill', stem: '水的化学式是____。', blanks: ['H2O'] }
]));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.questionBank || changes.questionBankEnabled)) load().catch(error => message(error.message, true));
});
updateType(); load().catch(error => message(error.message, true));
