// 后台测试用的假 chrome / fetch / IndexedDB；background.js 去掉 import 行后在 vm 里跑。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TOKEN = 'x'.repeat(40);
const BASE = `http://127.0.0.1:18780/${TOKEN}/`;

function harness(options = {}) {
  const requests = [], badges = [], menus = [], messages = [];
  const local = {}, sessionStore = {};
  const context = {
    submit_url: 'https://source.example/form', site: 'probekits', source_domain: 'source.example',
    record: {id: 'a'.repeat(32), step: 0},
    assets: [{id: '0', key: 'logo', name: 'logo.png'}],
  };
  const chrome = {
    storage: {
      local: {
        get: async key => (key === 'base' ? {base: BASE} : {[key]: local[key]}),
        set: async data => Object.assign(local, data),
      },
      session: {
        get: async key => ({[key]: sessionStore[key]}),
        set: async data => Object.assign(sessionStore, data),
        remove: async key => {delete sessionStore[key];},
      },
    },
    runtime: {
      onMessage: {addListener: fn => {context.__listener = fn;}},
      onInstalled: {addListener: fn => {context.__installed = fn;}},
      onStartup: {addListener: () => {}},
      getManifest: () => ({version: '1.0.0'}),
      lastError: null,
    },
    action: {setBadgeText: async data => badges.push(data), setBadgeBackgroundColor: async () => {}},
    tabs: {
      sendMessage: async (tabId, message) => {
        messages.push({tabId, message});
        // 面板发起“我已提交”时，后台会向内容脚本要一份步骤。
        if (message?.type === 'page:steps') return {value: {steps: [{fields: [{label: 'Auto field', key: 'name', value: 'from-page'}]}], complete: false}};
        if (message?.type === 'page:state') return {value: {count: {filled: 1, confirm: 0, unmatched: 0, captcha: 0, total: 1}, decisions: []}};
        if (message?.type === 'page:fill') {
          const key = 'tab:' + tabId;
          sessionStore[key] = {...(sessionStore[key] || {}), frames: {0: {top: true, step: 0, platform: 'generic',
            count: {filled: 1, confirm: 0, unmatched: 0, captcha: 0, total: 1}, decisions: [], at: Date.now()}}};
          return {value: {count: {filled: 1, confirm: 0, unmatched: 0, captcha: 0, total: 1}}};
        }
        return {value: {ok: true}};
      },
      get: async tabId => ({id: tabId, url: 'https://source.example/form', title: 'Source form', active: true, windowId: 1}),
      create: async ({url}) => ({id: 2, url, title: '', active: true, windowId: 1}),
      update: async () => ({}),
      query: async () => [{id: 1, url: 'https://source.example/form', title: 'Source form', active: true, windowId: 1}],
      onRemoved: {addListener: () => {}},
      onUpdated: {addListener: () => {}},
    },
    windows: {update: async () => ({})},
    sidePanel: {setPanelBehavior: async () => {}, open: async () => {}},
    contextMenus: {create: item => menus.push(item), onClicked: {addListener: () => {}}},
    commands: {onCommand: {addListener: () => {}}},
    debugger: {attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onDetach: {addListener: () => {}}},
  };
  const fetch = async (url, options = {}) => {
    requests.push({url, options});
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      if (url.endsWith('api/archive')) return {ok: true, json: async () => ({id: 'a'.repeat(32), archive: {saved_fields: 2}}), headers: {get: () => 'application/json'}};
      if (url.includes('api/remember') && options.__fail) return {ok: false, status: 409, json: async () => ({error: '当前状态不允许续填'})};
      return {ok: true, status: 200, json: async () => ({saved: true, body}), headers: {get: () => 'application/json'}};
    }
    if (url.includes('api/item')) return {ok: true, json: async () => context, headers: {get: () => 'application/json'}};
    if (url.includes('api/source')) return {ok: true, json: async () => context, headers: {get: () => 'application/json'}};
    if (url.includes('api/rules')) return {ok: true, json: async () => ({labels: {}, sensitive: {}, navigation: {}, learned: {}}), headers: {get: () => 'application/json'}};
    if (url.includes('api/file')) return {ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: {get: () => 'image/png'}};
    if (url.includes('api/health')) return {ok: true, json: async () => ({name: 'fast-backlink', version: '1.0.0'}), headers: {get: () => 'application/json'}};
    if (url.includes('api/logs')) return {ok: true, json: async () => ({written: 1}), headers: {get: () => 'application/json'}};
    if (url.includes('api/queue')) return {ok: true, json: async () => [], headers: {get: () => 'application/json'}};
    return {ok: true, json: async () => ({ok: true}), headers: {get: () => 'application/json'}};
  };
  const BKIdb = {
    store: new Map(),
    async put(store, value) {this.store.set(`${store}:${value.key || value.k || value.seq || Math.random()}`, value);},
    async get(store, key) {return this.store.get(`${store}:${key}`);},
    async all(store) {return [...this.store.entries()].filter(([key]) => key.startsWith(store + ':')).map(([, value]) => value);},
    async trimSnapshots() {return 0;},
    async trimLogs() {return 0;},
  };
  const logged = [];
  const BKLog = {createStore: () => ({ingest: async entries => {logged.push(...entries); return entries.length;}, deliver: async () => 0, pendingCount: () => 0})};
  // import 行整体去掉，用沙箱里的同名全局代替（vendor 文件本身由 boundaries 测试校验哈希）。
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8')
    .split('\n').filter(line => !line.startsWith('import ')).join('\n');
  const sandbox = {chrome, fetch, URL, Uint8Array, btoa: value => Buffer.from(value, 'binary').toString('base64'),
    setTimeout, clearTimeout, setInterval: () => 0, console, JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, Error,
    BKIdb, BKLog, CDP: {trustedFill: async () => ({ok: true}), uploadByPath: async () => ({ok: true}),
      pressKey: async () => ({ok: true}), clickElement: async () => ({ok: true})},
    omitPasswordValues: value => value,
    globalThis: null, structuredClone};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const send = (message, sender) => new Promise(resolve => context.__listener(message, sender, resolve));
  const page = {tab: {id: 1}, frameId: 0, url: 'https://source.example/form'};
  // 补发请求是 fire-and-forget，断言前让微任务跑完。
  const flush = () => new Promise(resolve => setTimeout(resolve, 10));
  return {send, page, requests, badges, menus, messages, sessionStore, sandbox, logged, flush};
}

module.exports = {harness, TOKEN, BASE};
