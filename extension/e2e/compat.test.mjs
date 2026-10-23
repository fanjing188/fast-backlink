// 真实 Chromium 控件合同回归；合成页面不代表外部站点已实投。
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function pageWith(html, host = '') {
  const page = await browser.newPage();
  const content = '<meta name="viewport" content="width=device-width">' + html;
  if (host) {
    await page.route('https://' + host + '/**', route => route.fulfill({contentType: 'text/html', body: content}));
    await page.goto('https://' + host + '/fixture');
  } else await page.setContent(content);
  for (const file of ['text', 'platforms', 'fields', 'widgets']) {
    await page.evaluate(source => (0, eval)(source), await readFile(path.join(root, 'lib', file + '.js'), 'utf8'));
  }
  return page;
}

test('Webflow 每个字段保留自己的标签，不能整张表都变成产品名', async () => {
  const page = await pageWith(`<div class="w-form"><form data-name="Submit tool">
    <label for="name">Product name</label><input id="name">
    <label for="url">Website URL</label><input id="url">
    <label for="desc">Short description</label><textarea id="desc"></textarea>
  </form></div>`, 'webflow.com');
  try {
    const labels = await page.evaluate(() => BKFields.scan().map(x => x.field.label));
    assert.deepEqual(labels, ['Product name', 'Website URL', 'Short description']);
  } finally { await page.close(); }
});

for (const [platform, wrapper, title] of [
  ['contact-form-7', 'class="wpcf7-form-control-wrap"', 'class="wpcf7-label"'],
  ['forminator', 'class="forminator-field"', 'class="forminator-label"'],
  ['fluent-forms', 'class="ff-el-group"', 'class="ff-el-input--label"'],
  ['ninja-forms', 'class="nf-field-container"', 'class="nf-field-label"'],
]) {
  test(platform + ' 识别字段局部题目，不依赖输入框 ID 或相邻字段', async () => {
    const page = await pageWith(`<div ${wrapper}><div ${title}>Website URL</div><div><input></div></div>`);
    try {
      const fields = await page.evaluate(() => BKFields.scan().map(x => x.field));
      assert.equal(fields[0].platform, platform);
      assert.equal(fields[0].label, 'Website URL');
    } finally { await page.close(); }
  });
}

test('延迟 portal 下拉只选 aria-controls 关联项，不碰页面其他同名项，也不敲回车', async () => {
  const page = await pageWith(`<div role="listbox"><div role="option" onclick="window.wrong=true">Utilities</div></div>
    <div class="react-select"><input id="category" role="combobox" aria-label="Category" aria-controls="mine"></div>
    <script>
      window.enters=0; document.addEventListener('keydown',e=>{if(e.key==='Enter')window.enters++});
      category.addEventListener('click',()=>setTimeout(()=>{
        const menu=document.createElement('div'); menu.id='mine'; menu.role='listbox';
        const option=document.createElement('div'); option.role='option'; option.textContent='Utilities';
        option.onclick=()=>{window.picked=true; category.value='Utilities'; menu.remove()};
        menu.append(option); document.body.append(menu);
      },120));
    </script>`);
  try {
    const result = await page.evaluate(async () => {
      const field = BKFields.describe(category);
      const result = await BKWidgets.set(category, field, 'Utilities');
      return {...result, wrong: !!window.wrong, picked: !!window.picked, enters: window.enters};
    });
    assert.equal(result.wrong, false);
    assert.equal(result.picked, true);
    assert.equal(result.enters, 0);
    assert.equal(result.ok, true);
  } finally { await page.close(); }
});

test('Radix/shadcn 的按钮式 combobox 能采集、选中并回读业务值', async () => {
  const page = await pageWith(`<label id="label">Category</label><div>
    <button type="button" id="category" role="combobox" data-placeholder aria-labelledby="label" aria-controls="menu">Choose category</button>
    <input type="hidden" id="saved"></div><div role="listbox" id="menu" hidden>
    <div role="option" onclick="saved.value='Utilities'; category.textContent='Utilities'; category.removeAttribute('data-placeholder'); menu.hidden=true">Utilities</div></div>
    <script>category.onclick=()=>{menu.hidden=false}</script>`);
  try {
    const result = await page.evaluate(async () => {
      const entry = BKFields.scan().find(x => x.element.id === 'category');
      if (!entry) return {found: false};
      const before = BKFields.read(entry.element, entry.field);
      const result = await BKWidgets.set(entry.element, entry.field, 'Utilities');
      return {found: true, before, ...result, value: BKFields.read(entry.element, entry.field), saved: saved.value};
    });
    assert.equal(result.found, true);
    assert.equal(result.before, '', '未选占位文案不是现值');
    assert.equal(result.ok, true);
    assert.equal(result.value, 'Utilities');
    assert.equal(result.saved, 'Utilities');
  } finally { await page.close(); }
});

for (const variant of ['duplicate', 'disabled', 'uncommitted', 'rebound']) {
  test('自定义下拉 ' + variant + ' 不误报成功、不点击歧义或禁用项', async () => {
    const page = await pageWith(`<div><input id="category" role="combobox" aria-label="Category" aria-controls="menu"></div>
      <div role="listbox" id="menu"><div role="option" ${variant === 'disabled' ? 'aria-disabled="true"' : ''}
        onclick="window.clicks=(window.clicks||0)+1">Utilities</div>
        ${variant === 'duplicate' ? '<div role="option">Utilities</div>' : ''}</div>
      <script>${variant === 'rebound' ? "category.onclick=()=>category.setAttribute('aria-controls','other')" : ''}</script>`);
    try {
      const result = await page.evaluate(async () => ({
        ...await BKWidgets.set(category, BKFields.describe(category), 'Utilities'), clicks: window.clicks || 0,
      }));
      assert.equal(result.ok, false);
      assert.equal(result.clicks, variant === 'uncommitted' ? 1 : 0);
    } finally { await page.close(); }
  });
}
