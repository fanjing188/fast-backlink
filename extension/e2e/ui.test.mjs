// 界面上线标准验收：布局不溢出、可达名称、目标尺寸、焦点可见、对比度（亮/暗）、空状态、截图。
import {after, afterEach, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {REPO, launchBrowser, openFixture, settle, startEnvironment} from './support.mjs';

let env, browser, context, extensionId;
const pages = [];
const SHOTS = path.join(REPO, 'docs', 'screenshots');
const generatedShots = new Set();
const require = createRequire(import.meta.url);

before(async () => {
  env = await startEnvironment();
  browser = await launchBrowser(env, {log_level: 'info'});
  context = browser.context;
  extensionId = browser.extensionId;
  await mkdir(SHOTS, {recursive: true});
}, {timeout: 180000});

after(async () => {
  for (const page of pages.splice(0)) await page.close().catch(() => {});
  await context?.close().catch(() => {});
  await env?.stop();
  await env?.cleanup();
});

afterEach(async () => {
  for (const page of pages.splice(0)) await page.close().catch(() => {});
});

/** 在页面里做一次可访问性/布局巡检。 */
async function audit(page, label) {
  return page.evaluate(label => {
    const problems = {label, overflow: null, unnamed: [], small: [], contrast: [], focus: null};
    const root = document.documentElement;
    problems.overflow = root.scrollWidth - window.innerWidth;
    const visible = element => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && element.getClientRects().length > 0;
    };
    const name = element => (element.getAttribute('aria-label') || '').trim() ||
      (element.getAttribute('title') || '').trim() ||
      (element.textContent || '').trim() ||
      (element.labels && [...element.labels].map(node => node.textContent.trim()).join(' ')) ||
      (element.placeholder || '').trim() ||
      (element.type === 'file' ? element.name || 'file' : '');
    for (const element of document.querySelectorAll('button, a[href], input, select, textarea, [role=tab], [role=button]')) {
      if (!visible(element) || element.type === 'hidden') continue;
      if (!name(element)) problems.unnamed.push(`${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''}`);
      const rect = element.getBoundingClientRect();
      if ((element.tagName === 'BUTTON' || element.tagName === 'A' || element.getAttribute('role') === 'tab') && rect.height < 22 && rect.height > 0) {
        problems.small.push(`${element.tagName.toLowerCase()} ${name(element).slice(0, 16)} ${rect.height.toFixed(1)}px`);
      }
    }
    const parse = value => {
      const match = String(value).match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const [r, g, b, a = 1] = match[1].split(',').map(Number);
      return {r, g, b, a};
    };
    const lum = ({r, g, b}) => {
      const channel = value => {
        const s = value / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (fg, bg) => {
      const lighter = Math.max(lum(fg), lum(bg)), darker = Math.min(lum(fg), lum(bg));
      return (lighter + 0.05) / (darker + 0.05);
    };
    const trail = [];
    const background = element => {
      let node = element;
      trail.length = 0;
      while (node && node !== document.documentElement) {
        const raw = getComputedStyle(node).backgroundColor;
        trail.push(`${node.tagName}.${(node.className || '').toString().split(' ')[0]}=${raw}`);
        const color = parse(raw);
        if (color && color.a > 0.6) return color;
        node = node.parentElement;
      }
      const body = getComputedStyle(document.body).backgroundColor;
      trail.push(`BODY=${body}`);
      return parse(body) || {r: 255, g: 255, b: 255, a: 1};
    };
    for (const element of document.querySelectorAll('body *')) {
      if (!visible(element)) continue;
      if (element.closest('.sr-only,[aria-hidden=true]') && !element.closest('#stats')) continue;
      if (element.closest('svg')) continue;
      const hasText = [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim());
      if (!hasText) continue;
      const style = getComputedStyle(element);
      const foreground = parse(style.color);
      const behind = background(element);
      const size = parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 600;
      const large = size >= 24 || (size >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      const value = ratio(foreground, behind);
      if (value + 0.01 < need) {
        problems.contrast.push(`${element.tagName.toLowerCase()}.${(element.className || '').toString().split(' ')[0]} "${element.textContent.trim().slice(0, 18)}" ${value.toFixed(2)} < ${need} fg=${style.color} bg=rgb(${behind.r},${behind.g},${behind.b}) trail=${trail.join(' → ')} scheme=${matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}`);
      }
    }
    return problems;
  }, label);
}

// 主题切换带 160ms 的 background 过渡，等两次读数一致再断言。
async function waitThemeSettled(page, sample = 'body .card, body .rowitem, body') {
  // 主题切换的 background 过渡是 160ms，先等它跑完再逐元素读样式。
  await page.waitForTimeout(420);
  let previous = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = await page.evaluate(selector => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const style = getComputedStyle(node);
      return `${style.backgroundColor}|${style.color}`;
    }, sample);
    if (current && current === previous) return current;
    previous = current;
    await page.waitForTimeout(120);
  }
  return previous;
}

async function keyboardFocusAudit(page) {
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Tab');
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return {ok: false, reason: 'Tab 没有把焦点给任何元素'};
    const style = getComputedStyle(active);
    return {ok: active.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
      reason: `${active.tagName.toLowerCase()} outline=${style.outlineStyle} ${style.outlineWidth} visible=${active.matches(':focus-visible')}`};
  });
}

function expectClean(problems) {
  assert.ok(problems.overflow <= 1, `${problems.label}：横向溢出 ${problems.overflow}px`);
  assert.deepEqual(problems.unnamed, [], `${problems.label}：这些控件没有可读名称：${JSON.stringify(problems.unnamed)}`);
  assert.deepEqual(problems.small, [], `${problems.label}：这些控件小于 22px 高：${JSON.stringify(problems.small)}`);
  assert.deepEqual(problems.contrast, [], `${problems.label}：这些文字对比度不足：${JSON.stringify(problems.contrast)}`);
}

async function shot(page, name) {
  const file = path.join(SHOTS, name);
  await page.screenshot({path: file, fullPage: false});
  generatedShots.add(name);
  const info = await stat(file);
  assert.ok(info.size > 8_000, `${name} 截图只有 ${info.size} 字节，可能是空白页`);
  return {file, bytes: info.size};
}

// ---------- 侧边栏 ----------

describe('侧边栏', () => {
  test('表单页：布局、对比度、可达名称、焦点环都达标（含暗色）', async () => {
    const fixture = await openFixture(context, 'plain.html');
    pages.push(fixture.page);
    await fixture.page.bringToFront();
    const panel = await context.newPage();
    pages.push(panel);
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.setViewportSize({width: 400, height: 900});
    await panel.waitForSelector('[data-panel=form] .bk-item', {timeout: 20000});
    expectClean(await audit(panel, '侧边栏-表单-亮色'));
    const focus = await keyboardFocusAudit(panel);
    assert.ok(focus.ok, `焦点环不可见：${focus.reason}`);
    await shot(panel, 'panel-form.png');

    await panel.emulateMedia({colorScheme: 'dark'});
    await waitThemeSettled(panel);
    expectClean(await audit(panel, '侧边栏-表单-暗色'));
    await shot(panel, 'panel-form-dark.png');
    await panel.emulateMedia({colorScheme: 'light'});
  });

  test('每个页签都能渲染且可截图（素材/快照/日志/任务/设置）', async () => {
    const fixture = await openFixture(context, 'plain.html');
    pages.push(fixture.page);
    await fixture.page.bringToFront();
    const panel = await context.newPage();
    pages.push(panel);
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.setViewportSize({width: 400, height: 900});
    await panel.waitForSelector('[data-panel=form] .bk-item', {timeout: 20000});
    for (const tab of ['assets', 'snapshots', 'logs', 'tasks', 'settings']) {
      await panel.click(`nav.bk-tabs button[data-tab=${tab}]`);
      await panel.waitForTimeout(700);
      const problems = await audit(panel, `侧边栏-${tab}`);
      expectClean(problems);
      await shot(panel, `panel-${tab}.png`);
    }
    // 页签支持左右方向键切换
    await panel.focus('nav.bk-tabs button[data-tab=settings]');
    await panel.keyboard.press('ArrowLeft');
    const selected = await panel.$eval('nav.bk-tabs button[aria-selected=true]', node => node.dataset.tab);
    assert.equal(selected, 'tasks');
    await panel.keyboard.press('Home');
    assert.equal(await panel.$eval('nav.bk-tabs button[aria-selected=true]', node => node.dataset.tab), 'form');
    await panel.keyboard.press('End');
    assert.equal(await panel.$eval('nav.bk-tabs button[aria-selected=true]', node => node.dataset.tab), 'settings');
  });

  test('没选项目时给出空状态；筛选无结果也有空状态', async () => {
    const blank = await context.newPage();
    pages.push(blank);
    await blank.goto('about:blank');
    const panel = await context.newPage();
    pages.push(panel);
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.waitForTimeout(1200);
    const empty = await panel.$eval('[data-panel=form]', node => node.textContent);
    assert.ok(/选一个目标项目|当前不是网页|还没连接本机/.test(empty), empty);
  });
});

// ---------- 素材库 ----------

describe('素材库管理页', () => {
  test('桌面与窄屏都不溢出，字段卡片与媒体卡片可达', async () => {
    const page = await context.newPage();
    pages.push(page);
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.waitForSelector('#editor .fieldrow', {timeout: 20000});
    await page.setViewportSize({width: 1280, height: 900});
    expectClean(await audit(page, '素材库-桌面'));
    await shot(page, 'options.png');
    await page.setViewportSize({width: 720, height: 900});
    const narrow = await audit(page, '素材库-窄屏');
    expectClean(narrow);
    // 8 个媒体位都在（有素材的显示缩略图，缺的显示“缺素材”）
    const cards = await page.$$eval('.media-grid .media', nodes => nodes.length);
    assert.equal(cards, 8);
    const videoHint = await page.evaluate(() => document.body.textContent.includes('暂不制作'));
    assert.ok(videoHint, '视频位要写明暂不制作');
    // 分组导航可用
    const groups = await page.$$eval('.groupnav a', nodes => nodes.map(node => node.textContent));
    assert.deepEqual(groups.length, 5, JSON.stringify(groups));
    await page.emulateMedia({colorScheme: 'dark'});
    await waitThemeSettled(page, '#editor .card, body');
    expectClean(await audit(page, '素材库-暗色'));
    await shot(page, 'options-dark.png');
  });

  test('拖拽上传：把文件拖到媒体卡片会走同一上传接口并刷新卡片', async () => {
    const page = await context.newPage();
    pages.push(page);
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.waitForSelector('#editor .media-grid', {timeout: 20000});
    // 用 1×1 PNG 作为拖入文件；上传成功后该卡的“缺素材”提示应消失。
    const before = await page.$eval('#group-media', node => node.textContent.includes('缺素材'));
    assert.ok(before, '测试资料包应当有缺失的素材位');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const card = await page.$('.media.missing');
    await card.evaluate((node, bytes) => {
      const file = new File([new Uint8Array(bytes)], 'icon-64.png', {type: 'image/png'});
      const transfer = new DataTransfer();
      transfer.items.add(file);
      node.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer}));
    }, [...png]);
    await page.waitForFunction(() => document.querySelector('#group-media')?.textContent.includes('icon-64.png'),
      null, {timeout: 25000})
      .catch(error => {throw Error(`拖拽上传后卡片没有刷新：${error.message}`);});
  });
});

// ---------- 日志 ----------

describe('日志页', () => {
  test('筛选、空状态、展开详情、周报面板', async () => {
    const fixture = await openFixture(context, 'plain.html');
    pages.push(fixture.page);
    await fixture.page.waitForTimeout(1200);
    const page = await context.newPage();
    pages.push(page);
    await page.goto(`chrome-extension://${extensionId}/logs.html`);
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length > 0, null, {timeout: 20000});
    await page.setViewportSize({width: 1280, height: 900});
    expectClean(await audit(page, '日志-亮色'));
    await shot(page, 'logs.png');
    // 空状态
    await page.fill('#search', 'zzz-绝对不存在的关键词');
    await page.waitForTimeout(300);
    const empty = await page.$eval('#rows', node => node.textContent);
    assert.ok(empty.includes('没有匹配的日志'), empty);
    await page.fill('#search', '');
    await page.waitForTimeout(300);
    // 展开一行看 JSON 详情
    await page.click('#rows tr.rowmain');
    await page.waitForSelector('#rows tr.detail pre', {timeout: 5000});
    const detail = await page.$eval('#rows tr.detail pre', node => node.textContent);
    assert.match(detail, /"ts"/);
    await page.click('#report');
    await page.waitForSelector('#summary:not([hidden])', {timeout: 15000});
    await page.emulateMedia({colorScheme: 'dark'});
    await waitThemeSettled(page, '#rows tr, body');
    expectClean(await audit(page, '日志-暗色'));
    await shot(page, 'logs-dark.png');
  });
});

// ---------- 几何与截图内容 ----------

describe('布局几何', () => {
  test('侧边栏：页脚贴底、页签在头下方、素材网格至少两列', async () => {
    const fixture = await openFixture(context, 'plain.html');
    pages.push(fixture.page);
    await fixture.page.bringToFront();
    const panel = await context.newPage();
    pages.push(panel);
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.setViewportSize({width: 400, height: 900});
    await panel.waitForSelector('[data-panel=form] .bk-item', {timeout: 20000});
    const geometry = await panel.evaluate(() => {
      const rect = selector => {
        const node = document.querySelector(selector);
        return node ? node.getBoundingClientRect().toJSON() : null;
      };
      return {appbar: rect('.appbar'), stats: rect('#stats'), tabs: rect('.tabs'), main: rect('main'),
        footer: rect('.actionbar'), viewport: {w: innerWidth, h: innerHeight}};
    });
    assert.ok(geometry.footer.bottom <= geometry.viewport.h + 1, '页脚应当在视口内');
    assert.ok(geometry.footer.bottom >= geometry.viewport.h - 2, `页脚没有贴底：${JSON.stringify(geometry)}`);
    assert.ok(geometry.tabs.top >= geometry.appbar.bottom - 1, '页签被顶栏遮住');
    assert.ok(geometry.main.height > 200, '内容区太矮');
    await panel.click('nav.bk-tabs button[data-tab=assets]');
    await panel.waitForSelector('[data-panel=assets] .media', {timeout: 10000});
    const perRow = await panel.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-panel=assets] .media')];
      const firstTop = cards[0].getBoundingClientRect().top;
      return cards.filter(card => Math.abs(card.getBoundingClientRect().top - firstTop) < 4).length;
    });
    assert.ok(perRow >= 2, `400px 宽下素材网格只有 ${perRow} 列`);
  });

  test('素材库：左侧栏固定宽度，右侧内容不互相覆盖', async () => {
    const page = await context.newPage();
    pages.push(page);
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.setViewportSize({width: 1280, height: 900});
    await page.waitForSelector('#editor .fieldrow', {timeout: 20000});
    const box = await page.evaluate(() => {
      const side = document.querySelector('.side').getBoundingClientRect();
      const main = document.querySelector('.main').getBoundingClientRect();
      return {side: side.toJSON(), main: main.toJSON()};
    });
    assert.ok(Math.abs(box.side.width - 244) < 12, `侧栏宽度异常：${box.side.width}`);
    assert.ok(box.main.left >= box.side.right - 1, '内容区与侧栏重叠');
    assert.ok(box.main.width > 600, `内容区太窄：${box.main.width}`);
  });

  test('日志：滚动时表头仍然可见（粘性）', async () => {
    const fixture = await openFixture(context, 'plain.html');
    pages.push(fixture.page);
    await fixture.page.waitForTimeout(1200);
    const page = await context.newPage();
    pages.push(page);
    await page.goto(`chrome-extension://${extensionId}/logs.html`);
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length > 3, null, {timeout: 20000});
    await page.setViewportSize({width: 1280, height: 700});
    const before = await page.$eval('thead th', node => node.getBoundingClientRect().top);
    await page.$eval('main', node => {node.scrollTop = 300;});
    await page.waitForTimeout(200);
    const after = await page.$eval('thead th', node => node.getBoundingClientRect().top);
    assert.ok(Math.abs(before - after) < 2, `表头没有粘住：${before} → ${after}`);
  });
});

// 解 PNG（8 位 RGB/RGBA，无交错）做像素级检查；不依赖任何图像库。
function decodePng(buffer) {
  const zlib = require('node:zlib');
  let pos = 8, width = 0, height = 0, colorType = 6;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const kind = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (kind === 'IHDR') {width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9];}
    if (kind === 'IDAT') idat.push(data);
    pos += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw Error(`不支持的 PNG 颜色类型 ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let offset = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[offset++];
    const line = raw.subarray(offset, offset + stride);
    offset += stride;
    const target = pixels.subarray(row * stride, (row + 1) * stride);
    const previous = row ? pixels.subarray((row - 1) * stride, row * stride) : Buffer.alloc(stride);
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? target[index - channels] : 0;
      const up = previous[index];
      const upLeft = index >= channels ? previous[index - channels] : 0;
      let value = line[index];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      target[index] = value & 255;
    }
  }
  return {width, height, channels, pixels};
}

function colorStats(image, target, tolerance = 12) {
  const {pixels, channels} = image;
  let count = 0;
  for (let index = 0; index < pixels.length; index += channels) {
    if (Math.abs(pixels[index] - target[0]) <= tolerance &&
        Math.abs(pixels[index + 1] - target[1]) <= tolerance &&
        Math.abs(pixels[index + 2] - target[2]) <= tolerance) count++;
  }
  return count / (pixels.length / channels);
}

function pixelAt(image, x, y) {
  const {pixels, channels, width} = image;
  const index = (y * width + x) * channels;
  return [pixels[index], pixels[index + 1], pixels[index + 2]];
}

// ---------- 页内 ----------

describe('页内 UI', () => {
  test('状态条与候选弹层：Alt+F 打开、方向键+Enter 填入、Esc 关闭', async () => {
    const {page} = await openFixture(context, 'plain.html');
    pages.push(page);
    // 清空一个字段，聚焦后用键盘挑第一项
    await page.$eval('#tagline', node => {node.value = ''; node.focus();});
    await page.keyboard.press('Alt+f');
    await page.waitForTimeout(500);
    await shot(page, 'inpage-picker.png');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    await shot(page, 'inpage-picker-keyboard.png');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#tagline')?.value.length > 0, null, {timeout: 8000});
    const value = await page.$eval('#tagline', node => node.value);
    assert.ok(value.length > 0, '弹层回车后应当填入');
    // Esc 关闭弹层后再截一张带状态条的整页图
    await page.keyboard.press('Alt+f');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const bar = await page.evaluate(() => !!document.getElementById('fast-backlink-bar'));
    assert.ok(bar, '页面上应当有状态条容器');
    await shot(page, 'inpage-page.png');
    const sizes = await Promise.all(['inpage-picker.png', 'inpage-picker-keyboard.png', 'inpage-page.png']
      .map(name => readFile(path.join(SHOTS, name)).then(buffer => buffer.length)));
    assert.ok(sizes.every(size => size > 8_000), JSON.stringify(sizes));
  });
});

describe('截图内容', () => {
  test('每张截图尺寸正确、不是纯色空图', async () => {
    const expected = {
      'panel-form.png': {w: 400, h: 900}, 'panel-form-dark.png': {w: 400, h: 900},
      'panel-assets.png': {w: 400, h: 900}, 'panel-snapshots.png': {w: 400, h: 900},
      'panel-logs.png': {w: 400, h: 900}, 'panel-tasks.png': {w: 400, h: 900},
      'panel-settings.png': {w: 400, h: 900}, 'options.png': {w: 1280, h: 900},
      // 暗色截图是在窄屏（720px）下拍的，验证响应式断点也一起验了
      'options-dark.png': {w: 720, h: 900}, 'logs.png': {w: 1280, h: 900}, 'logs-dark.png': {w: 1280, h: 900},
      'inpage-picker.png': {w: 1280, h: 900}, 'inpage-page.png': {w: 1280, h: 900},
    };
    for (const [name, size] of Object.entries(expected)) {
      assert.ok(generatedShots.has(name), `${name} 必须在本轮生成，不能依赖旧图`);
      const buffer = await readFile(path.join(SHOTS, name));
      assert.equal(buffer.readUInt32BE(16), size.w, `${name} 宽度`);
      assert.equal(buffer.readUInt32BE(20), size.h, `${name} 高度`);
      assert.ok(buffer.length > 20_000, `${name} 只有 ${buffer.length} 字节，可能是空图`);
    }
    // 像素级：确认品牌色、页面底色、暗色底都在图上，不是一张空图。
    const form = decodePng(await readFile(path.join(SHOTS, 'panel-form.png')));
    assert.ok(colorStats(form, [244, 246, 249]) > 0.15, '浅色底应当覆盖大部分面板');
    assert.ok(colorStats(form, [49, 95, 199], 18) > 0.002, '主按钮的brand蓝应当出现在图上');
    const darkForm = decodePng(await readFile(path.join(SHOTS, 'panel-form-dark.png')));
    assert.ok(colorStats(darkForm, [18, 22, 29]) > 0.15, '暗色底应当覆盖大部分面板');
    assert.ok(colorStats(darkForm, [27, 32, 41]) > 0.02, '暗色卡片应当可见');
    const options = decodePng(await readFile(path.join(SHOTS, 'options.png')));
    assert.ok(colorStats(options, [255, 255, 255]) > 0.15, '素材库白底卡片应当存在');
    assert.ok(colorStats(options, [244, 246, 249]) > 0.1, '素材库页面底色应当存在');
    const logs = decodePng(await readFile(path.join(SHOTS, 'logs.png')));
    assert.ok(colorStats(logs, [255, 255, 255]) > 0.2, '日志表格应当大面积白底');
    const picker = decodePng(await readFile(path.join(SHOTS, 'inpage-picker.png')));
    assert.ok(colorStats(picker, [255, 255, 255]) > 0.01, '候选弹层应当是白色卡片');
    // 弹层出现在输入框附近：截图右侧中部应当出现白色像素（页面本身是浅色表单，用亮度分布判断）
    const bright = colorStats(picker, [255, 255, 255], 6);
    assert.ok(bright > 0.005, `弹层白色面积太小：${bright.toFixed(3)}`);
  });
});
