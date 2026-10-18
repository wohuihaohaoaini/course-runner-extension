// 学习页的标签与入口（介绍页 / 视频 / 章节测验 / 下一节）。
// 0.2.0 起每张标签都会进去看一遍任务点清单，没有任务点的标签（介绍页等）直接跳过。
//
// 学习页顶部的 #dct1、#dct2……每个标签对应一张 knowledge/cards 卡片。很多课程的第一张卡片
// 是“介绍 / 学习目标 / 主要内容”之类的纯文字页，视频在第二张或之后。旧版只认 #dct1，
// 而且第一张是“主要内容”时直接当作文档处理、并认为“没有视频标签”，于是停在介绍页不动。
// 这里把所有标签读出来，按标题分类，供运行器在介绍页上自动切到视频。

function tabName(element) {
  const title = clean(element.getAttribute?.("title"));
  const label = clean(textOf(element) || element.value || "").replace(/^\d+\s*/, "");
  return title || label;
}

function tabKind(name) {
  if (/章节测验|章节测试|课后练习|测验|作业|考试/.test(name)) return "quiz";
  if (/视频|微课|录像/.test(name)) return "video";
  if (/^主要内容$/.test(name)) return "document";
  return "other";
}

function chapterTabs() {
  if (!isRunnerPage()) return [];
  let elements = [...document.querySelectorAll("[id^='dct']")];
  if (!elements.length) elements = [...document.querySelectorAll(".prev_ul li, .prev_tab li")];
  return elements.filter(visible).map((element, index) => {
    const name = tabName(element);
    return {
      element,
      index,
      kind: tabKind(name),
      active: element.classList.contains("currents") || element.classList.contains("active") ||
        Boolean(element.querySelector?.(".currents, .active"))
    };
  });
}

function findNextButton() {
  const completedButton = [...document.querySelectorAll("a.nextChapter")].find(visible);
  if (completedButton) return completedButton;
  const sideButton = document.querySelector("#right2");
  return visible(sideButton) && textOf(sideButton).includes("下一节") ? sideButton : null;
}

// 进入学习页时偶尔出现的“学习须知 / 课程介绍”提示层。只认这几种明确的关闭文字，
// 不点“确定 / 提交”这类可能触发提交的按钮。
function introDismissButton() {
  if (!isRunnerPage() && !CARDS_URL.test(location.pathname)) return null;
  return findButton(/^(我知道了|知道了|开始学习|进入学习)$/);
}
