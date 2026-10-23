const {test} = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/text.js');
global.BKText = T;
// 快照只读 DOM 的值；测试里用假元素代替。
global.BKFields = {read: (element, field) => (field.sensitive ? undefined : element.__value)};
const S = require('../lib/snapshot.js');

const element = (attrs = {}) => ({name: '', id: '', tagName: 'INPUT', value: '', checked: false, parentElement: null, __value: '', ...attrs});
const entry = (field, node) => ({element: node || element(), field: {index: 0, inputType: 'text', widget: 'text', label: '', ...field}});

test('指纹随字段结构变化，忽略值的改动', () => {
  const a = S.fingerprintFields([{label: 'Product name', inputType: 'text', widget: 'text', name: 'pname'}]);
  const b = S.fingerprintFields([{label: 'Product name', inputType: 'text', widget: 'text', name: 'pname'}]);
  const c = S.fingerprintFields([{label: 'Other', inputType: 'text', widget: 'text', name: 'pname'}]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('采集：敏感与验证码字段只记“跳过”，不记值；文件记 asset_id', () => {
  const password = element({__value: 'SECRET', name: 'pwd'});
  const captcha = element({__value: '1234', name: 'code'});
  const name = element({__value: 'ProbeKits', name: 'pname', id: 'pname'});
  const logo = element({name: 'logo', type: 'file'});
  const fileEntry = entry({label: 'Logo', inputType: 'file', widget: 'file', index: 3}, logo);
  const entries = [
    entry({label: 'Password', sensitive: 'password', inputType: 'password', name: 'pwd'}, password),
    entry({label: '验证码', captcha: 'label', name: 'code'}, captcha),
    entry({label: 'Product name', key: 'name', name: 'pname', id: 'pname'}, name),
    fileEntry,
  ];
  const snapshot = S.capture({entries, site: 'probekits', source_domain: 'seesaw.website', url: 'https://seesaw.website/submit#x',
    stepIndex: 0, by: 'extension', assetIds: {3: '1'}});
  const fields = snapshot.steps[0].fields;
  assert.equal(fields[0].skipped, 'sensitive');
  assert.equal(fields[0].value, undefined);
  assert.equal(fields[1].skipped, 'captcha');
  assert.equal(fields[2].value, 'ProbeKits');
  assert.equal(fields[2].locator.name, 'pname');
  assert.equal(fields[3].asset_id, '1');
  assert.equal(snapshot.url, 'https://seesaw.website/submit');
  assert.equal(snapshot.form_fingerprint.length, 8);
});

test('复原打分：多重标识相加，序号和路径单独不足', () => {
  const record = {locator: {name: 'pname', id: 'pname', label: 'Product name', autocomplete: '', inputType: 'text', widget: 'text', index: 2, path: ''}};
  const same = S.score(record, entry({label: 'Product name', index: 2}, element({name: 'pname', id: 'pname'})));
  assert.ok(same >= 100, String(same));
  const onlyIndex = S.score(record, entry({label: '别的字段', index: 2}, element()));
  assert.ok(onlyIndex < S.THRESHOLD, String(onlyIndex));
  const labelOnly = S.score(record, entry({label: 'Product name', index: 9}, element()));
  assert.ok(labelOnly >= S.THRESHOLD);
});

test('复原计划：命中、找不到、冲突三类分开，人工新值不被覆盖', () => {
  const snapshot = {steps: [{fields: [
    {locator: {name: 'pname', label: 'Product name'}, label: 'Product name', key: 'name', value: 'ProbeKits'},
    {locator: {name: 'gone', label: '老字段'}, label: '老字段', key: 'old', value: 'x'},
    {locator: {name: 'pdesc', label: 'Description'}, label: 'Description', key: 'description', value: '快照值'},
  ]}], step_index: 0};
  const entries = [
    entry({label: 'Product name', index: 0}, element({name: 'pname', __value: ''})),
    entry({label: 'Description', index: 1}, element({name: 'pdesc', __value: '人工新值'})),
  ];
  const planned = S.plan(snapshot, entries);
  assert.equal(planned.matched.length, 1);
  assert.equal(planned.matched[0].value, 'ProbeKits');
  assert.equal(planned.missing.length, 1);
  assert.equal(planned.conflicts.length, 1);
  assert.equal(planned.conflicts[0].existing, '人工新值');
});

test('diff 标出相同/不同/新增/页面无此字段', () => {
  const snapshot = {steps: [{fields: [
    {label: 'Product name', value: 'ProbeKits'},
    {label: 'Tagline', value: '老标语'},
  ]}], step_index: 0};
  const entries = [
    entry({label: 'Product name'}, element({__value: 'ProbeKits'})),
    entry({label: 'Tagline'}, element({__value: '新标语'})),
    entry({label: 'Website', }, element({__value: 'https://probekits.com/'})),
  ];
  const rows = S.diff(entries, snapshot);
  const byLabel = Object.fromEntries(rows.map(row => [row.label, row.state]));
  assert.equal(byLabel['Product name'], 'same');
  assert.equal(byLabel.Tagline, 'changed');
  assert.equal(byLabel.Website, 'new');
  assert.equal(rows.length, 3);
});

test('蜜罐字段不进快照（无名无值的隐形字段除外）', () => {
  const entries = [
    entry({label: 'hp', honeypot: 'suspicious_name'}, element({name: 'hp'})),
    entry({label: 'Product name'}, element({name: 'pname', __value: 'ProbeKits'})),
  ];
  const snapshot = S.capture({entries, site: 'x', source_domain: 'y', url: 'https://y/', stepIndex: 0});
  assert.equal(snapshot.steps[0].fields.length, 1);
  assert.equal(snapshot.steps[0].fields[0].label, 'Product name');
});

test('存档复原遇同分字段歧义、敏感字段或类型不一致时不写', () => {
  const snapshot = {step_index: 0, steps: [{fields: [{label: 'Product name', value: 'Saved',
    locator: {label: 'Product name', inputType: 'text', widget: 'text'}}]}]};
  const ambiguous = S.plan(snapshot, [entry({label: 'Product name'}), entry({label: 'Product name'})]);
  assert.equal(ambiguous.matched.length, 0);
  assert.equal(ambiguous.missing.length, 1);
  for (const field of [{sensitive: 'password'}, {captcha: 'inline'}, {inputType: 'password'}]) {
    assert.equal(S.plan(snapshot, [entry({label: 'Product name', ...field})]).matched.length, 0);
  }
});

test('单选组存档保留实际选项，而不是只保存代表组的第一个radio状态', () => {
  const snapshot = S.capture({entries: [entry({label: 'Pricing model', inputType: 'radio', widget: 'radio'},
    element({checked: false, __value: 'Free'}))], site: 'x', url: 'https://x/'});
  assert.equal(snapshot.steps[0].fields[0].value, 'Free');
  assert.equal(snapshot.steps[0].fields[0].checked, undefined);
});

test('文件快照保存稳定素材ID与内容摘要，不保存会重排的数组序号', () => {
  const snapshot = S.capture({entries: [entry({label: 'Logo', inputType: 'file', index: 0})],
    site: 'x', url: 'https://x/', assetIds: {0: {id: 'logo-512', sha256: 'a'.repeat(64)}}});
  assert.equal(snapshot.steps[0].fields[0].asset_id, 'logo-512');
  assert.equal(snapshot.steps[0].fields[0].asset_sha256, 'a'.repeat(64));
});

test('普通快照按定位元数据排除授权；旧快照和动态换绑目标也不能恢复勾选', () => {
  const consent = entry({label:'Confirm',inputType:'checkbox'},element({name:'agree_terms',id:'consent',checked:true}));
  const snapshot = S.capture({entries:[consent],site:'x',url:'https://x/'});
  assert.equal(snapshot.steps[0].fields[0].skipped,'sensitive');
  assert.equal(snapshot.steps[0].fields[0].checked,undefined);
  const legacy = {steps:[{fields:[{label:'Confirm',inputType:'checkbox',checked:true,value:true,
    locator:{name:'agree_terms',id:'consent',inputType:'checkbox',label:'Confirm'}}]}]};
  assert.equal(S.plan(legacy,[{...consent,element:element({name:'agree_terms',id:'consent'})}]).matched.length,0);
  assert.deepEqual(S.diff([consent], legacy), []);
  const oldSafe = {steps:[{fields:[{label:'Confirm',inputType:'checkbox',value:true,checked:true,
    locator:{name:'safe',inputType:'checkbox',label:'Confirm'}}]}]};
  assert.equal(S.plan(oldSafe,[entry({label:'Confirm',inputType:'checkbox'},element({name:'safe',id:'agree_terms'}))]).matched.length,0);
});
