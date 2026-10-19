#!/usr/bin/env node
// 生成发布用安装包：dist/course-runner-extension-<版本>.zip。
// 只收插件运行需要的文件和用户说明，不含 node_modules、测试、图标源文件等开发文件。
// 文件名按 UTF-8 写入并设置 ZIP 的 UTF-8 标记，Windows 解压中文文件名不会乱码。
// 不依赖 npm 包，Node.js 22 及以上直接运行：npm run package
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');

// 发布包的文件清单。新增运行文件或说明文件时在这里补充。
const INCLUDE = [
  'manifest.json',
  /^background[\w-]*\.js$/,
  'popup.html',
  'popup.css',
  'popup.js',
  /^content\/[\w-]+\.js$/,
  /^icons\/icon\d+\.png$/,
  /^docs\/images\/[\w-]+\.(png|svg)$/,
  'README.md',
  'CHANGELOG.md',
  '安装与使用说明.txt'
];

function listFiles(dir = ROOT, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'tests', 'scripts'].includes(entry.name)) continue;
    const rel = prefix + entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel + '/'));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function selectFiles(files) {
  return files.filter(file => INCLUDE.some(rule => typeof rule === 'string' ? rule === file : rule.test(file))).sort();
}

// manifest 引用的每个文件都必须进包，否则浏览器加载会失败。
function manifestReferences(manifest) {
  const refs = new Set(Object.values(manifest.icons || {}));
  if (manifest.background?.service_worker) refs.add(manifest.background.service_worker);
  if (manifest.action?.default_popup) refs.add(manifest.action.default_popup);
  for (const icon of Object.values(manifest.action?.default_icon || {})) refs.add(icon);
  for (const script of manifest.content_scripts || []) for (const file of [...(script.js || []), ...(script.css || [])]) refs.add(file);
  return [...refs];
}

// background.js 用 importScripts 加载的其他后台文件。
function importedScripts() {
  const source = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  return [...source.matchAll(/importScripts\(([^)]*)\)/g)]
    .flatMap(match => [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

const UTF8_FLAG = 0x0800;

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mtime } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const { time, date } = dosDateTime(mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // 由 Unix 生成，ZIP 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function packageExtension({ outDir = path.join(ROOT, 'dist') } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.version !== manifest.version) throw new Error(`版本号不一致：manifest.json ${manifest.version}，package.json ${pkg.version}`);

  const files = selectFiles(listFiles());
  const missing = [...manifestReferences(manifest), ...importedScripts()].filter(file => !files.includes(file));
  if (missing.length) throw new Error(`以下运行文件没有进入安装包：${missing.join('、')}`);

  const entries = files.map(name => {
    const full = path.join(ROOT, name);
    return { name, data: fs.readFileSync(full), mtime: fs.statSync(full).mtime };
  });
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `course-runner-extension-${manifest.version}.zip`);
  fs.writeFileSync(zipPath, buildZip(entries));
  return { zipPath, files };
}

module.exports = { packageExtension, selectFiles, listFiles };

if (require.main === module) {
  const { zipPath, files } = packageExtension();
  const size = fs.statSync(zipPath).size;
  console.log(`已生成 ${path.relative(ROOT, zipPath)}（${files.length} 个文件，${(size / 1024).toFixed(1)} KB）`);
}
