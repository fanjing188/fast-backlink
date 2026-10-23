const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

test('品牌素材包含可复用SVG与工具栏/商店各尺寸的真实PNG', () => {
  const svg = fs.readFileSync(path.join(root, 'extension/icons/mark.svg'), 'utf8');
  assert.match(svg, /viewBox="0 0 128 128"/);
  assert.doesNotMatch(svg, /<text|<image|https?:\/\/[^" ]+\.(?:png|jpg)|<script/);
  for (const size of [16, 32, 48, 128, 256, 512]) {
    const file = path.join(root, `extension/icons/icon-${size}.png`);
    assert.ok(fs.existsSync(file), `缺少 ${size}px 品牌图标`);
    const data = fs.readFileSync(file);
    assert.equal(data.subarray(1,4).toString(), 'PNG');
    assert.equal(data.readUInt32BE(16), size);
    assert.equal(data.readUInt32BE(20), size);
  }
});
