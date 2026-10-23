// 端到端测试环境：临时资料包 + 本机服务 + 两个静态端口（跨域 iframe）+ 真实 Chromium 加载解压扩展。
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXTENSION = path.join(REPO, 'extension');
export const PAGES = path.join(EXTENSION, 'test-pages');
export const API_PORT = Number(process.env.BK_E2E_API_PORT || 18790);
export const PORT_A = Number(process.env.BK_E2E_PORT_A || 18801);
export const PORT_B = Number(process.env.BK_E2E_PORT_B || 18802);

export const KIT = {
  schema_version: 2,
  site: 'probekits',
  source: '端到端测试夹具资料包',
  fields: {
    name: {value: 'ProbeKits'},
    url: {value: 'https://probekits.com/'},
    domain: {value: 'probekits.com'},
    tagline: {variants: {40: 'Free peripheral tests in browser', 60: 'Free browser-based tests for your computer peripherals'}},
    short_description: {variants: {
      100: 'Browser checks for mouse, keyboard and webcam, free and without an account.',
      160: 'Check mouse, keyboard, display, webcam, microphone and gamepad signals in your browser, free, with no account needed.',
    }},
    description: {variants: {
      250: 'ProbeKits provides free browser-based checks for mouse, keyboard and display input. Use the tools without an account or installation.',
      500: 'ProbeKits provides free browser-based checks for mouse, keyboard, display, webcam, microphone, audio and gamepad input. Use the tools without an account or installation. Camera and microphone checks need browser permission. Results describe signals the browser can observe; they are not repair advice or a warranty.',
    }},
    maker_story: {value: 'I built ProbeKits after buying a used keyboard and needing a quick way to check every key.'},
    features: {list: ['Mouse test', 'Keyboard test', 'Display test']},
    use_cases: {list: ['Checking second-hand hardware']},
    audience: {value: 'People buying or repairing computers'},
    category: {value: 'Utilities', alternates: ['Hardware Testing', 'Art', 'Music']},
    tags: {list: ['mouse test', 'keyboard test', 'display test']},
    pricing_model: {value: 'Free'},
    pricing_text: {value: 'Free, no account needed'},
    price_from: {value: '19'},
    launch_date: {value: '2026-09-27'},
    founded_year: {value: '2026'},
    platforms: {list: ['Web']},
    languages: {list: ['English']},
    alternatives: {list: ['Manual inspection']},
    license: {value: 'Proprietary'},
    email: {value: 'maker@probekits.test'},
    signature: {value: 'ProbeKits Team'},
    github_url: {value: 'https://github.com/fanjing188/probekits'},
    demo_url: {value: 'https://probekits.com/tools'},
    changelog_url: {value: 'https://probekits.com/changelog'},
    privacy_url: {value: 'https://probekits.com/privacy'},
    message: {value: 'Submitted by the maker through the official form.'},
  },
  assets: [],
  qa_overrides: {'How did you hear about us': 'Google search'},
};

export const PROFILE = {
  schema_version: 2,
  fields: {
    maker_name: 'Fan Jing', first_name: 'Fan', last_name: 'Jing', role: 'Founder', email: 'maker@probekits.test',
    company: 'ProbeKits', country: 'China', city: 'Shenzhen', twitter: '@probekits',
    twitter_url: 'https://twitter.com/probekits', linkedin: 'https://www.linkedin.com/in/probekits',
    website_personal: 'https://fanjing.test',
  },
  qa: {
    'How did you hear about us': 'Google search',
    'Are you the owner': 'Yes',
    'Team size': '1',
    'Funding': 'Bootstrapped',
    'Launch status': 'Launched',
  },
  qa_overrides: {},
};

// 断言用的期望值：与资料包一一对应，手写而不是复用扩展的算法。
export const EXPECTED = {
  name: 'ProbeKits',
  url: 'https://probekits.com/',
  domain: 'probekits.com',
  tagline40: 'Free peripheral tests in browser',
  tagline60: 'Free browser-based tests for your computer peripherals',
  short100: 'Browser checks for mouse, keyboard and webcam, free and without an account.',
  short160: 'Check mouse, keyboard, display, webcam, microphone and gamepad signals in your browser, free, with no account needed.',
  description250: 'ProbeKits provides free browser-based checks for mouse, keyboard and display input. Use the tools without an account or installation.',
  description500: 'ProbeKits provides free browser-based checks for mouse, keyboard, display, webcam, microphone, audio and gamepad input. Use the tools without an account or installation. Camera and microphone checks need browser permission. Results describe signals the browser can observe; they are not repair advice or a warranty.',
  category: 'Hardware Testing',
  categoryExact: 'Utilities',
  tags: 'mouse test, keyboard test, display test',
  email: 'maker@probekits.test',
  hear: 'Google search',
  owner: 'Yes',
  team: '1',
  funding: 'Bootstrapped',
  free: 'Yes',
  launch: '2026-09-27',
  founded: '2026',
  price: '19',
  makerStory: 'I built ProbeKits after buying a used keyboard and needing a quick way to check every key.',
  message: 'Submitted by the maker through the official form.',
  logo: 'logo-512.png',
  screenshot: 'homepage-1280x800.png',
  video: 'demo.mp4',
};

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function portFree(port) {
  return new Promise(resolve => {
    const socket = net.connect({port, host: '127.0.0.1'});
    socket.once('connect', () => {socket.destroy(); resolve(false);});
    socket.once('error', () => resolve(true));
    setTimeout(() => {socket.destroy(); resolve(true);}, 500);
  });
}

const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.mp4': 'video/mp4', '.gif': 'image/gif', '.json': 'application/json'};

async function serveStatic(port, root) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const target = path.join(root, path.normalize(url.pathname).replace(/^\/+/, ''));
    if (!target.startsWith(root)) {response.writeHead(403).end(); return;}
    try {
      const body = await readFile(target);
      response.writeHead(200, {'Content-Type': MIME[path.extname(target)] || 'application/octet-stream'});
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await listen(server, port);
  return server;
}

// 生成测试用素材：真 PNG（校验尺寸用）与真 MP4（走 CDP 上传）。
async function makeAssets(dir) {
  const python = `
import struct, zlib, sys
def png(path, width, height, rgb=(90, 120, 200)):
    raw = b''.join(b'\\x00' + bytes(rgb) * width for _ in range(height))
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    body = (b'\\x89PNG\\r\\n\\x1a\\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))
    open(path, 'wb').write(body)
png(sys.argv[1] + '/logo-512.png', 512, 512, (79, 70, 229))
png(sys.argv[2] + '/homepage-1280x800.png', 1280, 800, (16, 163, 74))
`;
  await writeFile(path.join(path.dirname(dir), 'make-assets.py'), python);
  const {execFile} = await import('node:child_process');
  await new Promise((resolve, reject) => execFile('python3', [path.join(path.dirname(dir), 'make-assets.py'), dir, dir], error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => execFile('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1', '-pix_fmt', 'yuv420p', path.join(dir, 'demo.mp4')],
    error => error ? reject(error) : resolve()));
  const logo = await readFile(path.join(dir, 'logo-512.png'));
  const screenshot = await readFile(path.join(dir, 'homepage-1280x800.png'));
  const video = await readFile(path.join(dir, 'demo.mp4'));
  return [
    {id: 'logo-512', key: 'logo', file: 'logo-512.png', mime: 'image/png', w: 512, h: 512, bytes: logo.length, alt: 'ProbeKits logo'},
    {id: 'homepage-1280x800', key: 'screenshot', file: 'homepage-1280x800.png', mime: 'image/png', w: 1280, h: 800, bytes: screenshot.length, alt: 'ProbeKits home page'},
    {id: 'demo-mp4', key: 'demo_video', file: 'demo.mp4', mime: 'video/mp4', w: 320, h: 240, bytes: video.length, alt: 'ProbeKits demo'},
  ];
}

export async function startEnvironment({site = 'probekits', ai = null, additionalKits = []} = {}) {
  if (!(await portFree(API_PORT))) {
    throw Error(`端口 ${API_PORT} 已被占用：端到端测试要求独占（可能是真实续填服务）。先停掉再跑。`);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'fb-e2e-'));
  const dirs = ['kits', 'sources', 'handoff', 'runs', 'logs', 'snapshots', 'settings', 'stage'];
  for (const dir of dirs) await mkdir(path.join(root, dir), {recursive: true});
  const kitDir = path.join(root, 'kits', site);
  await mkdir(path.join(kitDir, 'assets'), {recursive: true});
  const assets = await makeAssets(path.join(kitDir, 'assets'));
  await writeFile(path.join(kitDir, 'kit.json'), JSON.stringify({...KIT, site, assets}, null, 2));
  await writeFile(path.join(root, 'kits', '_profile.json'), JSON.stringify(PROFILE, null, 2));
  await writeFile(path.join(root, 'directories.csv'), 'domain,submit_url,status,fit_sites,dr,dr_date,last_verified,notes\n');
  await writeFile(path.join(root, 'ledger.csv'), 'record_id,source_domain,site,status,submitted_at,first_public_at,last_checked_at\n');
  const config = {
    directories: path.join(root, 'directories.csv'),
    ledger: path.join(root, 'ledger.csv'),
    sites_file: path.join(root, 'sites.md'),
    kits_source: path.join(root, 'kits'),
    kits_dir: path.join(root, 'kits'),
    runs_dir: path.join(root, 'runs'),
    handoff_dir: path.join(root, 'handoff'),
    snapshots_dir: path.join(root, 'snapshots'),
    logs_dir: path.join(root, 'logs', 'fast-backlink'),
    settings_dir: path.join(root, 'settings'),
    stage_dir: path.join(root, 'stage'),
    learned_file: path.join(root, 'learned.json'),
    sources_dir: path.join(root, 'sources'),
    raw_sources_dir: path.join(root, 'sources'),
    ahrefs_script: '', browser_script: '', outreach_template: '',
    sites: {[site]: {domain: 'probekits.com', kit: `${site}/kit.json`}},
    edge_instance: null,
  };
  for (const kit of additionalKits) {
    const directory = path.join(root, 'kits', kit.site);
    await mkdir(path.join(directory, 'assets'), {recursive: true});
    await writeFile(path.join(directory, 'kit.json'), JSON.stringify(kit));
    config.sites[kit.site] = {domain: kit.fields.domain.value, kit: `${kit.site}/kit.json`};
  }
  // 标准 OpenAI 兼容假服务：只回固定建议，由 e2e 用例按夹具页的字段索引断言。
  let aiServer = null;
  const aiRequests = [];
  if (ai) {
    const suggestions = ai.suggestions || [
      {i: 1, key: 'url', conf: 0.95, why: 'landing'},
      {i: 2, key: 'tagline', conf: 0.95, why: 'blurb'},
      {i: 3, key: 'how_did_you_hear', conf: 0.95, why: 'arrival'},
      {i: 5, key: 'pricing_model', conf: 0.95, why: 'billing'},
      {i: 6, key: 'tags', conf: 0.95, why: 'tests'},
    ];
    aiServer = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        try { aiRequests.push(JSON.parse(raw)); } catch { /* 不是 JSON 也照样回固定结果 */ }
        const body = JSON.stringify({choices: [{message: {content: JSON.stringify({suggestions})}}],
          usage: {prompt_tokens: 10, completion_tokens: 5}});
        response.writeHead(200, {'Content-Type': 'application/json'});
        response.end(body);
      });
    });
    await listen(aiServer, 0);
    config.ai = {
      enabled: true, base_url: `http://127.0.0.1:${aiServer.address().port}/v1`,
      model: 'e2e-fake', api_key: 'e2e-key', auto_apply: ai.auto_apply !== false, timeout_ms: 5000,
    };
  }
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const tokenPath = path.join(root, 'token');
  const token = 'e2e' + 'k'.repeat(37);
  await writeFile(tokenPath, token + '\n');
  const service = spawn('python3', [path.join(REPO, 'bk.py'), '--config', configPath, 'handoff', 'serve',
    '--port', String(API_PORT), '--token-file', tokenPath], {cwd: REPO, stdio: ['ignore', 'pipe', 'pipe']});
  let serviceLog = '';
  service.stdout.on('data', chunk => {serviceLog += chunk;});
  service.stderr.on('data', chunk => {serviceLog += chunk;});
  const base = `http://127.0.0.1:${API_PORT}/${token}/`;
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + 'api/health', {headers: {'X-Fast-Backlink': '1'}});
      if (response.ok) {ready = true; break;}
    } catch { /* 还没起来 */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) {
    service.kill();
    throw Error(`本机服务没起来：${serviceLog.slice(-800)}`);
  }
  const site_a = await serveStatic(PORT_A, EXTENSION);
  const site_b = await serveStatic(PORT_B, EXTENSION);
  return {
    root, base, configPath, service, log: () => serviceLog, kit: {...KIT, site, assets},
    aiRequests,
    async stop() {
      service.kill('SIGTERM');
      site_a.close(); site_b.close();
      if (aiServer) { aiServer.close(); aiServer = null; }
    },
    async cleanup() {await rm(root, {recursive: true, force: true});},
    async logLines() {
      const files = await readdir(path.join(root, 'logs', 'fast-backlink')).catch(() => []);
      const lines = [];
      for (const file of files.filter(name => name.endsWith('.jsonl'))) {
        const text = await readFile(path.join(root, 'logs', 'fast-backlink', file), 'utf8');
        for (const line of text.split('\n')) if (line.trim()) lines.push(JSON.parse(line));
      }
      return lines;
    },
    async snapshots() {
      const walk = async dir => {
        const found = [];
        for (const entry of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
          const target = path.join(dir, entry.name);
          if (entry.isDirectory()) found.push(...await walk(target));
          else if (entry.name.endsWith('.json')) found.push(JSON.parse(await readFile(target, 'utf8')));
        }
        return found;
      };
      return walk(path.join(root, 'snapshots'));
    },
  };
}

export async function launchBrowser(env, settings = {}, extension = EXTENSION) {
  const userDataDir = path.join(env.root, 'profile');
  await mkdir(userDataDir, {recursive: true});
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: {width: 1280, height: 900},
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-first-run', '--no-default-browser-check', '--disable-features=DialMediaRouteProvider,CalculateNativeWinOcclusion',
      // 合成域名由本机HTTP夹具提供，临时测试浏览器不继承系统代理。
      '--host-resolver-rules=MAP library-flow.example 127.0.0.1',
      '--no-proxy-server',
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', {timeout: 30000});
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async ([base, patch]) => {
    await chrome.storage.local.set({base, settings: {
      restore_after_reload: true, restore_after_submit_error: true, restore_window_hours: 2,
      auto_next: false, auto_next_sites: {}, fill_low_confidence: true, inline_asset_button: true,
      snapshot_keep: 5, snapshot_days: 14, log_level: 'debug', ...patch,
    }});
  }, [env.base, settings]);
  // service worker 给自己 sendMessage 不会触发 onMessage，用一次性 alarm 叫醒长轮询。
  await worker.evaluate(() => chrome.alarms.create('fb-agent', {periodInMinutes: 0.5, when: Date.now()}));
  return {context, worker, extensionId, env};
}

// 等价于在侧边栏里为这个标签页选一个项目：写标签页状态并让内容脚本重新建会话。
export async function activate(page, site = 'probekits') {
  const worker = page.context().serviceWorkers()[0];
  return worker.evaluate(async ([url, wanted]) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(item => item.url === url);
    if (!tab) return {error: 'tab not found'};
    const key = 'tab:' + tab.id;
    const current = (await chrome.storage.session.get(key))[key] || {};
    await chrome.storage.session.set({[key]: {...current, site: wanted}});
    const result = await chrome.tabs.sendMessage(tab.id, {type: 'page:activate', site: wanted})
      .catch(error => ({error: String(error.message)}));
    return {tabId: tab.id, result};
  }, [page.url(), site]);
}

export async function openFixture(context, name, {query = '', site = 'probekits', activateSite = true, host = '127.0.0.1'} = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://${host}:${PORT_A}/test-pages/${name}${query}`);
  await page.waitForFunction(() => !!document.documentElement.dataset.bkStatus, null, {timeout: 20000});
  if (activateSite) {
    await activate(page, site);
    // 等会话真的落到页面上，避免“还没选项目就开始断言”。
    await page.waitForFunction(wanted => JSON.parse(document.documentElement.dataset.bkStatus || '{}').site === wanted,
      site, {timeout: 10000});
  }
  await settle(page);
  const expectation = await page.evaluate(() => JSON.parse(document.getElementById('fixture-expect').textContent));
  const state = await statusOf(page);
  if (process.env.FB_E2E_DUMP) {
    const selectors = Object.keys(expectation.fields || {});
    const values = await page.evaluate(list => list.map(selector => {
      const node = document.querySelector(selector);
      return `${selector}=${node ? JSON.stringify(String(node.value ?? '').slice(0, 24)) : 'missing'}`;
    }), selectors);
    const bad = (state.decisions || []).filter(item => ['filled', 'pending'].includes(item.status) && !item.hasValue)
      .map(item => `${item.label}=${item.status}/${item.key}/${item.reason}`);
    console.log(`[fixture] ${name} site=${state.site} filled=${state.filled}/${state.total} ` +
      `captcha=${state.captcha} unmatched=${state.unmatched} ${bad.length ? 'BAD:' + bad.join(',') : ''}`);
    console.log(`          ${values.join(' ')}`);
  }
  return {page, expectation, status: state, errors};
}

// 状态稳定（两次读取一致）就算这一轮填完。
export async function settle(page, timeout = 12000) {
  const started = Date.now();
  let previous = null, same = 0;
  while (Date.now() - started < timeout) {
    const current = await page.evaluate(() => document.documentElement.dataset.bkStatus || '').catch(() => '');
    if (current && current === previous) same++;
    else same = 0;
    previous = current;
    if (same >= 2 && current) return JSON.parse(current);
    await page.waitForTimeout(250);
  }
  return JSON.parse(previous || '{}');
}

export const statusOf = page => page.evaluate(() => JSON.parse(document.documentElement.dataset.bkStatus || '{}'));

export const value = (page, selector) => page.$eval(selector, node => node.value ?? node.textContent);

export async function decision(page, selector) {
  const state = await statusOf(page);
  const label = await page.$eval(selector, node => {
    const id = node.id;
    if (id) {
      const explicit = document.querySelector(`label[for="${id}"]`);
      if (explicit) return explicit.textContent.replace(/\s+/g, ' ').trim();
    }
    return (node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.name || '').trim();
  });
  return (state.decisions || []).find(item => item.label === label) || null;
}
