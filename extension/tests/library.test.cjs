const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

// 纯 Node DOM 合同夹具；不替代 Chromium、扩展桥接或真实业务数据验收。
class Node {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attrs = {}; this.events = {};
    this.value = ''; this.disabled = false; this.hidden = false; this.checked = false;
  }
  append(...items) { this.children.push(...items.flat().map(item => item instanceof Node ? item : String(item))); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addEventListener(type, handler) { this.events[type] = handler; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  get textContent() { return this.ownText || this.children.map(item => typeof item === 'string' ? item : item.textContent).join(''); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
}
function fixture(handler, search = '') {
  const htmlPath = path.join(root, 'library.html');
  const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Node()]));
  const document = {querySelector: selector => nodes.get(selector.slice(1)), createElement: tag => new Node(tag)};
  const messages = [];
  const send = async (type, payload = {}) => { messages.push({type, ...payload}); return handler(type, payload); };
  const modulePath = path.join(root, 'library.js');
  assert.ok(fs.existsSync(modulePath), '需要实现 library.js');
  delete require.cache[require.resolve(modulePath)];
  const api = require(modulePath);
  const app = api.createLibrary({document, send, search, download: value => { app.downloaded = value; }});
  return {api, app, nodes, messages, html};
}
const list = (items = [], site = 'alpha') => ({items, counts: {total: items.length, confirmed: 0, ready: 0, needs_review: 0, already_submitted: 0, blocked: 0}, site});
const settled = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
function descendants(parent) { return parent.children.flatMap(child => typeof child === 'string' ? [] : [child, ...descendants(child)]); }
test('外链库筛选与编辑的类型选项使用后端实际政策枚举', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '../../rules/policy.json'), 'utf8'));
  const html = fs.readFileSync(path.join(__dirname, '../library.html'), 'utf8');
  const selectors = [...html.matchAll(/<select id="(?:record-)?scenario"[^>]*>([\s\S]*?)<\/select>/g)];
  assert.equal(selectors.length, 2);
  for (const select of selectors) {
    const values = [...select[1].matchAll(/<option value="([^"]+)"/g)].map(match => match[1]).sort();
    assert.deepEqual(values, Object.keys(policy.scenarios).sort());
  }
});

const platform = (extra = {}) => ({domain: 'directory.example', submit_url: 'https://directory.example/submit',
  scenario: 'directory', admission: '可投', reuse_state: 'ready', reasons: [], dr: null, dr_date: '', fee: '',
  login: '', backlink: '', has_recipe: true, previous_sites: ['old-product'], history: [], last_checked_at: '', ...extra});

test('初始化读取产品和清单；只接受已登记的 URL 产品，不自动选择首个产品', async () => {
  const f = fixture(type => type === 'sites' ? ['alpha', 'beta'] : list([], 'beta'), '?site=beta');
  await f.app.start();
  assert.equal(f.nodes.get('site').value, 'beta');
  assert.deepEqual(f.messages, [{type: 'sites'}, {type: 'library:list', site: 'beta', q: '', status: 'all', scenario: ''}]);
  assert.match(f.nodes.get('results').textContent, /还没有平台记录/);
  const empty = fixture(type => type === 'sites' ? ['alpha'] : list(), '?site=not-registered');
  await empty.app.start();
  assert.equal(empty.nodes.get('site').value, '');
  assert.match(empty.nodes.get('product-hint').textContent, /选择目标产品/);
});

test('加载时撤下旧清单与导出；错误不伪装空库，刷新可恢复，缺失响应也报错', async () => {
  let response = list();
  const f = fixture(type => type === 'sites' ? ['alpha'] : response);
  await f.app.start();
  assert.equal(f.nodes.get('export').disabled, false);
  const pending = deferred(); response = pending.promise;
  const loading = f.app.load();
  assert.match(f.nodes.get('results').textContent, /正在读取/);
  assert.equal(f.nodes.get('export').disabled, true);
  assert.equal(f.nodes.get('results').getAttribute('aria-busy'), 'true');
  pending.reject(Error('服务断开')); await loading;
  assert.match(f.nodes.get('results').textContent, /读取失败/);
  assert.match(f.nodes.get('notice').textContent, /服务断开/);
  assert.doesNotMatch(f.nodes.get('results').textContent, /还没有平台/);
  response = undefined; await f.app.load();
  assert.match(f.nodes.get('notice').textContent, /清单响应/);
  response = list(); await f.nodes.get('reload').events.click();
  assert.equal(f.nodes.get('notice').hidden, true);
  assert.equal(f.nodes.get('export').disabled, false);
});

test('产品、搜索、状态与类型使用消息筛选；过期响应不能覆盖新请求', async () => {
  let response = list();
  const f = fixture(type => type === 'sites' ? ['alpha', 'beta'] : response);
  await f.app.start();
  for (const [id, value, event] of [['site', 'alpha', 'change'], ['search', ' x.example ', 'input'],
    ['status', 'confirmed', 'change'], ['scenario', 'launch', 'change']]) {
    f.nodes.get(id).value = value;
    await f.nodes.get(id).events[event]();
  }
  assert.deepEqual(f.messages.at(-1), {type: 'library:list', site: 'alpha', q: 'x.example', status: 'confirmed', scenario: 'launch'});
  assert.match(f.nodes.get('results').textContent, /没有符合筛选的平台/);
  const old = deferred(); response = old.promise; const first = f.app.load();
  response = {...list(), counts: {...list().counts, total: 8, confirmed: 3}};
  await f.app.load();
  const summary = f.nodes.get('summary').textContent;
  assert.match(summary, /当前筛选 8 个平台/);
  assert.match(summary, /已确认可投 3/);
  old.reject(Error('旧请求失败')); await first;
  assert.equal(f.nodes.get('summary').textContent, summary);
  assert.equal(f.nodes.get('notice').hidden, true);
  assert.equal(f.nodes.get('results').getAttribute('aria-busy'), 'false');
});

test('平台准入、当前产品状态、历史及配方分开；未知 DR/费用不补成免费或可投', async () => {
  const items = [platform({note: '<img src=x onerror=alert(1)>', history: [{site: 'old-product', status: 'outcome_unknown', submitted_at: '2026-01-01'}]}),
    platform({domain: 'unknown.example', admission: '待核实', reuse_state: 'unknown', has_recipe: false}),
    platform({domain: 'review.example', reuse_state: 'needs_review', reasons: ['产品匹配需确认']}),
    platform({domain: 'done.example', reuse_state: 'already_submitted'}),
    platform({domain: 'blocked.example', reuse_state: 'blocked'})];
  const f = fixture(type => type === 'sites' ? ['alpha'] : list(items), '?site=alpha');
  await f.app.start();
  const content = f.nodes.get('results').textContent;
  for (const label of ['平台已确认可投', '当前产品可复用', '平台待核实', '复用状态未知', '需要核对', '当前产品已投 / 结果待核', '不可复用',
    'DR 未核实', '费用：未核实', '已有填写配方', '暂无填写配方', 'old-product', '结果未知', '2026-01-01', '产品匹配需确认']) assert.ok(content.includes(label), label);
  assert.ok(content.includes('<img src=x onerror=alert(1)>'));
  assert.equal(descendants(f.nodes.get('results')).some(node => node.tagName === 'img'), false);
  assert.equal(descendants(f.nodes.get('results')).filter(node => node.tagName === 'article').length, 5);
});

test('仅 ready 且选定产品能填写；已投/未知与不安全地址不可重放，查看始终 fill:false', async () => {
  const items = ['ready', 'needs_review', 'already_submitted', 'blocked', 'unknown'].map((reuse_state, i) => platform({domain: `${i}.example`, reuse_state}));
  items.push(platform({domain: 'unsafe.example', submit_url: 'javascript:alert(1)'}));
  items.push(platform({domain: 'credential.example', submit_url: 'https://' + 'user:password' + '@directory.example/submit'}));
  items.push(platform({domain: 'contradiction.example', history: [{site: 'alpha', status: 'outcome_unknown'}]}));
  const f = fixture(type => type === 'sites' ? ['alpha'] : type === 'library:list' ? list(items) : {tabId: 1}, '?site=alpha');
  await f.app.start();
  const buttons = () => descendants(f.nodes.get('results')).filter(node => node.tagName === 'button');
  const fills = buttons().filter(node => node.getAttribute('data-action') === 'fill');
  assert.equal(fills.length, 8);
  assert.deepEqual(fills.map(node => node.disabled), [false, true, true, true, true, true, true, true]);
  await fills[0].events.click();
  assert.deepEqual(f.messages.find(message => message.type === 'library:open'), {type: 'library:open', domain: '0.example', site: 'alpha', fill: true});
  const view = buttons().find(node => node.getAttribute('data-action') === 'view' && node.getAttribute('data-domain') === '2.example');
  await view.events.click();
  assert.deepEqual(f.messages.at(-1), {type: 'library:open', domain: '2.example', site: 'alpha', fill: false});
  f.nodes.get('site').value = ''; await f.nodes.get('site').events.change();
  assert.ok(buttons().filter(node => node.getAttribute('data-action') === 'fill').every(node => node.disabled));
  assert.doesNotMatch(f.nodes.get('results').textContent, /当前产品可复用/);
  const before = f.messages.length;
  await fills[0].events.click(); // 陈旧 DOM 回调也不能使用刚才产品的可投结论。
  assert.equal(f.messages.length, before);
});

test('打开请求防双击；失败后提示结果未知并锁住填写，不自动重试', async () => {
  const pending = deferred();
  const f = fixture(type => type === 'sites' ? ['alpha'] : type === 'library:list' ? list([platform()]) : pending.promise, '?site=alpha');
  await f.app.start();
  const fill = descendants(f.nodes.get('results')).find(node => node.getAttribute('data-action') === 'fill');
  const first = fill.events.click();
  await fill.events.click();
  assert.equal(f.messages.filter(message => message.type === 'library:open').length, 1);
  assert.equal(fill.disabled, true);
  pending.reject(Error('连接中断')); await first;
  assert.match(f.nodes.get('action-status').textContent, /结果可能未知/);
  assert.equal(fill.disabled, true);
  await f.app.load();
  const refreshed = descendants(f.nodes.get('results')).find(node => node.getAttribute('data-action') === 'fill');
  assert.equal(refreshed.disabled, true);
  await refreshed.events.click();
  assert.equal(f.messages.filter(message => message.type === 'library:open').length, 1);
});

test('人工新增默认待核实、不默认适配产品；保存只发明确填写字段并读回平台', async () => {
  let saved;
  const f = fixture((type, payload) => {
    if (type === 'sites') return ['alpha', 'beta'];
    if (type === 'library:save') { saved = payload.record; return {saved: true}; }
    return list(saved ? [platform({...saved, reuse_state: 'needs_review'})] : []);
  }, '?site=alpha');
  await f.app.start();
  await f.nodes.get('add').events.click();
  assert.equal(f.nodes.get('editor').hidden, false);
  assert.equal(f.nodes.get('record-admission').value, '待核实');
  assert.equal(f.nodes.get('record-dr').value, '');
  assert.equal(f.nodes.get('record-fee').value, '');
  assert.equal(descendants(f.nodes.get('fit-options')).filter(node => node.checked).length, 0);
  f.nodes.get('record-domain').value = 'new.example';
  f.nodes.get('record-url').value = 'https://new.example/submit';
  f.nodes.get('record-scenario').value = 'launch';
  f.nodes.get('record-note').value = '人工检查规则；适合 alpha';
  f.nodes.get('record-admission').value = '可投';
  const alpha = descendants(f.nodes.get('fit-options')).find(node => node.getAttribute('value') === 'alpha');
  alpha.checked = true;
  await f.nodes.get('record-form').events.submit({preventDefault() {}});
  assert.deepEqual(saved, {domain: 'new.example', submit_url: 'https://new.example/submit', scenario: 'launch', admission: '可投',
    note: '人工检查规则；适合 alpha', dr: null, dr_date: '', fit_sites: ['alpha'], fee: '', backlink: ''});
  const saveIndex = f.messages.findIndex(message => message.type === 'library:save');
  assert.deepEqual(f.messages[saveIndex + 1], {type: 'library:list', site: 'alpha', q: 'new.example', status: 'all', scenario: ''});
  assert.match(f.nodes.get('form-status').textContent, /已保存并读回/);
});

test('更新从原平台预填；域名不可改，适配只用显式 fit_sites，不从历史推断', async () => {
  const item = platform({note: '原人工备注', dr: 25, dr_date: '2026-01-01', fee: 'free', backlink: 'not_required', fit_sites: ['beta']});
  const f = fixture(type => type === 'sites' ? ['alpha', 'beta'] : list([item]), '?site=alpha');
  await f.app.start();
  const edit = descendants(f.nodes.get('results')).find(node => node.getAttribute('data-action') === 'edit');
  assert.ok(edit, '每个平台必须有更新入口');
  await edit.events.click();
  assert.equal(f.nodes.get('record-domain').value, 'directory.example');
  assert.equal(f.nodes.get('record-domain').readOnly, true);
  assert.equal(f.nodes.get('record-url').value, item.submit_url);
  assert.equal(f.nodes.get('record-note').value, item.note);
  assert.equal(f.nodes.get('record-dr').value, '25');
  assert.equal(f.nodes.get('record-fee').value, 'free');
  const selected = descendants(f.nodes.get('fit-options')).filter(node => node.checked).map(node => node.getAttribute('value'));
  assert.deepEqual(selected, ['beta']);
  await f.nodes.get('cancel-edit').events.click();
  assert.equal(f.nodes.get('editor').hidden, true);
  await f.nodes.get('add').events.click();
  assert.equal(f.nodes.get('record-domain').value, '');
  assert.equal(f.nodes.get('record-domain').readOnly, false);
});

test('保存前验证域名、安全 URL、DR 和日期；无效输入不发送写消息', async () => {
  const f = fixture(type => type === 'sites' ? ['alpha'] : list());
  await f.app.start();
  for (const [id, value, message] of [['domain', 'https://directory.example/path', /域名/],
    ['url', 'data:text/html,unsafe', /提交地址/], ['url', 'https://' + 'user:secret' + '@directory.example/', /提交地址/],
    ['dr', '101', /DR/], ['dr', 'NaN', /DR/], ['dr-date', '2026-02-30', /日期/]]) {
    await f.nodes.get('add').events.click();
    f.nodes.get('record-domain').value = 'directory.example';
    f.nodes.get('record-url').value = 'https://directory.example/submit';
    if (id === 'dr-date') f.nodes.get('record-dr').value = '25';
    f.nodes.get(`record-${id}`).value = value;
    await f.nodes.get('record-form').events.submit({preventDefault() {}});
    assert.match(f.nodes.get('form-status').textContent, message);
  }
  assert.equal(f.messages.some(message => message.type === 'library:save'), false);
});

test('导出仅当前成功读取的筛选清单；加载/失败不能导出旧数据，不称完整备份', async () => {
  let response = list([platform()]);
  const f = fixture(type => type === 'sites' ? ['alpha'] : response, '?site=alpha');
  await f.app.start();
  f.nodes.get('search').value = 'directory';
  f.nodes.get('status').value = 'confirmed';
  await f.app.load();
  await f.nodes.get('export').events.click();
  const exported = f.app.downloaded;
  assert.equal(exported.scope, 'current_list');
  assert.equal(exported.site, 'alpha');
  assert.deepEqual(exported.filters, {q: 'directory', status: 'confirmed', scenario: ''});
  assert.deepEqual(exported.items, response.items);
  assert.equal(exported.count, 1);
  assert.ok(exported.exported_at);
  assert.match(f.nodes.get('action-status').textContent, /当前清单/);
  assert.doesNotMatch(f.nodes.get('action-status').textContent, /完整备份|完整灾备/);
  f.app.downloaded = null;
  response = Promise.reject(Error('服务关闭')); await f.app.load();
  await f.nodes.get('export').events.click();
  assert.equal(f.app.downloaded, null);
});

test('返回另一产品的可复用结论必须拒绝，不可展示为当前产品可投', async () => {
  const f = fixture(type => type === 'sites' ? ['alpha', 'beta'] : list([platform()], 'beta'), '?site=alpha');
  await f.app.start();
  assert.match(f.nodes.get('notice').textContent, /目标产品不一致/);
  assert.equal(f.app.state.loaded, false);
  assert.equal(f.nodes.get('export').disabled, true);
  assert.doesNotMatch(f.nodes.get('results').textContent, /当前产品可复用/);
});

test('陈旧的 ready 若与当前产品结果未知历史冲突，展示为结果待核而非可复用', async () => {
  const f = fixture(type => type === 'sites' ? ['alpha'] : list([platform({history: [{site: 'alpha', status: 'unknown'}]})]), '?site=alpha');
  await f.app.start();
  assert.doesNotMatch(f.nodes.get('results').textContent, /当前产品可复用/);
  assert.match(f.nodes.get('results').textContent, /当前产品已投 \/ 结果待核/);
});

test('保存防双击；读回缺失不冒称成功，并保留人工输入', async () => {
  const pending = deferred();
  const f = fixture(type => type === 'sites' ? ['alpha'] : type === 'library:save' ? pending.promise : list());
  await f.app.start(); await f.nodes.get('add').events.click();
  f.nodes.get('record-domain').value = 'new.example';
  f.nodes.get('record-url').value = 'https://new.example/submit';
  f.nodes.get('record-note').value = '不能丢掉的人工备注';
  const first = f.nodes.get('record-form').events.submit({preventDefault() {}});
  await f.nodes.get('record-form').events.submit({preventDefault() {}});
  assert.equal(f.nodes.get('save').disabled, true);
  assert.equal(f.messages.filter(message => message.type === 'library:save').length, 1);
  pending.resolve({saved: true}); await first;
  assert.match(f.nodes.get('form-status').textContent, /尚未读回一致/);
  assert.doesNotMatch(f.nodes.get('form-status').textContent, /已保存并读回/);
  assert.equal(f.nodes.get('record-note').value, '不能丢掉的人工备注');
  assert.equal(f.nodes.get('editor').hidden, false);
});

test('产品列表失败后刷新重读；不把服务失败当作没有产品', async () => {
  let failed = true;
  const f = fixture(type => {
    if (type === 'sites') { if (failed) throw Error('产品服务不可达'); return ['alpha']; }
    return list();
  });
  await f.app.start();
  assert.match(f.nodes.get('notice').textContent, /产品服务不可达/);
  assert.equal(f.nodes.get('results').getAttribute('aria-busy'), 'false');
  failed = false; await f.nodes.get('reload').events.click();
  assert.equal(f.app.state.sitesReady, true);
  assert.equal(f.messages.filter(message => message.type === 'sites').length, 2);
  assert.equal(f.nodes.get('notice').hidden, true);
});

test('浏览器入口解包 chrome.runtime 的 value/error；后台错误原文可读', async () => {
  const f = fixture(() => list());
  const sandbox = {document: {querySelector: selector => f.nodes.get(selector.slice(1)), createElement: tag => new Node(tag)},
    chrome: {runtime: {sendMessage: async () => ({error: '后台：请先配置本机服务'})}},
    BKIcon: {hydrate() {}}, location: {search: ''}, URL, URLSearchParams, Blob, setTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'library.js'), 'utf8'), sandbox);
  await settled();
  assert.match(f.nodes.get('notice').textContent, /后台：请先配置本机服务/);
  sandbox.chrome.runtime.sendMessage = async message => ({value: message.type === 'sites' ? ['alpha'] : list()});
  await f.nodes.get('reload').events.click();
  assert.equal(f.nodes.get('notice').hidden, true);
  assert.match(f.nodes.get('results').textContent, /还没有平台记录/);
});

test('页面沿用品牌与共享控件，无内联脚本/事件和虚构硬编码业务总数', () => {
  const f = fixture(() => list());
  for (const asset of ['vendor/fbl/brand.css', 'ui/app.css', 'ui/icons.js', 'icons/icon-48.png', 'library.js']) assert.ok(f.html.includes(asset));
  assert.ok(!/<script(?![^>]*src=)[^>]*>/.test(f.html));
  assert.ok(!/\son(?:click|submit|change)=/.test(f.html));
  assert.ok(!/innerHTML/.test(fs.readFileSync(path.join(root, 'library.js'), 'utf8')));
  assert.ok(!/\b432\b|\b109\b/.test(f.html + fs.readFileSync(path.join(root, 'library.js'), 'utf8')));
});

test('适配区域不渲染 null 文本；没有产品也可记录平台且不猜测适配', async () => {
  for (const sites of [['alpha'], []]) {
    const f = fixture(type => type === 'sites' ? sites : list());
    await f.app.start(); await f.nodes.get('add').events.click();
    assert.doesNotMatch(f.nodes.get('fit-options').textContent, /null/);
    if (!sites.length) assert.match(f.nodes.get('fit-options').textContent, /尚无产品/);
  }
});
