// 真实扩展交互回归；AI仅使用本机合成服务，不读取个人安装或真实资料。
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {EXPECTED, REPO, launchBrowser, openFixture, startEnvironment, value} from './support.mjs';

let env, browser, context;
before(async () => {
  env = await startEnvironment({ai: {auto_apply: false}});
  browser = await launchBrowser(env, {ai_fallback: false});
  context = browser.context;
}, {timeout: 120000});
after(async () => {
  await context?.close().catch(() => {});
  await env?.stop();
  await env?.cleanup();
});

async function panelFor(form) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
  await form.bringToFront();
  await panel.waitForFunction(() => document.querySelector('#site').options.length > 1);
  return panel;
}

test('已打开页面也沿用后来保存的项目，AI一次点击即填写，不再逐项确认', async () => {
  const {page} = await openFixture(context, 'ai-fallback.html', {activateSite: false});
  assert.equal(await value(page, '#site'), '');
  const chooser = await openFixture(context, 'plain.html', {activateSite: false});
  const panel = await panelFor(chooser.page);
  await panel.selectOption('#site', 'probekits');
  await panel.waitForFunction(() => document.querySelector('#toasts').textContent.includes('已保存默认项目'));
  await page.bringToFront();
  await panel.waitForFunction(url => state.tab?.url === url, page.url());
  await panel.getByRole('button', {name: 'AI 智能填充', exact: true}).click();
  await panel.waitForFunction(() => !state.aiLoading);
  await page.waitForFunction(() => document.querySelector('#site').value !== '' && document.querySelector('#pitch').value !== '', null, {timeout: 15000});
  assert.equal(await value(page, '#site'), EXPECTED.url);
  assert.equal(await value(page, '#pitch'), EXPECTED.tagline60);
  assert.equal(await value(page, '#password'), '');
  assert.equal(await page.$eval('input[type=checkbox]', node => node.checked), false);
  assert.equal(await value(page, '#mystery'), '');
  assert.ok(!await panel.locator('#toasts').innerText().then(text => text.includes('确认后填入')));
  await panel.close(); await page.close(); await chooser.page.close();
});

test('AI直接填写保留人工输入，提交锁生效后不请求AI也不重填', async () => {
  const {page} = await openFixture(context, 'ai-fallback.html', {query: '?manual-preserved=1'});
  await page.fill('#site', 'https://manual.example/');
  const panel = await panelFor(page);
  await panel.getByRole('button', {name: 'AI 智能填充', exact: true}).click();
  await panel.waitForFunction(() => !state.aiLoading);
  await page.waitForFunction(() => document.querySelector('#pitch').value !== '');
  assert.equal(await value(page, '#site'), 'https://manual.example/');
  await browser.worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    const saved = (await chrome.storage.session.get('tab:' + tab.id))['tab:' + tab.id];
    await chrome.tabs.sendMessage(tab.id, {type: 'page:adopt', context: saved.context, submitted: true}, {frameId: 0});
  }, page.url());
  await page.evaluate(() => {document.querySelector('#site').value = '';});
  const before = env.aiRequests.length;
  const result = await browser.worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    return chrome.tabs.sendMessage(tab.id, {type: 'page:ai', action: 'fill'}, {frameId: 0});
  }, page.url());
  assert.equal(result.value.blocked, true);
  assert.equal(await value(page, '#site'), '');
  assert.equal(env.aiRequests.length, before);
  await panel.close(); await page.close();
});

test('AI等待期间重挂载或变成密码框的字段保持空白，不按旧索引写入', async () => {
  for (const mode of ['replace', 'mutate']) {
    const {page} = await openFixture(context, 'ai-fallback.html', {query: '?changed=' + mode});
    await page.fill('#site', '');
    await page.fill('#pitch', '');
    const panel = await panelFor(page);
    let release, began;
    const delayed = new Promise(resolve => {release = resolve;});
    const started = new Promise(resolve => {began = resolve;});
    const endpoint = env.base + 'api/ai_suggest';
    const hold = async route => {
      const response = await route.fetch();
      began(); await delayed;
      await route.fulfill({response});
    };
    await context.route(endpoint, hold);
    try {
      await panel.getByRole('button', {name: 'AI 智能填充', exact: true}).click();
      await started;
      await page.evaluate(mode => {
        const original = document.querySelector('#site');
        if (mode === 'replace') {
          const password = document.createElement('input');
          password.id = 'site'; password.type = 'password';
          original.replaceWith(password);
        } else original.type = 'password';
        document.querySelector('label[for=site]').textContent = 'Password';
      }, mode);
      await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.bkStatus || '{}')
        .decisions?.some(item => item.index === 1 && (item.status === 'sensitive' || item.sensitive === 'password')));
      release();
      await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.bkStatus || '{}')
        .ai?.suggestions?.some(item => item.i === 1 && (item.reason || item.applied)));
      assert.equal(await value(page, '#site'), '', mode + '不得向密码框写入任何资料');
    } finally {
      release();
      await context.unroute(endpoint, hold);
      await panel.close(); await page.close();
    }
  }
});

test('AI控件点击后原位变成密码框时，适配器等待后也不得写入', async () => {
  const {page} = await openFixture(context, 'ai-fallback.html', {query: '?widget-password=1'});
  await page.fill('#site', '');
  await page.evaluate(() => {
    const input = document.querySelector('#site');
    const container = document.createElement('div');
    container.className = 'MuiAutocomplete-root';
    input.replaceWith(container); container.append(input);
    input.setAttribute('role', 'combobox');
    window.sensitiveWrites = [];
    input.addEventListener('click', () => {input.type = 'password';});
    input.addEventListener('input', () => {if (input.type === 'password') window.sensitiveWrites.push(input.value);});
  });
  await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.bkStatus || '{}')
    .decisions?.some(item => item.index === 1 && item.widget === 'mui-autocomplete'));
  const panel = await panelFor(page);
  await panel.getByRole('button', {name: 'AI 智能填充', exact: true}).click();
  await panel.waitForFunction(() => !state.aiLoading);
  assert.equal(await page.$eval('#site', input => input.type), 'password');
  assert.equal(await value(page, '#site'), '');
  assert.deepEqual(await page.evaluate(() => window.sensitiveWrites), []);
  await panel.close(); await page.close();
});

test('AI合法延迟下拉仍可选择，等待时的人工输入优先且不被覆盖', async () => {
  for (const mode of ['select', 'manual']) {
    const {page} = await openFixture(context, 'ai-fallback.html', {query: '?widget-mode=' + mode});
    await page.fill('#site', '');
    await page.evaluate(({mode, wanted}) => {
      const input = document.querySelector('#site');
      const container = document.createElement('div'); container.className = 'MuiAutocomplete-root';
      input.replaceWith(container); container.append(input);
      input.setAttribute('role', 'combobox'); input.setAttribute('aria-controls', 'safe-options');
      input.addEventListener('click', () => {
        window.menuRequested = true;
        setTimeout(() => {
          const list = document.createElement('div'); list.id = 'safe-options'; list.setAttribute('role', 'listbox');
          const option = document.createElement('button'); option.type = 'button'; option.textContent = wanted;
          option.setAttribute('role', 'option');
          option.addEventListener('mousedown', () => {
            input.value = wanted;
            const selected = document.createElement('span'); selected.className = 'selected-value'; selected.textContent = wanted;
            container.append(selected); list.remove();
          });
          list.append(option); document.body.append(list);
        }, mode === 'manual' ? 800 : 120);
      }, {once: true});
    }, {mode, wanted: EXPECTED.url});
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.bkStatus || '{}')
      .decisions?.some(item => item.index === 1 && item.widget === 'mui-autocomplete'));
    const panel = await panelFor(page);
    await panel.getByRole('button', {name: 'AI 智能填充', exact: true}).click();
    if (mode === 'manual') {
      await page.waitForFunction(() => window.menuRequested);
      await page.fill('#site', 'https://manual.example/');
    }
    await panel.waitForFunction(() => !state.aiLoading);
    assert.equal(await value(page, '#site'), mode === 'manual' ? 'https://manual.example/' : EXPECTED.url);
    await panel.close(); await page.close();
  }
});

test('字段原位变敏感后，读取和快照也不能使用旧描述泄漏值', async () => {
  const {page} = await openFixture(context, 'ai-fallback.html', {query: '?read-privacy=1'});
  await page.evaluate(() => {document.querySelector('#pitch').type = 'password';});
  await page.fill('#pitch', 'synthetic-private-value');
  const results = await browser.worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    const inspect = await chrome.tabs.sendMessage(tab.id, {type: 'page:inspect'}, {frameId: 0});
    const snapshot = await chrome.tabs.sendMessage(tab.id, {type: 'page:snapshot'}, {frameId: 0});
    return {inspect, snapshot};
  }, page.url());
  assert.ok(!JSON.stringify(results).includes('synthetic-private-value'));
  assert.equal(await value(page, '#pitch'), 'synthetic-private-value', '隐私读取不能清空用户输入');
  await page.close();
});

test('容器标签不能遮住动态敏感ARIA或完整名称，既不写也不读取', async () => {
  for (const mode of ['aria', 'description', 'placeholder', 'details', 'errormessage', 'title', 'name']) {
    const {page} = await openFixture(context, 'ai-fallback.html', {query: '?semantic-privacy=' + mode});
    await page.fill('#site', '');
    await page.evaluate(mode => {
      const input = document.querySelector('#site'), label = document.querySelector('label[for=site]');
      const container = document.createElement('div'); container.id = 'semantic-wrap'; container.className = 'MuiAutocomplete-root';
      input.replaceWith(container); container.append(input);
      label.htmlFor = container.id; label.textContent = 'Keywords';
      input.setAttribute('role', 'combobox'); input.setAttribute('aria-label', 'Keywords');
      input.name = 'x'.repeat(300) + 'topics'; window.sensitiveWrites = [];
      input.addEventListener('focus', () => {
        if (mode === 'aria') input.setAttribute('aria-label', 'Password');
        else if (mode === 'description') input.setAttribute('aria-description', 'Password');
        else if (mode === 'placeholder') input.setAttribute('aria-placeholder', 'Password');
        else if (mode === 'details' || mode === 'errormessage') {
          const detail = document.createElement('span'); detail.id = 'private-semantic-detail'; detail.textContent = 'Password';
          document.body.append(detail); input.setAttribute('aria-' + mode, detail.id); input.setAttribute('aria-invalid', 'true');
        }
        else if (mode === 'title') input.title = 'Password';
        else input.name = 'x'.repeat(300) + 'password';
        input.value = 'synthetic-private-value';
      }, {once: true});
      input.addEventListener('input', () => {
        if (input.getAttribute('aria-label') === 'Password' || input.getAttribute('aria-description') === 'Password' ||
            input.getAttribute('aria-placeholder') === 'Password' || input.hasAttribute('aria-details') ||
            input.hasAttribute('aria-errormessage') || input.title === 'Password' || input.name.endsWith('password')) window.sensitiveWrites.push(input.value);
      });
      input.blur();
    }, mode);
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.bkStatus || '{}')
      .decisions?.some(item => item.index === 1 && item.widget === 'mui-autocomplete'));
    const panel = await panelFor(page);
    await panel.getByRole('button', {name: 'AI 智能填充', exact: true}).click();
    await panel.waitForFunction(() => !state.aiLoading);
    assert.deepEqual(await page.evaluate(() => window.sensitiveWrites), [], mode);
    assert.equal(await value(page, '#site'), 'synthetic-private-value');
    const result = await browser.worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      return chrome.tabs.sendMessage(tab.id, {type: 'page:snapshot'}, {frameId: 0});
    }, page.url());
    assert.ok(!JSON.stringify(result).includes('synthetic-private-value'), mode + '敏感值不能入档');
    await panel.close(); await page.close();
  }
});

test('封闭Shadow内的敏感ARIA不被文档中同ID标签遮住', async () => {
  const {page} = await openFixture(context, 'ai-fallback.html', {query: '?shadow-label=1'});
  await page.evaluate(() => {
    const outside = document.createElement('span'); outside.id = 'shared-semantic-label'; outside.textContent = 'Keywords';
    const host = document.createElement('div'); document.body.append(outside, host);
    const root = host.attachShadow({mode: 'closed'});
    const label = document.createElement('span'); label.id = outside.id; label.textContent = 'Password';
    const input = document.createElement('input'); input.setAttribute('aria-labelledby', label.id);
    input.value = 'synthetic-private-value'; root.append(label, input); window.privateInput = input;
  });
  const result = await browser.worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    return chrome.tabs.sendMessage(tab.id, {type: 'page:snapshot'}, {frameId: 0});
  }, page.url());
  assert.ok(!JSON.stringify(result).includes('synthetic-private-value'));
  assert.equal(await page.evaluate(() => window.privateInput.value), 'synthetic-private-value');
  await page.close();
});

test('选择项目自动保存，关闭侧栏、新页面和浏览器重启后仍沿用', async () => {
  const {page} = await openFixture(context, 'plain.html');
  const panel = await panelFor(page);
  await panel.selectOption('#site', 'probekits');

  const deadline = Date.now() + 5000;
  let chosen;
  do {
    chosen = await browser.worker.evaluate(async () => (await chrome.storage.local.get('preferredSite')).preferredSite);
    if (chosen === 'probekits') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(chosen, 'probekits');
  await panel.close();
  const next = await openFixture(context, 'plain.html', {activateSite: false, query: '?remembered=1'});
  assert.equal(await value(next.page, '#name'), EXPECTED.name);
  const reopened = await panelFor(next.page);
  await reopened.waitForFunction(() => document.querySelector('#site').value === 'probekits');
  const output = path.join(REPO, 'docs/screenshots/preferences');
  await mkdir(output, {recursive: true});
  for (const width of [375, 1440]) {
    await reopened.setViewportSize({width, height: 900});
    assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await reopened.screenshot({path: path.join(output, `remembered-${width}.png`)});
  }
  await context.close();
  browser = await launchBrowser(env, {ai_fallback: false});
  context = browser.context;
  const restarted = await openFixture(context, 'plain.html', {activateSite: false, query: '?restarted=1'});
  assert.equal(await value(restarted.page, '#name'), EXPECTED.name);
});
