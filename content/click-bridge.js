// 点击桥（页面主环境）：内容脚本在隔离环境里点击 href="javascript:..." 的链接时，
// Chrome 按扩展自己的 CSP 执行这段网址并拦截（“Running the JavaScript URL violates ...”），
// 写在网址里的页面操作就不会发生。内容脚本改为在元素上派发 course-runner-click，
// 由这里以页面身份完成同一次点击，网址按课程页自己的规则执行。
(() => {
  if (window.__courseRunnerClickBridge) return;
  Object.defineProperty(window, '__courseRunnerClickBridge', { value: true });
  // 在页面脚本运行前保存原生 click，页面改写原型也不影响这里。
  const click = HTMLElement.prototype.click;
  window.addEventListener('course-runner-click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    event.stopImmediatePropagation();
    // 取消事件即回执：内容脚本据此知道点击已由页面完成，不再自己点一次。
    event.preventDefault();
    click.call(target);
  }, true);
})();
