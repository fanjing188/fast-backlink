// 后台登录任务：授权留本地，阶段留session；未知点击只读回，不重放。
(function (root) {
  function create({chrome, request, readTab, writeTab, buildSession, CDP, invalidateTab = () => {}}) {
    const P = root.BKAuthPolicy, running = new Set(), timers = new Map();
    const writes = new Map(), starts = new Map(), revoked = new Set();
    const binding = state => JSON.stringify([state.site, state.pendingItem || state.context?.record?.id || null,
      state.entryURL || state.context?.submit_url || '', state.taskGeneration || 0]);
    const get = async key => (await chrome.storage.session.get(key))[key];
    const put = async (key, value) => chrome.storage.session.set({[key]: value});
    const terminal = task => !task || ['complete', 'cancelled'].includes(task.state);
    async function taskFor(tabId) {
      const task = await get('auth:' + ((await get('auth-owner:' + tabId)) || tabId));
      return task && (revoked.has(task.id) || await get('auth-stop:' + task.id)) ? {...task, state: 'cancelled'} : task;
    }
    function serial(rootId, change) {
      const pending = (writes.get(rootId) || Promise.resolve()).catch(() => {}).then(change);
      writes.set(rootId, pending);
      pending.finally(() => {if (writes.get(rootId) === pending) writes.delete(rootId);}).catch(() => {});
      return pending;
    }
    async function save(task, patch) {
      return serial(task.rootId, async () => {
        const current = await taskFor(task.rootId);
        if (!current || current.id !== task.id || current.state === 'cancelled') return null;
        const next = {...current, ...patch};
        await put('auth:' + task.rootId, next);
        return revoked.has(task.id) || await get('auth-stop:' + task.id) ? null : next;
      });
    }
    const summary = task => task && ({rootId: task.rootId, state: task.state, reason: task.reason || '',
      target: new URL(task.target).origin + new URL(task.target).pathname, childId: task.childId || null});
    async function setup(tabId, target) {
      const tab = await chrome.tabs.get(tabId), state = await readTab(tabId);
      const wanted = P.address(target || state.entryURL || state.context?.submit_url || tab.url);
      if (!wanted || wanted.protocol !== 'https:' || P.loginURL(wanted.href)) throw Error('请提供原始 HTTPS 投稿地址，不是登录页');
      if (!state.site) throw Error('先选择目标项目');
      const actual = P.address(tab.url);
      if (!actual || actual.protocol !== 'https:') throw Error('登录只支持 HTTPS 页面');
      return {tab, state, wanted, origins: [...new Set([wanted.origin, ...(P.google(tab.url) ? [] : [actual.origin])])]};
    }
    async function grant(tabId, {email, target, enabled = true}) {
      invalidateTab(tabId);
      const {wanted, origins} = await setup(tabId, target);
      const {googleLogin = {}} = await chrome.storage.local.get('googleLogin');
      if (enabled) {
        email = String(email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('请输入已授权的 Google 邮箱');
        googleLogin[wanted.origin] = {email, origins, target: wanted.href};
      } else {
        delete googleLogin[wanted.origin];
        const task = await taskFor(tabId);
        if (!terminal(task)) await cancel(tabId);
      }
      await chrome.storage.local.set({googleLogin});
      if (enabled) await writeTab(tabId, {entryURL: wanted.href}, {control: true});
      return status(tabId);
    }
    async function status(tabId) {
      const state = await readTab(tabId), tab = await chrome.tabs.get(tabId).catch(() => null);
      const task = await taskFor(tabId);
      const target = task?.target || state.entryURL || state.context?.submit_url || tab?.url;
      const wanted = P.address(target);
      const {googleLogin = {}} = await chrome.storage.local.get('googleLogin');
      const permission = wanted && googleLogin[wanted.origin];
      let probe = null;
      if (tab && !P.google(tab.url)) probe = await chrome.tabs.sendMessage(tabId, {type: 'auth:probe'}, {frameId: 0}).then(r => r?.value).catch(() => null);
      return {task: summary(task), authorized: !!permission, email: permission?.email || '', origins: permission?.origins || [],
        target: wanted ? wanted.origin + wanted.pathname : '', kind: tab && P.google(tab.url) ? 'google' : probe?.kind || 'unknown'};
    }
    function schedule(rootId) {
      clearTimeout(timers.get(rootId));
      timers.set(rootId, setTimeout(() => {timers.delete(rootId); step(rootId).catch(() => {});}, 500));
    }
    function start(tabId) {
      if (starts.has(tabId)) return starts.get(tabId);
      const pending = startTask(tabId).finally(() => starts.delete(tabId));
      starts.set(tabId, pending);
      return pending;
    }
    async function startTask(tabId) {
      const existing = await taskFor(tabId);
      if (!terminal(existing)) return summary(existing);
      const {tab, state, wanted} = await setup(tabId);
      const {googleLogin = {}} = await chrome.storage.local.get('googleLogin');
      const permission = googleLogin[wanted.origin];
      if (!permission || !P.allowedURL(tab.url, permission.origins)) throw Error('请先授权本站使用指定 Google 邮箱登录／注册');
      if (state.submitted || state.context?.submission_locked) throw Error('投稿结果未知，先核实，不重新登录填写');
      const task = {id: `${tabId}-${Date.now()}-${Math.random().toString(36).slice(2)}`, rootId: tabId, site: state.site, item: state.pendingItem || state.context?.record?.id || null,
        binding: binding(state),
        target: wanted.href, origins: permission.origins, email: permission.email,
        state: 'running', attempted: [], actions: [], createdAt: Date.now(), expires: Date.now() + 180000};
      await put('auth:' + tabId, task);
      await chrome.tabs.sendMessage(tabId, {type: 'page:loginHold', held: true}).catch(() => {});
      const index = await get('authIndex') || [];
      await put('authIndex', [...new Set([...index, tabId])]);
      await step(tabId);
      return summary(await taskFor(tabId));
    }
    async function cancel(tabId) {
      invalidateTab(tabId);
      const task = await taskFor(tabId);
      if (task) {
        invalidateTab(task.rootId);
        // 独立撤销墓碑先于排队写入生效，迟到的阶段回执不能撤销它。
        revoked.add(task.id);
        await put('auth-stop:' + task.id, true);
        await serial(task.rootId, () => put('auth:' + task.rootId, {...task, state: 'cancelled', reason: '已停止；已发出的动作只读回，不重试'}));
        await chrome.tabs.sendMessage(task.rootId, {type: 'page:loginHold', held: true}).catch(() => {});
        clearTimeout(timers.get(task.rootId)); timers.delete(task.rootId);
      }
      return summary(await taskFor(tabId));
    }
    async function live(task) {
      const current = await taskFor(task.rootId);
      const state = await readTab(task.rootId);
      const {googleLogin = {}} = await chrome.storage.local.get('googleLogin');
      const permission = googleLogin[new URL(task.target).origin];
      return !!current && current.id === task.id && !terminal(current) && current.state !== 'manual' &&
        binding(state) === task.binding && !state.submitted && !state.context?.submission_locked &&
        permission?.email === task.email && JSON.stringify(permission.origins) === JSON.stringify(task.origins);
    }
    async function probe(tabId) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete') return {tab, page: null};
      const result = await chrome.tabs.sendMessage(tabId, {type: 'auth:probe'}, {frameId: 0});
      if (!result?.value) throw Error('登录页面尚未就绪');
      return {tab, page: result.value};
    }
    async function pause(task, reason) { await save(task, {state: 'manual', reason}); }
    async function step(tabId, resume = false) {
      let task = await taskFor(tabId);
      if (terminal(task) || running.has(task.rootId)) return summary(task);
      if (task.state === 'manual' && !resume) return summary(task);
      if (resume) task = await save(task, {state: 'running', reason: '', expires: Date.now() + 180000});
      if (!task) return null;
      const rootId = task.rootId;
      let dispatching = false;
      running.add(rootId);
      try {
        if (!await live(task)) {await pause(task, '本站登录授权已变化，请重新授权'); return;}
        if (Date.now() > task.expires || task.attempted.length >= 8) {await pause(task, '登录未能完成，请人工处理后继续检查'); return;}
        const original = await probe(task.rootId);
        if (!P.allowedURL(original.tab.url, task.origins)) {await pause(task, '跳转到未授权域名，已停止自动操作'); return;}
        const target = new URL(task.target), actual = new URL(original.tab.url);
        if (original.page?.kind === 'form' && P.canFill(original.page, actual.href, target.href) && actual.pathname === target.pathname) {
          if (!await live(task)) return;
          // 先完成登录任务再建立产品会话，防止登录页和账号页接收资料。
          const completed = await save(task, {state: 'complete', reason: '已返回投稿表单并接续填写'});
          if (!completed) return;
          await chrome.tabs.sendMessage(task.rootId, {type: 'page:loginHold', held: false}).catch(() => {});
          await buildSession(task.rootId, {id: task.item, site: task.item ? undefined : task.site, url: task.target}, {}, {wait: true, authTask: task.id});
          return;
        }
        let current = original;
        if (task.childId) {
          const child = await chrome.tabs.get(task.childId).catch(() => null);
          if (child) current = await probe(task.childId);
          else task = await save(task, {childId: null});
        }
        if (!task) return;
        if (!P.allowedURL(current.tab.url, task.origins)) {await pause(task, '登录窗口跳转到未授权域名，请手动核实'); return;}
        if (!current.page) {schedule(task.rootId); return;}
        const page = current.page;
        if (page.kind === 'manual') {await pause(task, page.reason); return;}
        if (page.kind === 'google' && !P.matchesOAuth(task.expectedOAuth, current.tab.url, task.origins)) {
          await pause(task, '无法证明此 Google 流程属于本次本站登录，请手动选择账号后继续'); return;
        }
        if (current.tab.id === task.rootId && actual.origin === target.origin && actual.pathname !== target.pathname && page.authenticated) {
          if (task.returned) {await pause(task, '返回投稿入口后仍未找到表单，请人工核实'); return;}
          if (!await live(task)) return;
          await save(task, {returned: true});
          await chrome.tabs.update(task.rootId, {url: task.target}); schedule(task.rootId); return;
        }
        if (task.uncertain) {await pause(task, '上次登录动作结果未知，只能读回；请人工完成登录后继续检查'); return;}
        let choice = P.choose(page, task.email);
        // 只在本地候选有歧义时请求AI；账号选择和授权不交给模型。
        if (!choice && page.kind === 'login' && page.candidates.length) {
          const suggestion = await request('auth_suggest', {}, {kind: 'login', candidates: page.candidates.map(({id, action, label}) => ({id, action, label}))}).catch(() => null);
          choice = page.candidates.find(c => c.id === suggestion?.id && ['google', 'login'].includes(c.action)) || null;
        }
        if (!choice) {
          if (task.attempted.length && page.kind !== 'google') {schedule(task.rootId); return;}
          await pause(task, page.kind === 'google' ? '没有唯一匹配的已授权 Google 账号，请手动选择' : '没有可安全操作的 Google 登录入口，请人工处理'); return;
        }
        if (task.attempted.includes(choice.id)) {schedule(task.rootId); return;}
        if ((task.actions || []).includes(choice.action)) {await pause(task, '该登录阶段已操作过，不因刷新或候选重排重试；请人工核实'); return;}
        const selected = await chrome.tabs.sendMessage(current.tab.id, {type: 'auth:target', id: choice.id, document: page.document}, {frameId: 0});
        if (!selected?.value || selected.error) throw Error('登录目标变化，请重新检查');
        if (!await live(task)) return;
        const popup = choice.action === 'google' ? {openerId: current.tab.id, at: Date.now()} : null;
        task = await save(task, {state: 'waiting', reason: '已发出登录动作，正在核实页面', attempted: [...task.attempted, choice.id], actions: [...(task.actions || []), choice.action],
          ...(popup ? {pendingPopup: popup, expectedOAuth: P.oauthContext(selected.value.href || choice.href)} : {})});
        if (!task) return;
        // 先持久记尝试，再派发；超时、失联、worker重启都不会重复点击。
        dispatching = true;
        await CDP.clickElement(current.tab.id, selected.value.selector, {auth: selected.value, authorize: () => live(task)});
        schedule(task.rootId);
      } catch {
        if (task && dispatching) await save(task, {uncertain: true});
        if (task) await pause(task, '登录动作结果未确认，请核实页面后点继续检查；不会重复点击');
      } finally { running.delete(rootId); }
      return summary(await taskFor(tabId));
    }
    async function created(tab) {
      if (!tab.openerTabId) return;
      const task = await taskFor(tab.openerTabId);
      if (terminal(task) || !['waiting', 'running'].includes(task.state) || !task.attempted.length) return;
      if (!task.pendingPopup || task.pendingPopup.openerId !== tab.openerTabId || Date.now() - task.pendingPopup.at > 10000) return;
      if (task.childId && task.childId !== tab.id) {await pause(task, '出现多个登录窗口，请人工核实'); return;}
      await put('auth-owner:' + tab.id, task.rootId);
      await save(task, {childId: tab.id, pendingPopup: null}); schedule(task.rootId);
    }
    async function changed(tabId, removed = false) {
      const task = await taskFor(tabId);
      if (terminal(task)) return;
      if (removed && task.rootId === tabId) {await cancel(tabId); return;}
      schedule(task.rootId);
    }
    async function tick() {
      for (const id of await get('authIndex') || []) {
        const task = await taskFor(id);
        if (!terminal(task) && task.state !== 'manual') await step(id);
      }
    }
    async function ready(tabId, id) {
      const task = await taskFor(tabId);
      const {googleLogin = {}} = await chrome.storage.local.get('googleLogin');
      const permission = task && googleLogin[new URL(task.target).origin];
      return !!task && task.id === id && task.state === 'complete' && binding(await readTab(task.rootId)) === task.binding &&
        permission?.email === task.email && JSON.stringify(permission.origins) === JSON.stringify(task.origins);
    }
    async function invalidate(tabId) {
      const task = await taskFor(tabId);
      if (!task || task.rootId !== tabId) return;
      if (!terminal(task)) await cancel(tabId);
      await serial(tabId, async () => {
        if ((await taskFor(tabId))?.id === task.id) await chrome.storage.session.remove('auth:' + tabId);
      });
      await chrome.tabs.sendMessage(tabId, {type: 'page:loginHold', held: false}).catch(() => {});
    }
    return {grant, status, start, cancel, step, created, changed, tick, ready, invalidate,
      holds: async tabId => {const task = await taskFor(tabId); return !!task && task.state !== 'complete';}};
  }
  root.BKAuthFlow = {create};
})(globalThis);
