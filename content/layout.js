// 使用平台已有的折叠控件，保留目录 DOM 和卡片/播放器 iframe。
const CourseLayout = (() => {
  let applying = false;
  async function apply() {
    if (window !== window.top || !isRunnerPage() || applying) return;
    const { collapseCourseSidebar } = await chrome.storage.local.get('collapseCourseSidebar');
    if (typeof collapseCourseSidebar !== 'boolean') return;
    const button = document.querySelector('#selector.posChapter_right .switchbtn');
    if (!button || button.classList.contains('switchbtn_cur') === collapseCourseSidebar) return;
    applying = true;
    try { pageClick(button); } finally { applying = false; }
  }
  function init() {
    apply().catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.collapseCourseSidebar) apply().catch(() => {});
    });
    document.addEventListener('click', event => {
      if (!event.isTrusted || !event.target.closest?.('#selector.posChapter_right .switchbtn')) return;
      setTimeout(() => {
        const button = document.querySelector('#selector.posChapter_right .switchbtn');
        if (button) chrome.storage.local.set({ collapseCourseSidebar: button.classList.contains('switchbtn_cur') });
      }, 350);
    });
  }
  return { apply, init };
})();
