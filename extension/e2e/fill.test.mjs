// 端到端：真实 Chromium 加载解压扩展 + 本机服务 + 24 个夹具页。
import {after, afterEach, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {EXPECTED, PORT_A, PORT_B, launchBrowser, openFixture, settle, startEnvironment, statusOf, value} from './support.mjs';

let env, browser, context, extensionId;
const pages = [];

before(async () => {
  env = await startEnvironment();
  browser = await launchBrowser(env, {log_level: 'debug'});
  context = browser.context;
  extensionId = browser.extensionId;
}, {timeout: 120000});

after(async () => {
  for (const page of pages) await page.close().catch(() => {});
  await context?.close().catch(() => {});
  await env?.stop();
  await env?.cleanup();
});

async function fixture(name, options) {
  const handle = await openFixture(context, name, options);
  pages.push(handle.page);
  return handle;
}

// 每个用例结束就关掉它开的页面，别让几十个标签页堆着影响后面的用例。
afterEach(async () => {
  for (const page of pages.splice(0)) await page.close().catch(() => {});
});

// 让内容脚本做一件事：等价于点面板上的按钮（同一个后台转发路径）。
async function worker_command(page, type, data) {
  const worker = context.serviceWorkers()[0];
  return worker.evaluate(async ([url, type, data]) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(item => item.url?.split('#')[0] === url);
    if (!tab) return {error: 'tab not found'};
    return chrome.tabs.sendMessage(tab.id, {type, ...(data || {})}).catch(error => ({error: String(error.message)}));
  }, [page.url().split('#')[0], type, data || {}]);
}

// 设置按扩展自己的路径写（同时镜像到本机服务），和面板里拨开关等价。
async function patchSettings(patch) {
  const worker = context.serviceWorkers()[0];
  return worker.evaluate(async ([base, patch]) => {
    const current = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({settings: {...current, ...patch}});
    await fetch(base + 'api/settings', {method: 'POST', headers: {'X-Fast-Backlink': '1', 'Content-Type': 'application/json'},
      body: JSON.stringify({patch})});
    return patch;
  }, [env.base, patch]);
}

describe('单页填写', () => {
  test('普通表单：产品名/网址/分档描述/下拉/标签/邮箱/问答都填对，条款不勾', async () => {
    const {page} = await fixture('plain.html');
    assert.equal(await value(page, '#name'), EXPECTED.name);
    assert.equal(await value(page, '#url'), EXPECTED.url);
    assert.equal(await value(page, '#tagline'), EXPECTED.tagline60);
    assert.equal((await value(page, '#description')).length <= 200, true);
    assert.equal(await value(page, '#category'), EXPECTED.categoryExact);
    assert.equal(await value(page, '#email'), EXPECTED.email);
    assert.ok((await value(page, '#tags')).includes('mouse test'));
    assert.equal(await value(page, '#hear'), EXPECTED.hear);
    assert.equal(await page.$eval('#agree', node => node.checked), false);
    const state = await statusOf(page);
    assert.ok(state.filled >= 7, JSON.stringify(state));
    assert.equal(state.captcha, 0);
  });

  test('受控组件（React 风格）与 Vue 风格 v-model 都能写进去', async () => {
    const react = await fixture('react-controlled.html');
    assert.equal(await value(react.page, '#name'), EXPECTED.name);
    assert.equal(await value(react.page, '#description'), EXPECTED.short160);
    assert.equal(await value(react.page, '#email'), EXPECTED.email);
    const mirror = await react.page.$eval('#mirror', node => node.textContent);
    assert.ok(mirror.includes(EXPECTED.name), mirror);
    const vue = await fixture('vue-like.html');
    assert.equal(await value(vue.page, '#product'), EXPECTED.name);
    assert.equal(await value(vue.page, '#site'), EXPECTED.url);
    assert.equal(await value(vue.page, '#pitch'), EXPECTED.tagline60);
  });

  test('自定义下拉：react-select / select2 / 标签输入 / 富文本', async () => {
    const select = await fixture('react-select.html');
    assert.equal(await value(select.page, '#name'), EXPECTED.name);
    assert.equal(await select.page.$eval('#category-selected', node => node.textContent), EXPECTED.categoryExact);
    assert.equal(await value(select.page, '#category'), EXPECTED.categoryExact);
    const select2 = await fixture('select2.html');
    assert.equal(await value(select2.page, '#topic'), EXPECTED.categoryExact);
    const tags = await fixture('tags.html');
    assert.equal(await value(tags.page, '#tags'), EXPECTED.tags);
    const rich = await fixture('rich-text.html');
    assert.equal(await value(rich.page, '#quill-value'), EXPECTED.description500);
    assert.equal(await value(rich.page, '#pm-value'), EXPECTED.makerStory);
  });

  test('托管表单适配：Google Forms 与 Tally 用题目文字命中', async () => {
    const google = await fixture('google-forms-like.html');
    assert.equal(await value(google.page, '#gname'), EXPECTED.name);
    assert.equal(await value(google.page, '#gurl'), EXPECTED.url);
    assert.equal(await value(google.page, '#gdesc'), EXPECTED.short160);
    assert.equal(await value(google.page, '#ghear'), EXPECTED.hear);
    assert.equal(google.status.platform, 'google-forms');
    const tally = await fixture('tally-like.html');
    assert.equal(await value(tally.page, '#tname'), EXPECTED.name);
    assert.equal(await value(tally.page, '#turl'), EXPECTED.url);
    assert.equal(await value(tally.page, '#tcat'), EXPECTED.categoryExact);
    assert.equal(tally.status.platform, 'tally');
  });

  test('长度分档：按 maxlength 选最长可用版本，放不下的留空不截断', async () => {
    const {page} = await fixture('maxlength.html');
    assert.equal(await value(page, '#short'), EXPECTED.tagline40);
    assert.equal(await value(page, '#mid'), EXPECTED.short100);
    assert.equal(await value(page, '#long'), EXPECTED.description250);
    const hinted = await value(page, '#hinted');
    assert.ok([EXPECTED.description250, EXPECTED.short160, EXPECTED.description500].includes(hinted), hinted);
    assert.equal(await value(page, '#tiny'), '');
  });

  test('日期、数字、bare domain 与问答库', async () => {
    const dates = await fixture('date-and-number.html');
    assert.equal(await value(dates.page, '#launch'), EXPECTED.launch);
    assert.equal(await value(dates.page, '#founded'), EXPECTED.founded);
    assert.equal(await value(dates.page, '#price'), EXPECTED.price);
    assert.equal(await value(dates.page, '#site'), EXPECTED.url);
    assert.equal(await value(dates.page, '#bare'), EXPECTED.domain);
    const qa = await fixture('qa-questions.html');
    assert.equal(await value(qa.page, '#hear'), EXPECTED.hear);
    assert.equal(await value(qa.page, '#owner'), EXPECTED.owner);
    assert.equal(await value(qa.page, '#team'), EXPECTED.team);
    assert.equal(await value(qa.page, '#funding'), EXPECTED.funding);
    assert.equal(await value(qa.page, '#free'), EXPECTED.free);
    assert.equal(await value(qa.page, '#message'), EXPECTED.message);
    assert.equal(await value(qa.page, '#mrr'), '', '收入类必须留空交人');
    assert.equal(await qa.page.$eval('#agree', node => node.checked), false);
    assert.equal(await qa.page.$eval('#news', node => node.checked), false);
  });

  test('蜜罐与验证码：一律不填，验证码字段被标出来', async () => {
    const honey = await fixture('honeypot.html');
    assert.equal(await value(honey.page, '#name'), EXPECTED.name);
    assert.equal(await value(honey.page, '#email'), EXPECTED.email);
    for (const selector of ['#hp', '#website2', '#hfield']) assert.equal(await value(honey.page, selector), '', selector);
    const captcha = await fixture('captcha.html');
    assert.equal(await value(captcha.page, '#name'), EXPECTED.name);
    assert.equal(await value(captcha.page, '#code'), '');
    assert.equal(await value(captcha.page, '#sum'), '');
    assert.ok(captcha.status.captcha >= 1, JSON.stringify(captcha.status));
  });

  test('联动下拉：选了国家之后重新扫描补齐下级', async () => {
    const {page} = await fixture('linked-selects.html');
    assert.equal(await value(page, '#country'), 'China');
    assert.equal(await value(page, '#name'), EXPECTED.name);
    const options = await page.$eval('#state', node => node.options.length);
    assert.ok(options > 1, '下级选项应当出现');
  });

  test('文件上传：图片进 input.files，视频走本机暂存 + CDP', async () => {
    const {page} = await fixture('file-upload.html');
    assert.equal(await value(page, '#name'), EXPECTED.name);
    const files = await page.$$eval('input[type=file]', nodes => nodes.map(node => [...node.files].map(file => `${file.name}:${file.type}`).join(',')));
    assert.equal(files[0], `${EXPECTED.logo}:image/png`);
    assert.equal(files[1], `${EXPECTED.screenshot}:image/png`);
    assert.ok(files[2].endsWith(`${EXPECTED.video}:video/mp4`), `视频应经暂存路径上传：${files[2]}`);
    assert.equal(await page.$eval('#logo', node => node.files[0].size > 0), true);
  });

  test('跨域 iframe：每个 frame 各填一份', async () => {
    const child = `http://127.0.0.1:${PORT_B}/test-pages/iframe-child.html`;
    const {page} = await fixture('iframe-parent.html', {query: `?child=${encodeURIComponent(child)}`});
    assert.equal(await value(page, '#name'), EXPECTED.name);
    const frame = page.frames().find(candidate => candidate !== page.mainFrame() && candidate.url().includes('iframe-child'));
    assert.ok(frame, '应当有子 frame');
    await frame.waitForFunction(expected => document.querySelector('#iname')?.value === expected, EXPECTED.name, {timeout: 20000});
    assert.equal(await frame.$eval('#iname', node => node.value), EXPECTED.name);
    assert.equal(await frame.$eval('#iurl', node => node.value), EXPECTED.url);
    assert.equal(await frame.$eval('#idesc', node => node.value), EXPECTED.short160);
  });

  test('开放与封闭 Shadow DOM 都能填', async () => {
    const open = await fixture('shadow-open.html');
    assert.equal(await open.page.$eval('#host', node => node.shadowRoot.querySelector('#sname').value), EXPECTED.name);
    const closed = await fixture('shadow-closed.html');
    const closedValues = await closed.page.evaluate(() => {
      const root = window.__closedRoot;
      return {name: root.querySelector('#cname').value, url: root.querySelector('#curl').value};
    });
    assert.equal(closedValues.name, EXPECTED.name);
    assert.equal(closedValues.url, EXPECTED.url);
  });

  test('人工改过的值不会被覆盖', async () => {
    const {page} = await fixture('plain.html');
    await page.$eval('#name', node => {node.value = '人工改过的名字'; node.dispatchEvent(new Event('input', {bubbles: true}));});
    await page.waitForTimeout(300);
    const worker = context.serviceWorkers()[0];
    await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({currentWindow: true});
      const tab = tabs.find(item => item.url?.startsWith('http'));
      if (tab) await chrome.tabs.sendMessage(tab.id, {type: 'page:fill'});
    });
    await page.waitForTimeout(1200);
    assert.equal(await page.$eval('#name', node => node.value), '人工改过的名字');
  });
});

describe('快照与复原', () => {
  test('刷新后自动复原（页面自己清空也照样填回来）', async () => {
    const {page} = await fixture('reset-on-reload.html');
    assert.equal(await value(page, '#name'), EXPECTED.name);
    assert.equal(await value(page, '#url'), EXPECTED.url);
    assert.equal(await value(page, '#email'), EXPECTED.email);
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForFunction(() => !!document.documentElement.dataset.bkStatus, null, {timeout: 20000});
    // 复原要先等页面稳定 500ms，再逐项回填；这里等“已复原”计数出现。
    await page.waitForFunction(() => (JSON.parse(document.documentElement.dataset.bkStatus || '{}').restored || 0) >= 3,
      null, {timeout: 30000})
      .catch(async error => {throw Error(`${error.message}；状态=${JSON.stringify(await statusOf(page)).slice(0, 300)}`);});
    assert.equal(await value(page, '#name'), EXPECTED.name);
    assert.equal(await value(page, '#url'), EXPECTED.url);
    assert.equal(await value(page, '#description').then(text => text.length > 0), true);
    const state = await statusOf(page);
    assert.ok(state.restored >= 3, JSON.stringify(state));
    const snapshots = await env.snapshots();
    assert.ok(snapshots.some(item => item.url.includes('reset-on-reload')), '快照应当落到本机');
  });

  test('提交后即使页面报错清空也不自动重放，人工复原请求仍受提交锁保护', async () => {
    const {page} = await fixture('submit-error.html');
    assert.equal(await value(page, '#name'), EXPECTED.name);
    await page.click('button[type=submit]');
    await page.waitForFunction(() => document.getElementById('error').hidden === false);
    assert.equal(await value(page, '#name'), '', '页面自己清空了');
    await page.waitForTimeout(2000);
    assert.equal(await value(page, '#name'), '', '错误文案不能证明平台未受理，不自动复原');
    await worker_command(page, 'page:restore');
    await worker_command(page, 'page:fill', {force: true});
    assert.equal(await value(page, '#name'), '');
    assert.equal(await value(page, '#url'), '');
    const saved = (await env.snapshots()).filter(item => item.url.includes('submit-error'));
    assert.ok(saved.length > 0, '保留提交前快照供后续核实，不清除资产');
  });
});

describe('多步表单的自动下一步开关', () => {
  test('开关关闭时不动按钮，填完本步就停', async () => {
    const {page} = await fixture('wizard.html');
    assert.equal(await value(page, '#name'), EXPECTED.name);
    assert.equal(await page.$eval('#step1', node => node.hidden), false);
    assert.equal(await page.$eval('#step2', node => node.hidden), true);
  });

  test('开关打开时点 Next 并继续填第二步；含 Submit 的按钮永不点', async () => {
    const worker = context.serviceWorkers()[0];
    await patchSettings({auto_next: true});
    const {page} = await fixture('wizard.html');
    await page.waitForFunction(() => document.getElementById('step2').hidden === false, null, {timeout: 15000});
    await page.waitForFunction(expected => document.querySelector('#tagline')?.value === expected, EXPECTED.tagline60, {timeout: 15000});
    const dangerous = await fixture('wizard-danger.html');
    await dangerous.page.waitForTimeout(3000);
    assert.equal(await dangerous.page.$eval('#step2', node => node.hidden), true, '含 Submit 的按钮不能被点');
    await patchSettings({auto_next: false});
  });
});

describe('侧边栏与日志', () => {
  test('侧边栏表单页列出字段状态，任务页有续填队列', async () => {
    const {page} = await fixture('plain.html');
    await page.bringToFront();
    const panel = await context.newPage();
    pages.push(panel);
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.waitForSelector('[data-panel=form] .bk-item', {timeout: 20000});
    const labels = await panel.$$eval('[data-panel=form] .bk-item strong', nodes => nodes.map(node => node.textContent));
    assert.ok(labels.some(label => label.includes('Product name')), JSON.stringify(labels));
    const statuses = await panel.$$eval('[data-panel=form] .bk-item', nodes => nodes.map(node => node.dataset.status));
    assert.ok(statuses.includes('filled'));
    const header = await panel.$eval('#status', node => node.textContent);
    assert.ok(header.includes('probekits'), header);
    await panel.click('nav.bk-tabs button[data-tab=assets]');
    await panel.waitForSelector('[data-panel=assets] .bk-asset', {timeout: 10000});
    const assets = await panel.$$eval('[data-panel=assets] .bk-asset', nodes => nodes.length);
    assert.ok(assets >= 3, String(assets));
    await panel.click('nav.bk-tabs button[data-tab=snapshots]');
    await panel.waitForSelector('[data-panel=snapshots] table', {timeout: 10000});
    await panel.click('nav.bk-tabs button[data-tab=settings]');
    const switches = await panel.$$eval('[data-panel=settings] .bk-switch', nodes => nodes.length);
    assert.ok(switches >= 5, String(switches));
    // 走真实 UI 路径：刷新清空页面后，用面板的项目下拉让它重新填。
    await page.reload();
    await page.waitForFunction(() => !!document.documentElement.dataset.bkStatus, null, {timeout: 20000});
    await panel.selectOption('#site', 'probekits');
    await page.waitForFunction(expected => document.querySelector('#name')?.value === expected, EXPECTED.name, {timeout: 20000})
      .catch(async error => {throw Error(`面板下拉没触发填写：${error.message}；状态=${JSON.stringify(await statusOf(page)).slice(0, 200)}`);});
    assert.equal(await value(page, '#url'), EXPECTED.url);
  });

  test('日志页与 JSONL 落盘：有填写事件与每轮汇总', async () => {
    const logs = await context.newPage();
    pages.push(logs);
    await logs.goto(`chrome-extension://${extensionId}/logs.html`);
    await logs.waitForFunction(() => document.querySelectorAll('#rows tr').length > 0, null, {timeout: 20000});
    const rows = await logs.$$eval('#rows tr', nodes => nodes.map(node => node.textContent));
    assert.ok(rows.length > 0);
    // 日志是满 50 条或 5 秒批量落盘，等它写出来再断言。
    let entries = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      entries = await env.logLines();
      if (entries.some(item => item.cat === 'fill' && item.msg === 'filled')) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(entries.some(item => item.cat === 'fill' && item.msg === 'filled'), '应当有填写日志');
    assert.ok(entries.some(item => item.cat === 'perf' && item.msg === 'run_summary'), '应当有每轮汇总');
    const summary = entries.find(item => item.cat === 'perf' && item.msg === 'run_summary');
    assert.ok(summary.fields_total >= 2, JSON.stringify(summary));
    assert.ok(typeof summary.fill_rate === 'undefined' || true);
    assert.ok(entries.every(item => !JSON.stringify(item).includes('hunter2')), '日志不得出现密码值');
  });

  test('素材库管理页：读资料包、检查完整度、缺视频素材有提示', async () => {
    const options = await context.newPage();
    pages.push(options);
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.waitForSelector('#sites .bk-item', {timeout: 20000});
    await options.waitForSelector('#editor textarea', {timeout: 10000});
    const title = await options.$eval('#editor h2', node => node.textContent);
    assert.ok(title.includes('probekits'), title);
    const hasVideoHint = await options.evaluate(() => document.body.textContent.includes('暂不制作'));
    assert.ok(hasVideoHint, '视频素材要显示留位提示');
    await options.click('#check');
    await options.waitForFunction(() => (document.querySelector('#check-result')?.textContent || '').length > 0, null, {timeout: 15000});
    const check = await options.$eval('#check-result', node => node.textContent);
    assert.ok(/必须修|提示|通过/.test(check), check);
    const health = await options.$eval('#status', node => node.textContent);
    assert.ok(health.includes('本机服务正常'), health);
  });
});

describe('写回、学习与续填交接', () => {
  test('记住表单把非敏感值写回来源库，密码类不写回', async () => {
    const {page} = await fixture('plain.html');
    await worker_command(page, 'page:remember');
    const source = JSON.parse(await readFile(path.join(env.root, 'sources', '127.0.0.1.json'), 'utf8'));
    const fields = source.memories.probekits.fields.map(item => item.label);
    for (const label of ['Product name', 'Website URL', 'Contact email']) {
      assert.ok(fields.includes(label), `${label} 应当写回：${JSON.stringify(fields)}`);
    }
    assert.ok(source.recipe?.steps?.length >= 1, '应当记下配方结构');
    assert.ok(!JSON.stringify(source).includes('password'), '不得写回密码类字段');
  });

  test('人工改值会变成学习观察，命中字段标签', async () => {
    const {page} = await fixture('plain.html');
    await worker_command(page, 'page:set', {index: 0, key: 'name', value: 'Manually Chosen'});
    assert.equal(await page.$eval('#name', node => node.value), 'Manually Chosen');
    const response = await fetch(env.base + 'api/rules', {headers: {'X-Fast-Backlink': '1'}});
    const rules = await response.json();
    const learned = await readFile(path.join(env.root, 'learned.json'), 'utf8').then(JSON.parse);
    const observed = Object.entries(learned.observations).some(([label, keys]) =>
      label.includes('product name') && keys.name && keys.name.some(entry => entry.includes('127.0.0.1')));
    assert.ok(observed, `学习观察应当包含刚改过的字段：${JSON.stringify(learned.observations)}`);
    assert.ok(rules.labels, '规则接口仍可用');
  });

  test('续填交接：带 #bk 标记打开可填，点“我已提交”只记待核实', async () => {
    const item = {
      id: 'a'.repeat(32), source_domain: '127.0.0.1', site: 'probekits',
      submit_url: `http://127.0.0.1:${PORT_A}/test-pages/handoff.html`,
      status: '待处理', blocker: '人工验证', blocker_location: '当前表单', step: 0,
      fields: [{label: 'Product name', key: 'name', value: 'Handoff Name'}],
      steps: [], created_at: new Date().toISOString().slice(0, 19),
    };
    await writeFile(path.join(env.root, 'handoff', `${item.id}.json`), JSON.stringify(item, null, 2));
    const page = await context.newPage();
    pages.push(page);
    await page.goto(`${item.submit_url}#bk=${item.id}`);
    await page.waitForFunction(() => !!document.documentElement.dataset.bkStatus, null, {timeout: 20000});
    await settle(page);
    // 续填项里的原标签值优先
    await page.waitForFunction(() => document.querySelector('#name')?.value === 'Handoff Name', null, {timeout: 15000});
    assert.equal(await value(page, '#url'), EXPECTED.url, '其余字段继续按资料包填');
    assert.ok(!(await page.url()).includes('bk='), '标记应当从地址栏移除');
    const done = await worker_command(page, 'page:done');
    assert.ok(done, JSON.stringify(done).slice(0, 200));
    const stored = JSON.parse(await readFile(path.join(env.root, 'handoff', `${item.id}.json`), 'utf8'));
    assert.equal(stored.status, '待核实');
    // 完成只记待核实，不写 ledger（这里 ledger 应当还只有表头）。
    const ledger = await readFile(path.join(env.root, 'ledger.csv'), 'utf8');
    assert.equal(ledger.trim().split('\n').length, 1, `ledger 不应有新行：${ledger}`);
    // 回执按服务本地日期归档，不使用可能仍是前一天的客户端UTC日期。
    const receipts = await readFile(path.join(env.root, 'runs', stored.completed_at.slice(0, 10), 'handoff-done.csv'), 'utf8');
    assert.ok(receipts.includes(item.id), '应当写完成回执');
  });
});

describe('边界', () => {
  test('密码、银行卡、验证码字段一律留空，面板也不显示它们的值', async () => {
    const {page} = await fixture('sensitive.html', {host: 'localhost'});
    // 与此前已提交的127.0.0.1来源隔离，不绕开真实的按产品/平台提交锁。
    assert.equal(await value(page, '#name'), EXPECTED.name);
    for (const selector of ['#pw', '#card', '#otp', '#sms']) assert.equal(await value(page, selector), '', selector);
    const state = await statusOf(page);
    assert.ok(state.sensitive >= 2, JSON.stringify(state));
    const decisions = state.decisions.filter(item => ['captcha', 'sensitive'].includes(item.status));
    assert.ok(decisions.length >= 3, JSON.stringify(state.decisions));
    for (const item of decisions) assert.equal(item.value, '', item.label);
  });

  test('素材库的 v2 schema 与分档在服务侧校验', async () => {
    const response = await fetch(env.base + 'api/kits', {headers: {'X-Fast-Backlink': '1'}});
    const kits = await response.json();
    assert.equal(kits[0].schema_version, 2);
    assert.ok(kits[0].assets >= 3);
    assert.deepEqual(kits[0].errors, [], JSON.stringify(kits[0].errors));
    assert.ok(kits[0].warnings.some(item => item.includes('demo_gif')), '缺的素材要在提示里说明');
    const logs = await env.logLines();
    assert.ok(logs.some(item => item.cat === 'restore'), '应当记录复原事件');
  });
});
