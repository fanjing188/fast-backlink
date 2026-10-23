const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {harness} = require('./harness.cjs');
const root = path.join(__dirname, '..');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

// 运行完整内容脚本，只替换 DOM/浏览器边界与稳定等待；不冒充原生事件验收。
function content(send = async () => ({value: {}})) {
  const listeners = {}, form = {}, documentRoot = {};
  const window = {addEventListener() {}}; window.top = window;
  const element = {name: 'product', id: 'product', type: 'text', tagName: 'INPUT', nodeType: 1,
    isConnected: true, form, value: '', getRootNode: () => documentRoot};
  const field = {index: 0, label: 'Product name', inputType: 'text', widget: 'native', name: 'product'};
  const entry = {element, field}, writes = [];
  const sandbox = {window, document: {documentElement: documentRoot, addEventListener: (type, fn) => {listeners[type] = fn;}},
    location: {href: 'https://source.example/form', hostname: 'source.example'}, console, setTimeout, clearTimeout, URL,
    chrome: {runtime: {sendMessage: send, onMessage: {addListener() {}}}, storage: {onChanged: {addListener() {}}}},
    BKAuthPolicy: require('../lib/auth-policy.js'), BKAuthPage: {inspect: () => ({kind: 'form'})},
    BKFields: {scan: () => [entry], describe: () => field, read: node => node.value,
      setValue: (node, value) => {writes.push(value); node.value = value;}},
    BKText: require('../lib/text.js'), BKUI: {toast() {}}, BKWidgets: {sleep: async () => {}}};
  sandbox.globalThis = sandbox; vm.createContext(sandbox);
  for (const name of ['snapshot', 'match', 'ai']) vm.runInContext(fs.readFileSync(path.join(root, 'lib', name + '.js'), 'utf8'), sandbox);
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const start = source.lastIndexOf('  start().catch(error => {');
  assert.ok(start > 0);
  vm.runInContext(source.slice(0, start) + `globalThis.api = {state, adoptContext, bindHumanInput, restore, scan, applyValue,
    settleWith: fn => {settle = fn;}}; render = () => {}; focusCaptcha = () => {}; })();`, sandbox);
  return {sandbox, ...sandbox.api, element, entry, writes, listeners};
}
const context = site => ({site, source_domain: 'source.example', record: {id: (site === 'A' ? 'a' : 'b').repeat(32)}, submit_url: 'https://source.example/form'});

test('首次item回包前的人工提交立即锁定并持久记录，迟到会话不能继续填写', async () => {
  const h = harness(), gate = deferred(), entered = deferred();
  const id = 'a'.repeat(32);
  h.sessionStore['tab:1'] = {site: 'probekits', pendingItem: id, entryURL: 'https://source.example/form', context: null, submitted: false};
  const fetch = h.sandbox.fetch;
  h.sandbox.fetch = async (url, options) => {if (url.includes('/api/item')) {entered.resolve(); await gate.promise;} return fetch(url, options);};
  const f = content(message => h.send(message, h.page)); f.bindHumanInput();
  const pending = h.send({type: 'session', url: 'https://source.example/form'}, h.page);
  await entered.promise; f.listeners.submit(); await h.flush();
  gate.resolve(); await pending;
  assert.equal(f.state.submitted, true);
  assert.equal(h.sessionStore['tab:1'].submitted, true);
  const attempts = h.requests.filter(request => request.url.endsWith('/api/submission-attempt'));
  assert.equal(attempts.length, 1); assert.equal(JSON.parse(attempts[0].options.body).id, id);
  assert.equal(h.messages.some(item => item.message.type === 'page:session'), false);
  f.adoptContext(context('A'), false);
  assert.equal(f.state.submitted, true, '首次采纳上下文也不能清掉本页已经发生的提交');
});

test('原始任务标记尚未建立可信绑定时，先核真实任务地址再记录提交', async () => {
  for (const matching of [true, false]) {
    const h = harness(), id = 'a'.repeat(32);
    const fetch = h.sandbox.fetch;
    h.sandbox.fetch = async (url, options) => {
      const result = await fetch(url, options);
      if (url.includes('/api/item') && !matching) return {...result, json: async () => ({
        site: 'probekits', record: {id}, submit_url: 'https://other.example/form'})};
      return result;
    };
    const f = content(message => h.send(message, h.page));
    f.state.entryItem = id; f.bindHumanInput(); f.listeners.submit(); await h.flush();
    const attempts = h.requests.filter(request => request.url.endsWith('/api/submission-attempt'));
    assert.equal(attempts.length, matching ? 1 : 0);
    assert.ok(h.requests.some(request => request.url.includes('/api/item')));
    if (matching) assert.equal(JSON.parse(attempts[0].options.body).id, id);
  }
});

for (const interaction of ['own-upload', 'other-input', 'keyboard']) {
  test(`CDP文件上传的${interaction}事件正确区分程序写入与人工操作`, async () => {
    let f;
    f = content(async message => {
      if (message.type === 'stage') return {value: {path: '/synthetic-stage/demo.mp4', root: '/synthetic-stage'}};
      if (message.type === 'cdp:upload') {
        f.listeners.input({isTrusted: true, target: f.element});
        if (interaction === 'other-input') f.listeners.input({isTrusted: true, target: {type: 'text'}});
        if (interaction === 'keyboard') f.listeners.keydown({isTrusted: true, altKey: false, key: 'Enter'});
        return {value: {ok: true}};
      }
      return {value: {}};
    });
    f.sandbox.setTimeout = () => 0;
    f.sandbox.BKFields.selector = () => '#product';
    f.element.type = 'file'; f.entry.field.inputType = 'file';
    f.adoptContext(context('A')); f.bindHumanInput();
    const revision = f.state.humanRevision;
    const result = await f.applyValue(f.entry, null, {asset: {id: 'demo', assetId: 'stable-demo',
      mime: 'video/mp4', sha256: 'synthetic'}, eligible: () => f.state.humanRevision === revision});
    assert.equal(f.state.humanRevision - revision, interaction === 'own-upload' ? 0 : 1);
    assert.equal(result.ok, interaction === 'own-upload');
  });
}

for (const mutation of ['project', 'document', 'url', 'human', 'same-binding']) {
  test(`快照等待期间${mutation}变化按原调用资格复原`, async () => {
    const f = content(); f.adoptContext(context('A')); f.scan();
    const snapshot = f.sandbox.BKSnapshot.capture({entries: [f.entry], site: 'A', source_domain: 'source.example', url: f.sandbox.location.href});
    snapshot.steps[0].fields[0].value = 'PRIVATE-A-VALUE';
    const gate = deferred(); f.settleWith(() => gate.promise);
    const pending = f.restore({snapshot, rounds: 1, announce: false});
    if (mutation === 'project') f.adoptContext(context('B'));
    if (mutation === 'document') f.sandbox.document.documentElement = {};
    if (mutation === 'url') f.sandbox.location.href = 'https://source.example/other';
    if (mutation === 'human') {f.state.humanRevision++; f.element.value = 'human-value';}
    if (mutation === 'same-binding') f.adoptContext(context('A'));
    gate.resolve();
    if (mutation === 'same-binding') {
      assert.equal((await pending).restored, 1); assert.equal(f.element.value, 'PRIVATE-A-VALUE');
    } else {
      await assert.rejects(pending, /上下文.*变化/);
      assert.equal(f.writes.length, 0);
      assert.equal(f.element.value, mutation === 'human' ? 'human-value' : '');
    }
  });
}
