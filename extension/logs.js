// 全量日志页：筛选、搜索、展开详情、导出 JSONL、诊断包、周报。
const CATEGORIES = ['scan', 'match', 'ai', 'fill', 'verify', 'upload', 'snapshot', 'restore', 'captcha', 'user', 'service', 'error', 'perf', 'auto-next'];
const $ = selector => document.querySelector(selector);
const send = async (type, data = {}) => {
  const response = await chrome.runtime.sendMessage({type, ...data});
  if (response?.error) throw Error(response.error);
  return response?.value;
};
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
  return node;
};
const text = value => document.createTextNode(String(value ?? ''));
const icon = name => BKIcon.svg(name);

BKIcon.hydrate();
for (const name of CATEGORIES) $('#cat').append(el('option', {value: name}, text(name)));

let rows = [];
let expanded = new Set();

function toast(message, tone = 'ok') {
  const box = $('#toasts');
  const item = el('div', {class: `toast ${tone}`}, icon(tone === 'err' ? 'alert' : tone === 'warn' ? 'info' : 'check'), text(message));
  box.append(item);
  setTimeout(() => item.remove(), 3600);
}

function setStats() {
  const shown = filtered();
  const stats = {entries: rows.length, shown: shown.length,
    warn: rows.filter(item => item.level === 'warn').length, error: rows.filter(item => item.level === 'error').length};
  for (const cell of document.querySelectorAll('[data-stat]')) cell.textContent = String(stats[cell.dataset.stat] || 0);
  $('#status').textContent = rows.length ? `共 ${rows.length} 条日志，显示 ${shown.length} 条` : '没有日志';
  $('#range-pill').textContent = `最近 ${$('#days').value} 天`;
}

function filtered() {
  const search = $('#search').value.trim().toLowerCase();
  if (!search) return rows;
  return rows.filter(item => JSON.stringify(item).toLowerCase().includes(search));
}

function detailRow(item) {
  return el('tr', {class: 'detail'}, el('td', {colspan: 6},
    el('pre', {}, text(JSON.stringify(item, null, 2)))));
}

function row(item, index) {
  const key = `${item.ts}|${index}`;
  const main = el('tr', {class: 'rowmain', tabindex: '0', 'aria-expanded': String(expanded.has(key)),
    onclick: () => toggle(key), onkeydown: event => {if (event.key === 'Enter') toggle(key);}},
    el('td', {class: 'mono'}, text(String(item.ts || '').replace('T', ' ').slice(5, 19))),
    el('td', {}, el('span', {class: `lvl ${item.level || 'info'}`}, el('i'), text(item.level || 'info'))),
    el('td', {}, el('span', {class: 'pill line'}, text(item.cat || '—'))),
    el('td', {}, el('div', {}, text(item.site || '—')), el('div', {class: 'hash'}, text(item.source || ''))),
    el('td', {}, text([item.msg, item.key ? `key=${item.key}` : '', item.field?.label ? `字段=${item.field.label}` : '',
      item.reason ? `原因=${item.reason}` : '', item.value ? String(item.value).slice(0, 120) : '',
      item.ms ? `${item.ms}ms` : ''].filter(Boolean).join(' · '))),
    el('td', {}, icon(expanded.has(key) ? 'down' : 'chev')));
  return {main, key};
}

function toggle(key) {
  if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
  draw();
}

function draw() {
  const body = $('#rows');
  body.replaceChildren();
  const shown = filtered().slice(-500).reverse();
  if (!shown.length) {
    body.append(el('tr', {}, el('td', {colspan: 6, class: 'empty-cell'},
      el('div', {class: 'empty'}, el('div', {class: 'ring'}, icon('log')),
        el('b', {}, text(rows.length ? '没有匹配的日志' : '还没有日志')),
        el('p', {}, text(rows.length ? '换一个关键词或放宽筛选。' : '在页面上填一次表，日志会在这里出现。'))))));
  }
  shown.forEach((item, index) => {
    const {main, key} = row(item, index);
    body.append(main);
    if (expanded.has(key)) body.append(detailRow(item));
  });
  setStats();
}

async function load() {
  $('#status').textContent = '读取中…';
  try {
    rows = await send('logs', {query: {
      days: Number($('#days').value),
      level: $('#level').value || undefined,
      cat: $('#cat').value || undefined,
      limit: 2000,
    }}) || [];
  } catch (error) {
    rows = [];
    $('#status').textContent = error.message;
    toast(error.message, 'err');
  }
  draw();
}

$('#reload').addEventListener('click', load);
$('#search').addEventListener('input', draw);
for (const id of ['#days', '#level', '#cat']) $(id).addEventListener('change', load);

$('#export').addEventListener('click', () => {
  const blob = new Blob([filtered().map(item => JSON.stringify(item)).join('\n')], {type: 'application/x-ndjson'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `fast-backlink-${new Date().toISOString().slice(0, 10)}.jsonl`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast(`已导出 ${filtered().length} 条`);
});

$('#bundle').addEventListener('click', async () => {
  const runs = new Map();
  for (const item of rows) {
    if (!item.run) continue;
    const bucket = runs.get(item.run) || [];
    bucket.push(item);
    runs.set(item.run, bucket);
  }
  const last = [...runs.entries()].sort((a, b) => (b[1].at(-1)?.ts || '').localeCompare(a[1].at(-1)?.ts || ''))[0];
  const bundle = {exported_at: new Date().toISOString(), run: last?.[0] || null, entries: last?.[1] || rows.slice(-50),
    fields: (last?.[1] || []).filter(item => item.field).map(item => item.field)};
  try {
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    toast(`诊断包已复制（run ${bundle.run || '-'}，${bundle.entries.length} 条）`);
  } catch {toast('复制失败，请检查剪贴板权限', 'err');}
});

$('#report').addEventListener('click', async () => {
  try {
    const report = await send('report', {query: {days: Number($('#days').value)}});
    const box = $('#summary');
    box.hidden = false;
    $('#summary-line').textContent = `${report.entries} 条日志 · 复原成功率 ${Math.round((report.restore_success_rate || 0) * 100)}%`;
    const body = $('#summary-body');
    body.replaceChildren();
    if (!(report.sources || []).length) {
      body.append(el('p', {class: 'muted'}, text('这段时间没有填写记录。跑几页表单后周报就有数据了。')));
    } else {
      const table = el('table', {class: 'data reporttable'},
        el('thead', {}, el('tr', {}, ...['来源', '轮次', '填写率', '未匹配', '平均耗时'].map(head => el('th', {}, text(head))))));
      const tbody = el('tbody');
      for (const source of report.sources) {
        tbody.append(el('tr', {},
          el('td', {}, text(source.source)),
          el('td', {class: 'mono'}, text(String(source.runs))),
          el('td', {}, el('div', {class: 'bar-row'}, el('div', {class: `bar ${source.fill_rate >= 0.85 ? '' : 'warn'}`},
            el('i', {style: `width:${Math.round(source.fill_rate * 100)}%`})), el('span', {class: 'mono'}, text(`${Math.round(source.fill_rate * 100)}%`)))),
          el('td', {class: 'mono'}, text(String(source.unmatched))),
          el('td', {class: 'mono'}, text(`${source.avg_ms}ms`))));
      }
      table.append(tbody);
      body.append(table);
    }
    const extra = [];
    if (report.unmatched_labels?.length) {
      extra.push(el('div', {}, el('b', {}, text('未匹配标签排行')), el('ul', {},
        ...report.unmatched_labels.slice(0, 10).map(item => el('li', {}, text(`${item.label} × ${item.count}`))))));
    }
    if (report.failed_widgets?.length) {
      extra.push(el('div', {}, el('b', {}, text('失败控件')), el('ul', {},
        ...report.failed_widgets.slice(0, 8).map(item => el('li', {}, text(`${item.widget} × ${item.count}`))))));
    }
    if (report.errors?.length) {
      extra.push(el('div', {}, el('b', {}, text('错误排行')), el('ul', {},
        ...report.errors.slice(0, 8).map(item => el('li', {}, text(`${item.error} × ${item.count}`))))));
    }
    if (extra.length) body.append(el('div', {class: 'grid2'}, ...extra));
    toast('周报已生成');
  } catch (error) {toast(error.message, 'err');}
});

load();
