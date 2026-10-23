// 后台：只接受扩展内消息，令牌不发内容脚本；快照与日志先落 IndexedDB，再转本机服务。
import './lib/idb.js';
import './lib/log.js';
import * as CDP from './lib/cdp.js';
import {omitPasswordValues} from './vendor/fbl/password-values.mjs';

// 只允许本机 127.0.0.1 的任意端口；端口可配是为了测试服务和常驻服务并存。
const API_HOST = '127.0.0.1';
const OPERATIONS = {
  sites: '读取目标站列表', item: '读取续填项', source: '读取来源资料', rules: '读取字段规则', file: '读取素材',
  stage: '准备上传文件', snapshot: '保存快照', snapshots: '读取快照', logs: '上传日志', settings: '读写设置',
  learn: '记录映射', remember: '记住表单', results: '保存填写结果', done: '标记待核实', skip: '跳过续填项',
  kit: '读取资料包', kits: '读取资料包列表', profile: '读取身份档案', queue: '读取任务队列',
  report: '读取统计', health: '检查本机服务', asset: '保存素材', ai: '读取 AI 状态',
  ai_suggest: '获取 AI 兜底建议',
  library: '读取或保存外链库', library_prepare: '准备外链复用任务',
  'agent/next': '等待 Agent 指令', 'agent/result': '回传 Agent 结果',
};
const DEFAULT_SETTINGS = {
  restore_after_reload: true, restore_after_submit_error: true, restore_window_hours: 2,
  auto_next: false, auto_next_sites: {}, fill_low_confidence: true, inline_asset_button: true,
  ai_fallback: true, snapshot_keep: 5, snapshot_days: 14, log_level: 'info',
};
const logStore = globalThis.BKLog.createStore({send: entries => request('logs', {}, {entries}).then(result => result.written)});

// ---------- 本机服务 ----------

async function base() {
  const {base} = await chrome.storage.local.get('base');
  if (!base) throw Error('请在扩展选项页粘贴续填列表地址');
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== API_HOST || !/^\/[\w-]{32,}\/$/.test(url.pathname)) {
    throw Error('连接地址必须是 http://127.0.0.1 的续填列表地址（含令牌）');
  }
  return base;
}

async function request(endpoint, query = {}, data, options = {}) {
  const operation = OPERATIONS[endpoint] || '本机服务请求';
  try {
    const url = new URL('api/' + endpoint, await base());
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, value);
    const headers = {'X-Fast-Backlink': '1', ...(data ? {'Content-Type': 'application/json'} : {})};
    const response = await fetch(url.href, {method: data ? 'POST' : 'GET', headers, redirect: 'error', credentials: 'omit',
      cache: 'no-store', ...(data ? {body: JSON.stringify(data)} : {})});
    if (!response.ok) {
      if (response.status === 403) throw Error('本机服务拒绝（403）');
      const body = await response.json().catch(() => ({}));
      throw Error(`${body.error || '本机服务请求失败'}（${response.status}）`);
    }
    if (options.bytes) {
      const raw = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (const byte of raw) binary += String.fromCharCode(byte);
      return {data: btoa(binary), type: response.headers.get('Content-Type')};
    }
    return await response.json();
  } catch (error) {
    throw Error(`${operation}失败：${error.message}`);
  }
}

// 日志服务的兜底：直接读扩展自己的 IndexedDB 环形缓冲。
async function localLogs(query = {}) {
  const days = Number(query.days || 7);
  const cutoff = Date.now() - days * 86400000;
  const items = await globalThis.BKIdb.all('logs');
  return items
    .filter(item => Date.parse(item.ts || 0) >= cutoff)
    .filter(item => !query.level || item.level === query.level)
    .filter(item => !query.cat || item.cat === query.cat)
    .filter(item => !query.site || item.site === query.site)
    .filter(item => !query.source || item.source === query.source)
    .slice(-(Number(query.limit) || 500));
}

// ---------- 每个标签页的状态 ----------

async function readTab(tabId) {
  const key = 'tab:' + tabId;
  const stored = (await chrome.storage.session.get(key))[key];
  return stored || {site: null, context: null, steps: [], submitted: false, step: 0, frames: {}};
}
async function writeTab(tabId, patch, eligible = () => true) {
  const current = await readTab(tabId);
  if (!eligible()) return null;
  const next = {...current, ...patch};
  if (current.submitted && patch.context && current.context?.site === patch.context.site &&
      current.context?.source_domain === patch.context.source_domain) next.submitted = true;
  await chrome.storage.session.set({['tab:' + tabId]: next});
  return next;
}
async function clearTab(tabId) {
  await chrome.storage.session.remove('tab:' + tabId);
}

async function settings() {
  const {settings} = await chrome.storage.local.get('settings');
  return {...DEFAULT_SETTINGS, ...(settings || {})};
}

async function patchSettings(patch) {
  const next = {...await settings(), ...patch};
  await chrome.storage.local.set({settings: next});
  request('settings', {}, {patch}).catch(() => {});
  return next;
}

// ---------- 会话 ----------

const sessionBindings = new Map();
function beginBinding(tabId, explicit, key) {
  // 同任务的顶层/子frame初始化共享绑定；不同任务或人工选择立即使旧请求失效。
  const previous = sessionBindings.get(tabId);
  if (!previous || (explicit && (previous.key !== key || previous.failed))) {
    sessionBindings.set(tabId, {pending: 0, failed: false, key});
  }
  const binding = sessionBindings.get(tabId);
  if (explicit) binding.pending++;
  return binding;
}
function bindingCurrent(tabId, binding, explicit) {
  return sessionBindings.get(tabId) === binding && (explicit || (!binding.pending && !binding.failed));
}

async function buildSession(tabId, message, sender, options = {}) {
  const child = !!sender.tab && (sender.frameId ?? 0) !== 0;
  const explicit = !!(message.id || (message.site && !child));
  const key = message.id ? 'task:' + message.id : 'site:' + message.site + '|' + String(message.url || '').split('#')[0];
  const binding = beginBinding(tabId, explicit, key);
  const eligible = () => bindingCurrent(tabId, binding, explicit);
  try {
    const current = await readTab(tabId);
    if (!eligible()) return null;
    let context = current.context;
    if (child && !message.id) {
      // 来源属于顶层页面，不能让嵌入页用自己的URL抢建整个标签页的任务。
      if (!context || (message.site && context.site !== message.site)) return null;
    } else if (message.id) {
      context = await request('item', {id: message.id});
    } else if (message.site) {
      if (!message.url) throw Error('缺少页面地址，无法读取来源资料');
      context = await request('source', {site: message.site, url: message.url});
    } else if (!context) {
      const site = current.site || (await chrome.storage.local.get('preferredSite')).preferredSite;
      if (site) context = await request('source', {site, url: message.url});
    }
    if (!context) return null;
    const rules = await request('rules');
    const prefs = await settings();
    const latest = await readTab(tabId);
    if (!eligible()) return null;
    const submissionLocked = !!context.submission_locked || (!!latest.submitted && latest.context?.site === context.site &&
      latest.context?.record?.id === context.record?.id && latest.context?.submit_url === context.submit_url);
    const committed = await writeTab(tabId, {context, site: context.site, submitted: submissionLocked}, eligible);
    if (!committed || !eligible()) return null;
    const submitted = committed.submitted;
    binding.failed = false;
    // 默认请求不得越过后来建立的显式绑定；提交锁成立时只采纳上下文，不填写。
    const type = options.adopt || submitted ? 'page:adopt' : 'page:session';
    const delivery = chrome.tabs.sendMessage(tabId, {type, context, rules, submitted, settings: prefs, step: latest.step || 0}).catch(() => {});
    if (options.wait) await delivery;
    if (!eligible()) return null;
    return {context, rules, settings: prefs, step: latest.step || 0, navigated: false, submitted, site: context.site};
  } catch (error) {
    if (explicit) binding.failed = true;
    throw error;
  } finally {
    if (explicit) binding.pending--;
  }
}

function frameSummaryTable(tab) {
  return Object.entries(tab.frames || {}).map(([frameId, summary]) => ({frameId: Number(frameId), ...summary}));
}

function aggregate(tab, tabId) {
  const frames = frameSummaryTable(tab);
  const top = frames.find(frame => frame.top) || frames[0] || {};
  const count = top.count || {filled: 0, confirm: 0, unmatched: 0, captcha: 0, total: 0};
  const subFields = frames.filter(frame => !frame.top).reduce((sum, frame) => sum + (frame.count?.total || 0), 0);
  const pending = (count.unmatched || 0) + (count.confirm || 0) + (subFields ? 0 : 0);
  // AI 建议按 frame 合并：顶层和跨域 iframe 各自持有索引，回填时要带 frameId。
  const aiItems = frames.flatMap(frame => (frame.ai?.suggestions || [])
    .map(item => ({...item, frameId: frame.frameId, label: item.label || ''})));
  const aiError = frames.map(frame => frame.ai?.error).find(Boolean) || null;
  const aiModel = frames.map(frame => frame.ai?.model).find(Boolean) || '';
  const ai = (aiItems.length || aiError)
    ? {enabled: top.ai?.enabled !== false, configured: top.ai?.configured !== false, model: aiModel,
       auto: frames.some(frame => frame.ai?.auto), suggestions: aiItems, error: aiError}
    : (top.ai || null);
  return {tabId, site: tab.context?.site || tab.site || null, source: tab.context?.source_domain || null,
    step: top.step ?? tab.step ?? 0, platform: top.platform || 'generic', count, frames,
    decisions: top.decisions || [], ai, submitted: !!tab.submitted,
    url: top.url || null, pending, badge: top.count?.captcha && !pending ? '·' : String(pending || '')};
}

async function badge(tabId, info) {
  const text = info.badge === '·' ? '' : (info.badge || '');
  await chrome.action.setBadgeText({tabId, text});
  await chrome.action.setBadgeBackgroundColor({tabId, color: info.badge === '·' ? '#7c3aed' : '#dba90a'});
  if (info.badge === '·') await chrome.action.setBadgeText({tabId, text: '·'});
}

// ---------- 快照 ----------

const snapshotKey = snapshot => `${snapshot.site}|${snapshot.source_domain}|${snapshot.form_fingerprint}|${snapshot.step_index || 0}|${snapshot.id}`;

async function saveSnapshot(snapshot, options = {}) {
  const secrets = [];
  const clean = omitPasswordValues(snapshot, secrets);
  const record = {...clean, key: snapshotKey(clean), form: `${clean.site}|${clean.source_domain}|${clean.form_fingerprint}`};
  await globalThis.BKIdb.put('snapshots', record);
  const current = await settings();
  await globalThis.BKIdb.trimSnapshots(current.snapshot_keep, current.snapshot_days);
  try {
    await request('snapshot', {}, clean);
  } catch (error) {
    await globalThis.BKIdb.put('meta', {k: 'snapshot_backlog', value: (await globalThis.BKIdb.get('meta', 'snapshot_backlog'))?.value + 1 || 1, at: new Date().toISOString()});
    logStore.ingest([{ts: new Date().toISOString(), level: 'warn', cat: 'snapshot', msg: 'disk_save_failed', reason: String(error.message)}]).catch(() => {});
  }
  return record;
}

async function snapshotsFor(query = {}) {
  const items = await globalThis.BKIdb.all('snapshots');
  const wanted = String(query.source || '').replace(/^www\./, '');
  const url = String(query.url || '').split('#')[0];
  return items
    .filter(item => item.site === query.site && (!wanted || item.source_domain === wanted || item.source_domain === query.source) &&
      (!url || String(item.url || '').split('#')[0] === url) &&
      (!query.fingerprint || item.form_fingerprint === query.fingerprint))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

async function snapshotDecision(query) {
  const current = await settings();
  const exact = await snapshotsFor(query);
  // 指纹是首选；页面结构略微变了（多一个字段、换个措辞）也允许按来源+网址取回最近一版。
  const samePage = exact.length ? exact : await snapshotsFor({site: query.site, source: query.source, url: query.url});
  if (!samePage.length) return null;
  const newest = samePage[0];
  const age = Date.now() - Date.parse(newest.created_at);
  const hours = Number(current.restore_window_hours || 2);
  if (age > hours * 3600000) return 'ask';
  return current.restore_after_reload === false ? 'ask' : 'auto';
}

// ---------- Agent CLI 命令通道 ----------

const AGENT_ACTIONS = new Set(['status', 'tabs', 'open', 'fill', 'ai', 'restore', 'remember', 'snapshot',
  'steps', 'state', 'activate', 'done', 'skip']);
let agentPolling = false;

function tabSummary(tab) {
  return {id: tab.id, url: tab.url || '', title: tab.title || '', active: !!tab.active, windowId: tab.windowId};
}

function samePage(left, right) {
  try {
    const a = new URL(left), b = new URL(right);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

async function httpTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(tab => /^https?:/i.test(tab.url || ''));
}

async function findAgentTab(args = {}) {
  if (args.tabId !== undefined && args.tabId !== null) {
    const tab = await chrome.tabs.get(Number(args.tabId)).catch(() => null);
    if (!tab) throw Error('找不到标签页 ' + args.tabId);
    return tab;
  }
  const wanted = String(args.url || '').split('#')[0];
  if (wanted) {
    const tabs = await httpTabs();
    const exact = tabs.find(tab => String(tab.url || '').split('#')[0] === wanted);
    if (exact) return exact;
    return tabs.find(tab => samePage(tab.url, wanted)) || null;
  }
  const [active] = await chrome.tabs.query({active: true, currentWindow: true});
  return active || null;
}

async function waitForContent(tabId, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === 'complete') {
      const reply = await chrome.tabs.sendMessage(tabId, {type: 'page:state'}, {frameId: 0}).catch(() => null);
      if (reply?.value) return tab;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error('页面内容脚本没有就绪（只支持 http/https 页面）');
}

async function tabCommand(tabId, type, data = {}, options = undefined) {
  const reply = await chrome.tabs.sendMessage(tabId, {type, ...data}, options);
  if (reply?.error) throw Error(reply.error);
  return reply?.value;
}

async function waitForReports(tabId, timeout = 3000) {
  // 内容脚本按 frame 上报；等汇总稳定下来，再把结果交给 CLI。
  const started = Date.now();
  let signature = '', stable = 0;
  while (Date.now() - started < timeout) {
    const tab = await readTab(tabId);
    const current = JSON.stringify(tab.frames || {});
    if (current === signature && Object.keys(tab.frames || {}).length) {
      stable += 1;
      if (stable >= 2) return tab;
    } else {
      stable = 0;
    }
    signature = current;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return readTab(tabId);
}

function agentView(tab, state) {
  const info = aggregate(state, tab.id);
  return {tab: tabSummary(tab), site: info.site, source: info.source, step: info.step,
    platform: info.platform, counts: info.count, pending: info.pending,
    decisions: info.decisions, frames: info.frames, ai: info.ai, submitted: info.submitted};
}

async function agentPrepare(args = {}, options = {}) {
  let item = null;
  if (args.item) {
    item = await request('item', {id: args.item});
    args = {...args, url: args.url || item.submit_url, site: args.site || item.site};
  }
  let tab = await findAgentTab(args);
  if (!tab && options.create) {
    const url = args.url || item?.submit_url;
    if (!url) throw Error('没有可打开的提交页地址');
    const created = await chrome.tabs.create({url, active: true});
    tab = await waitForContent(created.id);
  }
  if (!tab) throw Error(args.url ? '目标页没有打开：' + args.url : '没有可操作的活动标签页');
  if (!/^https?:/i.test(tab.url || '')) throw Error('只支持 http/https 页面');
  if (item && !samePage(tab.url, item.submit_url)) throw Error('标签页与续填项地址不一致');
  if (options.session || options.adopt) {
    const session = await buildSession(tab.id, {id: args.item, site: args.site, url: tab.url}, {},
      {adopt: !!options.adopt && !options.session, wait: true});
    if (!session) throw Error('这个来源拿不到资料：请从续填列表打开或先选项目');
  }
  return {tab, item};
}

async function agentStatus() {
  const tabs = await httpTabs();
  const active = tabs.find(tab => tab.active) || null;
  const view = active ? agentView(active, await readTab(active.id)) : null;
  return {
    extension_version: chrome.runtime.getManifest().version,
    service: await request('health').then(() => true).catch(() => false),
    tabs: tabs.length,
    active: view ? {id: view.tab.id, url: view.tab.url, title: view.tab.title, site: view.site,
      source: view.source, step: view.step, counts: view.counts, pending: view.pending,
      ai_pending: (view.ai?.suggestions || []).filter(item => item.key && !item.applied && !item.reason).length} : null,
  };
}

async function agentTabs() {
  const rows = [];
  for (const tab of (await httpTabs()).slice(0, 100)) {
    const state = await readTab(tab.id);
    rows.push({...tabSummary(tab), site: state.site || null, source: state.context?.source_domain || null,
      item: state.context?.record?.id || null, submitted: !!state.submitted});
  }
  return {tabs: rows};
}

async function agentOpen(args = {}) {
  let item = null;
  if (args.item) {
    item = await request('item', {id: args.item});
    args = {...args, url: args.url || item.submit_url, site: args.site || item.site};
  }
  if (!args.url) throw Error('open 需要 url');
  let tab = await findAgentTab({url: args.url});
  const opened = !tab;
  if (tab) {
    await chrome.tabs.update(tab.id, {active: true});
    chrome.windows?.update(tab.windowId, {focused: true}).catch(() => {});
    tab = await waitForContent(tab.id);
  } else {
    const created = await chrome.tabs.create({url: args.url, active: true});
    tab = await waitForContent(created.id);
  }
  if (item && !samePage(tab.url, item.submit_url)) throw Error('标签页与续填项地址不一致');
  if (args.fill === false) return {opened, tab: tabSummary(tab)};
  if (args.site || args.item) {
    await buildSession(tab.id, {id: args.item, site: args.site, url: tab.url}, {}, {wait: true});
  }
  const reply = await tabCommand(tab.id, 'page:fill', {force: !!args.force}).catch(() => null);
  const state = await waitForReports(tab.id);
  const view = agentView(tab, state);
  if (!Object.keys(state.frames || {}).length && reply?.count) view.counts = reply.count;
  return {opened, ...view};
}

async function agentFill(args = {}) {
  const {tab} = await agentPrepare(args, {create: !!args.open, session: true});
  const reply = await tabCommand(tab.id, 'page:fill', {force: !!args.force});
  const state = await waitForReports(tab.id);
  const view = agentView(tab, state);
  if (!Object.keys(state.frames || {}).length && reply?.count) {
    view.counts = reply.count;
    view.pending = (reply.count.unmatched || 0) + (reply.count.confirm || 0);
  }
  return view;
}

async function agentAi(args = {}) {
  const {tab} = await agentPrepare(args, {create: !!args.open, session: true});
  const current = await waitForReports(tab.id, 1200);
  const frameIds = Object.keys(current.frames || {}).map(Number);
  const targets = frameIds.length ? frameIds : [0];
  const suggestions = [];
  let filled = 0, skipped = 0, enabled = true, configured = true, error = null, reason = '';
  for (const frameId of targets) {
    const reply = await chrome.tabs.sendMessage(tab.id, {
      type: 'page:ai', action: args.apply ? 'auto' : 'suggest', minConf: args.minConf,
    }, {frameId}).catch(() => null);
    const value = reply?.value;
    if (value?.enabled === false) enabled = false;
    if (value?.configured === false) configured = false;
    if (value?.error) error = value.error;
    if (value?.reason) reason = value.reason;
    if (Array.isArray(value?.suggestions)) {
      suggestions.push(...value.suggestions.map(item => ({...item, frameId})));
    }
    if (value?.applied) {
      filled += Number(value.applied.filled) || 0;
      skipped += Number(value.applied.skipped) || 0;
    }
  }
  const state = await waitForReports(tab.id);
  return {...agentView(tab, state), result: {enabled, configured, error, reason, suggestions,
    applied: {filled, skipped}}};
}

async function agentRestore(args = {}) {
  const {tab} = await agentPrepare(args, {adopt: !!(args.site || args.item)});
  const value = await tabCommand(tab.id, 'page:restore', {snapshot: args.snapshot || undefined});
  const state = await waitForReports(tab.id);
  return {...agentView(tab, state), restored: value?.restored ?? null, conflicts: value?.conflicts ?? null};
}

async function agentRemember(args = {}) {
  const {tab} = await agentPrepare(args, {session: true});
  const value = await tabCommand(tab.id, 'page:remember');
  const state = await waitForReports(tab.id);
  const view = agentView(tab, state);
  return {...view, remembered: value?.remembered ?? null};
}

async function agentSnapshot(args = {}) {
  const {tab} = await agentPrepare(args, {adopt: !!(args.site || args.item)});
  const value = await tabCommand(tab.id, 'page:snapshot', {}, {frameId: 0});
  return {tab: tabSummary(tab), snapshot: value?.snapshot || null};
}

async function agentSteps(args = {}) {
  const {tab} = await agentPrepare(args, {adopt: !!(args.site || args.item)});
  const value = await tabCommand(tab.id, 'page:steps', {}, {frameId: 0});
  return {tab: tabSummary(tab), steps: value?.steps || [], complete: !!value?.complete};
}

async function agentState(args = {}) {
  const {tab} = await agentPrepare(args, {adopt: !!(args.site || args.item)});
  const value = await tabCommand(tab.id, 'page:state', {}, {frameId: 0});
  return {...agentView(tab, await readTab(tab.id)), page: value || null};
}

async function agentActivate(args = {}) {
  const {tab} = await agentPrepare(args, {session: true});
  return agentView(tab, await waitForReports(tab.id));
}

async function agentDone(args = {}) {
  let tab;
  if (args.id) {
    ({tab} = await agentPrepare({...args, item: args.id}, {adopt: true, create: !!args.open}));
  } else {
    tab = await findAgentTab(args);
    if (!tab) throw Error('没有可结束的标签页');
    const state = await readTab(tab.id);
    if (!state.context?.record?.id) throw Error('没有可结束的续填项：请带 --id');
  }
  const result = await handle({type: 'done', tabId: tab.id, data: {id: args.id, steps: args.steps}}, {});
  return {tab: tabSummary(tab), item: result};
}

async function agentSkip(args = {}) {
  if (!args.id) throw Error('skip 需要续填项 id');
  return {item: await request('skip', {}, {id: args.id, reason: args.reason || 'Agent 跳过'})};
}

async function executeAgentCommand(command) {
  const action = String(command?.action || '');
  const args = command?.args && typeof command.args === 'object' ? command.args : {};
  if (!AGENT_ACTIONS.has(action)) throw Error('未知 Agent 动作：' + action);
  switch (action) {
    case 'status': return agentStatus();
    case 'tabs': return agentTabs();
    case 'open': return agentOpen(args);
    case 'fill': return agentFill(args);
    case 'ai': return agentAi(args);
    case 'restore': return agentRestore(args);
    case 'remember': return agentRemember(args);
    case 'snapshot': return agentSnapshot(args);
    case 'steps': return agentSteps(args);
    case 'state': return agentState(args);
    case 'activate': return agentActivate(args);
    case 'done': return agentDone(args);
    case 'skip': return agentSkip(args);
    default: throw Error('未知 Agent 动作：' + action);
  }
}

let agentAlarmReady = false;

function ensureAgentPolling() {
  // 单测环境没有 alarms；真实扩展靠 alarms 在 service worker 休眠后把它叫醒。
  if (!chrome.alarms) return;
  if (!agentAlarmReady) {
    agentAlarmReady = true;
    chrome.alarms.create('fb-agent', {periodInMinutes: 0.5}, () => {
      if (chrome.runtime.lastError) chrome.alarms.create('fb-agent', {periodInMinutes: 1});
    });
  }
  pollAgentLoop();
}

async function pollAgentLoop() {
  if (!chrome.alarms || agentPolling) return;
  agentPolling = true;
  let retry = 1000;
  try {
    while (true) {
      let reply;
      try {
        reply = await request('agent/next', {wait: 20, version: chrome.runtime.getManifest().version});
        retry = 1000;
      } catch {
        // 服务未启动或令牌还没配置：指数退避，不把长轮询变成忙等。
        await new Promise(resolve => setTimeout(resolve, retry));
        retry = Math.min(retry * 2, 10000);
        continue;
      }
      const command = reply?.command;
      if (!command) continue;
      let body;
      try {
        body = {id: command.id, result: await executeAgentCommand(command)};
      } catch (error) {
        body = {id: command.id, error: String(error?.message || error)};
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await request('agent/result', {}, body);
          break;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }
  } finally {
    agentPolling = false;
  }
}

// ---------- 消息路由 ----------

const FORWARD_TO_FRAMES = ['page:fill', 'page:restore', 'page:snapshot', 'page:remember', 'page:done', 'page:skip', 'page:complete'];
let projectSelection = 0;

async function handle(message, sender) {
  ensureAgentPolling();
  // 扩展页在标签页里打开时 sender.tab 指向它自己，所以要用 sender.url 判断是不是网页上下文。
  const senderUrl = sender?.url || sender?.tab?.url || '';
  const fromPage = !!sender?.tab && /^https?:/i.test(senderUrl);
  // 侧边栏/日志页没有自己的网页上下文：用它们显式指定的 tabId，再退回当前活动标签页。
  let tabId = fromPage ? sender.tab.id : (message.tabId ?? null);
  if (tabId == null) {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    tabId = tabs[0]?.id ?? null;
  }
  if (!fromPage && ['session', 'frame:report', 'submitted', 'stage', 'cdp:fill', 'cdp:upload', 'cdp:click',
    'page:fillField'].includes(message.type)) {
    throw Error('仅允许页面内容脚本');
  }
  if (fromPage && ['agent:execute', 'agent:wake', 'panel:archive'].includes(message.type)) {
    throw Error('仅允许扩展页面');
  }
  switch (message.type) {
    case 'session': {
      const session = await buildSession(tabId, message, sender, {adopt: message.adopt === true, wait: message.adopt === true});
      return session;
    }
    case 'agent:wake': {
      ensureAgentPolling();
      return {polling: true};
    }
    case 'agent:execute': return executeAgentCommand(message.command || {});
    case 'rules': return request('rules');
    case 'ai:suggest': return request('ai_suggest', {}, message.payload || {});
    case 'sites': return request('sites');
    case 'kits': return request('kits');
    case 'kit': return request('kit', {site: message.site});
    case 'library:list':
      if (fromPage) throw Error('仅允许扩展页面读取外链库');
      return request('library', {site: message.site || '', q: message.q || '', status: message.status || 'all', scenario: message.scenario || ''});
    case 'library:save':
      if (fromPage) throw Error('仅允许扩展页面修改外链库');
      if (!message.record || typeof message.record !== 'object' || Array.isArray(message.record)) throw Error('外链记录格式无效');
      return request('library', {}, message.record);
    case 'library:open': {
      if (fromPage) throw Error('仅允许扩展页面打开外链库任务');
      if (!message.domain) throw Error('请选择外链平台');
      const list = await request('library', {site: message.site || '', q: message.domain});
      const item = list.items?.find(row => row.domain === message.domain);
      if (!item) throw Error('外链库中没有这个平台，请刷新后重试');
      const safeURL = value => {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('平台提交地址不安全');
        return url.href;
      };
      const url = safeURL(item.submit_url);
      if (message.fill !== true) {
        const tab = await chrome.tabs.create({url, active: true});
        return tabSummary(await chrome.tabs.get(tab.id));
      }
      if (!message.site || item.reuse_state !== 'ready') throw Error('当前产品不能直接复用，请先核对适用范围与提交状态');
      const prepared = await request('library_prepare', {}, {domain: message.domain, site: message.site});
      if (prepared.site !== message.site || !/^[a-f0-9]{32}$/.test(prepared.id || '')) throw Error('复用任务未能正确保存，请刷新后检查');
      return agentOpen({site: message.site, item: prepared.id, url: safeURL(prepared.submit_url), fill: true});
    }
    case 'profile': return request('profile');
    case 'kit-save': {
      if (!message.site || !message.kit) throw Error('缺少项目或资料包内容');
      return request('kit', {}, {site: message.site, kit: message.kit});
    }
    case 'profile-save': return request('profile', {}, {profile: message.profile});
    case 'asset': {
      const {site, key, name, data, alt} = message;
      if (!site || !key || !name || !data) throw Error('素材上传缺少参数');
      return request('asset', {}, {site, key, name, data, alt});
    }
    case 'queue': return request('queue', {site: message.site});
    case 'snapshots': return request('snapshots', message.query || {});
    case 'snapshot:service': return request('snapshot', {id: message.id});
    case 'logs': {
      // 先把扩展缓冲补发给服务（日志页读的是落盘后的 JSONL），服务不可用时退回本机缓冲。
      await logStore.deliver().catch(() => {});
      try {
        const remote = await request('logs', message.query || {});
        if (remote.length) return remote;
      } catch { /* 落到本机缓冲 */ }
      return localLogs(message.query || {});
    }
    case 'report': return request('report', message.query || {});
    case 'health': return request('health');
    case 'settings': return settings();
    case 'settings:patch': return patchSettings(message.patch || {});
    case 'file': {
      const tab = await readTab(tabId);
      const site = message.site || tab.context?.site;
      if (!site) throw Error('未选择项目，无法取素材');
      return request('file', {site, id: message.id, sha256: message.sha256}, null, {bytes: true});
    }
    case 'stage': {
      const tab = await readTab(tabId);
      const site = message.site || tab.context?.site;
      if (!site) throw Error('未选择项目，无法准备上传');
      return request('stage', {site, id: message.id, sha256: message.sha256});
    }
    case 'log': return logStore.ingest((message.entries || []).map(entry => ({...entry, tab: tabId ?? entry.tab, tab_id: tabId})));
    case 'frame:report': {
      const tab = await readTab(tabId);
      const frames = {...(tab.frames || {})};
      const frameId = sender.frameId ?? 0;
      frames[frameId] = {...(message.summary || {}), at: Date.now(), top: frameId === 0};
      const next = await writeTab(tabId, {frames, step: frames[0]?.step ?? tab.step});
      const info = aggregate(next, tabId);
      if (frameId === 0) await badge(tabId, info);
      return {ok: true};
    }
    case 'snapshot:save': {
      const record = await saveSnapshot(message.snapshot, message);
      return {saved: record.key, id: message.snapshot?.id};
    }
    case 'snapshot:latest': {
      const tab = await readTab(tabId);
      const items = await snapshotsFor({...message, site: tab.context?.site});
      return items[0] || null;
    }
    case 'snapshot:decision': return snapshotDecision({...message, site: (await readTab(tabId)).context?.site});
    case 'snapshot:list': return snapshotsFor({...message.query || message, site: (await readTab(tabId)).context?.site});
    case 'snapshot:load': {
      const item = await globalThis.BKIdb.get('snapshots', message.key);
      return item?.site === (await readTab(tabId)).context?.site ? item : null;
    }
    case 'learn': {
      const label = String(message.label || '').slice(0, 200);
      if (!label || !message.key) throw Error('记录映射需要字段标签和素材键');
      const tab = await readTab(tabId);
      return request('learn', {}, {label, key: message.key, source: tab.context?.source_domain || '', site: tab.context?.site || ''});
    }
    case 'remember': {
      const tab = await readTab(tabId);
      const data = {...message.data, id: tab.context?.record?.id, site: tab.context?.site, url: tab.context?.submit_url};
      if (!data.site && !data.id) throw Error('请先从续填列表打开或选择目标站');
      const result = await request('remember', {}, data);
      return result;
    }
    case 'results': {
      const tab = await readTab(tabId);
      if (!tab.context?.record?.id) return {skipped: true};
      return request('results', {}, {...message.data, id: tab.context.record.id, site: tab.context.site, url: tab.context.submit_url});
    }
    case 'submitted': {
      await writeTab(tabId, {submitted: true});
      const tab = await readTab(tabId);
      if (tab.context?.record?.id) {
        await request('submission-attempt', {}, {id: tab.context.record.id});
      }
      return {ok: true};
    }
    case 'done':
    case 'skip': {
      const tab = await readTab(tabId);
      const ident = message.data?.id || tab.context?.record?.id;
      if (!ident) throw Error('没有可结束的续填项');
      if (message.type === 'done' && ident !== tab.context?.record?.id) throw Error('请先打开目标存档，不能用当前页面结束另一条任务');
      if (message.type === 'done' && (await chrome.tabs.get(tabId)).url !== tab.context.submit_url) {
        throw Error('当前页面与存档不匹配，请先核实原提交结果');
      }
      let steps = message.data?.steps;
      if (message.type === 'done' && (!Array.isArray(steps) || !steps.some(step => step?.fields?.length))) {
        // “我已提交”要先把页面上的非敏感值交回来源库；面板没带步骤就找内容脚本要一份。
        const answer = await chrome.tabs.sendMessage(tabId, {type: 'page:steps'}).catch(() => null);
        steps = answer?.value?.steps || [];
      }
      if (message.type === 'done' && !steps.some(step => step?.fields?.length)) {
        throw Error('页面上没有可记住的字段：先在页面上填好或点“记住表单”');
      }
      const result = await request(message.type, {}, {...message.data, steps, id: ident, site: tab.context.site, url: tab.context.submit_url});
      await writeTab(tabId, {submitted: message.type === 'done'});
      return result;
    }
    case 'panel:open': {
      if (tabId) await chrome.sidePanel.open({tabId}).catch(() => {});
      return {ok: true};
    }
    case 'panel:state': {
      const tab = await readTab(tabId);
      const info = aggregate(tab, tabId);
      info.site ||= (await chrome.storage.local.get('preferredSite')).preferredSite || null;
      return {...info, settings: await settings(), base: await base().catch(() => null),
        service: await request('health').then(() => true).catch(() => false),
        aiStatus: await request('ai').catch(() => null)};
    }
    case 'panel:tasks': return request('queue', {site: message.site});
    case 'panel:archive': {
      const tab = await readTab(tabId);
      if (!tab.context?.site || tab.submitted) throw Error('先选择项目；已触发提交的页面请先核实结果，不重复排队');
      const current = await chrome.tabs.get(tabId);
      const frameIds = [...new Set([0, ...Object.keys(tab.frames || {}).map(Number)])];
      const frames = [];
      for (const frameId of frameIds) {
        const answer = await chrome.tabs.sendMessage(tabId, {type: 'page:archive'}, {frameId});
        if (answer?.error || !answer?.value?.snapshot) throw Error(answer?.error || `frame ${frameId} 读取失败，未保存不完整存档`);
        frames.push(answer.value.snapshot);
      }
      const result = await request('archive', {}, {site: tab.context.site, url: current.url, frames});
      if (!result?.id) throw Error('存档回执不完整，请刷新任务列表核实');
      const context = await request('item', {id: result.id});
      await writeTab(tabId, {context});
      return result;
    }
    case 'panel:activate': {
      const site = message.site;
      if (!site) throw Error('请选择目标站');
      const selection = ++projectSelection;
      const binding = beginBinding(tabId, true, 'selection:' + selection);
      const eligible = () => selection === projectSelection && bindingCurrent(tabId, binding, true);
      try {
        await request('kit', {site});
        const tab = tabId == null ? null : await chrome.tabs.get(tabId);
        if (!tab) throw Error('找不到当前标签页');
        if (!await writeTab(tab.id, {site}, eligible) || !eligible()) return {site, superseded: true};
        await chrome.storage.local.set({preferredSite: site});
        if (!eligible()) return {site, superseded: true};
        await chrome.tabs.sendMessage(tab.id, {type: 'page:activate', site}).catch(() => {});
        return {site};
      } catch (error) {
        binding.failed = true;
        throw error;
      } finally {
        binding.pending--;
      }
    }
    case 'panel:command': {
      const tab = tabId == null ? null : await chrome.tabs.get(tabId);
      if (!tab) throw Error('找不到当前标签页');
      const name = message.command;
      if (FORWARD_TO_FRAMES.includes(name)) {
        const results = await chrome.tabs.sendMessage(tab.id, {type: name, ...(message.data || {})}).catch(() => null);
        return {forwarded: name, results};
      }
      const result = await chrome.tabs.sendMessage(tab.id, {type: name, ...(message.data || {})}, {frameId: message.frameId ?? 0});
      return result;
    }
    case 'cdp:fill': {
      const tab = await readTab(tabId);
      const frame = message.frameId ?? sender.frameId ?? 0;
      const selector = message.selector;
      if (!selector) throw Error('缺少目标选择器');
      return CDP.trustedFill(tabId, selector, message.value, {clear: true});
    }
    case 'cdp:upload': {
      const staged = message.path;
      const root = message.root || staged;
      return CDP.uploadByPath(tabId, message.selector, staged, message.allowedRoot);
    }
    case 'cdp:press': return CDP.pressKey(tabId, message.selector, message.key);
    case 'cdp:click': return CDP.clickElement(tabId, message.selector);
    case 'panel:settings': return patchSettings(message.patch || {});
    case 'reset': {
      if (tabId) await clearTab(tabId);
      return {ok: true};
    }
    default: throw Error('未知操作：' + message.type);
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message.type !== 'string') return;
  handle(message, sender).then(value => reply({value})).catch(error => reply({error: error.message}));
  return true;
});

// ---------- 工具栏、菜单、快捷键 ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(() => {});
  ensureAgentPolling();
  const menus = [
    ['fb-fill-page', '填入整页（Fast-Backlink）', ['page', 'editable']],
    ['fb-ai', 'AI 兜底填写整页', ['page', 'editable']],
    ['fb-fill-field', '填入这个字段', ['editable']],
    ['fb-restore', '复原最近快照', ['page', 'editable']],
    ['fb-panel', '打开侧边栏', ['page', 'editable']],
  ];
  for (const [id, title, contexts] of menus) chrome.contextMenus.create({id, title, contexts}, () => void chrome.runtime.lastError);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'fb-panel') return chrome.sidePanel.open({tabId: tab.id}).catch(() => {});
  if (info.menuItemId === 'fb-ai') {
    return chrome.tabs.sendMessage(tab.id, {type: 'page:ai', action: 'fill'}).catch(() => {});
  }
  const command = {'fb-fill-page': 'page:fill', 'fb-fill-field': 'page:fillField', 'fb-restore': 'page:restore'}[info.menuItemId];
  if (!command) return;
  await chrome.tabs.sendMessage(tab.id, {type: command}).catch(() => {});
});

chrome.commands?.onCommand.addListener(async command => {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.id) return;
  const map = {'fill-page': 'page:fill', 'fill-field': 'page:fillField', 'restore-snapshot': 'page:restore'};
  const type = map[command];
  if (type) await chrome.tabs.sendMessage(tab.id, {type}).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => { sessionBindings.delete(tabId); clearTab(tabId); });
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  const tab = await readTab(tabId);
  // 页面重新加载：清掉 frame 汇总，但保留会话与已提交标记。
  await writeTab(tabId, {frames: {}});
  const info = aggregate(tab, tabId);
  await badge(tabId, {...info, badge: ''});
});
chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(() => {});
  ensureAgentPolling();
});
chrome.alarms?.onAlarm.addListener(alarm => {
  if (alarm.name === 'fb-agent') pollAgentLoop();
});

// 队列里的日志和快照在服务恢复后补发。
setInterval(() => { logStore.deliver().catch(() => {}); }, 60000);
