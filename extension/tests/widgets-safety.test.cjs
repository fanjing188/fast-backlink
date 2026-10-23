const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const writes = [], events = [];
  const container = {getAttribute: () => '', querySelectorAll: () => [], querySelector: () => null};
  class Event {constructor(type, data) {this.type = type; Object.assign(this, data);}}
  const document = {defaultView: {MouseEvent: Event, PointerEvent: Event, KeyboardEvent: Event}};
  const root = {querySelectorAll: () => []};
  const element = {tagName: 'INPUT', type: 'text', value: '', isConnected: true, disabled: false, readOnly: false, attributes: {},
    ownerDocument: document, parentElement: container, getRootNode: () => root, closest: () => container,
    getAttribute(name) {return this.attributes[name] || (name === 'role' ? 'combobox' : '');},
    focus() {this.onFocus?.();}, dispatchEvent(event) {events.push(event.type); this.onEvent?.(event); return true;}};
  const fields = {setNative(node, key, value) {writes.push({type: node.type, value}); node[key] = value;},
    events(node, types) {for (const type of types) node.dispatchEvent(new Event(type));}};
  const sandbox = {BKFields: fields, document, setTimeout, clearTimeout, console};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/widgets.js'), 'utf8'), sandbox);
  return {widgets: sandbox.BKWidgets, element, writes, events};
}

test('排队控件在开始执行前重新核资格，失效队列不派发事件', async () => {
  const h = fixture();
  let release;
  const blocked = h.widgets.serial(() => new Promise(resolve => {release = resolve;}));
  await Promise.resolve();
  let allowed = true;
  const operation = h.widgets.set(h.element, {widget: 'mui-autocomplete'}, 'Product', {eligible: () => allowed});
  allowed = false; release(); await blocked;
  const result = await operation;
  assert.equal(result.reason, 'target_changed');
  assert.equal(h.events.length, 0);
  assert.equal(h.writes.length, 0);
});

test('控件点击后变密码框，不等待后向密码框补搜索词', async () => {
  const h = fixture();
  h.element.onEvent = event => {if (event.type === 'click') h.element.type = 'password';};
  const result = await h.widgets.set(h.element, {widget: 'mui-autocomplete'}, 'Product');
  assert.equal(result.reason, 'target_changed');
  assert.equal(h.writes.length, 0);
});

test('展开期间aria关联换绑后，不能向旧搜索控件写建议', async () => {
  const h = fixture();
  h.element.attributes['aria-controls'] = 'original-menu';
  h.element.onEvent = event => {if (event.type === 'click') h.element.attributes['aria-controls'] = 'other-menu';};
  const result = await h.widgets.set(h.element, {widget: 'mui-autocomplete'}, 'Product');
  assert.equal(h.writes.length, 0);
  assert.equal(result.reason, 'target_changed');
});

test('combobox声明不能授权点击会提交或重置表单的原生控件', async () => {
  for (const type of ['submit', 'reset', 'image']) {
    const h = fixture(); h.element.type = type; h.element.form = {};
    const result = await h.widgets.set(h.element, {widget: 'mui-autocomplete'}, 'Product');
    assert.equal(result.reason, 'target_changed', type);
    assert.equal(h.events.length, 0, type);
    assert.equal(h.writes.length, 0, type);
  }
});

test('输入控件focus处理器改变类型时，连清空值都不执行', async () => {
  const h = fixture();
  h.element.onFocus = () => {h.element.type = 'password'; h.element.value = 'keep-private';};
  const result = await h.widgets.set(h.element, {widget: 'tags'}, ['one']);
  assert.equal(result.reason, 'target_changed');
  assert.equal(h.element.value, 'keep-private');
  assert.equal(h.writes.length, 0);
});

test('清空事件把控件改成密码框后，不继续写正文', async () => {
  const h = fixture();
  h.element.onEvent = event => {if (event.type === 'input') h.element.type = 'password';};
  const result = await h.widgets.set(h.element, {widget: 'tags'}, ['one']);
  assert.equal(result.reason, 'target_changed');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].type, 'text');
  assert.equal(h.writes[0].value, '');
});

test('标签输入按键后失效，不向敏感框写下一个标签', async () => {
  const h = fixture();
  h.element.onEvent = event => {if (event.type === 'keydown') h.element.type = 'password';};
  const result = await h.widgets.set(h.element, {widget: 'tags'}, ['one', 'two']);
  assert.equal(result.reason, 'target_changed');
  assert.ok(!h.writes.some(item => item.type === 'password' || item.value === 'two'));
});

test('合法控件仍能串行写入多个标签，不因自己的输入事件失效', async () => {
  const h = fixture();
  h.element.onEvent = event => {if (event.type === 'keydown') h.element.value = '';};
  const result = await h.widgets.set(h.element, {widget: 'tags'}, ['one', 'two'], {eligible: () => true});
  assert.equal(result.ok, true);
  assert.deepEqual(h.writes.filter(item => item.value).map(item => item.value), ['one', 'two']);
});
