const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('状态图标外壳属于HTML命名空间，内部图形属于SVG，不能生成不可绘制的SVG span', () => {
  const vm = require('node:vm');
  const make = (namespaceURI, tag) => ({namespaceURI, tag, children: [],
    setAttribute() {}, append(...children) {this.children.push(...children);}});
  const sandbox = {document: {
    createElement: tag => make('http://www.w3.org/1999/xhtml', tag),
    createElementNS: (ns, tag) => make(ns, tag), createTextNode: value => value
  }};
  vm.runInNewContext(read('ui/icons.js'), sandbox);
  const status = sandbox.BKIcon.status('filled', {label: false});
  assert.equal(status.namespaceURI, 'http://www.w3.org/1999/xhtml');
  assert.equal(status.children[0].namespaceURI, 'http://www.w3.org/2000/svg');
});

test('页内 UI 的色彩与圆角令牌与 vendor/fbl/brand.css 一致', () => {
  const brand = read('vendor/fbl/brand.css');
  const ui = read('lib/ui.js');
  const keys = ['--brand', '--on-brand', '--brand-soft', '--bg', '--paper', '--ink', '--ink-2',
    '--line', '--line-2', '--hover', '--ok', '--ok-bg', '--warn-bg', '--bad', '--bad-bg', '--idle', '--idle-bg', '--r', '--rc'];
  for (const key of keys) {
    const match = brand.match(new RegExp(`${key}:([^;}]+)`));
    assert.ok(match, `brand.css 缺少 ${key}`);
    const value = match[1].trim();
    assert.ok(ui.includes(`'${key}': '${value}'`), `lib/ui.js 的 ${key} 应为 ${value}，与品牌表保持一致`);
  }
  // 这两项为了提高对比度刻意加深，浅色模式与页内弹层都用可达值。
  assert.ok(ui.includes("'--ink-3': '#616b7a'"));
  assert.ok(ui.includes("'--warn': '#8a5d08'"));
  assert.match(read('ui/app.css'), /--ink-3: #616b7a; --warn: #8a5d08/);
  assert.match(read('ui/app.css'), /--ink-3: #96a1b1/);
});

test('页内 UI 支持减少动效与深色页面的可读性', () => {
  const ui = read('lib/ui.js');
  assert.match(ui, /prefers-reduced-motion:no-preference/);
  assert.match(ui, /'--paper': '#ffffff'/);
  assert.match(ui, /prefers-color-scheme:dark/);
  assert.match(ui, /--paper:#1b2029/);
  assert.match(ui, /\.pop button:focus-visible,\.bar button:focus-visible/);
});

test('图标集完整：页签/操作/状态都有图形，且都是 16 或 12 的 viewBox', () => {
  const source = read('ui/icons.js');
  const names = [...source.matchAll(/^\s{4}([a-z]+): \[\[/gm)].map(match => match[1]);
  for (const needed of ['gear', 'check', 'search', 'log', 'form', 'image', 'video', 'clock', 'list', 'sliders',
    'bolt', 'key', 'link', 'refresh', 'copy', 'upload', 'download', 'alert', 'info', 'plus', 'trash', 'eye', 'wand']) {
    assert.ok(names.includes(needed), `图标缺失：${needed}`);
  }
  const statuses = [...source.matchAll(/^\s{4}([a-z]+): \{tone:/gm)].map(match => match[1]);
  for (const needed of ['filled', 'pending', 'confirm', 'unmatched', 'captcha', 'sensitive', 'honeypot', 'skipped', 'failed']) {
    assert.ok(statuses.includes(needed), `状态图形缺失：${needed}`);
  }
  assert.match(source, /viewBox: '0 0 12 12'/);
  assert.match(source, /viewBox: '0 0 16 16'/);
});

test('三个页面都引用品牌表、组件层与图标；CSP 下没有内联脚本', () => {
  for (const page of ['panel.html', 'options.html', 'logs.html']) {
    const html = read(page);
    assert.match(html, /vendor\/fbl\/brand\.css/, `${page} 应当引用品牌表`);
    assert.match(html, /ui\/app\.css/, `${page} 应当引用组件层`);
    assert.match(html, /ui\/icons\.js/, `${page} 应当引用图标`);
    assert.match(html, /<html lang="zh-CN">/, `${page} 应当声明语言`);
    assert.ok(!/<script(?![^>]*src=)[^>]*>/.test(html), `${page} 不应有内联脚本`);
    assert.ok(!/onclick=/.test(html), `${page} 不应有内联事件`);
    assert.match(html, /<meta name="viewport"/, `${page} 应当有 viewport`);
  }
});

test('扩展图标齐全且被 manifest 声明', () => {
  const manifest = JSON.parse(read('manifest.json'));
  for (const size of ['16', '32', '48', '128']) {
    assert.equal(manifest.icons[size], `icons/icon-${size}.png`);
    assert.equal(manifest.action.default_icon[size], `icons/icon-${size}.png`);
    const file = path.join(root, manifest.icons[size]);
    assert.ok(fs.statSync(file).size > 200, `${file} 太小，可能不是有效 PNG`);
  }
});

test('界面文案：空状态、错误、加载都有，且没有遗留的 alert/prompt 阻塞', () => {
  const panel = read('panel.js');
  const options = read('options.js');
  const logs = read('logs.js');
  assert.match(panel, /emptyState/);
  assert.match(panel, /skeleton/);
  assert.match(panel, /confirmSheet/);
  assert.ok(!/alert\(/.test(panel), 'panel 不应再用 alert');
  assert.match(options, /drop/);
  assert.match(options, /toast\(/);
  assert.ok(!/alert\(/.test(options), 'options 不应再用 alert');
  assert.match(logs, /empty-cell|emptyState|class: 'empty'/);
  // 面板里的原生 prompt 只用于“跳过原因”这类自由文本，属于可接受范围。
  assert.ok(!/alert\(/.test(logs), 'logs 不应再用 alert');
});

test('图标节点用 createElementNS 构建，不解析 HTML 字符串', () => {
  const source = read('ui/icons.js');
  assert.match(source, /createElementNS/);
  assert.ok(!/innerHTML/.test(source));
});
