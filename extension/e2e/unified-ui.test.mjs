import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {REPO, launchBrowser, openFixture, startEnvironment} from './support.mjs';

let env, browser;
const directory = path.join(REPO, 'docs/screenshots/unified');
const evidence = [];
before(async () => {
  env = await startEnvironment();
  browser = await launchBrowser(env);
  await mkdir(directory, {recursive: true});
}, {timeout: 180000});
after(async () => {
  await writeFile(path.join(directory, 'geometry.json'), JSON.stringify(evidence, null, 2));
  await browser?.context.close();
  await env?.stop();
  await env?.cleanup();
});

async function inspect(page, name) {
  const result = await page.evaluate(() => {
    const failures = [];
    for (const node of document.querySelectorAll('button, input:not([type=checkbox]):not([type=file]), select, textarea')) {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || node.closest('[hidden]')) continue;
      // 项目列表允许自身横向滚动，数据表也保留独立滚动；其他控件不能被整页裁掉。
      if (!node.closest('.navlist, .tablewrap') && (rect.left < -1 || rect.right > innerWidth + 1)) failures.push(`${node.id || node.textContent.trim().slice(0, 20)} 越界`);
      if (node.tagName === 'BUTTON' && !node.classList.contains('toggle') && rect.height < 32) failures.push(`${node.id || node.textContent.trim().slice(0, 20)} 高度 ${rect.height}`);
    }
    const main = document.querySelector('main, .main');
    return {width: innerWidth, height: innerHeight, font: parseFloat(getComputedStyle(document.body).fontSize),
      overflow: document.documentElement.scrollWidth - innerWidth, mainHeight: main?.getBoundingClientRect().height, failures};
  });
  evidence.push({name, ...result});
  assert.ok(result.font >= 14, `${name} 正文字号不能小于 14px`);
  assert.ok(result.overflow <= 1, `${name} 整页横向溢出`);
  assert.deepEqual(result.failures, [], `${name} 控件必须整齐、可达：${result.failures.join('；')}`);
  assert.ok(result.mainHeight >= 200, `${name} 内容区被头部和导航挤没了：${result.mainHeight}`);
  await page.screenshot({path: path.join(directory, `${name}.png`)});
}

test('六个侧栏页签在320/375/480及深浅色下统一可读、控件完整可达', async () => {
  const {page: fixture} = await openFixture(browser.context, 'plain.html');
  await fixture.bringToFront();
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${browser.extensionId}/panel.html`);
  await page.waitForSelector('[data-panel=form] .bk-item');
  for (const width of [320, 375, 480]) for (const colorScheme of ['light', 'dark']) {
    await page.setViewportSize({width, height: 900});
    await page.emulateMedia({colorScheme, reducedMotion: 'reduce'});
    for (const tab of ['form', 'assets', 'snapshots', 'logs', 'tasks', 'settings']) {
      await page.click(`nav [data-tab=${tab}]`);
      await page.waitForFunction(tab => document.querySelector(`[data-panel=${tab}]`)?.hidden === false, tab);
      await inspect(page, `panel-${tab}-${width}-${colorScheme}`);
    }
  }
  await page.close();
  await fixture.close();
}, {timeout: 120000});

test('页内封闭Shadow弹层与状态条适配窄屏，跟随深浅色并保留键盘操作', async () => {
  const {page} = await openFixture(browser.context, 'plain.html');
  const cdp = await browser.context.newCDPSession(page);
  const geometry = async () => {
    const {root} = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
    const roots = [];
    const walk = node => {
      if (['fast-backlink-layer', 'fast-backlink-bar'].some(id => node.attributes?.includes(id))) roots.push(...(node.shadowRoots || []));
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
    };
    walk(root);
    const values = [];
    for (const node of roots) {
      const {object} = await cdp.send('DOM.resolveNode', {nodeId: node.nodeId});
      const {result} = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: `function () { return [...this.querySelectorAll('.pop, .bar, .pop .v, .bar button, .badge .ico, .badge .g, .pop .item .ico, .pop .close .ico')].map(node => {
          const r = node.getBoundingClientRect(), s = getComputedStyle(node);
          return {kind: node.getAttribute('class'), svg: node instanceof SVGElement, stroke: s.stroke, color: s.color,
            parentNamespace: node.parentElement?.namespaceURI, parentKind: node.parentElement?.getAttribute('class'),
            containerKind: node.parentElement?.parentElement?.getAttribute('class'), width: r.width, x: r.x, right: r.right, y: r.y,
            bottom: r.bottom, height: r.height, font: parseFloat(s.fontSize), background: s.backgroundColor};
        }); }`
      });
      values.push(...result.value);
      await cdp.send('Runtime.releaseObject', {objectId: object.objectId});
    }
    return values;
  };
  for (const width of [320, 375, 480, 1440]) for (const colorScheme of ['light', 'dark']) {
    await page.setViewportSize({width, height: 900});
    await page.emulateMedia({colorScheme, reducedMotion: 'reduce'});
    await page.focus('#tagline');
    await page.keyboard.press('Alt+f');
    let items = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      items = await geometry();
      if (items.some(item => item.kind === 'pop')) break;
      await page.waitForTimeout(50);
    }
    const pop = items.find(item => item.kind === 'pop');
    assert.ok(pop, '快捷键必须打开真实扩展弹层');
    for (const item of items) assert.ok(item.x >= 0 && item.right <= width + 1, `${width} ${colorScheme} 页内控件越界：${JSON.stringify(item)}`);
    assert.ok(items.filter(item => item.kind === 'v').every(item => item.font >= 14), '素材正文需要可读字号');
    assert.ok(items.filter(item => item.svg && item.kind !== 'g').every(item => item.stroke !== 'none'), '封闭Shadow中的线形图标必须保留描边');
    const badges = items.filter(item => item.kind === 'g');
    assert.ok(badges.length > 0 && badges.every(item => item.width > 0 && item.parentNamespace === 'http://www.w3.org/1999/xhtml'), '状态图标必须实际绘制，不能只剩深色底圆');
    const filledBadges = badges.filter(item => item.parentKind === 'st ok');
    assert.ok(filledBadges.length > 0 && filledBadges.every(item => item.containerKind === 'badge ok'), '已填标记必须使用已完成色，而不是未知灰色');
    if (colorScheme === 'dark') assert.notEqual(pop.background, 'rgb(255, 255, 255)', '页内助手必须跟随深色主题');
    const name = `inpage-${width}-${colorScheme}`;
    evidence.push({name, items});
    await page.screenshot({path: path.join(directory, `${name}.png`)});
    await page.keyboard.press('Escape');
    assert.equal((await geometry()).some(item => item.kind === 'pop'), false, 'Escape应关闭候选层');
  }
  await cdp.detach();
  await page.close();
}, {timeout: 120000});

test('外链库在侧栏、素材库与日志页有常驻可见入口', async () => {
  for (const route of ['panel', 'options', 'logs']) {
    const page = await browser.context.newPage();
    await page.setViewportSize({width: 375, height: 900});
    await page.goto(`chrome-extension://${browser.extensionId}/${route}.html`);
    assert.equal(await page.locator('#open-library').count(), 1, `${route}缺少外链库入口`);
    assert.equal(await page.locator('#open-library').isVisible(), true);
    assert.equal(await page.getAttribute('#open-library', 'href'), 'library.html');
    await page.close();
  }
});

test('导入其他产品资料包必须拒绝且保留当前素材', async () => {
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
  await page.waitForSelector('#field-name textarea');
  const original = await page.inputValue('#field-name textarea');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#import')]);
  await chooser.setFiles({name: 'other-kit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    schema_version: 2, site: 'otherproduct', fields: {name: {value: 'Wrong product'}}, assets: []
  }))});
  await page.waitForFunction(() => document.querySelector('#toasts')?.textContent.trim());
  assert.match(await page.innerText('#toasts'), /产品不匹配|属于其他产品/);
  assert.equal(await page.inputValue('#field-name textarea'), original);
  await page.reload();
  await page.waitForSelector('#field-name textarea');
  assert.equal(await page.inputValue('#field-name textarea'), original, '拒绝导入不能破坏持久资料');
  await page.close();
});

test('素材库显示已有分档文案而不是假空白，复制读取最新编辑值', async () => {
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
  await page.waitForSelector('#field-tagline textarea');
  assert.ok((await page.inputValue('#field-tagline textarea')).length > 0, '只有variants的合法字段不能显示为空');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: {writeText: async value => {window.copiedForTest = value;}}
  }));
  await page.fill('#field-tagline textarea', 'Edited text from the material editor');
  await page.locator('#field-tagline button', {hasText: '复制'}).click();
  assert.equal(await page.evaluate(() => window.copiedForTest), 'Edited text from the material editor');
  await page.close();
});

test('素材库和日志页在320/375/480/1440宽度保持同一控件尺度与可用内容区', async () => {
  for (const route of ['options', 'logs']) {
    const page = await browser.context.newPage();
    await page.goto(`chrome-extension://${browser.extensionId}/${route}.html`);
    if (route === 'options') await page.waitForSelector('#editor .fieldrow');
    else await page.waitForFunction(() => !document.querySelector('#status')?.textContent.includes('读取中'));
    for (const width of [320, 375, 480, 1440]) for (const colorScheme of ['light', 'dark']) {
      await page.setViewportSize({width, height: 900});
      await page.emulateMedia({colorScheme, reducedMotion: 'reduce'});
      await inspect(page, `${route}-${width}-${colorScheme}`);
    }
    await page.close();
  }
}, {timeout: 120000});
