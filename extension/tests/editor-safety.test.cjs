const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 只替换浏览器边界；编辑、事件处理、保存与竞态逻辑都运行真实 options.js。
class Node {
  constructor(tag = 'div') {this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.style = {}; this.classList = {add() {}, remove() {}};}
  setAttribute(key, value) {if (key === 'value') this.value = value; if (key === 'data-site') this.dataset.site = value; this[key] = value;}
  append(...items) {this.children.push(...items);}
  replaceChildren(...items) {this.children = items;}
  addEventListener(name, fn) {(this.listeners[name] ||= []).push(fn);}
  async fire(name) {for (const fn of this.listeners[name] || []) await fn({target: this, preventDefault() {}});}
  click() {this.clicked = true;}
  remove() {}
  replaceWith(node) {this.replacement = node;}
  scrollIntoView() {}
  get textContent() {return this.content ?? this.children.map(item => typeof item === 'string' ? item : item.textContent).join('');}
  set textContent(value) {this.content = value;}
}
const all = node => [node, ...node.children.flatMap(child => child instanceof Node ? all(child) : [])];
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const kit = site => ({site, schema_version: 2, fields: {name: {value: site}, tagline: {value: 'old', i18n: {de: 'alt'}}}, assets: [], qa: {Shared: 'global'}, qa_overrides: {Local: 'original'}});
function editor(handler = async () => ({})) {
  const nodes = new Map(), created = [];
  const byId = id => [...nodes.values()].flatMap(all).find(node => node.id === id);
  const document = {querySelector: key => {const found = /^#[\w-]+$/.test(key) && byId(key.slice(1)); if (found) return found;
      if (!nodes.has(key)) nodes.set(key, new Node()); return nodes.get(key);},
    querySelectorAll: () => [], createElement: tag => {const node = new Node(tag); created.push(node); return node;},
    createTextNode: value => String(value), getElementById: id => byId(id) || nodes.get('#' + id), body: new Node('body')};
  const calls = [], prompts = [], clipboard = [];
  const context = vm.createContext({document, chrome: {runtime: {sendMessage: async message => {calls.push(structuredClone(message)); return {value: await handler(message)};}}},
    BKIcon: {hydrate() {}, svg: () => new Node('svg')}, BKText: require('../lib/text.js'),
    navigator: {clipboard: {writeText: async value => {clipboard.push(value);}}},
    prompt: () => prompts.shift() ?? null, setTimeout: () => 0, clearTimeout() {}, structuredClone, Uint8Array, btoa: value => Buffer.from(value, 'binary').toString('base64')});
  const source = fs.readFileSync(path.join(__dirname, '../options.js'), 'utf8').replace('load().then(health);', '');
  vm.runInContext(source + '\nglobalThis.api = {state, fieldRow, addTranslation, saveKit, open, qaSection, addQa, upload, removeAsset, mediaSection, check, render};', context);
  const api = context.api;
  api.state.site = 'a'; api.state.kit = kit('a'); api.state.profile = {fields: {}, qa: {Shared: 'global'}};
  return {...api, calls, prompts, clipboard, nodes, created, context};
}

test('编辑文案再加翻译保留最新正文、分档与此前翻译', async () => {
  const e = editor();
  const row = e.fieldRow('tagline', e.state.kit.fields.tagline);
  const area = all(row).find(node => node.tag === 'textarea');
  area.value = 'new copy'; await area.fire('change');
  e.prompts.push('ja', '新しい');
  await all(row).find(node => node.tag === 'button' && node.textContent === '加翻译').fire('click');
  assert.equal(e.state.kit.fields.tagline.value, 'new copy');
  assert.equal(e.state.kit.fields.tagline.variants['8'], 'new copy');
  assert.equal(e.state.kit.fields.tagline.i18n.de, 'alt');
  assert.equal(e.state.kit.fields.tagline.i18n.ja, '新しい');
});

test('change立即保存，连续修改串行发送且绑定原产品与最后文案', async () => {
  const first = deferred();
  let writes = 0;
  const e = editor(async message => {if (message.type === 'kit-save' && ++writes === 1) await first.promise; return {};});
  const original = e.state.kit;
  original.assets = [{id: '0', assetId: 'logo-stable', file: '0', alt: 'keep'}];
  const row = e.fieldRow('tagline', original.fields.tagline);
  const area = all(row).find(node => node.tag === 'textarea');
  area.value = 'first'; await area.fire('change');
  await tick();
  assert.equal(e.calls.filter(item => item.type === 'kit-save').length, 1, 'change不应等待250ms定时器');
  area.value = 'last'; await area.fire('change');
  e.state.site = 'b'; e.state.kit = kit('b');
  await tick();
  assert.equal(writes, 1, '同产品写入必须串行');
  first.resolve(); await tick(); await tick();
  const saved = e.calls.filter(item => item.type === 'kit-save');
  assert.equal(saved.length, 2);
  assert.ok(saved.every(item => item.site === 'a' && item.kit.site === 'a'));
  assert.equal(saved.at(-1).kit.fields.tagline.value, 'last');
  assert.deepEqual(saved.at(-1).kit.assets, original.assets);
  assert.equal(saved.at(-1).kit.qa_overrides.Local, 'original');
  assert.equal(e.state.kit.fields.tagline.value, 'old');
});

test('一次保存失败不吞后续修改，错误可见且不清空当前内容', async () => {
  let writes = 0;
  const e = editor(async () => {if (++writes === 1) throw Error('disk full'); return {};});
  e.state.kit.fields.tagline.value = 'unsaved';
  assert.equal(await e.saveKit(), false);
  assert.equal(e.state.kit.fields.tagline.value, 'unsaved');
  assert.match(e.nodes.get('#toasts').textContent, /保存失败.*disk full/);
  e.state.kit.fields.tagline.value = 'retry latest';
  assert.equal(await e.saveKit(), true);
  assert.equal(e.calls.at(-1).kit.fields.tagline.value, 'retry latest');
});

test('异步打开A后B，A迟到不能把B的编辑器换成A', async () => {
  const slow = deferred();
  const e = editor(async message => {
    if (message.type === 'kit') return message.site === 'a' ? slow.promise : kit(message.site);
    if (message.type === 'profile') return {fields: {}, qa: {}};
    if (message.type === 'kits') return [];
  });
  const a = e.open('a');
  await tick();
  await e.open('b');
  slow.resolve(kit('a')); await a;
  assert.equal(e.state.site, 'b');
  assert.equal(e.state.kit.site, 'b');
  assert.match(e.nodes.get('#editor').textContent, /b/);
});

test('A到B再到A仍忽略第一次A的迟到结果和错误', async () => {
  const slow = deferred(); let reads = 0;
  const e = editor(async message => {
    if (message.type === 'kit') return message.site === 'a' && ++reads === 1 ? slow.promise : {...kit(message.site), fields: {name: {value: 'latest'}}};
    if (message.type === 'profile') return {fields: {}, qa: {}};
    if (message.type === 'kits') return [];
  });
  const first = e.open('a'); await tick();
  await e.open('b'); await e.open('a');
  slow.reject(Error('stale error')); await first;
  assert.equal(e.state.kit.fields.name.value, 'latest');
  assert.doesNotMatch(e.nodes.get('#editor').textContent, /stale error/);
});

test('保存失败的草稿切换产品后重开仍保留，可再次编辑保存', async () => {
  let fail = true;
  const e = editor(async message => {
    if (message.type === 'kit-save') {if (fail) throw Error('disk full'); return {};}
    if (message.type === 'kit') return kit(message.site);
    if (message.type === 'profile') return {fields: {}, qa: {}};
    if (message.type === 'kits') return [];
  });
  e.state.kit.fields.name.value = 'never discard';
  await e.saveKit();
  await e.open('b'); await e.open('a');
  assert.equal(e.state.kit.fields.name.value, 'never discard');
  fail = false;
  assert.equal(await e.saveKit(), true);
  assert.equal(e.calls.at(-1).kit.fields.name.value, 'never discard');
});

test('本站问答只编辑qa_overrides，留空可显式覆盖共享答案，删除恢复继承', async () => {
  const e = editor();
  let section = e.qaSection();
  assert.deepEqual(all(section).filter(node => node.tag === 'input').map(node => node['aria-label']), ['Local']);
  assert.match(section.textContent, /留空.*覆盖共享答案/);
  e.prompts.push('Shared', ''); e.addQa();
  await tick();
  assert.equal(e.state.kit.qa_overrides.Shared, '');
  assert.equal(e.state.kit.qa.Shared, 'global');
  section = e.qaSection();
  const local = all(section).find(node => node.tag === 'input' && node['aria-label'] === 'Local');
  local.value = 'edited'; await local.fire('change'); await tick();
  assert.equal(e.state.kit.qa_overrides.Local, 'edited');
  const sharedRow = all(section).find(node => node.className === 'qa-row' && node.textContent.startsWith('Shared'));
  await all(sharedRow).find(node => node.tag === 'button').fire('click'); await tick();
  assert.equal(Object.hasOwn(e.state.kit.qa_overrides, 'Shared'), false);
  assert.equal(e.calls.at(-1).kit.qa.Shared, 'global');
});

test('取消问答答案输入不创建空覆盖', () => {
  const e = editor();
  e.prompts.push('Shared', null); e.addQa();
  assert.equal(Object.hasOwn(e.state.kit.qa_overrides, 'Shared'), false);
  assert.equal(e.state.kit.qa.Shared, 'global');
});

test('上传绑定发起产品，等前次保存，上传期间的最后修改与新素材都保留', async () => {
  const saving = deferred(), reading = deferred(), uploading = deferred();
  let writes = 0;
  const newAssets = [{id: '0', assetId: 'new-logo', key: 'logo', alt: 'uploaded'}];
  const e = editor(async message => {
    if (message.type === 'kit-save') {if (++writes === 1) await saving.promise; return {};}
    if (message.type === 'asset') {await uploading.promise; return {asset: {w: 512, h: 512}};}
    if (message.type === 'kit') return {...kit(message.site), assets: newAssets};
  });
  const a = e.state.kit;
  a.fields.name.value = 'original product';
  const previous = e.saveKit(); await tick();
  const task = e.upload('logo', {name: 'logo.png', size: 3, arrayBuffer: () => reading.promise});
  e.state.site = 'b'; e.state.kit = kit('b');
  reading.resolve(Uint8Array.from([1, 2, 3]).buffer); await tick();
  assert.equal(e.calls.some(item => item.type === 'asset'), false, '上传必须等待此前写入');
  saving.resolve(); await previous; await tick();
  assert.equal(e.calls.find(item => item.type === 'asset').site, 'a');
  assert.equal(e.calls.find(item => item.type === 'asset').alt, 'original product');
  a.fields.tagline.value = 'edit while upload';
  const last = e.saveKit('latest', a);
  uploading.resolve(); await task; await last;
  assert.equal(e.state.kit.site, 'b');
  assert.equal(e.state.kit.assets.length, 0);
  assert.equal(e.calls.at(-1).kit.fields.tagline.value, 'edit while upload');
  assert.deepEqual(e.calls.at(-1).kit.assets, newAssets);
  assert.equal(e.calls.at(-1).site, 'a');
});

test('移除确认后仍绑定原产品，并等待保存完成才返回', async () => {
  const confirmation = deferred(), saving = deferred();
  const e = editor(async message => {if (message.type === 'kit-save') await saving.promise; return {};});
  const a = e.state.kit;
  a.assets = [{key: 'logo', assetId: 'a-logo'}];
  e.context.confirmation = confirmation.promise;
  vm.runInContext('confirmSheet = () => confirmation;', e.context);
  let complete = false;
  const task = e.removeAsset('logo', '标志').then(() => {complete = true;});
  e.state.site = 'b'; e.state.kit = kit('b'); e.state.kit.assets = [{key: 'logo', assetId: 'b-logo'}];
  confirmation.resolve(true); await tick();
  assert.equal(e.calls[0].site, 'a');
  assert.equal(complete, false, '移除不能在保存前返回');
  assert.equal(e.calls[0].kit.assets.length, 0);
  saving.resolve(); await task;
  assert.equal(e.state.kit.assets[0].assetId, 'b-logo');
});

test('上传前保存失败时停止上传，不清空当前未保存正文', async () => {
  const e = editor(async message => {if (message.type === 'kit-save') throw Error('disk full'); return {asset: {}};});
  e.state.kit.fields.name.value = 'unsaved product';
  await e.upload('logo', {name: 'logo.png', size: 0, arrayBuffer: async () => new ArrayBuffer(0)});
  assert.equal(e.calls.some(item => item.type === 'asset'), false);
  assert.equal(e.state.kit.fields.name.value, 'unsaved product');
  assert.match(e.nodes.get('#toasts').textContent, /保存失败.*disk full/);
});

test('切到全局身份档案会使未完成的产品open失效', async () => {
  const slow = deferred();
  const e = editor(async message => {
    if (message.type === 'kit') return slow.promise;
    if (message.type === 'profile') return {fields: {}, qa: {}};
    if (message.type === 'kits') return [];
  });
  const opening = e.open('a'); await tick();
  await e.nodes.get('#edit-profile').fire('click');
  slow.resolve(kit('a')); await opening;
  assert.match(e.nodes.get('#editor').textContent, /全局身份档案/);
  assert.equal(e.state.kit, null);
});

test('上传只更新媒体区，不重绘用户正在输入的正文；读文件失败可见', async () => {
  const e = editor(async message => {
    if (message.type === 'asset') return {asset: {}};
    if (message.type === 'kit') return {...kit('a'), assets: []};
    return {};
  });
  const main = e.context.document.querySelector('#editor');
  const marker = new Node('textarea'); marker.value = 'not blurred yet'; main.append(marker);
  await e.upload('logo', {name: 'logo.png', size: 0, arrayBuffer: async () => new ArrayBuffer(0)});
  assert.equal(main.children[0], marker);
  await e.upload('logo', {name: 'bad.png', size: 1, arrayBuffer: async () => {throw Error('unreadable');}});
  assert.match(e.nodes.get('#toasts').textContent, /unreadable/);
  assert.equal(main.children[0].value, 'not blurred yet');
});

test('选文件事件延迟到切换后仍使用原卡片绑定的产品', async () => {
  const e = editor(async message => {
    if (message.type === 'asset') return {asset: {}};
    if (message.type === 'kit') return kit(message.site);
    return {};
  });
  const section = e.mediaSection();
  const picker = all(section).find(node => node.tag === 'input' && node.type === 'file');
  e.state.site = 'b'; e.state.kit = kit('b');
  picker.files = [{name: 'logo.png', size: 0, arrayBuffer: async () => new ArrayBuffer(0)}];
  await picker.fire('change');
  assert.equal(e.calls.find(item => item.type === 'asset').site, 'a');
  assert.equal(e.state.kit.site, 'b');
});

test('上传期间编辑已有素材alt，上传读回不恢复旧alt', async () => {
  const uploading = deferred();
  const original = {id: '0', assetId: 'old-logo', key: 'logo', alt: 'old alt'};
  const e = editor(async message => {
    if (message.type === 'asset') {await uploading.promise; return {asset: {}};}
    if (message.type === 'kit') return {...kit('a'), assets: [{...original}, {id: '1', assetId: 'new-logo', key: 'logo'}]};
    return {};
  });
  e.state.kit.assets = [{...original}];
  const media = e.mediaSection();
  const task = e.upload('logo', {name: 'new.png', size: 0, arrayBuffer: async () => new ArrayBuffer(0)});
  await tick();
  const alt = all(media).find(node => node['aria-label'] === '品牌标志 alt');
  alt.value = 'latest alt'; await alt.fire('change');
  uploading.resolve(); await task; await tick();
  const saved = e.calls.filter(message => message.type === 'kit-save').at(-1);
  assert.equal(saved.kit.assets.find(asset => asset.assetId === 'old-logo').alt, 'latest alt');
  assert.ok(saved.kit.assets.some(asset => asset.assetId === 'new-logo'));
});

test('上传已写入但读回失败，后续保存不能丢掉刚登记的素材', async () => {
  const e = editor(async message => {
    if (message.type === 'asset') return {asset: {id: 'uploaded', key: 'logo', file: 'uploaded.png', alt: 'kept'}};
    if (message.type === 'kit') throw Error('readback offline');
    return {};
  });
  assert.equal(await e.upload('logo', {name: 'uploaded.png', size: 0, arrayBuffer: async () => new ArrayBuffer(0)}), false);
  assert.match(e.nodes.get('#toasts').textContent, /readback offline/);
  e.state.kit.fields.name.value = 'retry without data loss';
  assert.equal(await e.saveKit(), true);
  assert.equal(e.calls.at(-1).kit.assets.find(asset => asset.assetId === 'uploaded')?.file, 'uploaded.png');
});

test('移除后剩余素材的展示序号与保存顺序一致，稳定身份不变', async () => {
  const e = editor();
  e.state.kit.assets = [{id: '0', assetId: 'logo-main', key: 'logo'}, {id: '1', assetId: 'screen-main', key: 'screenshot'}];
  vm.runInContext('confirmSheet = async () => true;', e.context);
  await e.removeAsset('logo', '标志');
  assert.equal(e.state.kit.assets[0].id, '0');
  assert.equal(e.state.kit.assets[0].assetId, 'screen-main');
  assert.equal(e.calls.find(message => message.type === 'kit-save').kit.assets[0].assetId, 'screen-main');
});

test('共享问答取消答案不保存，显式空字符串仍可清空答案交人', async () => {
  const e = editor();
  e.prompts.push('Shared', null);
  await e.nodes.get('#edit-qa').fire('click');
  assert.equal(e.calls.filter(message => message.type === 'profile-save').length, 0);
  assert.equal(e.state.profile.qa.Shared, 'global');
  e.prompts.push('Shared', '');
  await e.nodes.get('#edit-qa').fire('click');
  assert.equal(e.calls.filter(message => message.type === 'profile-save').length, 1);
  assert.equal(e.calls.at(-1).profile.qa.Shared, '');
  assert.equal(e.state.profile.qa.Shared, '');
});

test('完整度检查只更新报告，不替换未blur的正文节点或焦点', async () => {
  const waiting = deferred();
  const e = editor(async () => waiting.promise);
  e.render();
  const main = e.nodes.get('#editor');
  const area = all(main).find(node => node['aria-label'] === 'description');
  const report = all(main).find(node => node.id === 'check-result');
  const task = e.check();
  area.value = 'still typing without change';
  e.context.document.activeElement = area;
  waiting.resolve([{site: 'a', errors: ['missing logo'], warnings: []}]);
  await task;
  assert.equal(all(main).find(node => node['aria-label'] === 'description'), area);
  assert.equal(area.value, 'still typing without change');
  assert.equal(e.context.document.activeElement, area);
  assert.match(report.replacement?.textContent || report.textContent, /missing logo/);
  assert.equal(e.calls.some(message => message.type === 'kit-save'), false);
});

test('A完整度回包不能套到B或A重新打开后的编辑器', async () => {
  for (const destination of ['b', 'a']) {
    const waiting = deferred(); let checks = 0;
    const e = editor(async message => {
      if (message.type === 'kit') return kit(message.site);
      if (message.type === 'profile') return {fields: {}, qa: {}};
      if (message.type === 'kits') return ++checks === 1 ? waiting.promise : [];
    });
    const task = e.check();
    await e.open('b');
    if (destination === 'a') await e.open('a');
    const current = e.nodes.get('#editor').children[0];
    waiting.resolve([{site: 'a', errors: ['stale A'], warnings: []}, {site: 'b', errors: ['wrong B'], warnings: []}]);
    await task;
    assert.deepEqual(Array.from(e.state.errors), []);
    assert.equal(e.nodes.get('#editor').children[0], current);
  }
});

test('asset落盘但回执丢失，先读回登记再继续排队保存，不重传也不串产品', async () => {
  const uploading = deferred();
  const registered = [{id: '0', assetId: 'receipt-lost', key: 'logo', file: 'lost.png'}];
  const e = editor(async message => {
    if (message.type === 'asset') {await uploading.promise; throw Error('response lost');}
    if (message.type === 'kit') return {...kit(message.site), assets: registered};
    return {};
  });
  const a = e.state.kit;
  const task = e.upload('logo', {name: 'lost.png', size: 0, arrayBuffer: async () => new ArrayBuffer(0)});
  await tick();
  a.fields.name.value = 'queued after upload';
  const saving = e.saveKit('latest', a);
  e.state.site = 'b'; e.state.kit = kit('b');
  uploading.resolve(); await task; await saving;
  assert.equal(e.calls.filter(message => message.type === 'asset').length, 1);
  const recovery = e.calls.findIndex(message => message.type === 'kit');
  const last = e.calls.findLastIndex(message => message.type === 'kit-save');
  assert.ok(recovery > 0 && recovery < last, '必须先读回成功登记，再恢复后续保存');
  assert.deepEqual(e.calls[last].kit.assets, registered);
  assert.equal(e.calls[last].kit.fields.name.value, 'queued after upload');
  assert.ok(e.calls.every(message => message.site === 'a'));
  assert.equal(e.state.kit.site, 'b');
  assert.equal(e.state.kit.assets.length, 0);
});

test('asset回执和读回都失败时阻止该产品整包覆盖，核实成功后才恢复', async () => {
  let readable = false;
  const registered = [{id: '0', assetId: 'unknown-upload', key: 'logo', file: 'unknown.png'}];
  const e = editor(async message => {
    if (message.type === 'asset') throw Error('response lost');
    if (message.type === 'kit') {if (!readable) throw Error('read offline'); return {...kit(message.site), assets: registered};}
    return {};
  });
  const a = e.state.kit;
  await e.upload('logo', {name: 'unknown.png', size: 0, arrayBuffer: async () => new ArrayBuffer(0)});
  a.fields.name.value = 'must keep draft';
  assert.equal(await e.saveKit(), false, '未核实登记前不能用旧assets继续整包保存');
  assert.equal(e.calls.filter(message => message.type === 'kit-save').length, 1, '只允许上传前那次保存');
  assert.match(e.nodes.get('#toasts').textContent, /素材登记.*未核实.*阻止.*覆盖/);
  e.state.site = 'b'; e.state.kit = kit('b');
  assert.equal(await e.saveKit(), true, '只阻止结果未知的产品');
  readable = true;
  assert.equal(await e.saveKit('retry', a), true);
  assert.deepEqual(e.calls.at(-1).kit.assets, registered);
  assert.equal(e.calls.at(-1).kit.fields.name.value, 'must keep draft');
  assert.equal(e.calls.filter(message => message.type === 'asset').length, 1);
});

test('上传缺失响应内容同样视为结果未知，不能继续使用旧登记', async () => {
  const e = editor(async message => {
    if (message.type === 'asset') return undefined;
    if (message.type === 'kit') throw Error('still offline');
    return {};
  });
  await e.upload('logo', {name: 'lost.png', size: 0, arrayBuffer: async () => new ArrayBuffer(0)});
  assert.equal(await e.saveKit(), false);
  assert.equal(e.calls.filter(message => message.type === 'kit-save').length, 1);
});

test('重新读取可只读核实未知上传，保留正文草稿并恢复素材登记', async () => {
  let readable = false;
  const e = editor(async message => {
    if (message.type === 'asset') throw Error('lost');
    if (message.type === 'kit') {
      if (!readable) throw Error('offline');
      return {...kit(message.site), assets: [{id: '0', assetId: 'recovered', key: 'logo'}]};
    }
    if (message.type === 'kits') return [];
    return {};
  });
  e.state.kit.fields.name.value = 'keep local draft';
  await e.upload('logo', {name: 'lost.png', size: 0, arrayBuffer: async () => new ArrayBuffer(0)});
  readable = true;
  await e.open('a');
  assert.equal(e.state.kit.assets[0]?.assetId, 'recovered');
  assert.equal(e.state.kit.fields.name.value, 'keep local draft');
  assert.equal(e.calls.filter(message => message.type === 'kit-save').length, 1);
  assert.equal(await e.saveKit(), true);
});

async function importPicker(e) {
  await e.nodes.get('#import').fire('click');
  return e.created.at(-1);
}
function chooseImport(picker, value) {
  picker.files = [{text: typeof value === 'function' ? value : async () => JSON.stringify(value)}];
  return picker.fire('change');
}
test('导入绑定点击时的产品和kit，选文件及读取期间切换都不串产品', async () => {
  const reading = deferred();
  const e = editor(async message => message.type === 'kit' ? kit(message.site) : {});
  const original = e.state.kit;
  const picker = await importPicker(e);
  e.state.site = 'b'; e.state.kit = kit('b');
  const task = chooseImport(picker, () => reading.promise);
  await tick();
  const imported = kit('a'); delete imported.site;
  imported.fields.name.value = 'imported A';
  reading.resolve(JSON.stringify(imported)); await task;
  const saved = e.calls.find(message => message.type === 'kit-save');
  assert.equal(saved.site, 'a');
  assert.equal(saved.kit.site, 'a');
  assert.equal(original.fields.name.value, 'imported A');
  assert.equal(e.state.site, 'b');
  assert.equal(e.state.kit.fields.name.value, 'b');
});

test('导入占用产品保存队列，前次写入先完成，旧kit后续保存不能覆盖导入', async () => {
  const saving = deferred(), reading = deferred(); let writes = 0;
  const imported = kit('a'); imported.fields.name.value = 'import wins';
  const e = editor(async message => {
    if (message.type === 'kit-save' && ++writes === 1) await saving.promise;
    return message.type === 'kit' ? structuredClone(imported) : {};
  });
  const a = e.state.kit;
  a.fields.name.value = 'old draft';
  const previous = e.saveKit(); await tick();
  const picker = await importPicker(e);
  const task = chooseImport(picker, () => reading.promise);
  reading.resolve(JSON.stringify(imported)); await tick();
  assert.equal(writes, 1, '导入不可绕过已有产品保存');
  const last = e.saveKit('later', a);
  saving.resolve(); await previous; await task; await last;
  const saves = e.calls.filter(message => message.type === 'kit-save');
  assert.equal(saves.length, 3);
  assert.equal(saves[0].kit.fields.name.value, 'old draft');
  assert.equal(saves[1].kit.fields.name.value, 'import wins');
  assert.equal(saves[2].kit.fields.name.value, 'import wins');
});

test('导入已提交但读回失败保留导入内容，重开和后续保存不恢复失败旧草稿', async () => {
  let failWrite = true;
  const e = editor(async message => {
    if (message.type === 'kit-save' && failWrite) throw Error('previous failed draft');
    if (message.type === 'kit') {if (message.site === 'a') throw Error('import readback offline'); return kit(message.site);}
    if (message.type === 'kits') return [];
    return {};
  });
  e.state.kit.fields.name.value = 'failed old draft'; await e.saveKit();
  failWrite = false;
  const imported = kit('a'); imported.fields.name.value = 'committed import';
  const picker = await importPicker(e); await chooseImport(picker, imported);
  assert.equal(e.state.kit.fields.name.value, 'committed import');
  assert.match(e.nodes.get('#toasts').textContent, /import readback offline/);
  await e.open('b'); await e.open('a');
  assert.equal(e.state.kit.fields.name.value, 'committed import');
  assert.equal(await e.saveKit(), true);
  assert.equal(e.calls.at(-1).kit.fields.name.value, 'committed import');
});

test('导入读回迟到不能修改新编辑器，重新打开同产品也按open代次隔离', async () => {
  const reading = deferred(); let reads = 0;
  const imported = kit('a'); imported.fields.name.value = 'imported';
  const e = editor(async message => {
    if (message.type === 'kit') return ++reads === 1 ? reading.promise : {...kit(message.site), fields: {name: {value: 'fresh open'}}};
    if (message.type === 'kits') return [];
    return {};
  });
  const picker = await importPicker(e);
  const task = chooseImport(picker, imported); await tick();
  await e.open('b');
  const reopening = e.open('a'); await tick();
  const loading = e.nodes.get('#editor').children[0];
  reading.resolve({...kit('a'), fields: {name: {value: 'stale readback'}}});
  await task;
  // open A在等导入队列，不允许导入拿旧代次提前渲染它。
  assert.notEqual(e.state.kit?.fields.name.value, 'stale readback');
  await reopening;
  assert.equal(e.state.kit.fields.name.value, 'fresh open');
  assert.notEqual(e.nodes.get('#editor').children[0], loading);
});

test('导入拒绝跨产品包，保留原字段、分档、素材和本站问答', async () => {
  const e = editor(async message => {
    if (message.type === 'kit-save' && message.kit.site !== message.site) throw Error('产品不匹配');
    return {};
  });
  const before = structuredClone(e.state.kit);
  const picker = await importPicker(e); await chooseImport(picker, kit('b'));
  assert.deepEqual(structuredClone(e.state.kit), before);
  assert.match(e.nodes.get('#toasts').textContent, /产品不匹配/);
});

test('导入读回不吞随后正在输入的文案，保留分档、翻译、问答和复制行为', async () => {
  const reading = deferred();
  const imported = kit('a');
  imported.fields.tagline = {value: 'imported copy', variants: {40: 'short'}, i18n: {ja: '日本語'}};
  imported.qa_overrides.Shared = '';
  const e = editor(async message => message.type === 'kit' ? reading.promise : {});
  const picker = await importPicker(e);
  const task = chooseImport(picker, imported); await tick();
  const main = e.nodes.get('#editor');
  const area = all(main).find(node => node['aria-label'] === 'tagline');
  area.value = 'typing during import readback';
  const row = all(main).find(node => node.id === 'field-tagline');
  await all(row).find(node => node.tag === 'button' && node.textContent === '复制').fire('click');
  assert.deepEqual(e.clipboard, ['typing during import readback']);
  reading.resolve(structuredClone(imported)); await task;
  assert.equal(all(main).find(node => node['aria-label'] === 'tagline'), area);
  assert.equal(area.value, 'typing during import readback');
  await area.fire('change'); await tick();
  assert.equal(e.calls.at(-1).kit.fields.tagline.value, area.value);
  assert.equal(e.calls.at(-1).kit.fields.tagline.variants['40'], 'short');
  assert.equal(e.calls.at(-1).kit.fields.tagline.i18n.ja, '日本語');
  assert.equal(e.calls.at(-1).kit.qa_overrides.Shared, '');
});

test('导入读回期间已change的最新正文与素材身份不会被旧读回覆盖', async () => {
  const reading = deferred();
  const imported = kit('a'); imported.assets = [{id: '0', assetId: 'stable-logo', key: 'logo'}];
  const e = editor(async message => message.type === 'kit' ? reading.promise : {});
  const picker = await importPicker(e);
  const task = chooseImport(picker, imported); await tick();
  const area = all(e.nodes.get('#editor')).find(node => node['aria-label'] === 'name');
  area.value = 'latest after commit'; await area.fire('change');
  reading.resolve(structuredClone(imported)); await task; await tick();
  assert.equal(e.calls.at(-1).kit.fields.name.value, 'latest after commit');
  assert.equal(e.calls.at(-1).kit.assets[0].assetId, 'stable-logo');
});
