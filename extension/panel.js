// 侧边栏：表单 / 素材 / 快照 / 日志 / 任务 / 设置。普通扩展页，便于自动化验收。
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
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
  return node;
};
const text = value => document.createTextNode(String(value ?? ''));
const icon = (name, options) => BKIcon.svg(name, options);

const STATUS_LABEL = {filled: '已填', pending: '待确认', confirm: '待确认', unmatched: '未匹配',
  captcha: '验证码', sensitive: '敏感', honeypot: '蜜罐', skipped: '跳过', failed: '失败'};
const state = {info: null, settings: {}, kit: null, sites: [], snapshots: [], target: null, view: 'form',
  filter: 'all', search: '', loading: true, lastError: null, snapshotError: null, aiLoading: false,
  tasksSite: '', verificationOnly: false, archiving: false, projectChanging: false, auth: null};
let refreshGeneration = 0, projectSelection = 0;

// ---------- 基础 UI ----------

BKIcon.hydrate();

function toast(message, tone = 'ok') {
  const box = $('#toasts');
  const item = el('div', {class: `toast ${tone}`}, icon(tone === 'err' ? 'alert' : tone === 'warn' ? 'info' : 'check'), text(message));
  box.append(item);
  setTimeout(() => item.remove(), 3600);
}

function confirmSheet(title, body, okText = '确定', danger = false) {
  const dialog = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  const ok = dialog.querySelector('button[value=ok]');
  ok.textContent = okText;
  ok.className = danger ? 'danger' : 'primary';
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), {once: true});
    for (const button of dialog.querySelectorAll('button')) {
      button.onclick = () => dialog.close(button.value);
    }
  });
}

const skeleton = (rows = 4) => el('div', {class: 'loading', 'aria-busy': 'true'},
  ...Array.from({length: rows}, () => el('div', {class: 'skel card'})));

function emptyState(options) {
  const ring = el('div', {class: 'ring'}, icon(options.icon || 'info'));
  return el('div', {class: 'empty'}, ring, el('b', {}, text(options.title)),
    options.body ? el('p', {}, text(options.body)) : null,
    options.actions ? el('div', {class: 'row'}, ...options.actions) : null);
}

function banner(tone, message, ...actions) {
  return el('div', {class: `banner ${tone}`}, icon(tone === 'err' ? 'alert' : tone === 'warn' ? 'info' : 'check'),
    el('div', {class: 'grow'}, text(message), actions.length ? el('div', {class: 'row', style: 'margin-top:4px'}, ...actions) : null));
}

// ---------- 顶部与统计 ----------

async function currentTab() {
  const tabs = await chrome.tabs.query({active: true, currentWindow: true});
  if (tabs[0]?.url?.startsWith('http')) return tabs[0];
  const all = await chrome.tabs.query({currentWindow: true});
  const http = all.filter(tab => tab.url?.startsWith('http'));
  return http.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

async function refresh({render = true} = {}) {
  const generation = ++refreshGeneration;
  let tab = await currentTab();
  let info = null, auth = null, errorMessage = null;
  try {
    auth = tab ? await send('auth:status', {tabId: tab.id}).catch(() => null) : null;
    if (auth?.task && auth.task.rootId !== tab?.id) {
      tab = await chrome.tabs.get(auth.task.rootId).catch(() => tab);
    }
    info = await send('panel:state', {tabId: tab?.id});
  } catch (error) {
    errorMessage = error.message;
  }
  const sites = state.sites.length ? state.sites : await send('sites').catch(() => []);
  if (generation !== refreshGeneration || state.projectChanging) return;
  state.tab = tab;
  state.auth = auth;
  state.info = info;
  if (info) state.settings = info.settings || {};
  state.lastError = errorMessage;
  state.sites = sites;
  const select = $('#site');
  const choosing = !select.disabled && document.activeElement === select && document.hasFocus();
  if (!choosing && select.options.length !== state.sites.length + 1) {
    select.replaceChildren(el('option', {value: ''}, text('（未选项目）')),
      ...state.sites.map(site => el('option', {value: site}, text(site))));
  }
  const selected = state.info?.site || '';
  // 原生菜单展开期间写value（即使同值）也会重置选择，不让轮询抢走操作。
  if (!choosing && select.value !== selected) select.value = selected;
  select.title = '项目选择自动保存，新页面沿用；续填任务使用其绑定项目';
  renderStatus();
  if (render) renderView();
}

function renderStatus() {
  const info = state.info;
  const status = $('#status');
  const conn = $('#conn');
  if (state.lastError) {
    status.textContent = state.lastError;
    conn.className = 'conn off';
    return;
  }
  if (!info) {status.textContent = '读取中…'; return;}
  if (!info.base) {
    status.replaceChildren(text('未连接本机服务 '), el('button', {class: 'link', onclick: () => chrome.runtime.openOptionsPage()}, text('去设置')));
    conn.className = 'conn off';
    return;
  }
  const count = info.count || {};
  status.textContent = [info.site || '未选项目', info.source || '—', `第 ${(info.step ?? 0) + 1} 步`,
    `已填 ${count.filled || 0}/${count.total || 0}`].join(' · ');
  conn.className = `conn ${info.service ? '' : 'off'}`;
  conn.title = info.service ? '本机服务已连接' : '本机服务未响应';
  conn.lastElementChild.textContent = info.service ? '本机' : '离线';
  for (const cell of document.querySelectorAll('[data-stat]')) {
    cell.textContent = String(count[cell.dataset.stat] || 0);
  }
  const total = Math.max(1, count.total || 1);
  const progress = $('#progress');
  progress.style.width = `${Math.round(((count.filled || 0) / total) * 100)}%`;
  progress.parentElement.classList.toggle('warn', !!(count.unmatched || count.confirm));
  const pending = (count.unmatched || 0) + (count.confirm || 0);
  const formCount = document.querySelector('[data-count=form]');
  formCount.hidden = !pending;
  formCount.textContent = String(pending);
}

// ---------- 视图 ----------

function switchView(view) {
  state.view = view;
  for (const button of document.querySelectorAll('nav.bk-tabs button')) button.setAttribute('aria-selected', String(button.dataset.tab === view));
  for (const section of document.querySelectorAll('main section')) section.hidden = section.dataset.panel !== view;
  renderView();
}

async function renderView() {
  if (state.view === 'form') renderForm();
  if (state.view === 'assets') {
    if (state.info?.site && (!state.kit || state.kit.site !== state.info.site)) {
      state.kit = await send('kit', {site: state.info.site}).catch(() => null);
    }
    await renderAssets();
  }
  if (state.view === 'snapshots') {await loadSnapshots(); renderSnapshots();}
  if (state.view === 'logs') await renderLogs();
  if (state.view === 'tasks') await renderTasks();
  if (state.view === 'settings') renderSettings();
}

// ---------- 表单 ----------

function formToolbar() {
  const search = el('input', {type: 'search', placeholder: '搜索字段…', value: state.search, 'aria-label': '搜索字段'});
  search.addEventListener('input', () => {state.search = search.value.trim(); renderForm();});
  const seg = el('div', {class: 'seg', role: 'group', 'aria-label': '过滤'});
  for (const [key, label] of [['all', '全部'], ['todo', '待处理'], ['filled', '已填']]) {
    seg.append(el('button', {type: 'button', 'data-filter': key, 'aria-pressed': String(state.filter === key),
      onclick: () => {state.filter = key; renderForm();}}, text(label)));
  }
  return el('div', {class: 'panel-head form-toolbar'},
    el('div', {class: 'search grow'}, icon('search'), search), seg,
    el('button', {class: 'icon ghost', title: 'AI 智能填充：直接补填安全空字段，无需二次确认', 'aria-label': 'AI 智能填充', onclick: requestAi}, icon('wand')),
    el('button', {class: 'icon ghost', title: '重新扫描并填写', 'aria-label': '重新扫描并填写', onclick: async () => {
      try {
        await send('panel:command', {command: 'page:fill', tabId: state.tab?.id});
        await refresh();
      } catch (error) {toast(error.message, 'err');}
    }}, icon('refresh')));
}

function aiCard(info) {
  const ai = info.ai;
  if (!ai) return state.aiLoading ? banner('warn', 'AI 正在分析剩余字段，通常几秒内完成…') : null;
  if (state.aiLoading || ai.busy) {
    return banner('warn', 'AI 正在分析剩余字段，通常几秒内完成…');
  }
  if (ai.error) {
    return banner('warn', `AI 智能填充：${ai.error}`,
      el('button', {class: 'sm', onclick: requestAi}, text('重试')),
      el('button', {class: 'sm ghost', onclick: () => switchView('settings')}, text('设置')));
  }
  const pending = (ai.suggestions || []).filter(item => item.key && !item.applied && !item.reason);
  if (!pending.length) {
    const failed = (ai.suggestions || []).filter(item => item.key && item.reason && !item.applied);
    if (failed.length) {
      return banner('warn', `AI 找到 ${failed.length} 项，但都不适合当前字段（超长或选项不匹配）`);
    }
    return null;
  }
  const labels = new Map((info.decisions || []).map(item => [item.index, item.label]));
  const rows = el('div', {class: 'pad stack tight'});
  for (const item of pending) {
    rows.append(el('div', {class: 'rowitem'},
      el('div', {class: 'body'},
        el('div', {class: 'title'}, el('strong', {class: 'truncate'}, text(labels.get(item.i) || item.label || `字段 ${item.i}`)),
          el('span', {class: 'keychip'}, text(item.key)),
          (item.frameId ?? 0) !== 0 ? el('span', {class: 'pill line'}, text('iframe')) : null),
        el('div', {class: 'meta'}, text(`${Math.round((item.conf || 0) * 100)}%${item.why ? ' · ' + item.why : ''}`)),
        item.display ? el('div', {class: 'value'}, text(item.display)) : null),
      el('div', {class: 'acts', style: 'opacity:1'},
        el('button', {class: 'icon ghost', title: '定位到页面字段', 'aria-label': '定位',
          onclick: () => locate(item.i, item.frameId ?? 0)}, icon('eye')),
        el('button', {class: 'sm', onclick: () => applyAi([item])}, text('填入')))));
  }
  return el('div', {class: 'card flat ai-card'},
    el('div', {class: 'head', style: 'flex-wrap:wrap;gap:6px'}, icon('wand'),
      el('h3', {}, text(`AI 建议 · ${pending.length}`)),
      el('span', {class: 'muted'}, text([ai.applied ? `已补填 ${ai.applied}` : '', ai.model || ''].filter(Boolean).join(' · '))),
      el('button', {class: 'sm ghost', title: '重新分析', 'aria-label': '重新分析', onclick: requestAi}, text('重试')),
      el('button', {class: 'sm', onclick: () => applyAi(pending)}, text('全部填入')),
      el('button', {class: 'sm ghost', onclick: dismissAi}, text('忽略'))),
    rows);
}

async function requestAi() {
  if (state.aiLoading) return;
  state.aiLoading = true;
  if (state.view === 'form') renderForm();
  try {
    const frames = new Set([0, ...(state.info?.frames || []).filter(frame => !frame.top).map(frame => frame.frameId)]);
    await Promise.all([...frames].map(frameId => send('panel:command', {command: 'page:ai',
      data: {action: 'fill'}, tabId: state.tab?.id, frameId}).catch(() => null)));
  } catch (error) {toast(error.message, 'err');}
  finally {
    state.aiLoading = false;
    await refresh();
    const ai = state.info?.ai;
    if (!ai) toast('AI 未返回结果，先在页面上选一个目标项目', 'warn');
    else if (ai.enabled === false) {toast('AI 未启用，请在设置中配置并开启 AI 智能填充', 'warn'); switchView('settings');}
    else if (ai.error) toast(ai.error, 'err');
    else {
      const open = (ai.suggestions || []).filter(item => item.key && !item.applied && !item.reason).length;
      const applied = (ai.suggestions || []).filter(item => item.applied).length;
      if (applied) toast(`AI 已补填 ${applied} 项`);
      else if (open) toast('仍有字段无法安全填写，请检查资料或页面', 'warn');
      else toast('AI 没有找到可填的项', 'warn');
    }
  }
}

async function applyAi(items) {
  const list = (items || []).filter(item => item && item.i !== undefined && item.i !== null);
  if (!list.length) return;
  const groups = new Map();
  for (const item of list) {
    const frameId = item.frameId ?? 0;
    if (!groups.has(frameId)) groups.set(frameId, []);
    groups.get(frameId).push(item.i);
  }
  try {
    let filled = 0;
    for (const [frameId, indices] of groups) {
      try {
        const result = await send('panel:command', {command: 'page:ai', data: {action: 'apply', indices},
          tabId: state.tab?.id, frameId});
        filled += result?.value?.filled ?? 0;
      } catch { /* frame 已关闭或刷新，跳过这一组 */ }
    }
    toast(filled ? `AI 已填入 ${filled} 项` : '没有可填入的项', filled ? 'ok' : 'warn');
    await refresh();
  } catch (error) {toast(error.message, 'err');}
}

async function dismissAi() {
  try {
    const frames = new Set([0, ...(state.info?.frames || []).filter(frame => !frame.top).map(frame => frame.frameId)]);
    for (const frameId of frames) {
      await send('panel:command', {command: 'page:ai', data: {action: 'dismiss'}, tabId: state.tab?.id, frameId})
        .catch(() => {});
    }
    await refresh();
  } catch (error) {toast(error.message, 'err');}
}

function renderForm() {
  const panel = $('[data-panel=form]');
  const info = state.info;
  const loginBlocked = ['login', 'google', 'manual'].includes(state.auth?.kind) ||
    (state.auth?.task && state.auth.task.state !== 'complete');
  for (const button of document.querySelectorAll('footer [data-command]')) {
    button.disabled = !!(loginBlocked || !info?.base || !info?.site || !state.tab || state.projectChanging);
  }
  const authBinding = JSON.stringify([state.tab?.id, state.tab?.url, info?.site,
    state.auth?.authorized, state.auth?.kind, state.auth?.task?.state]);
  const previousLogin = panel.querySelector('#auth-card');
  // 同页输入时不打断草稿；换页面、项目或登录阶段必须重建授权范围。
  if (previousLogin?.dataset.binding === authBinding && previousLogin.contains(document.activeElement) &&
      document.activeElement.tagName === 'INPUT') return;
  const toolbar = panel.querySelector('.form-toolbar');
  const focused = toolbar?.contains(document.activeElement) ? document.activeElement : null;
  panel.replaceChildren();
  if (state.loading && !info) return void panel.append(skeleton(5));
  if (state.lastError) {
    panel.append(banner('err', state.lastError,
      el('button', {class: 'sm', onclick: () => refresh()}, text('重试')),
      el('button', {class: 'sm', onclick: () => chrome.runtime.openOptionsPage()}, text('打开设置'))));
    return;
  }
  if (!info) return void panel.append(emptyState({title: '读取中…', body: '正在和本机服务同步。'}));
  if (!info.base) {
    panel.append(emptyState({icon: 'link', title: '还没连接本机服务',
      body: '在设置页粘贴本机续填列表的完整地址（含令牌），资料、快照与日志都从这里读。',
      actions: [el('button', {class: 'primary', onclick: () => chrome.runtime.openOptionsPage()}, text('打开设置页'))]}));
    return;
  }
  if (!state.tab) {
    panel.append(emptyState({icon: 'globe', title: '当前不是网页', body: '切到一个提交表单的标签页，再回到这里。'}));
    return;
  }
  if (!info.site) {
    panel.append(emptyState({icon: 'form', title: '先选一个目标项目',
      body: '用上方的项目下拉选一个项目，当前页面会立刻开始填；也可以从续填列表点“开始”进入。'}));
    return;
  }
  const login = BKAuthPanel.card({auth: state.auth, tab: state.tab, send, refresh, toast, el, text});
  if (login) {login.dataset.binding = authBinding; panel.append(login);}
  if (loginBlocked) return;
  const controls = toolbar || formToolbar();
  for (const button of controls.querySelectorAll('[data-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
  }
  panel.append(controls);
  if (focused) focused.focus({preventScroll: true});
  panel.append(el('div', {class: 'panel-head'},
    el('span', {class: 'grow muted'}, text('卡在验证？存档后到「任务」集中处理。')),
    el('button', {class: 'sm', disabled: state.archiving ? true : null, onclick: async () => {
      if (state.archiving) return;
      state.archiving = true;
      renderForm();
      try {
        await send('panel:archive', {tabId: state.tab.id});
        toast('已存档到待处理');
      } catch (error) {toast(error.message, 'err');}
      finally {state.archiving = false; renderForm();}
    }}, icon('clock'), text(state.archiving ? '正在存档…' : '存档待验证'))));
  const suggestions = aiCard(info);
  if (suggestions) panel.append(suggestions);
  const all = info.decisions || [];
  const shown = all.filter(item => {
    if (state.search && !`${item.label} ${item.key || ''} ${item.value || ''}`.toLowerCase().includes(state.search.toLowerCase())) return false;
    if (state.filter === 'filled') return item.status === 'filled' && item.hasValue;
    if (state.filter === 'todo') return ['pending', 'confirm', 'unmatched', 'captcha', 'sensitive'].includes(item.status) || !item.hasValue;
    return true;
  });
  if (!all.length) {
    panel.append(emptyState({icon: 'search', title: '没有识别到字段',
      body: '这个页面可能是纯展示页，或表单在单独的 iframe 里。换一页试试，或点右上角重新扫描。'}));
  } else if (!shown.length) {
    panel.append(emptyState({icon: 'check', title: state.filter === 'filled' ? '还没有填上的字段' : '没有待处理字段',
      body: state.filter === 'filled' ? '点底部“一键填写”开始。' : '这一页的字段都处理完了。'}));
  }
  const aiByIndex = new Map((info.ai?.suggestions || [])
    .filter(item => (item.frameId ?? 0) === 0).map(item => [item.i, item]));
  const list = el('ul', {class: 'list'});
  for (const item of shown) {
    const statusKey = ['captcha', 'sensitive'].includes(item.status) ? 'captcha' : item.status;
    const statusNode = BKIcon.status(statusKey, {label: false, title: STATUS_LABEL[item.status] || item.status});
    const meterTone = item.status === 'filled' ? '' : ['pending', 'confirm'].includes(item.status) ? 'warn' : 'idle';
    const meter = el('span', {class: `meter ${meterTone}`, title: `置信度 ${Math.round((item.conf || 0) * 100)}%`},
      el('i', {style: `width:${Math.round((item.conf || 0) * 100)}%`}));
    const row = el('li', {class: 'rowitem fieldrow bk-item', 'data-status': item.status, 'data-index': item.index,
      tabindex: '0', onclick: () => locate(item.index),
      onkeydown: event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); locate(item.index);}}},
      el('span', {class: 'lead'}, statusNode),
      el('div', {class: 'body'},
        el('div', {class: 'title'}, el('strong', {class: 'truncate'}, text(item.label || '未命名字段')),
          item.required ? el('span', {class: 'pill line'}, text('必填')) : null,
          item.key ? el('span', {class: 'keychip'}, text(item.key)) : null,
          aiByIndex.has(item.index) ? el('span', {class: 'pill brand'}, text('AI')) : null),
        el('div', {class: 'meta'}, text(`${STATUS_LABEL[item.status] || item.status} · ${item.widget || ''}${item.reason ? ' · ' + item.reason : ''}`), meter),
        item.value ? el('div', {class: 'value'}, text(item.value)) : null),
      el('div', {class: 'acts'},
        el('button', {class: 'icon ghost', title: '定位到页面字段', 'aria-label': '定位', onclick: event => {event.stopPropagation(); locate(item.index);}}, icon('eye')),
        el('button', {class: 'icon ghost', title: '换素材', 'aria-label': '换素材', onclick: event => {event.stopPropagation(); pickFor(item);}}, icon('wand'))));
    list.append(row);
  }
  if (shown.length) panel.append(list);
  const frames = (info.frames || []).filter(frame => !frame.top);
  if (frames.length) {
    panel.append(el('div', {class: 'card flat frame-list'},
      el('div', {class: 'head'}, icon('globe'), el('h3', {}, text(`内嵌表单 ${frames.length} 个`)),
        el('span', {class: 'muted'}, text('跨域 iframe 各自填写'))),
      el('div', {class: 'pad stack tight'}, ...frames.map(frame => el('div', {class: 'row between'},
        el('span', {class: 'truncate mono', style: 'font-size:10px'}, text(frame.url || '')),
        el('span', {class: 'pill'}, text(`已填 ${frame.count?.filled || 0}/${frame.count?.total || 0}`)))))));
  }
}

async function locate(index, frameId = 0) {
  try {await send('panel:command', {command: 'page:locate', data: {index}, tabId: state.tab?.id, frameId});}
  catch (error) {toast(error.message, 'err');}
}

function pickFor(item) {
  state.target = item;
  switchView('assets');
}

// ---------- 素材 ----------

async function renderAssets() {
  const panel = $('[data-panel=assets]');
  panel.replaceChildren();
  if (!state.info?.site) {
    panel.append(emptyState({icon: 'image', title: '先选一个目标项目', body: '素材按项目存放，选中项目后才能取用。'}));
    return;
  }
  if (!state.kit) {
    panel.append(skeleton(3));
    try {
      state.kit = await send('kit', {site: state.info.site});
    } catch (error) {
      panel.replaceChildren(emptyState({icon: 'alert', title: '读不到资料包', body: error.message}));
      return;
    }
    panel.replaceChildren();
  }
  const target = state.target;
  panel.append(el('div', {class: 'panel-head'},
    el('div', {class: 'grow muted truncate'}, text(target ? `选中字段：${target.label}` : '先在表单页点“选”，或用页面里的 Alt+F')),
    el('button', {class: 'icon ghost', title: '刷新素材', 'aria-label': '刷新素材', onclick: async () => {state.kit = null; await renderAssets();}}, icon('refresh'))));
  const assets = state.kit.assets || [];
  const media = el('div', {class: 'media-grid'});
  for (const asset of assets) {
    const image = el('img', {alt: asset.alt || asset.name});
    const thumb = el('div', {class: 'thumb'}, image);
    send('file', {id: asset.id}).then(file => {image.src = `data:${file.type};base64,${file.data}`;})
      .catch(() => {thumb.replaceChildren(emptyState({icon: 'image', title: '预览失败'}));});
    media.append(el('div', {class: 'media bk-asset'},
      thumb,
      el('div', {class: 'info'}, el('div', {class: 'name truncate'}, text(asset.name || asset.file || asset.key)),
        el('div', {class: 'dims'}, text(`${asset.w || '?'}×${asset.h || '?'} · ${Math.round((asset.bytes || 0) / 1024)}KB`))),
      el('div', {class: 'bar'}, el('button', {class: 'sm', disabled: !target, onclick: () => applyAsset(asset)}, text('填入')),
        el('button', {class: 'sm icon', title: '复制文件名', 'aria-label': '复制文件名', onclick: () => copy(asset.name || asset.key)}, icon('copy')))));
  }
  panel.append(el('div', {class: 'section'},
    el('div', {class: 'head'}, icon('image'), el('h2', {}, text(`媒体素材${assets.length ? ' · ' + assets.length : ''}`))),
    assets.length ? media : emptyState({icon: 'image', title: '这个项目还没有媒体素材',
      body: '去素材库管理页上传 logo、截图或视频；缺视频时表单里会标“缺素材”交人。',
      actions: [el('button', {onclick: () => chrome.runtime.openOptionsPage()}, text('打开素材库'))]})));

  const fields = Object.entries(state.kit.fields || {});
  const search = el('input', {type: 'search', placeholder: '过滤文本素材…', 'aria-label': '过滤文本素材'});
  const list = el('div', {class: 'stack tight'});
  const draw = filter => {
    list.replaceChildren();
    for (const [key, field] of fields) {
      const value = field.value ?? (field.variants ? Object.entries(field.variants).sort((a, b) => Number(a[0]) - Number(b[0]))[0]?.[1] : '') ?? (field.list || []).join(', ');
      if (filter && !`${key} ${value}`.toLowerCase().includes(filter.toLowerCase())) continue;
      list.append(el('div', {class: 'rowitem', style: 'cursor:default'},
        el('div', {class: 'body'},
          el('div', {class: 'title'}, el('strong', {}, text(key)),
            el('span', {class: 'muted'}, text(`${String(value || '').length} 字符${field.variants ? ' · ' + Object.keys(field.variants).length + ' 档' : ''}`))),
          el('div', {class: 'value', style: 'white-space:normal'}, text(String(value || '（空）').slice(0, 220)))),
        el('div', {class: 'acts', style: 'opacity:1'},
          el('button', {class: 'sm', disabled: !target, onclick: () => applyValue(key, value)}, text('填入')),
          el('button', {class: 'sm icon', title: '复制', 'aria-label': '复制', onclick: () => copy(String(value || ''))}, icon('copy')))));
    }
    if (!list.children.length) list.append(el('div', {class: 'muted', style: 'padding:8px 2px'}, text('没有匹配的素材。')));
  };
  search.addEventListener('input', () => draw(search.value.trim()));
  panel.append(el('div', {class: 'section'},
    el('div', {class: 'head'}, icon('key'), el('h2', {}, text(`文本素材 · ${fields.length}`)), el('div', {class: 'search grow'}, icon('search'), search)),
    list));
  draw('');
}

async function copy(value) {
  try {await navigator.clipboard.writeText(value); toast('已复制');}
  catch {toast('复制失败，请手动选择', 'warn');}
}

async function applyValue(key, value) {
  if (!state.target) return toast('先在表单页选一个字段', 'warn');
  try {
    const result = await send('panel:command', {command: 'page:set', data: {index: state.target.index, key, value: String(value ?? '')}, tabId: state.tab?.id});
    if (!result?.value?.ok) throw Error(result?.value?.reason || '写入失败');
    toast('已填入 ' + key);
    await refresh();
  } catch (error) {toast(error.message, 'err');}
}

async function applyAsset(asset) {
  if (!state.target) return toast('先在表单页选一个字段', 'warn');
  try {
    const result = await send('panel:command', {command: 'page:set', data: {index: state.target.index, key: asset.key, value: {id: asset.id, key: asset.key}}, tabId: state.tab?.id});
    if (!result?.value?.ok) throw Error(result?.value?.reason || '写入失败');
    toast('已填入 ' + asset.name);
    await refresh();
  } catch (error) {toast(error.message, 'err');}
}

// ---------- 快照 ----------

async function loadSnapshots() {
  state.snapshotError = null;
  try {
    state.snapshots = await send('snapshot:list', {query: {url: state.tab?.url, source: state.info?.source}, tabId: state.tab?.id}) || [];
  } catch (error) {
    state.snapshots = [];
    state.snapshotError = error.message;
  }
  const badge = document.querySelector('[data-count=snapshots]');
  if (badge) {badge.hidden = !state.snapshots.length; badge.textContent = String(state.snapshots.length);}
}

function renderSnapshots() {
  const panel = $('[data-panel=snapshots]');
  panel.replaceChildren();
  panel.append(el('div', {class: 'panel-head'},
    el('div', {class: 'grow muted'}, text(`本机保留 ${state.settings.snapshot_keep || 5} 版 / ${state.settings.snapshot_days || 14} 天`)),
    el('button', {class: 'icon ghost', title: '刷新', 'aria-label': '刷新快照', onclick: async () => {await loadSnapshots(); renderSnapshots();}}, icon('refresh'))));
  if (state.snapshotError) {panel.append(banner('err', state.snapshotError)); return;}
  if (!state.snapshots.length) {
    panel.append(emptyState({icon: 'clock', title: '还没有这个页面的快照',
      body: '填一次表单就会自动存一版；刷新、重开或提交报错后可以一键复原。'}));
    return;
  }
  const table = el('table', {class: 'data'},
    el('thead', {}, el('tr', {}, ...['时间', '方式', '字段', '操作'].map(head => el('th', {}, text(head))))));
  const body = el('tbody');
  for (const snapshot of state.snapshots.slice(0, 20)) {
    const when = new Date(snapshot.created_at);
    const fields = (snapshot.steps?.[snapshot.step_index || 0]?.fields || []).filter(field => field.value || field.checked);
    body.append(el('tr', {class: 'snapshot'},
      el('td', {}, el('div', {class: 'when'}, text(when.toLocaleString('zh-CN', {hour12: false}))),
        el('div', {class: 'muted'}, text(`第 ${(snapshot.step_index ?? 0) + 1} 步`))),
      el('td', {}, el('span', {class: `pill ${snapshot.by === 'manual' ? 'warn' : 'brand'}`}, text(snapshot.by === 'manual' ? '人工' : '扩展'))),
      el('td', {class: 'mono'}, text(String(fields.length))),
      el('td', {}, el('div', {class: 'acts'},
        el('button', {class: 'sm', onclick: () => restoreSnapshot(snapshot)}, text('复原')),
        el('button', {class: 'sm ghost', onclick: () => showDiff(snapshot)}, text('差异'))))));
  }
  table.append(body);
  panel.append(el('div', {class: 'card flat'}, table));
}

async function restoreSnapshot(snapshot) {
  try {
    await send('panel:command', {command: 'page:restore', data: {snapshot}, tabId: state.tab?.id});
    toast('已开始复原');
    await refresh();
  } catch (error) {toast(error.message, 'err');}
}

function showDiff(snapshot) {
  const panel = $('[data-panel=snapshots]');
  panel.querySelector('.diff-card')?.remove();
  const current = new Map((state.info?.decisions || []).map(item => [item.label, item.value]));
  const body = el('tbody');
  for (const record of snapshot.steps?.[snapshot.step_index || 0]?.fields || []) {
    if (record.skipped) continue;
    const value = current.get(record.label);
    const same = String(record.value ?? '') === String(value ?? '');
    body.append(el('tr', {},
      el('td', {}, text(record.label)),
      el('td', {class: 'mono clamp-2'}, text(String(record.value ?? '').slice(0, 90))),
      el('td', {class: 'mono clamp-2'}, text(String(value ?? '').slice(0, 90))),
      el('td', {}, el('span', {class: `pill ${same ? 'ok' : value === undefined ? 'line' : 'warn'}`},
        text(same ? '相同' : value === undefined ? '页面无此字段' : '不同')))));
  }
  const table = el('table', {class: 'data diff-table'},
    el('thead', {}, el('tr', {}, ...['字段', '快照', '当前', '差异'].map(head => el('th', {}, text(head))))), body);
  panel.prepend(el('div', {class: 'card flat diff-card'},
    el('div', {class: 'head'}, icon('eye'), el('h3', {}, text('快照 vs 页面当前值')),
      el('button', {class: 'icon ghost', title: '关闭', 'aria-label': '关闭差异',
        onclick: event => event.currentTarget.closest('.diff-card').remove()}, icon('x'))),
    table));
}

// ---------- 日志 ----------

async function renderLogs() {
  const panel = $('[data-panel=logs]');
  panel.replaceChildren();
  const level = el('select', {style: 'width:auto', 'aria-label': '级别'},
    ...['', 'debug', 'info', 'warn', 'error'].map(value => el('option', {value}, text(value || '全部级别'))));
  const category = el('select', {style: 'width:auto', 'aria-label': '类别'},
    ...[['', '全部类别'], ['fill', '填写'], ['match', '匹配'], ['ai', 'AI 智能填充'], ['verify', '回读'], ['snapshot', '快照'],
      ['restore', '复原'], ['captcha', '验证码'], ['auto-next', '自动下一步'], ['error', '错误'], ['perf', '汇总'],
      ['upload', '上传'], ['user', '人工']]
      .map(([value, label]) => el('option', {value}, text(label))));
  const body = el('tbody');
  const table = el('table', {class: 'data'},
    el('thead', {}, el('tr', {}, ...['时间', '级别', '内容'].map(head => el('th', {}, text(head))))), body);
  const draw = async () => {
    body.replaceChildren(el('tr', {}, el('td', {colspan: 3}, el('div', {class: 'skel line'}))));
    let rows = [];
    try {
      rows = await send('logs', {query: {days: 1, level: level.value || undefined, cat: category.value || undefined,
        source: state.info?.source || undefined, limit: 120}, tabId: state.tab?.id}) || [];
    } catch (error) {rows = [];}
    body.replaceChildren();
    for (const row of rows.slice().reverse()) {
      body.append(el('tr', {},
        el('td', {class: 'mono'}, text(String(row.ts || '').slice(11, 19))),
        el('td', {}, el('span', {class: `lvl ${row.level || 'info'}`}, el('i'), text(row.level || 'info'))),
        el('td', {}, text([row.msg, row.key ? `key=${row.key}` : '', row.field?.label ? `字段=${row.field.label}` : '',
          row.reason ? `原因=${row.reason}` : ''].filter(Boolean).join(' · ')))));
    }
    if (!body.children.length) {
      body.append(el('tr', {}, el('td', {colspan: 3}, emptyState({icon: 'log', title: '这个页面还没有日志'}))));
    }
  };
  level.addEventListener('change', draw);
  category.addEventListener('change', draw);
  panel.append(el('div', {class: 'panel-head'}, level, category, el('div', {class: 'grow'}),
    el('button', {class: 'icon ghost', title: '刷新', 'aria-label': '刷新日志', onclick: draw}, icon('refresh')),
    el('button', {class: 'sm', onclick: () => chrome.tabs.create({url: 'logs.html'})}, text('完整日志'))));
  panel.append(el('div', {class: 'card flat'}, table));
  await draw();
}

// ---------- 任务 ----------

async function renderTasks() {
  const panel = $('[data-panel=tasks]');
  panel.replaceChildren();
  let queue = [];
  try {queue = await send('panel:tasks', {site: state.tasksSite || undefined}) || [];}
  catch (error) {
    panel.append(banner('err', '任务读取失败：' + error.message,
      el('button', {class: 'sm', onclick: renderTasks}, text('重试'))));
    return;
  }
  const badge = document.querySelector('[data-count=tasks]');
  if (badge) {badge.hidden = !queue.length; badge.textContent = String(queue.length);}
  const projects = el('select', {'aria-label': '待处理项目', style: 'width:auto'},
    el('option', {value: ''}, text('所有项目')),
    ...state.sites.map(site => el('option', {value: site}, text(site))));
  projects.value = state.tasksSite;
  projects.onchange = () => {state.tasksSite = projects.value; renderTasks();};
  const only = el('button', {class: 'sm', 'aria-pressed': String(state.verificationOnly), onclick: () => {
    state.verificationOnly = !state.verificationOnly; renderTasks();
  }}, text('仅剩验证'));
  panel.append(el('div', {class: 'panel-head'}, projects, only,
    el('button', {class: 'sm ghost', onclick: renderTasks}, text('刷新'))));
  if (state.verificationOnly) queue = queue.filter(item => item.archive?.only_verification);
  panel.append(el('div', {class: 'panel-head'}, el('div', {class: 'grow muted'}, text(`待处理 ${queue.length} 项 · 存档不自动提交`))));
  if (!queue.length) {
    panel.append(emptyState({icon: 'list', title: '没有待处理的续填项',
      body: '在表单页点「存档待验证」。存档会保留填写内容，验证码和密码不会保存。'}));
    return;
  }
  for (const item of queue) {
    panel.append(el('div', {class: 'card task'},
      el('div', {class: 'pad stack tight'},
        el('div', {class: 'row between'}, el('strong', {}, text(item.source_domain || item.source || '')),
          el('span', {class: 'pill brand'}, text(item.site))),
        el('div', {class: 'url truncate'}, text(item.submit_url || '')),
        el('div', {class: 'muted'}, text(item.archive?.saved_at ?
          `${item.archive.only_verification ? '仅剩验证' : '有内容需核对'} · 已存 ${item.archive.saved_fields} 项${item.archive.multistep ? ' · 多步表单需逐步复原' : ''}` : item.blocker || item.status)),
        item.archive?.remaining?.length ? el('div', {class: 'muted'}, text('待补：' + item.archive.remaining.join('、'))) : null,
        el('div', {class: 'row wrap'},
          el('button', {class: 'primary sm', onclick: () => chrome.tabs.create({url: item.submit_url + (item.submit_url.includes('#') ? '&' : '#') + 'bk=' + item.id})}, text(item.archive?.saved_at ? '打开并复原' : '打开并填')),
          el('button', {class: 'sm', onclick: () => finish(item, 'skip')}, text('跳过')),
          el('button', {class: 'sm ghost', onclick: () => finish(item, 'done')}, text('我已提交'))))));
  }
}

async function finish(item, action) {
  const ok = await confirmSheet(action === 'skip' ? '跳过这条存档？' : '确认已提交？',
    action === 'skip' ? '只移出待处理，保留存档和历史。' : '请先打开这条存档并自行提交。这里仅标记待核实，不代表已收录。',
    action === 'skip' ? '保留并跳过' : '确认已提交');
  if (!ok) return;
  const reason = action === 'skip' ? '人工跳过；保留存档与历史' : '';
  try {
    await send(action, {data: {id: item.id, reason}, tabId: state.tab?.id});
    toast(action === 'skip' ? '已跳过' : '已标记完成（待核实）');
    await renderTasks();
  } catch (error) {toast(error.message, 'err');}
}

// ---------- 设置 ----------

const SETTING_ROWS = [
  ['floating_window', '网站快捷悬浮窗', '开启显示网页底部快捷条；关闭后隐藏，侧栏与快捷键仍可使用'],
  ['restore_after_reload', '刷新后自动复原', '页面清空或重开时，2 小时内的快照自动填回'],

  ['auto_next', '多步表单自动点下一步', '只在填好且回读一致时点；永不点提交类按钮'],
  ['fill_low_confidence', '低置信度也自动填', '0.5–0.85 的匹配照填，但标黄待确认'],
  ['ai_fallback', '填写后自动使用 AI', '启用并配置 AI 智能填充后，自动分析剩余的安全空字段'],
  ['inline_asset_button', '字段内素材按钮', '聚焦输入框时右侧出现 ⚡，打开候选'],
];

function renderSettings() {
  const panel = $('[data-panel=settings]');
  // AI 表单留在原位保留草稿和焦点，其余设置按当前标签页重新读取。
  const existing = panel.querySelector('#ai-config');
  if (existing) existing.refreshStatus(state.info?.aiStatus);
  for (const child of [...panel.children]) if (child !== existing) child.remove();
  if (state.info && !state.info.base) {
    panel.append(banner('warn', '还没连接本机服务。',
      el('button', {class: 'sm', onclick: () => chrome.runtime.openOptionsPage()}, text('打开设置'))));
  }
  const behaviors = el('div', {class: 'settings-group'}, el('h3', {}, text('填写行为')));
  for (const [key, label, hint] of SETTING_ROWS) {
    const input = el('input', {type: 'checkbox', class: 'smooth-switch', 'aria-label': label});
    input.checked = state.settings[key] !== false;
    input.addEventListener('change', () => saveSetting({[key]: input.checked}, input));
    behaviors.append(el('label', {class: 'switch bk-switch'},
      el('span', {class: 'txt'}, el('b', {}, text(label)), el('small', {}, text(hint))), input));
  }
  panel.append(behaviors);

  if (!existing) panel.prepend(BKAISettings.create({el, text, send, status: state.info?.aiStatus,
    onSaved: status => {if (state.info) state.info.aiStatus = status;}}));

  const source = state.info?.source;
  if (source) {
    const map = state.settings.auto_next_sites || {};
    const override = el('input', {type: 'checkbox', class: 'smooth-switch'});
    override.checked = map[source] ?? state.settings.auto_next;
    override.addEventListener('change', () => saveSetting({auto_next_sites: {...(state.settings.auto_next_sites || {}), [source]: override.checked}}, override));
    panel.append(el('div', {class: 'settings-group'},
      el('h3', {}, text('本站覆盖')),
      el('label', {class: 'switch bk-switch'},
        el('span', {class: 'txt'}, el('b', {}, text(source)), el('small', {}, text('只对当前来源生效，优先于全局开关'))), override)));
  }

  const snapshots = el('div', {class: 'settings-group'}, el('h3', {}, text('快照与日志')));
  for (const [key, label, hint, min] of [['restore_window_hours', '自动复原窗口（小时）', '超过窗口只提示、不自动填', 0],
    ['snapshot_keep', '每表单保留版本', 'IndexedDB 与本机各留一份', 1],
    ['snapshot_days', '快照保留天数', '超过就清理', 1]]) {
    const input = el('input', {type: 'number', class: 'num', min: String(min), value: String(state.settings[key] ?? '')});
    input.addEventListener('change', () => saveSetting({[key]: Number(input.value)}, input));
    snapshots.append(el('label', {class: 'inline-num'}, el('span', {}, el('b', {}, text(label)), el('small', {}, text(hint))), input));
  }
  const level = el('select', {style: 'width:auto', 'aria-label': '日志级别'},
    ...['debug', 'info', 'warn', 'error'].map(value => el('option', {value}, text(value))));
  level.value = state.settings.log_level || 'info';
  level.addEventListener('change', () => saveSetting({log_level: level.value}, level));
  snapshots.append(el('label', {class: 'inline-num'}, el('span', {}, el('b', {}, text('日志级别')), el('small', {}, text('debug 记录每次匹配与回读'))), level));
  panel.append(snapshots);

  panel.append(el('div', {class: 'settings-group'},
    el('h3', {}, text('更多')),
    el('div', {class: 'pad stack tight'},
      el('div', {class: 'row wrap'},
        el('button', {onclick: () => chrome.runtime.openOptionsPage()}, icon('image'), text('素材库管理')),
        el('button', {onclick: () => chrome.tabs.create({url: 'logs.html'})}, icon('log'), text('日志页')),
        el('button', {onclick: () => send('health').then(() => toast('本机服务正常')).catch(error => toast(error.message, 'err'))}, icon('globe'), text('检查服务'))),
      el('dl', {class: 'shortcuts'},
        el('dt', {}, text('Alt+F')), el('dd', {}, text('当前字段候选')),
        el('dt', {}, text('Alt+Shift+F')), el('dd', {}, text('填整页')),
        el('dt', {}, text('Alt+R')), el('dd', {}, text('复原最近快照'))))));
}

async function saveSetting(patch, input) {
  try {
    state.settings = await send('panel:settings', {patch});
    toast('设置已保存');
  } catch (error) {
    toast(error.message, 'err');
    if (input && input.type === 'checkbox') input.checked = !input.checked;
  }
}

// ---------- 事件 ----------

for (const button of document.querySelectorAll('nav.bk-tabs button')) {
  button.addEventListener('click', () => switchView(button.dataset.tab));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('nav.bk-tabs button')];
    const index = tabs.indexOf(button);
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1]
      : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    event.preventDefault();
    next.focus();
    switchView(next.dataset.tab);
  });
}

for (const button of document.querySelectorAll('footer [data-command]')) {
  button.addEventListener('click', async () => {
    const command = button.dataset.command;
    try {
      if (command === 'page:fill') await send('panel:command', {command, tabId: state.tab?.id});
      else if (command === 'page:restore') {
        const snapshot = await send('snapshot:latest', {url: state.tab?.url, source: state.info?.source, tabId: state.tab?.id});
        await send('panel:command', {command, data: snapshot ? {snapshot} : {}, tabId: state.tab?.id});
      } else if (command === 'page:remember') {
        const result = await send('panel:command', {command, tabId: state.tab?.id});
        const count = result?.value?.remembered;
        toast(count ? `已记住 ${count} 个字段` : '已记住这个表单');
      } else if (command === 'page:done') {
        const ok = await confirmSheet('确认已提交？', '只会记「待核实」并写完成回执，不写 ledger、不算 submitted。', '确认提交');
        if (!ok) return;
        await send('done', {data: {}, tabId: state.tab?.id});
        toast('已记待核实');
      }
      await refresh();
    } catch (error) {toast(error.message, 'err');}
  });
}

$('#site').addEventListener('change', async event => {
  const site = event.target.value;
  if (!site) return;
  const selection = ++projectSelection;
  ++refreshGeneration;
  state.projectChanging = true;
  event.target.disabled = true;
  event.target.setAttribute('aria-busy', 'true');
  let saved = false;
  try {
    const tab = (await currentTab()) || state.tab;
    if (selection !== projectSelection) return;
    const selected = await send('panel:activate', {site, tabId: tab?.id});
    if (selected?.superseded || selection !== projectSelection) return;
    state.kit = null;
    await new Promise(resolve => setTimeout(resolve, 350));
    saved = true;
  } catch (error) {
    if (selection === projectSelection) toast(error.message, 'err');
  } finally {
    if (selection === projectSelection) {
      state.projectChanging = false;
      try {
        await refresh();
      } finally {
        if (selection === projectSelection) {
          event.target.disabled = false;
          event.target.removeAttribute('aria-busy');
          if (saved) toast(`已保存默认项目：${site}`);
        }
      }
    }
  }
});
$('#settings').addEventListener('click', () => switchView('settings'));

chrome.tabs.onActivated?.addListener(() => refresh());
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {if (changeInfo.status === 'complete' || changeInfo.url) refresh();});
setInterval(() => {if (!document.hidden) refresh();}, 4000);

renderView();
refresh().finally(() => {state.loading = false; renderView();});
