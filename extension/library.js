/* 外链库仅通过 background 消息读写；Node 导出供合成夹具检验，不加载真实资料。 */
(function () {
  const STATES = {ready: '当前产品可复用', needs_review: '需要核对', already_submitted: '当前产品已投 / 结果待核', blocked: '不可复用', unknown: '复用状态未知'};
  const SCENARIOS = {directory: '目录', launch: 'Launch', roundup: 'Roundup', resource: '资源页', community: '社区', comment: '评论', producthunt: 'Product Hunt', github: 'GitHub', paid: '付费渠道'};
  const scalar = value => value && typeof value === 'object' ? value.value : value;
  const display = (value, unknown) => scalar(value) === '' || scalar(value) === 'UNKNOWN' || scalar(value) == null ? unknown : String(scalar(value));
  const admission = item => scalar(item.admission) === '可投' ? '平台已确认可投' : scalar(item.admission) === '不做' ? '平台不可投' : '平台待核实';
  function safeURL(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }
  function createLibrary({document, send, search = '', download}) {
    const $ = id => document.querySelector(`#${id}`);
    const state = {sites: [], items: [], counts: null, loaded: false, sitesReady: false};
    let request = 0;
    const opening = new Set();
    const uncertain = new Set();
    let fitInputs = [];
    let saving = false;
    function node(tag, attrs = {}, ...children) {
      const result = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith('on')) result.addEventListener(key.slice(2), value);
        else result.setAttribute(key, value);
      }
      result.append(...children.flat().filter(child => child != null));
      return result;
    }
    function hint() {
      $('product-hint').textContent = $('site').value
        ? `当前产品：${$('site').value}。只有“当前产品可复用”的平台允许打开并填写。`
        : '先选择目标产品才能判断是否可复用；未选产品时只能查看平台。';
    }
    function reuseState(item) {
      const site = $('site').value;
      if (Array.isArray(item.history) && item.history.some(record => record?.site === site &&
        ['unknown', 'outcome_unknown', 'submitted', 'live', 'verified', 'accepted', 'published'].includes(record.status))) return 'already_submitted';
      if (uncertain.has(`${site}|${item.domain}`)) return 'unknown';
      return item.reuse_state;
    }
    function canFill(item) {
      const site = $('site').value;
      return Boolean(state.loaded && site && state.sites.includes(site) && state.loadedSite === site && reuseState(item) === 'ready'
        && safeURL(item.submit_url));
    }
    async function openPlatform(item, fill, controls) {
      if (!state.loaded || !state.items.includes(item) || opening.has(item.domain) || !safeURL(item.submit_url) || fill && !canFill(item)) return;
      const site = $('site').value;
      opening.add(item.domain);
      controls.forEach(button => { button.disabled = true; });
      $('action-status').textContent = `正在请求打开 ${item.domain}…`;
      try {
        const result = await send('library:open', {domain: item.domain, site, fill});
        if (!result) throw Error('打开请求未返回结果');
        $('action-status').textContent = fill ? '已返回打开请求结果。请在提交页检查填写；最终提交、验证码与授权仍需手动完成。'
          : '已返回查看请求结果；没有主动填写。请在提交页重新核对。';
      } catch (error) {
        if (fill) uncertain.add(`${site}|${item.domain}`);
        $('action-status').textContent = `${error.message}。打开或填写结果可能未知；先查看页面，不自动重试。`;
      } finally {
        opening.delete(item.domain);
        controls[0].disabled = !canFill(item);
        controls[1].disabled = !safeURL(item.submit_url);
      }
    }
    function platformRow(item) {
      const history = Array.isArray(item.history) ? item.history : [];
      const previous = Array.isArray(item.previous_sites) ? item.previous_sites : [];
      const reuse = reuseState(item);
      const status = $('site').value ? STATES[reuse] || STATES.unknown : '未选择目标产品';
      const tone = $('site').value && reuse === 'ready' ? 'ok' : reuse === 'blocked' ? 'bad' : 'line';
      const detail = node('details', {}, node('summary', {}, `历史与配方 · ${history.length} 条历史`),
        node('div', {class: 'detail-body'},
          node('p', {}, item.has_recipe ? '已有填写配方；页面字段仍需核对，最终提交不自动执行。' : '暂无填写配方；可以先查看提交页。'),
          node('p', {}, `曾用于：${previous.length ? previous.join('、') : '暂无已记录产品'}`),
          history.length ? node('ul', {}, ...history.map(record => node('li', {},
            typeof record === 'string' ? record : [record.site || '产品未知',
              ['unknown', 'outcome_unknown'].includes(record.status) ? '结果未知（先核实，不重放）' : record.status || '状态未知',
              record.date || record.submitted_at || record.at || record.last_checked_at || '时间未知', record.note || ''].filter(Boolean).join(' · '))))
            : node('p', {}, '暂无历史记录；不代表从未提交。'),
          node('p', {}, `最近核对：${display(item.last_checked_at, '未知')}`)));
      const controls = [];
      controls.push(node('button', {type: 'button', class: 'primary', 'data-action': 'fill', 'data-domain': item.domain,
        onclick: () => openPlatform(item, true, controls)}, '打开并填写'));
      controls.push(node('button', {type: 'button', 'data-action': 'view', 'data-domain': item.domain,
        onclick: () => openPlatform(item, false, controls)}, item.reuse_state === 'ready' ? '查看提交页' : '查看 / 重新核对'));
      controls[0].disabled = !canFill(item);
      controls[0].setAttribute('title', canFill(item) ? '只填写，不会最终提交' : '需选定产品、可复用状态和安全提交地址；已投或结果未知不可重放');
      controls[1].disabled = !safeURL(item.submit_url);
      const actions = node('div', {class: 'platform-actions'}, ...controls,
        node('button', {type: 'button', 'data-action': 'edit', onclick: () => showEditor(item)}, '更新平台资料'));
      return node('article', {class: 'platform', 'data-domain': item.domain},
        node('div', {class: 'platform-title'}, node('h3', {}, display(item.domain, '域名未知')),
          node('span', {class: 'pill line'}, admission(item)), node('span', {class: `pill ${tone}`}, status)),
        node('div', {class: 'platform-meta'},
          node('span', {}, SCENARIOS[item.scenario] || display(item.scenario, '类型未知')),
          node('span', {}, `DR ${display(item.dr, '未核实')}${display(item.dr_date, '') ? `（${item.dr_date}）` : ''}`),
          node('span', {}, `费用：${({free: '免费', paid: '付费'})[scalar(item.fee)] || display(item.fee, '未核实')}`),
          node('span', {}, `登录：${display(item.login, '未核实')}`),
          node('span', {}, `回链：${({true: '要求', false: '不要求'})[scalar(item.backlink)] || display(item.backlink, '未核实')}`)),
        node('p', {class: 'reason'}, Array.isArray(item.reasons) && item.reasons.length ? item.reasons.join('；') : '打开前检查平台规则与产品匹配。'),
        item.note ? node('p', {class: 'muted-2'}, String(item.note)) : null, detail, actions);
    }
    function showEditor(item = null) {
      if (saving) return;
      $('editor').hidden = false;
      $('editor-heading').textContent = item ? `更新 ${item.domain}` : '新增平台';
      const fields = {domain: 'domain', url: 'submit_url', scenario: 'scenario', dr: 'dr', 'dr-date': 'dr_date', fee: 'fee', backlink: 'backlink', note: 'note'};
      for (const [id, key] of Object.entries(fields)) $(`record-${id}`).value = display(item?.[key], '');
      $('record-domain').readOnly = Boolean(item);
      $('record-admission').value = ['可投', '不做'].includes(scalar(item?.admission)) ? scalar(item.admission) : '待核实';
      $('form-status').textContent = item && !Array.isArray(item.fit_sites)
        ? '此记录未返回适配产品；请重新明确勾选，不能把历史产品视为适配确认。' : '';
      fitInputs = state.sites.map(site => {
        const input = node('input', {type: 'checkbox', value: site, 'aria-label': `确认适配 ${site}`});
        input.checked = Array.isArray(item?.fit_sites) && item.fit_sites.includes(site);
        return {site, input};
      });
      $('fit-options').replaceChildren(...fitInputs.map(({site, input}) => node('label', {class: 'fit-option'}, input, site)),
        ...(state.sites.length ? [] : [node('p', {class: 'muted'}, '尚无产品。请先在本机配置登记产品并导入资料包，平台信息仍可保存。')]));
      $('record-domain').focus();
      $('editor').scrollIntoView({block: 'nearest'});
    }
    async function saveRecord(event) {
      event.preventDefault();
      if (saving) return;
      const record = {domain: $('record-domain').value.trim(), submit_url: $('record-url').value.trim(),
        scenario: $('record-scenario').value, admission: $('record-admission').value,
        note: $('record-note').value.trim(), dr: $('record-dr').value === '' ? null : Number($('record-dr').value),
        dr_date: $('record-dr-date').value, fit_sites: fitInputs.filter(({input}) => input.checked).map(({site}) => site),
        fee: $('record-fee').value.trim(), backlink: $('record-backlink').value === 'false' ? false : $('record-backlink').value === 'true' ? true : ''};
      const invalid = (id, message) => { $('form-status').textContent = message; $(`record-${id}`).focus(); };
      if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(record.domain)) {
        return invalid('domain', '只填写有效的小写平台域名，不含协议、端口或路径；不会自动修改你输入的标识。');
      }
      if (!safeURL(record.submit_url)) return invalid('url', '提交地址必须为完整的 HTTP(S) 地址，且不能包含账号或密码。');
      if (record.dr !== null && (!Number.isFinite(record.dr) || record.dr < 0 || record.dr > 100)) return invalid('dr', 'DR 必须为 0–100 的数字；未核实时请留空。');
      if (record.dr_date && (!/^\d{4}-\d{2}-\d{2}$/.test(record.dr_date) ||
        !Number.isFinite(Date.parse(record.dr_date)) || new Date(record.dr_date).toISOString().slice(0, 10) !== record.dr_date)) {
        return invalid('dr-date', '请填写有效的 DR 核验日期。');
      }
      if (record.dr !== null && !record.dr_date) return invalid('dr-date', '记录 DR 时请同时填写核验日期。');
      saving = true;
      $('save').disabled = true;
      $('record-fields').disabled = true;
      $('form-status').textContent = '正在保存并读回平台…';
      try {
        await send('library:save', {record});
        const check = await send('library:list', {site: $('site').value, q: record.domain, status: 'all', scenario: ''});
        const found = check?.items?.find(item => item.domain === record.domain);
        if (!found || found.submit_url !== record.submit_url || scalar(found.admission) !== record.admission) {
          throw Error('保存请求已发出，但尚未读回一致的平台记录');
        }
        $('form-status').textContent = '已保存并读回平台。当前筛选可能不包含该平台；适配与复用结论仍以后端核对为准。';
        await load();
      } catch (error) {
        $('form-status').textContent = `${error.message}。保留输入，请先刷新核实，不自动重复保存。`;
      } finally {
        saving = false;
        $('save').disabled = false;
        $('record-fields').disabled = false;
      }
    }
    async function load() {
      const current = ++request;
      const query = {site: $('site').value, q: $('search').value.trim(), status: $('status').value || 'all', scenario: $('scenario').value};
      state.loaded = false;
      state.items = [];
      $('export').disabled = true;
      $('notice').hidden = true;
      $('results').setAttribute('aria-busy', 'true');
      $('results').replaceChildren(node('div', {class: 'empty'}, '正在读取平台清单…'));
      $('summary').textContent = '读取中…';
      hint();
      try {
        const value = await send('library:list', query);
        if (current !== request) return;
        if (!value || !Array.isArray(value.items) || !value.counts) throw Error('清单响应不完整，请检查服务版本后刷新。');
        if (query.site && value.site !== query.site) throw Error('清单返回的目标产品不一致，请刷新核实。');
        for (const key of ['total', 'confirmed', 'ready', 'needs_review', 'already_submitted', 'blocked']) {
          if (!Number.isInteger(value.counts[key]) || value.counts[key] < 0) throw Error('清单响应的计数不完整，请刷新。');
        }
        state.items = value.items;
        state.counts = value.counts;
        state.loaded = true;
        state.loadedSite = query.site;
        state.query = query;
        $('export').disabled = false;
        const filtered = $('search').value.trim() || $('status').value && $('status').value !== 'all' || $('scenario').value;
        $('results').replaceChildren(state.items.length
          ? node('div', {class: 'platform-list'}, ...state.items.map(platformRow))
          : node('div', {class: 'empty'}, node('b', {}, filtered ? '没有符合筛选的平台' : '还没有平台记录'),
            node('p', {}, filtered ? '放宽状态或类型，或换一个关键词。' : '新增一个平台，或刷新已有来源。')));
        const c = value.counts;
        $('summary').textContent = `当前筛选 ${c.total} 个平台 · 已确认可投 ${c.confirmed}` +
          ($('site').value ? ` · 当前产品可复用 ${c.ready} · 待核对 ${c.needs_review} · 已投 / 结果待核 ${c.already_submitted} · 不可复用 ${c.blocked}` : ' · 选择产品后查看复用状态');
      } catch (error) { if (current === request) failure(error); }
      finally { if (current === request) $('results').setAttribute('aria-busy', 'false'); }
    }
    function failure(error) {
      state.loaded = false;
      state.items = [];
      $('export').disabled = true;
      $('results').setAttribute('aria-busy', 'false');
      $('notice').textContent = `${error.message} 可点击“刷新”重试。`;
      $('notice').hidden = false;
      $('summary').textContent = '未取得清单，不显示平台数量。';
      $('results').replaceChildren(node('div', {class: 'empty'}, node('b', {}, '读取失败'),
        node('p', {}, '检查本机服务及扩展连接，再刷新。')));
    }
    async function start() {
      try {
        state.sites = await send('sites');
        if (!Array.isArray(state.sites) || state.sites.some(site => typeof site !== 'string')) throw Error('产品列表响应不完整。');
        state.sitesReady = true;
        $('site').replaceChildren(node('option', {value: ''}, '未选择产品'),
          ...state.sites.map(site => node('option', {value: site}, site)));
        const initial = new URLSearchParams(search).get('site');
        $('site').value = state.sites.includes(initial) ? initial : '';
        await load();
      } catch (error) { failure(error); }
    }
    $('export').addEventListener('click', async () => {
      if (!state.loaded) return;
      const {q, status, scenario} = state.query;
      const data = {scope: 'current_list', exported_at: new Date().toISOString(), site: state.loadedSite,
        filters: {q, status, scenario}, count: state.items.length, items: state.items};
      try {
        await download(data);
        $('action-status').textContent = `已生成当前清单 JSON（${data.count} 个平台）。仅含当前筛选结果，不含产品素材与完整资产。`;
      } catch (error) { $('action-status').textContent = `导出失败：${error.message}。请重试。`; }
    });
    $('reload').addEventListener('click', () => state.sitesReady ? load() : start());
    for (const id of ['site', 'status', 'scenario']) $(id).addEventListener('change', load);
    $('search').addEventListener('input', load);
    $('add').addEventListener('click', () => showEditor());
    $('cancel-edit').addEventListener('click', () => { if (!saving) { $('editor').hidden = true; $('add').focus(); } });
    $('record-form').addEventListener('submit', saveRecord);
    return {state, start, load};
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {createLibrary};
  else {
    const send = async (type, data = {}) => {
      const response = await chrome.runtime.sendMessage({type, ...data});
      if (response?.error) throw Error(response.error);
      return response?.value;
    };
    const download = data => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = `fast-backlink-library-${data.exported_at.slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    };
    BKIcon.hydrate();
    createLibrary({document, send, search: location.search, download}).start();
  }
})();
