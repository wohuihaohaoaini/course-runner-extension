const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { packageExtension } = require('../scripts/package.cjs');

function readZip(file) {
  const buffer = fs.readFileSync(file);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const flags = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = zlib.inflateRawSync(buffer.subarray(start, start + size));
    entries.push({ name, flags, localFlags: buffer.readUInt16LE(localOffset + 6), data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('安装包只含运行文件和说明，中文文件名带 UTF-8 标记', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-package-'));
  try {
    const { zipPath } = packageExtension({ outDir });
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
    assert.equal(path.basename(zipPath), `course-runner-extension-${manifest.version}.zip`);

    const entries = readZip(zipPath);
    const names = entries.map(entry => entry.name);
    for (const required of ['manifest.json', 'background.js', 'background-ai.js', 'background-playback.js', 'popup.html',
      ...manifest.content_scripts[0].js, ...Object.values(manifest.icons), 'README.md', 'CHANGELOG.md', '安装与使用说明.txt']) {
      assert.ok(names.includes(required), `缺少 ${required}`);
    }
    for (const name of names) {
      assert.doesNotMatch(name, /node_modules|^tests\/|^scripts\/|package(-lock)?\.json|icon\.svg|osmanthus-source|\.DS_Store/);
    }
    for (const entry of entries) {
      assert.ok(entry.flags & 0x0800, `${entry.name} 缺少 UTF-8 标记`);
      assert.ok(entry.localFlags & 0x0800, `${entry.name} 本地头缺少 UTF-8 标记`);
      assert.deepEqual(entry.data, fs.readFileSync(path.join(__dirname, '..', entry.name)), `${entry.name} 内容与源码不一致`);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
