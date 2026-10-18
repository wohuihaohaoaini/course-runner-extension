// 页面悬浮面板：固定控件、局部更新；拖动不依赖课程 iframe 内的鼠标事件。
const Panel = (() => {
  const STATE_TEXT = { idle: '待启动', running: '运行中', waiting: '等你处理', paused: '已暂停', error: '需处理', completed: '已完成' };
  const JOB_ICON = { done: '✓', current: '›', skipped: '↷', pending: '○' };
  const JOB_TYPE = { video: '视频', audio: '音频', document: '文档', quiz: '测验', book: '阅读', link: '链接', other: '其他' };
  let root, host, tabId, captureTimer, currentTask, renderVersion = 0;
  let pointerHeld = false, renderDeferred = false, dragging = false, viewLoaded = false;
  let view = { schema: 2, x: null, y: null, minimized: false, section: null };
  const signatures = new Map();
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const STYLE = `
    :host { all: initial; color-scheme: light; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .box, .mini { position: fixed; z-index: 2147483000; font: 13px/1.5 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }
    .box { width: min(300px, calc(100vw - 24px)); max-height: calc(100vh - 24px); display: flex; flex-direction: column;
      background: #fff; color: #0f172a; border: 1px solid #cbd5e1; border-radius: 10px; box-shadow: 0 8px 28px #0f172a20; overflow: hidden; }
    .box[data-state=waiting] { border-color: #f0bd67; box-shadow: 0 0 0 2px #fef3c7, 0 8px 28px #0f172a20; }
    .box[data-state=error] { border-color: #fca5a5; }
    header { display: flex; flex: none; align-items: center; gap: 8px; padding: 9px 10px 9px 12px;
      background: #f1f5f9; cursor: grab; user-select: none; touch-action: none; }
    header b { font-size: 13px; white-space: nowrap; }
    .chip { font-size: 11px; padding: 1px 7px; border-radius: 9px; background: #e2e8f0; color: #475569; white-space: nowrap; }
    .chip[data-state=running] { background: #dbeafe; color: #1d4ed8; }
    .chip[data-state=waiting] { background: #fef3c7; color: #92400e; }
    .chip[data-state=error] { background: #fee2e2; color: #b91c1c; }
    .chip[data-state=completed] { background: #dcfce7; color: #166534; }
    button { font: inherit; cursor: pointer; color: inherit; }
    button:focus-visible, a:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
    .icon-btn { margin-left: auto; border: 0; background: none; font-size: 15px; color: #64748b; padding: 0 4px; }
    .icon-btn:hover { color: #1d4ed8; }
    .body { padding: 10px 12px 0; flex: none; }
    .status { margin: 0 0 8px; line-height: 1.6; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; overflow-wrap: anywhere; }
    .chapter, .ai-caption { color: #64748b; font-size: 12px; margin-bottom: 6px; }
    .chapter { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .jobs { max-height: 96px; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
    ul { list-style: none; margin: 0 0 10px; padding: 0; }
    li { display: flex; gap: 6px; padding: 2px 0; font-size: 12px; color: #475569; }
    li[data-state=current] { color: #1d4ed8; font-weight: 600; }
    li[data-state=done] { color: #64748b; }
    .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { display: flex; gap: 6px; margin-bottom: 8px; }
    .act { flex: 1; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; padding: 5px 0; color: #334155; }
    .act:hover { background: #f8fafc; border-color: #94a3b8; }
    .act.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
    .act.primary:hover { background: #1d4ed8; border-color: #1d4ed8; }
    .act[aria-pressed=true] { background: #eff6ff; border-color: #93c5fd; color: #1d4ed8; }
    .tools { display: flex; align-items: center; gap: 16px; padding: 0 12px 10px; flex: none; }
    .fold { border: 0; background: none; padding: 4px 0; color: #2563eb; font-size: 12px; }
    .fold:hover { color: #1d4ed8; }
    .retry { color: #92400e; margin: 0 12px 8px; padding: 5px 8px; border: 1px solid #f0d49c; border-radius: 6px; background: #fffbeb; font-size: 12px; }
    .details-content { min-height: 0; max-height: 180px; overflow: auto; overscroll-behavior: contain;
      margin: 0 12px 10px; border-radius: 6px; background: #f8fafc; scrollbar-width: thin; scrollbar-color: #cbd5e1 transparent; }
    .details-content section { padding: 6px 8px; }
    .todo-item { padding: 4px 0; border-bottom: 1px solid #e2e8f0; font-size: 12px; overflow-wrap: anywhere; }
    .todo-item:last-child { border: 0; }
    .todo-item a { color: #2563eb; text-decoration: none; }
    .todo-item small { display: block; color: #64748b; margin-top: 2px; }
    .log div { margin-bottom: 6px; font-size: 12px; color: #475569; overflow-wrap: anywhere; }
    .empty { color: #64748b; font-size: 12px; }
    .mini { width: 44px; height: 44px; border-radius: 50%; border: 0; cursor: grab; background: #2563eb; color: #fff;
      font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px #0f172a30; user-select: none; touch-action: none; }
    .mini[data-state=waiting] { background: #b45309; }
    .mini[data-state=error] { background: #b91c1c; }
    .mini[data-state=completed] { background: #15803d; }
    .mini[data-state=paused], .mini[data-state=idle] { background: #64748b; }
    .drag-shield { position: fixed; inset: 0; z-index: 2147482999; cursor: grabbing; background: transparent; }
    .dragging { cursor: grabbing !important; will-change: transform; }
  `;

  function saveView() { chrome.storage.local.set({ panelView: { ...view } }).catch(() => {}); }
  function dimensions(element) {
    return { width: element.offsetWidth || (element.classList.contains('mini') ? 44 : 300), height: element.offsetHeight || 44 };
  }
  function clamp(x, y, size) {
    return { x: Math.max(8, Math.min(x, innerWidth - size.width - 8)), y: Math.max(8, Math.min(y, innerHeight - size.height - 8)) };
  }
  function place(element) {
    const size = dimensions(element);
    const point = clamp(view.x ?? innerWidth - size.width - 20, view.y ?? 96, size);
    element.style.left = `${point.x}px`; element.style.top = `${point.y}px`;
    return point;
  }
  function setHTML(selector, html) {
    if (signatures.get(selector) === html) return;
    signatures.set(selector, html); root.querySelector(selector).innerHTML = html;
  }
  function draggable(handle, element, activate) {
    let suppressClick = false;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.isPrimary === false || (!activate && event.target.closest('button'))) return;
      const size = dimensions(element);
      const origin = { x: parseFloat(element.style.left) || 0, y: parseFloat(element.style.top) || 0 };
      const start = { x: event.clientX, y: event.clientY };
      let point = origin, moved = false, animation;
      const draw = () => { animation = null; element.style.transform = `translate3d(${point.x - origin.x}px, ${point.y - origin.y}px, 0)`; };
      const move = e => {
        if (event.pointerId !== undefined && e.pointerId !== event.pointerId) return;
        if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
        if (!moved) { moved = dragging = true; element.classList.add('dragging'); root.querySelector('.drag-shield').hidden = false; }
        point = clamp(origin.x + e.clientX - start.x, origin.y + e.clientY - start.y, size);
        if (!animation) animation = requestAnimationFrame(draw);
        e.preventDefault();
      };
      const up = () => {
        removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true); removeEventListener('blur', up);
        if (animation) cancelAnimationFrame(animation);
        root.querySelector('.drag-shield').hidden = true;
        element.classList.remove('dragging'); element.style.transform = '';
        try { if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
        if (moved) {
          view.x = point.x; view.y = point.y; element.style.left = `${point.x}px`; element.style.top = `${point.y}px`;
          suppressClick = true; saveView(); setTimeout(() => { suppressClick = false; }, 0);
        }
        dragging = false;
      };
      try { handle.setPointerCapture?.(event.pointerId); } catch { /* shield handles older browsers */ }
      addEventListener('pointermove', move, { capture: true, passive: false }); addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true); addEventListener('blur', up);
    });
    handle.addEventListener('click', event => {
      if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      activate?.();
    }, true);
  }

  async function render() {
    if (!root) return;
    const version = ++renderVersion;
    const key = `task:${tabId}`;
    const s = await chrome.storage.local.get([key, 'todos', 'muted', 'panelView', 'aiEnabled', 'aiVideoEnabled', 'aiQuizEnabled', 'videoAnswerMode']);
    if (version !== renderVersion) return;
    if (pointerHeld || dragging) { renderDeferred = true; return; }
    if (!viewLoaded) {
      const saved = s.panelView || {};
      view = { ...view, x: Number.isFinite(saved.x) ? saved.x : null, y: Number.isFinite(saved.y) ? saved.y : null,
        minimized: saved.minimized === true, section: saved.schema === 2 && ['todo', 'log'].includes(saved.section) ? saved.section : null };
      viewLoaded = true;
    }
    currentTask = s[key] || null;
    const task = currentTask;
    const state = task?.state === 'running' && task.phase === 'waiting' ? 'waiting' : task?.state || 'idle';
    const running = task?.state === 'running', ai = s.aiEnabled === true;
    const jobs = task?.jobs || [], todos = Array.isArray(s.todos) ? s.todos : [];
    const box = root.querySelector('.box'), mini = root.querySelector('.mini');
    box.hidden = view.minimized; mini.hidden = !view.minimized; box.dataset.state = mini.dataset.state = state;
    mini.title = `课程流程助手：${STATE_TEXT[state]}（点击展开，按住拖动）`;
    const chip = root.querySelector('.chip'); chip.dataset.state = state; chip.textContent = STATE_TEXT[state] || '待启动';
    const status = root.querySelector('.status'); status.textContent = task?.status || '打开课程学习页后开始。'; status.title = status.textContent;
    const chapter = root.querySelector('.chapter'); chapter.textContent = task?.chapterName ? `当前小节：${task.chapterName}` : ''; chapter.hidden = !task?.chapterName;
    const start = root.querySelector('[data-act=toggle]'); start.textContent = running ? '暂停' : '开始'; start.classList.toggle('primary', !running);
    const aiButton = root.querySelector('[data-act=ai]'); aiButton.textContent = `AI：${ai ? '开启' : '关闭'}`; aiButton.setAttribute('aria-pressed', String(ai));
    const mute = root.querySelector('[data-act=mute]'); mute.textContent = s.muted === true ? '🔇 已静音' : '🔊 静音'; mute.setAttribute('aria-pressed', String(s.muted === true));
    const videoMode = s.videoAnswerMode === 'trial' ? '单选顺序试答' : s.videoAnswerMode === 'manual' ? '手动' : ai && s.aiVideoEnabled !== false ? 'AI' : '手动';
    root.querySelector('.ai-caption').textContent = `视频弹题：${videoMode} · 章节测验：${ai && s.aiQuizEnabled !== false ? 'AI' : '手动/跳过'}`;
    root.querySelector('[data-act=retry]').hidden = !(running && task?.ai?.stage === 'error');
    for (const [section, label] of [['todo', `待你处理（${todos.length}）`], ['log', '运行记录']]) {
      const button = root.querySelector(`[data-act=${section}]`); button.textContent = `${label} ${view.section === section ? '▴' : '▾'}`; button.setAttribute('aria-expanded', String(view.section === section));
      root.querySelector(`[data-section=${section}]`).hidden = view.section !== section;
    }
    const details = root.querySelector('.details-content'), scrollTop = details.scrollTop;
    details.hidden = !view.section;
    setHTML('.jobs', jobs.length ? `<ul>${jobs.map(j => `<li data-state="${escapeHtml(j.state)}"><span>${JOB_ICON[j.state] || '○'}</span><span>${JOB_TYPE[j.type] || '其他'}</span><span class="name" title="${escapeHtml(j.name)}">${escapeHtml(j.name)}</span></li>`).join('')}</ul>` : '<span class="empty">暂无任务点</span>');
    setHTML('.todo', todos.length ? todos.slice().reverse().map(item => `<div class="todo-item">${item.url ? `<a href="${escapeHtml(item.url)}">${escapeHtml(item.chapterName || '某一节')}</a>` : escapeHtml(item.chapterName || '某一节')} · ${escapeHtml(item.jobName || JOB_TYPE[item.type] || '任务')}<small>${escapeHtml(item.reason)}</small></div>`).join('') : '<span class="empty">暂无待办</span>');
    setHTML('.log', (task?.log || []).slice(-20).reverse().map(line => `<div>${new Date(line.at).toTimeString().slice(0, 5)} ${escapeHtml(line.text)}</div>`).join('') || '<span class="empty">暂无记录</span>');
    details.scrollTop = scrollTop;
    place(view.minimized ? mini : box);
  }

  async function act(action) {
    try {
      if (action === 'min') { view.minimized = true; saveView(); return render(); }
      if (['todo', 'log'].includes(action)) { view.section = view.section === action ? null : action; saveView(); return render(); }
      if (action === 'mute') { const { muted } = await chrome.storage.local.get('muted'); return chrome.storage.local.set({ muted: muted !== true }); }
      if (action === 'ai') {
        const { aiEnabled } = await chrome.storage.local.get('aiEnabled');
        const result = await chrome.runtime.sendMessage({ type: 'SET_AI_SETTINGS', patch: { aiEnabled: aiEnabled !== true } });
        if (result?.error) throw new Error(result.error); return render();
      }
      if (action === 'settings') { const result = await chrome.runtime.sendMessage({ type: 'OPEN_AI_SETTINGS' }); if (result?.error) throw new Error(result.error); return; }
      if (action === 'retry' || action === 'toggle') {
        const type = action === 'retry' ? 'RETRY_AI' : currentTask?.state === 'running' ? 'PAUSE' : 'START';
        const result = await handleStartOrPause(type); if (result?.error) throw new Error(result.error);
      }
    } catch (error) { const status = root.querySelector('.status'); status.textContent = displayError(error); status.title = status.textContent; }
  }

  function init(id) {
    if (root || !document.body) return;
    tabId = id; host = document.createElement('div'); host.id = 'course-runner-panel'; document.body.append(host);
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${STYLE}</style><div class="drag-shield" hidden></div>
      <div class="box" role="region" aria-label="课程流程助手"><header><b>课程流程助手</b><span class="chip"></span><button class="icon-btn" data-act="min" aria-label="收起悬浮窗" title="收起">−</button></header>
      <div class="body"><p class="status" role="status"></p><div class="chapter"></div><div class="jobs"></div>
      <div class="actions"><button class="act primary" data-act="toggle">开始</button><button class="act" data-act="mute" aria-pressed="false">🔊 静音</button></div><div class="actions"><button class="act" data-act="ai" aria-pressed="false">AI：关闭</button><button class="act" data-act="settings">AI 设置</button></div><div class="ai-caption"></div></div>
      <button class="retry" data-act="retry" hidden>重新读取当前题目</button>
      <div class="tools"><button class="fold" data-act="todo">待你处理</button><button class="fold" data-act="log">记录</button></div>
      <div class="details-content" hidden><section class="todo" data-section="todo" hidden></section><section class="log" data-section="log" hidden></section></div></div>
      <button class="mini" aria-label="展开课程流程助手" hidden>课</button>`;
    root.querySelectorAll('[data-act]').forEach(button => button.addEventListener('click', () => act(button.dataset.act)));
    draggable(root.querySelector('header'), root.querySelector('.box'));
    draggable(root.querySelector('.mini'), root.querySelector('.mini'), () => { view.minimized = false; saveView(); render(); });
    host.addEventListener('pointerdown', () => { pointerHeld = true; });
    const release = () => {
      if (!pointerHeld) return; pointerHeld = false;
      if (renderDeferred) { renderDeferred = false; setTimeout(render, 0); }
    };
    addEventListener('pointerup', release, true); addEventListener('pointercancel', release, true); addEventListener('blur', release);
    let pending;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || ![`task:${tabId}`, 'todos', 'muted', 'aiEnabled', 'aiVideoEnabled', 'aiQuizEnabled', 'videoAnswerMode'].some(k => changes[k])) return;
      clearTimeout(pending); pending = setTimeout(render, 100);
    });
    addEventListener('resize', () => { if (!dragging) place(view.minimized ? root.querySelector('.mini') : root.querySelector('.box')); });
    render();
  }
  function captureHidden(hidden) {
    if (!host) return; clearTimeout(captureTimer);
    if (hidden) { host.style.setProperty('visibility', 'hidden', 'important'); captureTimer = setTimeout(() => captureHidden(false), 5000); }
    else host.style.removeProperty('visibility');
  }
  return { init, captureHidden };
})();
