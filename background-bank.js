// 本地题库：仅匹配可读取的完整题干、题型和选项内容，不请求网络，不按选项顺序猜答案。
const QuestionBank = (() => {
  const LIMIT = 2000;
  const MAX_BYTES = 2 * 1024 * 1024;
  const TYPES = new Set(['single', 'multiple', 'judgment', 'fill']);
  const normalize = value => String(value || '').normalize('NFC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  // 匹配键：全角 ASCII 字符转半角，汉字和标点之间的空白去掉（英文单词之间保留一个空格），
  // 去掉平台常见的题号、题型标签、结尾分值和一个句号；大小写、上下标、问号叹号等仍需一致。
  const halfWidth = value => value.replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');
  const compact = value => normalize(halfWidth(normalize(value))).replace(/ (?![A-Za-z0-9])|(?<![A-Za-z0-9]) /g, '').replace(/_{2,}/g, '__');
  const SCORE = /\(\d+(?:\.\d+)?分\)$/;
  function stemKey(value) {
    return compact(value)
      .replace(/^\d+[.、)]?(?=【(?:单选|多选|判断|填空)题】)/, '')
      .replace(/^\d+[.、)](?!\d)/, '')
      .replace(/^【(?:单选|多选|判断|填空)题】/, '')
      .replace(/^\d+[.、)](?!\d)/, '')
      .replace(SCORE, '')
      .replace(/[。.]$/, '');
  }
  function optionKey(value, type) {
    const full = compact(value);
    const text = full.replace(/^[A-Z][.、)](?=.)/, '').replace(/[。.;；]$/, '') || full;
    if (type === 'judgment') {
      if (/^(对|正确|是|true|√|✓|✔)$/i.test(text)) return 'true';
      if (/^(错|错误|否|false|×|✗|✘)$/i.test(text)) return 'false';
    }
    return text;
  }
  function text(value, label, max) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label}不能为空，且不能超过 ${max} 字`);
    return value.trim();
  }
  function entry(raw) {
    if (!raw || !TYPES.has(raw.type)) throw new Error('题型须为 single、multiple、judgment 或 fill');
    const result = { type: raw.type, stem: text(raw.stem, '题干', 3000) };
    if (!stemKey(result.stem) || /见截图|[\uE000-\uF8FF]/.test(result.stem)) throw new Error('请录入可读的完整题干，不能使用截图占位文字或加密字符');
    if (result.type === 'fill') {
      if (!Array.isArray(raw.blanks) || !raw.blanks.length || raw.blanks.length > 20) throw new Error('填空题须按顺序录入 1–20 个空的答案');
      result.blanks = raw.blanks.map(value => text(value, '填空答案', 500));
      result.options = [];
    } else {
      if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 26) throw new Error('选择或判断题须录入 2–26 个选项');
      if (result.type === 'judgment' && raw.options.length !== 2) throw new Error('判断题须录入两个选项');
      result.options = raw.options.map((option, index) => ({
        id: typeof option === 'string' ? String.fromCharCode(65 + index) : text(option?.id, '选项编号', 1).toUpperCase(),
        text: text(typeof option === 'string' ? option : option?.text, '选项内容', 1000)
      }));
      if (result.options.some(option => !/^[A-Z]$/.test(option.id)) || new Set(result.options.map(option => option.id)).size !== result.options.length ||
          new Set(result.options.map(option => optionKey(option.text, result.type))).size !== result.options.length) throw new Error('选项编号或内容重复，无法可靠匹配');
      if (!Array.isArray(raw.choices) || !raw.choices.length) throw new Error('请录入答案编号，例如 ["A"] 或 ["A", "C"]');
      result.choices = [...new Set(raw.choices.map(value => String(value).trim().toUpperCase()))].sort();
      if (result.choices.some(value => !result.options.some(option => option.id === value)) || (result.type !== 'multiple' && result.choices.length !== 1)) throw new Error('答案编号不在选项中，或单选／判断题有多个答案');
    }
    if (typeof raw.id === 'string' && /^[\w-]{1,80}$/.test(raw.id)) result.id = raw.id;
    return result;
  }
  function identity(item) {
    return JSON.stringify([item.type, stemKey(item.stem), item.type === 'fill' ? item.blanks.length :
      item.options.map(option => optionKey(option.text, item.type)).sort()]);
  }
  function answerKey(item) {
    return JSON.stringify(item.type === 'fill' ? item.blanks : item.options.filter(option => item.choices.includes(option.id)).map(option => optionKey(option.text, item.type)).sort());
  }
  function parse(value) {
    let raw;
    try { raw = typeof value === 'string' ? JSON.parse(value.replace(/^\ufeff/, '')) : value; }
    catch { throw new Error('题库 JSON 格式无效，请使用下载的模板'); }
    const list = Array.isArray(raw) ? raw : raw?.questions;
    if (!Array.isArray(list) || !list.length || list.length > LIMIT) throw new Error(`题库须包含 1–${LIMIT} 道题（数组或 {"questions": [...]}）`);
    return list.map((value, index) => {
      try { return entry(value); } catch (error) { throw new Error(`第 ${index + 1} 题：${error.message}`); }
    });
  }
  async function read() {
    const { questionBank } = await chrome.storage.local.get('questionBank');
    return Array.isArray(questionBank) ? questionBank : [];
  }
  async function mutate(update) {
    // 与其他答题设置共用写队列；题库和版本号一次保存，使已读取的旧答案立即失效。
    const write = aiSettingsWrites.then(async () => {
      const list = await read();
      const result = update(list);
      if (result.entries.length > LIMIT || new TextEncoder().encode(JSON.stringify(result.entries)).length > MAX_BYTES) throw new Error('题库超过容量上限（2000 题或 2 MB），请先删除部分题目');
      cancelAIRequests();
      await chrome.storage.local.set({ questionBank: result.entries, questionBankCount: result.entries.length, aiRevision: `${Date.now()}:${Math.random()}` });
      return { ok: true, total: result.entries.length, ...result.info };
    });
    aiSettingsWrites = write.catch(() => {});
    return write;
  }
  function merge(list, incoming, editingId) {
    const entries = list.filter(item => item.id !== editingId);
    const byIdentity = new Map(entries.map(item => [identity(item), item]));
    let added = 0, skipped = 0;
    for (const item of incoming) {
      const key = identity(item), same = byIdentity.get(key);
      if (same) {
        if (answerKey(same) !== answerKey(item)) throw new Error('题库中已有相同题目但答案不同，请先查找并编辑原题');
        skipped++; continue;
      }
      const saved = { ...item, id: editingId || `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` };
      entries.push(saved); byIdentity.set(key, saved);
      added++;
    }
    return { entries, info: { added, skipped } };
  }
  function lookup(questions, entries) {
    if (!Array.isArray(questions) || !questions.length || questions.length > 100 || new Set(questions.map(q => String(q.id))).size !== questions.length) throw new Error('题目数量或编号无效');
    const answers = [], missing = [], index = new Map();
    for (const item of entries) {
      const key = JSON.stringify([item.type, stemKey(item.stem)]);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(item);
    }
    for (const question of questions) {
      const miss = reason => missing.push({ id: question.id, reason });
      if (question.needsImage || /见截图|[\uE000-\uF8FF]/.test(question.stem || '')) { miss('图片或加密题需要可读文字'); continue; }
      const candidates = index.get(JSON.stringify([question.type, stemKey(question.stem)])) || [];
      const matches = [];
      for (const item of candidates) {
        if (question.type === 'fill') {
          if (item.blanks.length === question.blankCount) matches.push({ id: question.id, blanks: item.blanks });
          continue;
        }
        if (!Array.isArray(question.options) || question.options.length !== item.options.length) continue;
        const byText = new Map(question.options.map(option => [optionKey(option.text, question.type), option.id]));
        if (byText.size !== question.options.length || item.options.some(option => !byText.has(optionKey(option.text, item.type)))) continue;
        matches.push({ id: question.id, choices: item.options.filter(option => item.choices.includes(option.id)).map(option => byText.get(optionKey(option.text, item.type))).sort() });
      }
      if (!matches.length) { miss('题干、题型、选项或空位数未匹配'); continue; }
      if (new Set(matches.map(answer => JSON.stringify(answer))).size !== 1) { miss('相同题目存在冲突答案'); continue; }
      answers.push(matches[0]);
    }
    return { answers, missing, total: questions.length, hits: answers.length };
  }
  async function handle(message, sender) {
    if (message.type === 'BANK_LOOKUP') {
      if (message.guard?.source !== 'bank') throw new Error('题库请求来源无效');
      await validateAIContext(sender.tab?.id, message.guard);
      const result = lookup(message.questions, await read());
      await assertAIRequest(sender.tab?.id, message.guard);
      return result;
    }
    if (message.type === 'BANK_LIST') return { entries: await read() };
    if (message.type === 'BANK_IMPORT') {
      if (typeof message.text !== 'string' || message.text.length > MAX_BYTES) throw new Error('请选择不超过 2 MB 的 JSON 题库');
      const incoming = parse(message.text);
      return mutate(list => merge(list, incoming));
    }
    if (message.type === 'BANK_SAVE') {
      const item = entry(message.entry);
      return mutate(list => {
        if (message.entry.id && !list.some(value => value.id === message.entry.id)) throw new Error('原题已被删除，请刷新后重新录入');
        return merge(list, [item], message.entry.id);
      });
    }
    if (message.type === 'BANK_DELETE') return mutate(list => ({ entries: list.filter(item => item.id !== message.id) }));
    throw new Error('未知题库操作');
  }
  return { handle, lookup, parse };
})();
