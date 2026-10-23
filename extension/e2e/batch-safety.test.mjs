// 真实 Chromium DOM 与源码 handler 夹具；不代表外部投稿或完整扩展链路。
import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
let browser;
before(async () => {browser = await chromium.launch({headless: true});});
after(async () => {await browser?.close();});
const script = name => fileURLToPath(new URL('../' + name, import.meta.url));
async function pageFor(html) {
  const page = await browser.newPage();
  await page.setContent(html);
  for (const name of ['lib/text.js', 'lib/fields.js', 'lib/batch-page.js']) await page.addScriptTag({path: script(name)});
  return page;
}

test('必填contenteditable为空、未确认映射和空自定义选择都转待人工', async () => {
  const page = await pageFor('<form><div role="textbox" contenteditable="true" aria-required="true" aria-label="Description"></div><button>Submit</button></form>');
  try {
    const result = await page.evaluate(() => BKBatchPage.inspect(document, BKFields.scan(), {}));
    assert.equal(result.canSubmit, false);
    assert.equal(result.result, 'manual');
    assert.match(result.reason, /Description/);
    await page.locator('[contenteditable]').fill('Human supplied description');
    const pending = await page.evaluate(() => BKBatchPage.inspect(document, BKFields.scan().map(e => ({...e, needsConfirmation: true})), {}));
    assert.equal(pending.result, 'manual');
  } finally {await page.close();}
});

test('首页搜索、订阅和导航Submit不获得投稿资格，真实产品表单的按钮仍可提交', async () => {
  const page = await pageFor('<header><input placeholder="Search products, tools or tags"><button id="navigation">Submit</button></header>' +
    '<form id="newsletter"><label>Email address<input type="email" value="maker@example.test"></label><button>Subscribe</button></form>');
  try {
    const rejected = await page.evaluate(() => {
      const entries = BKFields.scan();
      return BKBatchPage.inspect(document, entries, {decisions: new Map(entries.map(e => [e.field.index, {key: e.element.type === 'email' ? 'email' : 'tags'}]))});
    });
    assert.equal(rejected.canSubmit, false);
    assert.equal(rejected.result, 'manual');
    await page.locator('#newsletter').evaluate(form => form.insertAdjacentHTML('beforebegin',
      '<form id="listing"><label>Website URL<input type="url" value="https://product.example"></label><button id="listing-submit">Submit</button></form>'));
    const accepted = await page.evaluate(() => {
      const entries = BKFields.scan();
      const options = {decisions: new Map(entries.map(e => [e.field.index, {key: e.element.type === 'url' ? 'url' : e.element.type === 'email' ? 'email' : 'tags'}]))};
      return {state: BKBatchPage.inspect(document, entries, options), target: BKBatchPage.target(document, entries, options)?.id};
    });
    assert.equal(accepted.state.canSubmit, true);
    assert.equal(accepted.target, 'listing-submit');
  } finally {await page.close();}
});

for (const mutation of ['payment', 'captcha', 'submitted', 'replace-form', 'change-product', 'same-binding-refresh']) {
  test(`实际提交handler：等待授权期间${mutation}按真实任务身份决定是否点击`, async () => {
    const page = await pageFor('<form><label>Product name<input value="Synthetic" required></label><label>Website URL<input type="url" value="https://product.example" required></label><button type="button">Submit</button></form>');
    try {
      const source = await readFile(script('content.js'), 'utf8');
      const begin = source.indexOf("'page:batch-submit': ") + "'page:batch-submit': ".length;
      const end = source.indexOf("\n      'page:fill':", begin);
      assert.ok(begin > 0 && end > begin);
      await page.evaluate(handler => {
        window.F = BKFields;
        window.state = {session: {site: 'fixture', source_domain: 'fixture.example', record: {id: 'a'.repeat(32)}}, entries: [], decisions: new Map()};
        window.scan = () => {
          state.entries = BKFields.scan();
          state.decisions = new Map(state.entries.map(entry => [entry.field.index, {key: entry.element.type === 'url' ? 'url' : 'name'}]));
        };
        window.loginPage = () => false;
        window.contentAllowed = () => true;
        window.clicks = 0;
        document.addEventListener('click', () => window.clicks++);
        window.send = () => new Promise(resolve => {window.permit = () => resolve({authorized: true, id: 'a'.repeat(32)});});
        window.runSubmit = (0, eval)('(' + handler + ')');
        window.pending = runSubmit().then(() => null, error => error.message);
      }, source.slice(begin, end).trim().replace(/,$/, ''));
      await page.waitForFunction(() => !!window.permit);
      await page.evaluate(kind => {
        if (kind === 'payment') document.querySelector('button').textContent = 'Pay $99';
        if (kind === 'captcha') document.querySelector('form').insertAdjacentHTML('afterbegin', '<input aria-label="CAPTCHA">');
        if (kind === 'submitted') state.submitted = true;
        if (kind === 'replace-form') document.querySelector('form').outerHTML = document.querySelector('form').outerHTML;
        if (kind === 'change-product') state.session = {...state.session, site: 'other'};
        if (kind === 'same-binding-refresh') state.session = {...state.session, record:{...state.session.record}};
        window.permit();
      }, mutation);
      const error = await page.evaluate(() => window.pending);
      assert.equal(await page.evaluate(() => window.clicks), mutation === 'same-binding-refresh' ? 1 : 0);
      if (mutation === 'same-binding-refresh') assert.equal(error,null,'同一任务的等价刷新不是换产品或换任务');
      else assert.ok(error, '资格变更必须明确拒绝，不点击');
    } finally {await page.close();}
  });
}
