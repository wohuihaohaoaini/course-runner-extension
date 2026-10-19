const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const loadContent = require('./load-content.cjs');

test('mute switch mutes current videos and restores only the ones it muted', async () => {
  const listeners = [];
  const videos = [{ muted: false }, { muted: true }];
  let local = { muted: true };
  const w = {}; w.top = w;
  const context = vm.createContext({ window: w, top: w, URL, URLSearchParams, setTimeout, clearTimeout,
    HTMLMediaElement: function HTMLMediaElement() {},
    location: { pathname: '/ananas/modules/video/index.html', search: '' },
    document: { querySelector: () => null, querySelectorAll: (s) => s === 'video, audio' ? videos : [], addEventListener() {} },
    chrome: { storage: { local: { get: async () => local, set: async () => {} }, onChanged: { addListener: (fn) => listeners.push(fn) } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => undefined } } });
  loadContent(context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(videos.map((v) => v.muted), [true, true]);
  listeners.forEach((fn) => fn({ muted: { newValue: false } }, 'local'));
  // 原本就静音的视频保持静音，只恢复插件自己静音的那个。
  assert.deepEqual(videos.map((v) => v.muted), [false, true]);
});

test('with background playback on, the element is left audible so the tab mute can do the muting', async () => {
  const listeners = [];
  const videos = [{ muted: false }];
  const local = { muted: true, allowBackgroundPlayback: true };
  const w = {}; w.top = w;
  const context = vm.createContext({ window: w, top: w, URL, URLSearchParams, setTimeout, clearTimeout,
    HTMLMediaElement: function HTMLMediaElement() {},
    location: { pathname: '/ananas/modules/video/index.html', search: '' },
    document: { querySelector: () => null, querySelectorAll: (s) => s === 'video, audio' ? videos : [], addEventListener() {} },
    chrome: { storage: { local: { get: async () => local, set: async () => {} }, onChanged: { addListener: (fn) => listeners.push(fn) } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => undefined } } });
  loadContent(context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(videos[0].muted, false);
  assert.equal(vm.runInContext('Mute.isEnabled()', context), true);
  listeners.forEach((fn) => fn({ allowBackgroundPlayback: { newValue: false } }, 'local'));
  assert.equal(videos[0].muted, true);
  listeners.forEach((fn) => fn({ allowBackgroundPlayback: { newValue: true } }, 'local'));
  assert.equal(videos[0].muted, false);
});
