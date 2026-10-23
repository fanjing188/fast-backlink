const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};

// DOM 替身只覆盖浏览器边界；表单、轮询与项目选择运行真实 panel.js。
class Node {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.document = document; this.children = [];
    this.listeners = {}; this.dataset = {}; this.style = {}; this.value = ''; this.disabled = false;
    this.checked = false; this.classList = {toggle() {}};
  }
  setAttribute(key, value) {
    if (key === 'value') this.valueWrites = (this.valueWrites || 0) + 1;
    this[key] = String(value);
  }
  removeAttribute(key) {delete this[key];}
  append(...items) {
    for (const node of items) {
      if (node instanceof Node) {node.remove(); node.parent = this;}
      this.children.push(node);
    }
  }
  prepend(node) {node.remove(); node.parent = this; this.children.unshift(node);}
  remove() {if (this.parent) {this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null;}}
  replaceChildren(...items) {this.replacements = (this.replacements || 0) + 1; for (const node of [...this.children]) node.remove?.(); this.children = []; this.append(...items);}
  addEventListener(name, fn) {(this.listeners[name] ||= []).push(fn);}
  async fire(name) {for (const fn of this.listeners[name] || []) await fn({target: this, preventDefault() {}}); await tick();}
  contains(node) {return this === node || this.children.some(child => child instanceof Node && child.contains(node));}
  focus() {this.document.activeElement = this;}
  reportValidity() {return this.valid !== false;}
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return (this.className || '').split(' ').includes(selector.slice(1));
    if (selector.startsWith('[')) {const [, key, value] = selector.match(/^\[([^=]+)=([^\]]+)\]$/) || []; return this[key] === value?.replaceAll('"', '');}
    return this.tagName.toLowerCase() === selector;
  }
  querySelectorAll(selector) {return this.children.flatMap(child => child instanceof Node ? [child, ...child.querySelectorAll('*')] : [])
    .filter(node => selector === '*' || selector.split(/,\s*/).some(item => node.matches(item)));}
  querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
  get options() {return this.children;}
  get textContent() {return this.content ?? this.children.map(child => child.textContent ?? child).join('');}
  set textContent(value) {this.content = String(value); this.children = [];}
}
function panelHarness(handler = async () => ({})) {
  const nodes = new Map();
  const document = {activeElement: null, hasFocus: () => true, querySelectorAll: () => [],
    createElement: tag => new Node(tag, document), createTextNode: value => String(value),
    querySelector: selector => {if (!nodes.has(selector)) nodes.set(selector, new Node(selector === '#site' ? 'select' : 'div', document)); return nodes.get(selector);}};
  const calls = [], storage = [];
  const context = vm.createContext({document, chrome: {
    runtime: {sendMessage: async message => {calls.push(structuredClone(message)); return {value: await handler(message)};}, openOptionsPage() {}},
    storage: {local: {set: async value => storage.push(value)}},
    tabs: {query: async () => [{id: 1, url: 'https://a.example/form'}], onActivated: {addListener() {}}, onUpdated: {addListener() {}}}},
    BKIcon: {hydrate() {}, svg: () => document.createElement('svg')},
    setTimeout: fn => {fn(); return 0;}, setInterval: () => 0});
  const file = path.join(__dirname, '../lib/ai-settings.js');
  if (fs.existsSync(file)) vm.runInContext(read('lib/ai-settings.js'), context);
  vm.runInContext(read('lib/auth-panel.js'), context);
  const source = read('panel.js').replace('renderView();\nrefresh().finally(() => {state.loading = false; renderView();});', '');
  vm.runInContext(source + '\nglobalThis.api = {state, renderForm, renderSettings, refresh, requestAi};', context);
  context.api.state.info = {base: 'http://127.0.0.1/', site: 'a', source: 'a.example', aiStatus: {
    enabled: true, configured: true, base_url: 'https://api.example/v1', model: 'saved-model', timeout_ms: 15000, json_mode: true, has_key: true}};
  context.api.state.sites = ['a', 'b'];
  context.api.state.settings = {auto_next: true, auto_next_sites: {}};
  context.api.state.tab = {id: 1};
  return {...context.api, nodes, document, calls, storage, context,
    form: () => nodes.get('[data-panel=settings]').querySelector('#ai-config')};
}
const control = (form, name) => form.querySelectorAll('input').find(node => node.name === name);
const button = (form, label) => form.querySelectorAll('button').find(node => node.textContent === label);

test('Google 弹窗状态映射回原任务标签，局部读回完成后才提交状态', async () => {
  const h = panelHarness(async message => message.type === 'auth:status'
    ? {kind: 'google', task: {rootId: 7}} : {base: 'http://127.0.0.1/', site: 'a'});
  h.context.chrome.tabs.get = async id => ({id, url: 'https://a.example/submit'});
  vm.runInContext('renderStatus = () => {};', h.context);
  await h.refresh({render: false});
  assert.equal(h.state.tab.id, 7);
  assert.equal(h.state.auth.kind, 'google');
  assert.equal(h.calls.find(message => message.type === 'panel:state').tabId, 7);
});

test('登录卡草稿只在原页面与项目保留，切换绑定后重建且完成后恢复操作按钮', () => {
  const h = panelHarness();
  const footer = [h.document.createElement('button'), h.document.createElement('button')];
  h.document.querySelectorAll = selector => selector === 'footer [data-command]' ? footer : [];
  h.state.tab = {id: 1, url: 'https://a.example/submit'};
  h.state.auth = {kind: 'login', authorized: false};
  h.renderForm();
  const panel = h.nodes.get('[data-panel=form]'), card = panel.querySelector('#auth-card');
  assert.ok(card, '登录页必须提供本站授权入口');
  const email = card.querySelector('#auth-email');
  email.value = 'draft@example.test'; email.focus();
  h.renderForm();
  assert.equal(panel.querySelector('#auth-card'), card);
  assert.equal(email.value, 'draft@example.test');
  assert.ok(footer.every(node => node.disabled));
  h.state.tab = {id: 2, url: 'https://b.example/submit'};
  h.state.info.site = 'b'; h.state.info.source = 'b.example';
  h.renderForm();
  assert.notEqual(panel.querySelector('#auth-card'), card);
  assert.equal(panel.querySelector('#auth-target').value, h.state.tab.url);
  assert.equal(panel.querySelector('#auth-email').value, '');
  h.state.auth = {kind: 'form', authorized: true, task: {state: 'complete'}};
  h.renderForm();
  assert.ok(footer.every(node => !node.disabled));
});

test('AI 草稿节点和焦点保留，来源 A→B 的覆盖设置与写入目标刷新', async () => {
  const h = panelHarness(async message => message.patch || {});
  h.renderSettings();
  const form = h.form();
  assert.ok(form, '设置页应提供 AI 可视配置表单');
  const model = control(form, 'model');
  model.value = 'draft-model';
  control(form, 'api_key').value = 'synthetic-secret';
  await form.fire('input'); model.focus();
  h.state.info.source = 'b.example';
  h.renderSettings();
  assert.equal(h.form(), form);
  assert.equal(h.document.activeElement, model);
  assert.equal(model.value, 'draft-model');
  assert.equal(control(form, 'api_key').value, 'synthetic-secret');
  const groups = h.nodes.get('[data-panel=settings]').querySelectorAll('.settings-group');
  const override = groups.find(node => node.textContent.includes('本站覆盖'));
  assert.match(override.textContent, /b\.example/);
  assert.doesNotMatch(override.textContent, /a\.example/);
  const toggle = override.querySelector('input'); toggle.checked = false; await toggle.fire('change');
  const write = h.calls.find(message => message.type === 'panel:settings');
  assert.deepEqual(write.patch, {auto_next_sites: {'b.example': false}});
  assert.deepEqual(h.storage, []);
});

test('更换 API 地址时，保存和草稿测试都必须重新提供或明确移除旧密钥', async () => {
  const h = panelHarness(async () => ({ok: true, model: 'synthetic', ms: 1}));
  h.renderSettings();
  const form = h.form();
  control(form, 'base_url').value = 'https://other.example/v1';
  await form.fire('input');
  await button(form, '测试连通').fire('click');
  await form.fire('submit');
  assert.equal(h.calls.length, 0, '旧密钥不能通过草稿流向新地址');
  assert.match(form.querySelector('#ai-feedback').textContent, /重新填写密钥.*移除/);
  control(form, 'api_key').value = 'synthetic-replacement';
  await button(form, '测试连通').fire('click');
  assert.equal(h.calls.at(-1).type, 'ai:test');
  assert.equal(h.calls.at(-1).patch.api_key, 'synthetic-replacement');
  control(form, 'api_key').value = '';
  control(form, 'clear_api_key').checked = true;
  await button(form, '测试连通').fire('click');
  assert.equal(h.calls.at(-1).patch.clear_api_key, true);
  assert.deepEqual(h.storage, []);
});

test('侧栏加载 AI 配置模块并复用品牌控件，页内入口使用统一名称', () => {
  const html = read('panel.html');
  assert.match(html, /<script src="lib\/ai-settings\.js"><\/script>\s*<script src="lib\/auth-panel\.js"><\/script>\s*<script src="panel\.js">/);
  assert.match(html, /#ai-config \.ai-actions/);
  assert.match(read('ui/app.css'), /input\[type=password\]/);
  assert.match(read('ui/app.css'), /input\[type=email\]/);
  assert.match(read('lib/ui.js'), /AI 智能填充（Alt\+A）/);
});

test('测试只发送草稿配置，不保存、不请求项目资料，保留草稿密钥', async () => {
  const h = panelHarness(async () => ({ok: true, model: 'draft-model', ms: 7}));
  h.renderSettings();
  const form = h.form();
  control(form, 'model').value = 'draft-model';
  control(form, 'api_key').value = 'synthetic-secret';
  await form.fire('input');
  await button(form, '测试连通').fire('click');
  assert.deepEqual(h.calls, [{type: 'ai:test', patch: {enabled: true, base_url: 'https://api.example/v1',
    model: 'draft-model', api_key: 'synthetic-secret', timeout_ms: 15000, json_mode: true, clear_api_key: false}}]);
  assert.match(form.querySelector('#ai-feedback').textContent, /连接成功.*草稿尚未保存/);
  assert.equal(h.state.info.aiStatus.model, 'saved-model');
  assert.equal(control(form, 'api_key').value, 'synthetic-secret');
  assert.equal(control(form, 'api_key').type, 'password');
  assert.doesNotMatch(form.textContent, /synthetic-secret/);
  assert.deepEqual(h.storage, []);
});

test('保存必须读回服务状态，清空密钥输入；同地址留空保留旧密钥', async () => {
  const saved = {enabled: true, configured: true, model: 'new-model', base_url: 'https://api.example/v1', has_key: true};
  const h = panelHarness(async message => message.type === 'panel:state' ? {aiStatus: saved} : {});
  h.renderSettings();
  const form = h.form();
  assert.equal(control(form, 'api_key').value, '', '状态中的 has_key 不得回填密钥');
  control(form, 'model').value = 'new-model';
  await form.fire('input'); await form.fire('submit');
  assert.deepEqual(h.calls.map(message => message.type), ['ai:configure', 'panel:state']);
  assert.equal(h.calls[0].patch.api_key, '');
  assert.equal(h.calls[0].patch.clear_api_key, false);
  assert.match(form.querySelector('#ai-feedback').textContent, /已保存/);
  assert.equal(h.state.info.aiStatus.model, 'new-model');
  assert.equal(control(form, 'api_key').value, '');
  assert.match(control(form, 'api_key').placeholder, /已保存/);
  control(form, 'api_key').value = 'synthetic-new-secret';
  await form.fire('input'); await form.fire('submit');
  assert.equal(h.calls.at(-2).patch.api_key, 'synthetic-new-secret');
  assert.equal(control(form, 'api_key').value, '', '新输入的密钥保存读回后必须清空');
  assert.doesNotMatch(form.textContent, /synthetic-new-secret/);
  assert.deepEqual(h.storage, []);
});

test('保存回执未知或读回失败不自动重发、不宣称保存成功', async () => {
  for (const readbackFailure of [false, true]) {
    const h = panelHarness(async message => {
      if (!readbackFailure || message.type === 'panel:state') throw Error('synthetic unavailable');
      return {};
    });
    h.renderSettings();
    const form = h.form();
    control(form, 'api_key').value = 'synthetic-secret';
    await form.fire('input'); await form.fire('submit'); await tick();
    assert.equal(h.calls.filter(message => message.type === 'ai:configure').length, 1);
    assert.match(form.querySelector('#ai-feedback').textContent, /unavailable/);
    assert.doesNotMatch(form.querySelector('#ai-feedback').textContent, /已保存/);
    assert.equal(control(form, 'api_key').value, 'synthetic-secret');
    assert.ok(form.querySelectorAll('input, button').every(node => !node.disabled));
    h.renderSettings();
    assert.equal(control(form, 'api_key').value, 'synthetic-secret');
  }
});

test('在途连通测试禁止重复派发和保存，失败后恢复控件且不丢草稿', async () => {
  const pending = deferred();
  const h = panelHarness(() => pending.promise);
  h.renderSettings();
  const form = h.form();
  control(form, 'model').value = 'pending-model'; await form.fire('input');
  const testing = button(form, '测试连通').fire('click'); await tick();
  assert.ok(form.querySelectorAll('input, button').every(node => node.disabled));
  await button(form, '测试连通').fire('click'); await form.fire('submit');
  h.renderSettings();
  assert.equal(h.calls.length, 1);
  assert.equal(control(form, 'model').value, 'pending-model');
  pending.resolve({ok: false, error: 'AI 接口返回 HTTP 401'}); await testing;
  assert.match(form.querySelector('#ai-feedback').textContent, /401/);
  assert.ok(form.querySelectorAll('input, button').every(node => !node.disabled));
  form.valid = false; await button(form, '测试连通').fire('click');
  assert.equal(h.calls.length, 1, '原生表单校验失败不得派发');
});

test('显式 AI 请求沿用 public 的 fill 合同，不退回建议后二次确认', async () => {
  const h = panelHarness(async message => message.type === 'panel:state' ? {base: 'local', site: 'a', ai: {suggestions: []}} : {});
  vm.runInContext('renderStatus = () => {}; renderView = () => {};', h.context);
  h.state.view = 'settings'; h.state.info.frames = [{top: true, frameId: 0}, {top: false, frameId: 7}];
  await h.requestAi();
  const requests = h.calls.filter(message => message.type === 'panel:command');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(message => message.frameId), [0, 7]);
  assert.ok(requests.every(message => message.command === 'page:ai' && message.data.action === 'fill'));
});

test('刷新拒绝迟到响应并保留原生项目选择器的焦点、options 和 value', async () => {
  const pending = deferred(); let reads = 0;
  const h = panelHarness(async message => message.type !== 'panel:state' ? null
    : ++reads === 1 ? pending.promise : {base: 'local', site: 'b'});
  vm.runInContext('renderStatus = () => {};', h.context);
  const select = h.nodes.get('#site');
  select.append(h.document.createElement('option')); select.value = 'user-choosing'; select.focus();
  let writes = 0, value = select.value;
  Object.defineProperty(select, 'value', {get: () => value, set: next => {++writes; value = next;}});
  const old = h.refresh({render: false}); await tick();
  await h.refresh({render: false});
  pending.resolve({base: 'local', site: 'a'}); await old;
  assert.equal(h.state.info.site, 'b');
  assert.equal(select.value, 'user-choosing');
  assert.equal(writes, 0); assert.equal(select.replacements || 0, 0);
});

test('项目切换期间拒绝旧刷新，完成或失败后恢复控件和真实项目', async () => {
  for (const fail of [false, true]) {
    const stale = deferred(), activation = deferred(); let reads = 0;
    const h = panelHarness(async message => {
      if (message.type === 'panel:activate') return activation.promise;
      if (message.type !== 'panel:state') return null;
      if (++reads === 1) return stale.promise;
      return {base: 'local', site: fail ? 'a' : 'b'};
    });
    vm.runInContext('renderStatus = () => {}; renderView = () => {};', h.context);
    const select = h.nodes.get('#site'); select.value = 'b';
    const old = h.refresh({render: false}); await tick();
    const changing = select.fire('change'); await tick();
    assert.equal(h.state.projectChanging, true); assert.equal(select.disabled, true);
    stale.resolve({base: 'local', site: 'stale'}); await old;
    assert.equal(h.state.info.site, 'a');
    if (fail) activation.reject(Error('synthetic activation failure')); else activation.resolve({site: 'b'});
    await changing;
    assert.equal(h.state.projectChanging, false); assert.equal(select.disabled, false);
    assert.equal(h.state.info.site, fail ? 'a' : 'b');
    assert.equal(select.value, fail ? 'a' : 'b');
  }
});
