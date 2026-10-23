const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('主机权限只有本机 127.0.0.1，匹配范围只有 http/https', () => {
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:*/*']);
  assert.equal(manifest.manifest_version, 3);
  for (const script of manifest.content_scripts) {
    for (const match of script.matches) assert.match(match, /^https?:\/\/\*\/\*$/);
    assert.equal(script.all_frames, true);
    assert.equal(script.match_about_blank, true);
  }
});

test('权限清单与方案一致：debugger 只用于按需附着，没有 tabs 之外的越权项', () => {
  for (const permission of ['storage', 'activeTab', 'scripting', 'debugger', 'sidePanel', 'contextMenus', 'unlimitedStorage', 'tabs', 'alarms']) {
    assert.ok(manifest.permissions.includes(permission), permission);
  }
  const forbidden = ['webRequest', 'cookies', 'proxy', 'management', 'nativeMessaging', 'declarativeNetRequest', '<all_urls>'];
  for (const permission of forbidden) assert.ok(!manifest.permissions.includes(permission), permission);
  assert.equal(manifest.side_panel.default_path, 'panel.html');
  assert.equal(manifest.background.type, 'module');
});

test('内容脚本不发网络请求、不自动点最终提交、不读敏感值', () => {
  const source = read('content.js');
  assert.ok(!/\bfetch\s*\(/.test(source), '内容脚本不得自己发请求');
  assert.ok(!/XMLHttpRequest/.test(source));
  assert.ok(!/\.submit\s*\(/.test(source), '不得用 form.submit() 提交');
  assert.ok(!/click\(\).*submit|submit.*click\(\)/i.test(source));
  assert.match(source, /FINAL_WORDS = \/\(submit\|publish\|pay\|send\|post/);
  const fields = read('lib/fields.js');
  assert.match(fields, /if \(field\.sensitive\) return undefined;/);
  assert.match(fields, /HONEYPOT_NAMES/);
  assert.match(fields, /CAPTCHA_WORDS|CAPTCHA_HOSTS/);
});

test('后台只连本机服务，令牌不下发内容脚本', () => {
  const source = read('background.js');
  assert.match(source, /const API_HOST = '127\.0\.0\.1';/);
  assert.match(source, /url\.hostname !== API_HOST/);
  assert.ok(!/tabs\.executeScript\(\{[^}]*world/.test(source));
  // 只有 API 请求体里会带 base；返回给页面的对象不能含 base 之外的凭据
  assert.match(source, /redirect: 'error'/);
  assert.match(source, /credentials: 'omit'/);
  const cdp = read('lib/cdp.js');
  assert.match(cdp, /ARTIFACT_PATH_DENIED/);
  assert.match(cdp, /DOM\.setFileInputFiles/);
  assert.match(cdp, /Input\.insertText/);
  assert.match(cdp, /Input\.dispatchKeyEvent/);
  assert.match(cdp, /Input\.dispatchMouseEvent/);
});

test('vendor/fbl 的哈希与 VERSION.json 一致；沉余实现只在 lib/vendor-fbl.js', () => {
  const version = JSON.parse(read('vendor/fbl/VERSION.json'));
  const crypto = require('node:crypto');
  for (const [name, record] of Object.entries(version.files)) {
    const data = fs.readFileSync(path.join(root, 'vendor/fbl', name));
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), record.sha256, name);
    assert.equal(data.toString().split('\n').length, record.lines);
  }
  assert.ok(!fs.readFileSync(path.join(root, 'lib/vendor-fbl.js'), 'utf8').includes('export '), '内容脚本侧是经典脚本');
});

test('夹具页齐全：覆盖普通表单、受控组件、自定义控件、iframe、蜜罐、验证码、多步', () => {
  const dir = path.join(root, 'test-pages');
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.html'));
  assert.ok(files.length >= 20, `夹具页数量 ${files.length}`);
  for (const need of ['plain', 'react-controlled', 'vue-like', 'react-select', 'select2', 'tags', 'rich-text', 'wizard', 'wizard-danger',
    'linked-selects', 'file-upload', 'honeypot', 'captcha', 'maxlength', 'reset-on-reload', 'submit-error', 'google-forms-like',
    'tally-like', 'shadow-open', 'shadow-closed', 'iframe-parent', 'iframe-child', 'date-and-number', 'qa-questions', 'sensitive', 'handoff']) {
    assert.ok(files.some(name => name.startsWith(need)), need);
  }
});

test('规则文件含加权同义词、排他词与 autocomplete 映射', () => {
  const rules = JSON.parse(read('../rules/field-rules.json'));
  assert.ok(Object.keys(rules.keys).length >= 50);
  for (const key of ['name', 'url', 'description', 'category', 'tags', 'pricing_model', 'email', 'twitter', 'logo', 'demo_video', 'message']) {
    assert.ok(rules.keys[key], key);
  }
  assert.ok(rules.keys.url.exclude.includes('twitter'));
  assert.ok(rules.keys.url.exclude.includes('logo'));
  assert.equal(rules.autocomplete.email, 'email');
  assert.equal(rules.autocomplete['given-name'], 'first_name');
});
