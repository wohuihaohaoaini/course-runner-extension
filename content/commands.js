// 运行器通过后台页把命令发给具体框架执行（视频、文档等都在各自的内嵌页里）。
// AI 命令每次执行前检查开关、运行身份、页面文档和题目指纹。

const clickOrThrow = (element, message) => {
  if (!element) throw new Error(message);
  pageClick(element);
  return { clicked: true };
};

const FRAME_COMMANDS = {
  async PLAY() {
    if (videoQuestionSurfaceVisible()) throw new Error('视频弹题尚未关闭，请先完成当前题目');
    const video = currentVideo();
    if (!video) throw new Error("找不到可播放的视频");
    if (video.ended) return videoInfo();
    let playTimer;
    try {
      // 没有可用 src 的 HTMLVideoElement.play() 可能永久 pending，不能堵住上层轮询。
      await Promise.race([video.play(), new Promise((_, reject) => {
        playTimer = setTimeout(() => reject(new Error('播放器未响应播放请求，等待已超时')), 2500);
      })]);
    } catch (error) {
      const button = document.querySelector(".vjs-big-play-button");
      if (!visible(button)) throw error;
      pageClick(button);
      await wait(500);
      if (video.paused) throw new Error("浏览器未允许自动播放，请手动点击视频中央播放按钮后继续（开启静音可减少这种情况）");
    } finally { clearTimeout(playTimer); }
    return videoInfo();
  },
  PAUSE_MEDIA(data) {
    if (data.frameToken && data.frameToken !== AI_DOCUMENT) throw new Error('播放器已刷新');
    if (!isMediaPage()) throw new Error('当前框架不是播放器');
    currentVideo()?.pause();
    return { paused: true };
  },
  INITIAL_PLAY: () => clickOrThrow(initialPlayButton(), "首次播放按钮不可见"),
  // 播放器报“网络错误 / 文件损坏”时重新加载一次播放器内嵌页。
  RELOAD_MEDIA() {
    if (!isMediaPage()) throw new Error("当前框架不是播放器");
    location.reload();
    return { reloaded: true };
  },
  CONTINUE_VIDEO_QUESTION(data) {
    if (data.frameToken && data.frameToken !== AI_DOCUMENT) throw new Error('播放器已刷新，停止点击旧题目的继续按钮');
    if (data.fingerprint && videoAIEnvelope().fingerprint !== data.fingerprint) throw new Error('视频题目已变化，停止点击旧题目的继续按钮');
    return clickOrThrow(videoQuestionContinueButton(), '视频弹题继续按钮已变化');
  },
  OPEN_TAB({ index }) {
    const tab = chapterTabs().find((item) => item.index === index);
    return clickOrThrow(tab?.element, "要切换的标签已不存在");
  },
  DISMISS_INTRO: () => clickOrThrow(introDismissButton(), "提示层已关闭"),
  // 任务点 iframe 在介绍文字下方、还没滚动到时，部分课程不会加载播放器。
  REVEAL_JOB({ id }) {
    const frame = jobFrame(id);
    if (!frame) return { revealed: false };
    frame.scrollIntoView({ block: "center", behavior: "auto" });
    return { revealed: true };
  },
  SCROLL_DOCUMENT() {
    const reader = documentReader();
    if (!reader) throw new Error("未定位到文档正文滚动区");
    const { element } = reader;
    const before = element.scrollTop;
    element.scrollTop = Math.min(element.scrollHeight - element.clientHeight,
      before + Math.max(160, Math.floor(element.clientHeight * 0.7)));
    return { moved: element.scrollTop > before,
      atBottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 4 };
  },
  // 点左侧目录里的小节，由页面自己的 getTeacherAjax 换节。
  OPEN_CHAPTER({ id }) {
    const chapter = catalogChapters().find((item) => item.id === id);
    return clickOrThrow(chapter?.element, "目录里找不到要进入的小节");
  },
  NEXT: () => clickOrThrow(findNextButton(), "未找到下一节按钮"),
  READ_QUIZ: () => quizEnvelope(),
  CAPTURE_QUESTION: (data) => captureQuestion(data.id, data.guard),
  VERIFY_QUIZ(data) {
    ensureQuizVisible();
    return verifyAnswers(data.answers, data.guard);
  },
  async FILL_QUIZ(data) {
    ensureQuizVisible();
    const roots = getQuestionElements();
    if (!roots.length || roots.length !== data.answers.length) throw new Error("测验题数已变化，停止填写");
    const byId = new Map(data.answers.map((answer) => [String(answer.id), answer]));
    const tabId = await chrome.runtime.sendMessage({ type: "TAB_ID" });
    for (let index = 0; index < roots.length; index++) {
      await assertAICommand(data.guard);
      const root = roots[index];
      const id = questionId(root, index);
      if (!id) throw new Error("题目缺少稳定编号，停止填写");
      const answer = byId.get(id);
      if (!answer) throw new Error(`题目 ${id} 缺少答案`);
      if (questionType(root) === "fill") {
        const result = await chrome.runtime.sendMessage({ type: "FILL_BLANKS", questionId: id, blanks: answer.blanks, guard: data.guard, expected: blankEditorAction(id, [], "snapshot").snapshot });
        if (result?.error) throw new Error(result.error);
        if (result?.filled !== answer.blanks.length) throw new Error(`题目 ${id} 的填空内容未填完`);
        continue;
      }
      if (!root.isConnected) throw new Error('题目已重新加载，停止填写');
      const options = optionElements(root);
      if (options.some((option) => option.type === "radio")) {
        const choice = options.find((option) => answer.choices.includes(option.id));
        if (!choice || answer.choices.length !== 1) throw new Error(`题目 ${id} 的单选答案不合法`);
        if (!choice.selected) {
          pageClick(choice.target);
          await wait(1000);
        }
        continue;
      }
      for (const option of options) {
        await assertAICommand(data.guard);
        const desired = answer.choices.includes(option.id);
        if (desired !== option.selected) {
          pageClick(option.target);
          await wait(1000);
        }
      }
    }
    return { filled: roots.length };
  },
  SUBMIT_QUIZ() {
    ensureQuizVisible();
    const pattern = /^(提交|交卷|提交答案|提交作业)$/;
    const button = [...document.querySelectorAll('.btnSubmit')].find(element => visible(element) && pattern.test(textOf(element))) || findButton(pattern);
    return clickOrThrow(button, "未找到测验提交按钮");
  },
  CONFIRM_SUBMIT() {
    const confirm = quizSubmitConfirmation();
    if (!confirm) throw new Error("提交确认框不可见");
    return clickOrThrow(confirm);
  },
  CONFIRM_TOP_SUBMIT() {
    const confirm = topSubmitConfirmation();
    if (!confirm) throw new Error("顶层提交确认框不可见");
    return clickOrThrow(confirm);
  },

  READ_VIDEO_TRIAL: () => videoTrialEnvelope(),
  SUBMIT_VIDEO_TRIAL: data => submitVideoTrial(data),
  READ_VIDEO_QUESTION: () => videoAIEnvelope(),
  CAPTURE_VIDEO_QUESTION: data => captureVideoQuestion(data.guard),
  FILL_VIDEO_QUESTION: data => fillAIVideoQuestion(data.answers[0], data.guard),
  SUBMIT_VIDEO_QUESTION(data) {
    if (!data.answers?.[0]?.choices) throw new Error('缺少本次视频弹题的核对答案，停止提交');
    verifyAIVideoSelection(data.answers[0]);
    return clickOrThrow(aiVideoSubmitButton(), '视频弹题提交按钮已变化');
  }

};

async function ensureRunning(tabId) {
  const key = `task:${tabId}`;
  const task = (await chrome.storage.local.get(key))[key];
  if (task?.state !== "running") throw new Error("任务已暂停");
}

async function runFrameCommand(command, data) {
  const handler = FRAME_COMMANDS[command];
  if (!handler) throw new Error("未知页面命令");
  await ensureRunning(await chrome.runtime.sendMessage({ type: "TAB_ID" }));
  if (['READ_VIDEO_TRIAL', 'SUBMIT_VIDEO_TRIAL'].includes(command)) await assertVideoTrialCommand(data?.guard);
  if (AI_COMMANDS.has(command)) await assertAICommand(data?.guard);
  return handler(data || {});
}
