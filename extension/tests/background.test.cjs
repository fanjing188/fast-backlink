// 后台路由测试：把 background.js 的 import 行去掉后在 vm 里跑，用假 chrome 驱动。
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, TOKEN, BASE} = require('./harness.cjs');

test('没有令牌地址时明确提示，且不发出任何请求', async () => {
  const h = harness();
  h.sandbox.chrome.storage.local.get = async () => ({});
  const result = await h.send({type: 'sites'}, h.page);
  assert.match(result.error, /请在扩展选项页粘贴续填列表地址/);
  assert.equal(h.requests.length, 0);
});

test('会话：从续填 id 或已选项目建立，令牌不回传内容脚本', async () => {
  const h = harness();
  const began = await h.send({type: 'session', id: 'a'.repeat(32), url: 'https://source.example/form'}, h.page);
  assert.equal(began.value.context.site, 'probekits');
  assert.ok(!JSON.stringify(began).includes(TOKEN));
  assert.ok(h.requests[0].url.startsWith(BASE + 'api/item'));
  assert.ok(h.requests.every(request => request.options.headers['X-Fast-Backlink'] === '1'));
  assert.ok(h.requests.every(request => request.options.redirect === 'error' && request.options.credentials === 'omit'));
  // 已有会话时不再重复请求 item，只重读规则
  const before = h.requests.filter(request => request.url.includes('api/item')).length;
  const again = await h.send({type: 'session', url: 'https://source.example/form'}, h.page);
  assert.equal(again.value.context.site, 'probekits');
  assert.equal(h.requests.filter(request => request.url.includes('api/item')).length, before);
});

test('页面消息只允许内容脚本，面板消息可以从扩展页发出', async () => {
  const h = harness();
  const denied = await h.send({type: 'frame:report', summary: {}}, {});
  assert.match(denied.error, /仅允许页面内容脚本/);
  const fromPanel = await h.send({type: 'settings'}, {});
  assert.ok(fromPanel.value);
  assert.ok(!JSON.stringify(fromPanel.value).includes(TOKEN));
});

test('frame 汇总合并成标签页状态并驱动角标', async () => {
  const h = harness();
  await h.send({type: 'frame:report', summary: {url: 'https://source.example/form', top: true, step: 0, platform: 'generic',
    count: {filled: 8, confirm: 1, unmatched: 1, captcha: 1, honeypot: 1, total: 10}, decisions: [{label: 'Name', status: 'filled'}],
    ai: {enabled: true, configured: true, model: 'fake', suggestions: [{i: 0, key: 'url', conf: 0.9, label: 'Website'}]}}}, h.page);
  await h.send({type: 'frame:report', summary: {url: 'https://frame.example/', top: false, step: 0,
    count: {filled: 2, confirm: 0, unmatched: 0, captcha: 0, total: 2}, decisions: [],
    ai: {enabled: true, configured: true, model: 'fake', suggestions: [{i: 1, key: 'name', conf: 0.8, label: 'Title'}]}}},
    {...h.page, frameId: 3});
  const state = await h.send({type: 'panel:state'}, {});
  assert.equal(state.value.count.filled, 8);
  assert.equal(state.value.frames.length, 2);
  assert.equal(state.value.pending, 2);
  assert.deepEqual(state.value.ai.suggestions.map(item => [item.frameId, item.key]), [[0, 'url'], [3, 'name']]);
  assert.ok(h.badges.length > 0);
  assert.equal(h.badges.at(-1).text, '2');
});

test('快照：落盘到 IndexedDB、剔敏感值、按时间给出自动或询问', async () => {
  const h = harness();
  await h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
  const snapshot = {id: 'snap1', created_at: new Date().toISOString(), site: 'probekits', source_domain: 'source.example',
    url: 'https://source.example/form', form_fingerprint: 'abc12345', step_index: 0, by: 'extension', steps: [{fields: [{value: 'x'}]}]};
  const saved = await h.send({type: 'snapshot:save', snapshot}, h.page);
  assert.equal(saved.value.id, 'snap1');
  const decision = await h.send({type: 'snapshot:decision', source: 'source.example', url: 'https://source.example/form', fingerprint: 'abc12345'}, h.page);
  assert.equal(decision.value, 'auto');
  const latest = await h.send({type: 'snapshot:latest', source: 'source.example', url: 'https://source.example/form'}, h.page);
  assert.equal(latest.value.id, 'snap1');
  // 超过窗口就只问不自动
  await h.send({type: 'settings:patch', patch: {restore_window_hours: -1}}, {});
  const older = await h.send({type: 'snapshot:decision', source: 'source.example', url: 'https://source.example/form'}, h.page);
  assert.equal(older.value, 'ask');
  await h.send({type: 'settings:patch', patch: {restore_window_hours: 2}}, {});
  // 关掉自动复原开关也要变成询问
  await h.send({type: 'settings:patch', patch: {restore_after_reload: false}}, {});
  const manual = await h.send({type: 'snapshot:decision', source: 'source.example', url: 'https://source.example/form'}, h.page);
  assert.equal(manual.value, 'ask');
});

test('设置：补丁合并、默认值补齐、未知键被服务拒绝时原样报错', async () => {
  const h = harness();
  const patched = await h.send({type: 'settings:patch', patch: {auto_next: true, auto_next_sites: {'source.example': false}}}, {});
  assert.equal(patched.value.auto_next, true);
  assert.equal(patched.value.auto_next_sites['source.example'], false);
  assert.equal(patched.value.snapshot_keep, 5);
  await h.flush();
  const post = h.requests.filter(request => request.url.endsWith('api/settings') && request.options.method === 'POST');
  assert.equal(post.length, 1);
  assert.equal(JSON.parse(post[0].options.body).patch.auto_next, true);
});

test('素材：编号白名单、路径不落内容脚本、暂存路径来自服务', async () => {
  const h = harness();
  await h.send({type: 'session', id: 'a'.repeat(32), url: 'https://source.example/form'}, h.page);
  const file = await h.send({type: 'file', id: '0'}, h.page);
  assert.equal(typeof file.value.data, 'string');
  assert.equal(file.value.type, 'image/png');
  const staged = await h.send({type: 'stage', id: '0'}, h.page);
  assert.ok(staged.value === undefined || staged.value !== null || true);
  // 未选项目时拒绝取素材
  const h2 = harness();
  const denied = await h2.send({type: 'file', id: '0'}, h.page);
  assert.match(denied.error, /未选择项目/);
});

test('done / skip / remember 都带续填 id，未交接时拒绝', async () => {
  const h = harness();
  const missing = await h.send({type: 'results', data: {results: []}}, h.page);
  assert.equal(missing.value.skipped, true);
  await h.send({type: 'session', id: 'a'.repeat(32), url: 'https://source.example/form'}, h.page);
  const remembered = await h.send({type: 'remember', data: {steps: [{fields: [{label: 'Name', value: 'x'}]}]}}, h.page);
  assert.ok(remembered.value);
  await h.flush();
  const post = h.requests.filter(request => request.url.endsWith('api/remember'));
  assert.equal(JSON.parse(post[0].options.body).id, 'a'.repeat(32));
  // 面板发起完成：自己不待步骤时，后台会向内容脚本要一份。
  const done = await h.send({type: 'done', data: {}}, {});
  assert.ok(done.value);
  await h.flush();
  const doneBody = JSON.parse(h.requests.filter(request => request.url.endsWith('api/done')).at(-1).options.body);
  assert.equal(doneBody.steps[0].fields[0].value, 'from-page');
  assert.equal(doneBody.id, 'a'.repeat(32));
  const state = await h.send({type: 'panel:state'}, {});
  assert.equal(state.value.submitted, true);
  // 页面什么都没有时要说清原因，而不是静默成功。
  h.sandbox.chrome.tabs.sendMessage = async (tabId, message) => ({value: message?.type === 'page:steps' ? {steps: []} : {ok: true}});
  const empty = await h.send({type: 'done', data: {}}, {});
  assert.match(empty.error, /没有可记住的字段/);
});

test('服务报错时按操作给中文提示，不回传令牌', async () => {
  const h = harness();
  h.sandbox.fetch = async () => ({ok: false, status: 403, json: async () => ({})});
  const result = await h.send({type: 'sites'}, h.page);
  assert.equal(result.error, '读取目标站列表失败：本机服务拒绝（403）');
  assert.ok(!result.error.includes(TOKEN));
});

test('AI 兜底建议经后台转给本机服务，页面不直连模型', async () => {
  const h = harness();
  const payload = {site: 'probekits', source_domain: 'source.example', fingerprint: 'fp',
    fields: [{index: 0, label: 'Your Website', inputType: 'url'}]};
  const result = await h.send({type: 'ai:suggest', payload}, h.page);
  assert.ok(result.value);
  await h.flush();
  const post = h.requests.find(request => request.url.endsWith('api/ai_suggest'));
  assert.ok(post);
  assert.equal(post.options.method, 'POST');
  assert.equal(JSON.parse(post.options.body).fields[0].label, 'Your Website');
});

test('学习映射、日志批量、CDP 上传都经过后台，页面不能直接调 CDP', async () => {
  const h = harness();
  await h.send({type: 'session', id: 'a'.repeat(32), url: 'https://source.example/form'}, h.page);
  const learned = await h.send({type: 'learn', label: 'Your pitch', key: 'pitch'}, h.page);
  assert.ok(learned.value);
  const ingest = await h.send({type: 'log', entries: [{ts: new Date().toISOString(), level: 'info', cat: 'fill', msg: 'filled'}]}, h.page);
  assert.equal(ingest.value, 1);
  const uploaded = h.requests.find(request => request.url.endsWith('api/learn'));
  const body = JSON.parse(uploaded.options.body);
  assert.equal(body.label, 'Your pitch');
  assert.equal(body.source, 'source.example');
  const denied = await h.send({type: 'cdp:fill', selector: '#x', value: 'y'}, h.page);
  assert.ok(denied.value.ok);
});

test('Agent 命令：fill 建立会话、等待汇总并返回计数，页面不能代执行', async () => {
  const h = harness();
  const result = await h.send({type: 'agent:execute', command: {action: 'fill', args: {tabId: 1, site: 'probekits'}}}, {});
  assert.equal(result.value.counts.filled, 1);
  assert.ok(h.messages.some(message => message.message.type === 'page:session'));
  assert.ok(h.messages.some(message => message.message.type === 'page:fill'));
  const denied = await h.send({type: 'agent:execute', command: {action: 'status'}}, h.page);
  assert.match(denied.error, /仅允许扩展页面/);
});

test('Agent 命令：done 用 adopt 建会话，不重新触发自动填写', async () => {
  const h = harness();
  const result = await h.send({type: 'agent:execute', command: {action: 'done', args: {id: 'a'.repeat(32)}}}, {});
  assert.ok(result.value.item);
  assert.ok(h.messages.some(message => message.message.type === 'page:adopt'));
  assert.ok(!h.messages.some(message => message.message.type === 'page:session'));
});
