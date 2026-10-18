// 按 manifest.json 中 content_scripts 的顺序把各个内容脚本加载进同一个 vm 上下文，
// 与浏览器把它们注入同一个隔离环境的行为一致。
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const files = manifest.content_scripts[0].js;
module.exports = function loadContent(context) {
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return context;
};
module.exports.files = files;
