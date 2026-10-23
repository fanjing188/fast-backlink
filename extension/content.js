// 同页填表内容脚本：采集 → 匹配 → 填写 → 回读 → 标记 → 快照。每个 frame 各跑一份。
(() => {
  if (window.__fastBacklinkInitialized) return;
  window.__fastBacklinkInitialized = true;
  // OAuth页只保留auth-page候选接口，不接收产品数据、日志或快照。
  if (BKAuthPolicy.google(location.href) || BKAuthPolicy.callbackURL(location.href)) return;
  const F = BKFields, T = BKText, M = BKMatch, S = BKSnapshot, UI = BKUI, A = BKAI;
  const TOP = window.top === window;
  const FINAL_WORDS = /(submit|publish|pay|send|post|order|buy|提交|发布|购买|发送|下单|结账|付款)/i;

  const state = {
    session: null, entryItem: null, rules: null, settings: {}, entries: [], decisions: new Map(), assetIds: {}, loginHold: false,
    touched: new WeakSet(), byHuman: new WeakSet(), step: 0, run: null, restored: 0, submitted: false,
    lastSignature: '', filled: new WeakSet(), busy: false, pending: false, lastSnapshot: null, complete: false,
    autoNextDone: new WeakSet(), log: null, layer: null, marks: null, bar: null, button: null, hover: null,
    platform: 'generic', counters: {filled: 0, confirm: 0, unmatched: 0, captcha: 0, honeypot: 0, sensitive: 0, total: 0},
    ai: null, aiAttempt: '', aiBusy: false, aiDisabled: false, aiBinding: null, sessionGeneration: 0,
    humanRevision: 0, ownWriteDepth: 0, fileWrites: new WeakSet(),
    archiveRestored: new Set(), archiveInFlight: null,
  };

  const send = async (type, data = {}) => {
    const response = await chrome.runtime.sendMessage({type, ...data});
    if (response?.error) throw Error(response.error);
    return response?.value;
  };

  function loginPage() {
    return ['login', 'google', 'manual'].includes(BKAuthPage.inspect().kind);
  }

  function contentAllowed() {
    return !state.loginHold && !loginPage() && (!TOP || !state.session?.submit_url ||
      BKAuthPolicy.canFill({kind: 'form'}, location.href, state.session.submit_url));
  }

  function adoptContext(context, submitted = false) {
    const sameSource = state.session?.site === context.site && state.session?.source_domain === context.source_domain;
    if (sameSource && state.session?.record?.id && !context.record?.id) return false;
    const sameBinding = sameSource && state.session?.record?.id === context.record?.id && state.session?.submit_url === context.submit_url;
    if (!sameSource || state.session?.record?.id !== context.record?.id || state.session?.submit_url !== context.submit_url) {
      state.sessionGeneration++;
      state.ai = null;
      state.aiBinding = null;
      state.aiAttempt = '';
    }
    state.submitted = !!submitted || !!context.submission_locked || ((sameBinding || !state.session) && state.submitted);
    state.session = context;
    state.entryItem = null;
    return true;
  }

  function context() {
    const kit = state.session?.kit || {fields: {}, assets: [], profile: {}, qa: {}};
    return {
      site: state.session?.site, source_domain: state.session?.source_domain, kit,
      memory: state.session?.memory || {fields: [], labels: {}},
      recipe: state.session?.recipe || null,
      record: state.session?.record || null,
      fields: state.session?.fields || [], steps: state.session?.steps || [],
      qa: kit.qa || {},
    };
  }
  const matchCtx = () => ({context: context(), rules: state.rules || {}, settings: state.settings, step: state.step});

  async function ensureSession() {
    if (state.session) return true;
    try {
      const session = await send('session', {url: location.href, adopt: true});
      if (!session?.context) return false;
      if (!adoptContext(session.context, session.submitted)) return false;
      state.rules = session.rules;
      state.settings = {...session.settings, auto_next_for: session.context.auto_next};
      state.step = session.step || 0;
      state.log?.setName(state.session.site);
      state.log?.setSource(state.session.source_domain);
      return true;
    } catch (error) {
      UI.toast(state.layer, '连接本机服务失败：' + error.message, 'warn');
      return false;
    }
  }

  // ---------- AI 智能填充 ----------

  function aiSummary() {
    if (!state.ai) return null;
    const suggestions = state.ai.suggestions || [];
    return {
      enabled: state.ai.enabled !== false, configured: state.ai.configured !== false,
      auto: !!state.ai.auto, autoMinConf: state.ai.autoMinConf ?? 0.9,
      model: state.ai.model || '', cached: state.ai.cached || 0,
      at: state.ai.at || 0, error: state.ai.error || null, reason: state.ai.reason || '',
      busy: !!state.ai.busy, applied: suggestions.filter(item => item.applied).length,
      suggestions: suggestions.slice(0, 20).map(item => ({
        i: item.i, key: item.key, conf: item.conf, why: item.why || '', label: item.label || '',
        display: item.display || '', applied: !!item.applied, reason: item.reason || '',
      })),
    };
  }

  function residualFields() {
    return A.residual(state.entries, state.decisions, (element, field) => F.read(element, field));
  }

  function aiTarget(entry) {
    // 保留真实元素、作用域和完整字段语义，模型索引本身不构成写入资格。
    const safe = A.residual([entry], state.decisions, (element, field) => F.read(element, field))[0];
    if (!safe) return null;
    const field = entry.field;
    return {element: entry.element, form: entry.element.form, root: entry.element.getRootNode?.(),
      signature: JSON.stringify([safe, fieldIdentity(field, entry.element), field.options, field.helpText, field.placeholder])};
  }

  function bindingCurrent(binding) {
    return binding && binding.generation === state.sessionGeneration && binding.humanRevision === state.humanRevision &&
      binding.url === location.href && binding.documentRoot === document.documentElement && !state.submitted && contentAllowed();
  }

  async function aiFallback(options = {}) {
    if (!state.session || !contentAllowed()) return state.ai;
    if (state.aiDisabled && !options.force) return state.ai;
    if (!options.force && state.settings.ai_fallback === false) return state.ai;
    if (state.aiBusy) return state.ai;
    const fields = residualFields();
    if (!fields.length) {
      state.ai = {enabled: true, configured: true, busy: false, suggestions: [], at: Date.now(), reason: 'none'};
      return state.ai;
    }
    const fingerprint = S.fingerprintFields(state.entries.map(entry => entry.field));
    const binding = {generation: state.sessionGeneration, humanRevision: state.humanRevision, url: location.href,
      documentRoot: document.documentElement,
      fields: new Map(fields.map(field => [field.index, aiTarget(state.entries.find(entry => entry.field.index === field.index))]))};
    if (!options.force && state.aiAttempt === fingerprint && state.ai) return state.ai;
    state.aiAttempt = fingerprint;
    state.aiBusy = true;
    state.ai = {enabled: true, configured: true, busy: true, suggestions: [], at: Date.now()};
    render();
    const started = Date.now();
    try {
      const response = await send('ai:suggest', {payload: {
        site: state.session.site, source_domain: state.session.source_domain,
        url: location.href.split('#')[0], fingerprint, fields,
      }});
      if (!bindingCurrent(binding)) {
        return {stale: true, reason: 'context_changed', suggestions: []};
      }
      if (response?.enabled === false) {
        state.aiDisabled = true;
        state.ai = {enabled: false, configured: false, busy: false, suggestions: [], at: Date.now()};
        render();
        return state.ai;
      }
      state.aiDisabled = false;
      const kit = context().kit || {};
      const allowed = new Set(Object.keys(kit.fields || {}));
      if (kit.fields?.url) {allowed.add('url_bare'); allowed.add('domain');}
      for (const key of Object.keys(kit.profile || {})) allowed.add(key);
      for (const item of context().memory?.fields || []) {
        if (item.key && item.key !== 'label') allowed.add(item.key);
      }
      for (const question of Object.keys(kit.qa || {})) {
        const canonical = T.qaKey(question, {});
        if (canonical) allowed.add(canonical);
        allowed.add('qa:' + question);
      }
      const labels = new Map(fields.map(item => [item.index, item.label]));
      const ctx = matchCtx();
      const suggestions = A.normalize(response, new Set(fields.map(item => item.index)), allowed)
        .map(item => {
          const field = state.entries.find(entry => entry.field.index === item.i)?.field;
          let display = '', reason = '';
          if (field && item.key) {
            try {
              const scoped = {...ctx, field};
              const raw = M.resolveKey(item.key, scoped);
              if (raw === null || raw === undefined || raw === '') {
                reason = 'no_value';
              } else {
                const converted = M.convert(item.key, raw, {...scoped,
                  variantPool: M.variantPool(item.key, ctx), ownVariants: M.ownVariants(item.key, ctx)});
                const value = converted?.value;
                if (value === null || value === undefined) {
                  reason = converted?.reason || 'convert_failed';
                } else {
                  display = Array.isArray(value) ? value.join(', ') : String(value);
                  if (display.length > 110) display = display.slice(0, 110) + '…';
                }
              }
            } catch { reason = 'convert_failed'; }
          }
          return {...item, label: labels.get(item.i) || '', display, reason};
        });
      state.aiBinding = binding;
      state.ai = {
        enabled: true, configured: response?.configured !== false, auto: !!response?.auto_apply,
        autoMinConf: Number(response?.auto_apply_min_conf ?? 0.9),
        model: response?.model || '', cached: response?.cached || 0, at: Date.now(),
        busy: false, suggestions, error: null,
      };
      state.log?.push('info', 'ai', 'suggested', {
        fields: fields.length, suggestions: suggestions.length, cached: response?.cached || 0,
        model: response?.model || '', ms: response?.ms || (Date.now() - started),
      });
      if (options.applyAuto !== false && state.ai.auto && suggestions.length) {
        await applyAi({minConf: state.ai.autoMinConf});
      }
      render();
      return state.ai;
    } catch (error) {
      if (!bindingCurrent(binding)) return {stale: true, reason: 'context_changed', suggestions: []};
      state.ai = {enabled: true, configured: false, busy: false, suggestions: [], at: Date.now(),
        error: String(error.message || error)};
      state.log?.push('warn', 'ai', 'unavailable', {reason: String(error.message || error)});
      render();
      return state.ai;
    } finally {
      state.aiBusy = false;
    }
  }

  async function applyAi(options = {}) {
    const ai = state.ai;
    if (state.submitted) return {filled: 0, skipped: ai?.suggestions?.length || 0, reason: 'submitted'};
    const binding = state.aiBinding;
    if (!bindingCurrent(binding)) {
      return {filled: 0, skipped: ai?.suggestions?.length || 0, reason: 'context_changed'};
    }
    if (!ai?.suggestions?.length) return {filled: 0, skipped: 0};
    const indices = options.indices ? new Set(options.indices) : null;
    const ctx = matchCtx();
    let filled = 0, skipped = 0;
    for (const suggestion of ai.suggestions) {
      if (!bindingCurrent(binding)) break;
      if (suggestion.applied || suggestion.key === null || suggestion.key === undefined) continue;
      if (indices && !indices.has(suggestion.i)) continue;
      if (options.minConf !== undefined && suggestion.conf < options.minConf) {skipped++; continue;}
      const entry = scan().find(item => item.field.index === suggestion.i);
      if (!entry) {skipped++; continue;}
      const original = binding.fields.get(suggestion.i), currentTarget = aiTarget(entry);
      if (!original || !currentTarget || original.element !== currentTarget.element || original.form !== currentTarget.form ||
          original.root !== currentTarget.root || original.signature !== currentTarget.signature) {
        suggestion.reason = 'target_changed'; skipped++; continue;
      }
      const current = F.read(entry.element, entry.field);
      if (current !== undefined && String(current).trim() !== '') {skipped++; continue;}
      const scoped = {...ctx, field: entry.field};
      const raw = M.resolveKey(suggestion.key, scoped);
      if (raw === null || raw === undefined || raw === '') {
        suggestion.reason = 'no_value'; skipped++; continue;
      }
      const converted = M.convert(suggestion.key, raw, {...scoped,
        variantPool: M.variantPool(suggestion.key, ctx), ownVariants: M.ownVariants(suggestion.key, ctx)});
      if (converted.value === null || converted.value === undefined) {
        suggestion.reason = converted.reason || 'convert_failed'; skipped++; continue;
      }
      const applied = await applyValue(entry, converted.value, {key: suggestion.key,
        eligible: () => bindingCurrent(binding),
        candidates: M.optionCandidates(suggestion.key, converted.value, context())});
      if (!bindingCurrent(binding)) break;
      if (!applied.ok) {
        suggestion.reason = applied.reason || applied.error || 'fill_failed'; skipped++; continue;
      }
      state.filled.add(applied.element || entry.element);
      state.decisions.set(entry.field.index, {
        status: suggestion.conf >= 0.85 ? 'filled' : 'pending', key: suggestion.key,
        conf: suggestion.conf, layer: 'ai', value: converted.value, reason: 'ai_suggest',
      });
      suggestion.applied = true;
      filled++;
      state.log?.field('info', 'ai', 'filled', entry.field,
        {key: suggestion.key, conf: suggestion.conf, method: applied.method});
      if (options.learn !== false) {
        await send('learn', {label: entry.field.label, key: suggestion.key, site: state.session?.site}).catch(() => {});
      }
    }
    if (filled && bindingCurrent(binding)) {
      await capture({by: 'ai'});
      render();
    }
    return {filled, skipped};
  }

  async function aiUserTrigger() {
    if (!state.submitted && !state.session) await ensureSession();
    if (state.submitted) {
      UI.toast(state.layer, '已记录提交，请先核实结果，不再填写', 'warn');
      return {blocked: true, reason: 'submitted'};
    }
    const result = await aiFallback({force: true, applyAuto: false});
    if (!result) {UI.toast(state.layer, '先在侧边栏选一个目标项目', 'warn'); return result;}
    if (result.enabled === false) {UI.toast(state.layer, 'AI 未启用：在 config.json 打开 ai.enabled', 'warn'); return result;}
    if (result.error) {UI.toast(state.layer, 'AI 不可用：' + result.error, 'warn'); return result;}
    if (result.stale) {UI.toast(state.layer, '页面或项目已变化，未应用旧建议', 'warn'); return result;}
    const applied = await applyAi();
    if (applied.filled && TOP) await maybeAutoNext();
    if (applied.filled) UI.toast(state.layer, `AI 已补填 ${applied.filled} 项`);
    else UI.toast(state.layer, 'AI 没有找到可填的项');
    return {...result, applied};
  }

  function scan() {
    state.entries = F.scan(state.rules || {});
    if (!state.platform || state.platform === 'generic') state.platform = state.entries[0]?.field.platform || 'generic';
    return state.entries;
  }

  function signature() {
    return state.entries.map(entry => F.ownLabel(entry.element) + '|' + entry.field.inputType).join('|');
  }

  function counters() {
    const result = {filled: 0, confirm: 0, unmatched: 0, captcha: 0, honeypot: 0, sensitive: 0, total: 0};
    for (const entry of state.entries) {
      const decision = state.decisions.get(entry.field.index);
      if (entry.field.honeypot) { result.honeypot++; continue; }
      if (decision?.status === 'captcha' || entry.field.captcha) { result.captcha++; continue; }
      if (decision?.status === 'sensitive') { result.sensitive++; continue; }
      result.total++;
      const value = F.read(entry.element, entry.field);
      const hasValue = value !== undefined && String(value).trim() !== '';
      if (decision?.status === 'filled' && (hasValue || entry.field.inputType === 'file')) result.filled++;
      else if (decision?.status === 'pending') result.confirm++;
      else if (!hasValue) result.unmatched++;
    }
    if (result.filled + result.confirm + result.unmatched > result.total) result.total = result.filled + result.confirm + result.unmatched;
    state.counters = result;
    return result;
  }

  // ---------- 标记 ----------

  function marks(layer) {
    const count = counters();
    for (const entry of state.entries) {
      const decision = state.decisions.get(entry.field.index);
      const field = entry.field;
      const value = F.read(entry.element, field);
      const hasValue = value !== undefined && String(value).trim() !== '';
      const title = decision?.key ? `${field.label || '字段'} · ${decision.key}` : (field.label || '字段');
      if (field.honeypot) { layer.set(entry.element, null); continue; }
      if (decision?.status === 'captcha' || field.captcha) { layer.set(entry.element, 'captcha', {title: '验证码：交人'}); continue; }
      if (decision?.status === 'sensitive') { layer.set(entry.element, 'sensitive', {title: '敏感字段：不读不填'}); continue; }
      if (field.inputType === 'file') {
        layer.set(entry.element, decision?.status === 'filled' ? 'filled' : 'unmatched',
          {title: decision?.status === 'filled' ? '已放入文件' : '缺素材'});
        continue;
      }
      if (decision?.status === 'filled' && hasValue) { layer.set(entry.element, 'filled', {title}); continue; }
      if (decision?.status === 'pending' || decision?.status === 'confirm') { layer.set(entry.element, 'pending', {title: title + ' · 待确认'}); continue; }
      if (field.required && !hasValue) { layer.set(entry.element, 'failed', {title: title + ' · 必填未填'}); continue; }
      if (decision?.status === 'filled') { layer.set(entry.element, 'pending', {title: title + ' · 未写入'}); continue; }
      if (!hasValue) { layer.set(entry.element, 'unmatched', {title: title + ' · 未匹配'}); continue; }
      layer.set(entry.element, null);
    }
    return count;
  }

  function statusText() {
    const count = counters();
    if (!state.session) {
      return {text: count.filled ? `本页已填 ${count.filled} 项` : '未选择项目',
        chips: [{label: '在侧边栏选目标站', tone: 'warn'}]};
    }
    const chips = [];
    if (count.confirm) chips.push({label: `待确认 ${count.confirm}`, tone: 'warn'});
    if (count.unmatched) chips.push({label: `未匹配 ${count.unmatched}`, tone: 'bad'});
    if (count.captcha) chips.push({label: '验证码 1', tone: 'warn'});
    if (state.restored) chips.push({label: `已复原 ${state.restored}`, tone: 'ok'});
    if (state.ai?.busy) chips.push({label: 'AI 分析中', tone: ''});
    const aiOpen = state.ai?.suggestions?.filter(item => item.key && !item.applied && !item.reason).length || 0;
    if (aiOpen) chips.push({label: `AI 建议 ${aiOpen}`, tone: 'ok', action: 'panel'});
    if (state.ai?.error) chips.push({label: 'AI 不可用', tone: 'warn'});
    return {text: `已填 ${count.filled}/${count.total}`, chips};
  }

  function syncFloatingWindow() {
    if (!TOP || !state.layer) return;
    if (state.settings.floating_window === false) {
      state.bar?.remove();
      state.bar = null;
      return;
    }
    if (state.bar) return;
    state.bar = UI.statusBar({onAction: action => {
      if (action === 'fill') fillAll({force: false});
      if (action === 'ai') aiUserTrigger();
      if (action === 'restore') restore({announce: true});
      if (action === 'panel') send('panel:open').catch(() => {});
    }});
    state.bar.set(statusText());
  }

  function render() {
    syncFloatingWindow();
    const count = marks(state.marks);
    if (state.bar) state.bar.set(statusText());
    const decisionView = state.entries.map(entry => ({
      index: entry.field.index, label: entry.field.label, key: state.decisions.get(entry.field.index)?.key || null,
      status: state.decisions.get(entry.field.index)?.status || 'unmatched', reason: state.decisions.get(entry.field.index)?.reason || '',
      conf: state.decisions.get(entry.field.index)?.conf ?? 0, widget: entry.field.widget, required: !!entry.field.required,
      value: (() => { const value = F.read(entry.element, entry.field); return value === undefined ? '' : String(value).slice(0, 120); })(),
      hasValue: (() => { const value = F.read(entry.element, entry.field); return value !== undefined && String(value).trim() !== ''; })(),
      captcha: !!entry.field.captcha, honeypot: !!entry.field.honeypot, sensitive: entry.field.sensitive || null,
    }));
    if (TOP) {
      UI.publish({...count, step: state.step, restored: state.restored, platform: state.platform,
        site: state.session?.site || null, source: state.session?.source_domain || null,
        decisions: decisionView, ai: aiSummary()});
    }
    send('frame:report', {summary: {url: location.href, frame: TOP ? 0 : null, count, step: state.step,
      platform: state.platform, decisions: decisionView, ai: aiSummary(), top: TOP}}).catch(() => {});
    return count;
  }

  // ---------- 填写 ----------

  async function fetchAssetBytes(asset) {
    const file = await send('file', {id: asset.id, sha256: asset.sha256});
    const binary = atob(file.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return {bytes, type: file.type, name: asset.name};
  }

  function fieldIdentity(field, element) {
    return JSON.stringify([field.label, field.labelParts?.own, field.labelParts?.aria, element.name, element.id,
      field.inputType, field.widget, field.platformId,
      field.autocomplete, field.maxlength, field.minlength, field.pattern, field.min, field.max, field.accept, field.multiple]);
  }

  function fieldTarget(entry) {
    return {...entry, form: entry.element.form, root: entry.element.getRootNode(), documentRoot: document.documentElement,
      identity: fieldIdentity(entry.field, entry.element)};
  }

  function currentTarget(target) {
    if (target.documentRoot !== document.documentElement) return null;
    const matches = F.scan(state.rules || {}).filter(entry => entry.element.form === target.form &&
      entry.element.getRootNode() === target.root && fieldIdentity(entry.field, entry.element) === target.identity &&
      !entry.field.sensitive && !entry.field.captcha && !entry.field.honeypot && !M.sensitivityOf(entry.field, state.rules || {}));
    return matches.length === 1 ? matches[0] : null;
  }

  function writeBinding(entry, extra) {
    const target = fieldTarget(entry), element = target.element;
    const generation = state.sessionGeneration, url = location.href;
    const humanRevision = state.humanRevision;
    const contextCurrent = () => contentAllowed() && !state.submitted && state.sessionGeneration === generation &&
      state.humanRevision === humanRevision && location.href === url && target.documentRoot === document.documentElement && (!extra || extra());
    const eligible = () => {
      if (!contextCurrent() || !element.isConnected || element.form !== target.form || element.getRootNode() !== target.root) return false;
      const current = F.describe(element, state.rules || {});
      return !current.disabled && !current.honeypot && !current.captcha && !current.sensitive &&
        !M.sensitivityOf(current, state.rules || {}) && fieldIdentity(current, element) === target.identity;
    };
    return {eligible, contextCurrent, target};
  }

  function writeSync(action) {
    state.ownWriteDepth++;
    try {return action();} finally {state.ownWriteDepth--;}
  }

  async function applyValue(entry, value, options = {}) {
    if (!contentAllowed()) return {ok: false, reason: 'login_in_progress'};
    const field = entry.field, element = entry.element;
    const log = state.log;
    const started = Date.now();
    if ((value === undefined || value === null || value === '') && !options.asset) return {ok: false, reason: 'no_value'};
    try {
      const binding = writeBinding(entry, options.eligible), eligible = binding.eligible;
      if (!eligible()) return {ok: false, reason: 'target_changed'};
      if (field.inputType === 'file') {
        const asset = options.asset || context().kit.assets?.find(item => item.id === value?.id && item.key === value?.key);
        if (!asset) return {ok: false, reason: 'missing_asset'};
        if (String(asset.mime || '').startsWith('video/') || (asset.bytes || 0) > 2_000_000) {
          // 大文件走本机暂存路径 + CDP，不经消息体。
          const staged = await send('stage', {id: asset.id, sha256: asset.sha256});
          if (!eligible()) return {ok: false, reason: 'target_changed'};
          if (state.fileWrites.has(element)) return {ok: false, reason: 'file_write_in_progress'};
          state.fileWrites.add(element);
          let result;
          try {
            result = await send('cdp:upload', {selector: F.selector(element), path: staged.path, allowedRoot: staged.root});
          } finally {state.fileWrites.delete(element);}
          if (!eligible()) return {ok: false, reason: 'target_changed'};
          if (result?.ok) { state.assetIds[field.index] = {id: asset.assetId, sha256: asset.sha256}; return {ok: true, method: 'cdp-file'}; }
          return {ok: false, reason: result?.error || 'cdp_upload_failed'};
        }
        const file = await fetchAssetBytes(asset);
        if (!eligible()) return {ok: false, reason: 'target_changed'};
        const ok = await F.setFile(element, file);
        if (ok) state.assetIds[field.index] = {id: asset.assetId, sha256: asset.sha256};
        return {ok, method: 'datatransfer'};
      }
      if (field.inputType === 'radio') {
        const ok = F.setRadio(element, value);
        return {ok, method: 'radio'};
      }
      if (field.inputType === 'checkbox') {
        const ok = value === true || value === field.label;
        F.setChecked(element, ok);
        return {ok: !!element.checked, method: 'checked'};
      }
      if (element.tagName === 'SELECT') {
        if (element.multiple || field.widget === 'select-multiple') {
          const ok = F.setMultiSelect(element, value);
          return {ok, method: 'multi-select'};
        }
        const ok = Array.isArray(value) ? false : F.setSelect(element, value);
        return {ok, method: 'select'};
      }
      if (['react-select', 'mui-autocomplete', 'choices', 'custom-select', 'select2', 'tags', 'date'].includes(field.widget) || element.isContentEditable) {
        const candidates = options.candidates || (Array.isArray(value) ? value : [String(value)]);
        const custom = await BKWidgets.set(element, field, value, {candidates, eligible, writeSync});
        if (!eligible()) return {ok: false, reason: 'target_changed'};
        if (custom) {
          // 适配器已派发过动作却未确认选中时，只回读交人，不用 CDP 再写搜索框伪造成功。
          if (!custom.ok) return {ok: false, method: custom.method, reason: custom.reason || custom.error || 'widget_unverified'};
          const text = Array.isArray(value) ? value.join(', ') : String(value);
          const readback = custom.selected != null ? custom.selected : F.read(element, field);
          const normalize = value => String(value).trim().toLocaleLowerCase();
          // 只接受完整值或真实候选项，不能用空串/子串包含关系判成功。
          const ok = readback !== undefined && readback !== null &&
            [text, ...candidates].some(candidate => normalize(readback) === normalize(candidate));
          if (custom.uncertain) state.log?.field('debug', 'fill', 'widget_unverified', field, {method: custom.method, readback});
          // 已派发控件动作却回读不一致属于未知结果，不切换输入通道重放。
          return {ok, method: custom.method || field.widget};
        }
      }
      if (Array.isArray(value)) return {ok: false, reason: 'unexpected_list'};
      F.setValue(element, String(value));
      // 给受控组件一次状态提交窗口；瞬时 DOM 值不代表框架已接受。
      await BKWidgets.sleep(80);
      if (!eligible()) {
        // 受控组件可能提交后重挂载；只读核实唯一同业务字段，绝不向失效节点重放输入。
        const current = !element.isConnected && binding.contextCurrent() ? currentTarget(binding.target) : null;
        const ok = !!current && String(F.read(current.element, current.field) ?? '') === String(value);
        return {ok, method: 'dom-remount', reason: ok ? '' : 'target_changed', element: ok ? current.element : undefined};
      }
      const readback = F.read(element, field);
      const ok = element.isConnected && String(readback ?? '') === String(value);
      return {ok, method: 'dom', reason: ok ? '' : 'readback_mismatch'};
    } catch (error) {
      return {ok: false, error: String(error?.message || error)};
    } finally {
      if (log) log.info('fill', 'fill_attempt', {ms: Date.now() - started, key: options.key, method: options.method});
    }
  }

  async function fillAll(options = {}) {
    if (state.submitted || !contentAllowed()) return state.counters;
    if (state.busy) { state.pending = true; return state.counters; }
    state.busy = true;
    const log = state.log;
    let passGeneration = state.sessionGeneration;
    try {
      if (!state.session && !await ensureSession()) return state.counters;
      if (state.submitted || !contentAllowed()) return state.counters;
      scan();
      const ctx = matchCtx();
      const generation = state.sessionGeneration, url = location.href, documentRoot = document.documentElement;
      passGeneration = generation;
      const passCurrent = () => contentAllowed() && !state.submitted && state.sessionGeneration === generation && location.href === url &&
        document.documentElement === documentRoot;
      const targets = state.entries.map(fieldTarget);
      const shape = targets.map(target => target.identity).join('\n');
      const started = Date.now();
      const results = [];
      for (const target of targets) {
        if (!passCurrent()) break;
        const entry = target.element.isConnected ? {element: target.element,
          field: {...F.describe(target.element, state.rules || {}), index: target.field.index}} : currentTarget(target);
        if (!entry) continue;
        const field = entry.field;
        if (field.honeypot) { state.decisions.set(field.index, {status: 'honeypot', reason: field.honeypot, conf: 0}); continue; }
        if (options.only !== undefined && options.only !== null && field.index !== options.only) continue;
        if (state.byHuman.has(entry.element) && !options.force) continue;
        if (F.read(entry.element, field) !== undefined && String(F.read(entry.element, field) ?? '').trim() && !options.force) {
          // 页面上已有值：保留，除非是扩展刚填的。
          if (!state.filled.has(entry.element)) state.byHuman.add(entry.element);
          const decision = M.run(entry, {...ctx, field});
          if (['honeypot', 'sensitive', 'captcha'].includes(decision.status)) state.decisions.set(field.index, decision);
          continue;
        }
        const decision = M.run(entry, {...ctx, field});
        state.decisions.set(field.index, decision);
        if (decision.status === 'sensitive') log?.field('info', 'scan', 'sensitive', field, {key: decision.key});
        if (decision.status === 'captcha') log?.field('info', 'captcha', 'captcha_detected', field);
        if (decision.status === 'honeypot') log?.field('debug', 'scan', 'honeypot', field, {reason: field.honeypot});
        if (!M.shouldFill(decision.status, state.settings, decision)) {
          if (decision.status === 'unmatched') log?.field('info', 'match', 'unmatched', field, {conf: decision.conf, layer: decision.layer});
          results.push({label: field.label, key: decision.key, status: decision.status === 'pending' ? 'confirm' : decision.status, conf: decision.conf, layer: decision.layer});
          continue;
        }
        const value = decision.asset ? {key: decision.asset.key, id: decision.asset.id} : decision.value;
        state.decisions.set(field.index, {...decision, status: 'pending', reason: 'filling'});
        const applied = await applyValue(entry, value, {asset: decision.asset, key: decision.key,
          eligible: passCurrent,
          candidates: decision.key ? M.optionCandidates(decision.key, decision.value, context()) : undefined});
        if (!passCurrent()) break;
        if (applied.ok) {
          state.filled.add(applied.element || entry.element);
          state.decisions.set(field.index, decision);
          log?.field('info', 'fill', 'filled', field, {key: decision.key, conf: decision.conf, layer: decision.layer,
            method: applied.method, value: decision.asset ? decision.asset.name : decision.value, value_len: String(decision.value ?? '').length});
          results.push({label: field.label, key: decision.key, status: 'filled', conf: decision.conf, layer: decision.layer});
        } else {
          if (applied.method?.startsWith('cdp')) log?.field('warn', 'fill', 'cdp_fallback_failed', field, {reason: applied.reason || applied.error});
          state.decisions.set(field.index, {...decision, status: 'pending', reason: applied.reason || applied.error || 'fill_failed'});
          log?.field('warn', 'fill', 'fill_failed', field, {key: decision.key, reason: applied.reason || applied.error, method: applied.method});
          results.push({label: field.label, key: decision.key, status: 'failed', conf: decision.conf, reason: applied.reason || applied.error});
        }
      }
      if (!passCurrent()) return state.counters;
      scan();
      if (state.entries.map(entry => fieldIdentity(entry.field, entry.element)).join('\n') !== shape) state.pending = true;
      const count = counters();
      render();
      log?.push('info', 'perf', 'run_summary', {
        fields_total: count.total, filled_auto: count.filled, needs_confirm: count.confirm, unmatched: count.unmatched,
        honeypot: count.honeypot, captcha: count.captcha, ms: Date.now() - started, restores: state.restored, result: state.submitted ? 'submitted' : 'filled',
      });
      await log?.flush();
      await send('results', {data: {results}}).catch(() => {});
      await capture({reason: 'fill'});
      await aiFallback();
      await maybeAutoNext();
      return count;
    } finally {
      state.busy = false;
      if (state.pending) {
        state.pending = false;
        queueMicrotask(() => fillAll(state.sessionGeneration === passGeneration ? options : {}));
      }
    }
  }

  // ---------- 快照与复原 ----------

  async function capture(options = {}) {
    const entries = F.scan(state.rules || {});
    if (!entries.length || !contentAllowed()) return null;
    const snapshot = S.capture({
      entries: entries.map(entry => ({...entry, key: state.decisions.get(entry.field.index)?.key,
        needsConfirmation: !state.byHuman.has(entry.element) && ['pending', 'confirm'].includes(state.decisions.get(entry.field.index)?.status)})),
      site: state.session?.site || '', source_domain: state.session?.source_domain || location.hostname,
      url: location.href, stepIndex: state.step, by: options.by || 'extension', complete: state.complete,
      assetIds: state.assetIds,
    });
    if (state.lastSnapshot?.site === snapshot.site && state.lastSnapshot?.source_domain === snapshot.source_domain) {
      snapshot.steps = snapshot.steps.map((step, index) => index === state.step ? step : state.lastSnapshot.steps[index] || step);
    }
    state.lastSnapshot = snapshot;
    try {
      await send('snapshot:save', {snapshot, reason: options.reason || 'change'});
      state.log?.push('debug', 'snapshot', 'saved', {step: state.step, fields: snapshot.steps[state.step]?.fields.length});
    } catch (error) {
      state.log?.push('warn', 'snapshot', 'save_failed', {reason: String(error.message)});
    }
    return snapshot;
  }

  async function restore(options = {}) {
    if (state.submitted || !contentAllowed()) return;
    const binding = {generation: state.sessionGeneration, humanRevision: state.humanRevision,
      url: location.href, documentRoot: document.documentElement};
    const eligible = () => bindingCurrent(binding);
    const verify = () => {if (!eligible()) throw Error('复原上下文已变化，停止填写');};
    const log = state.log;
    const snapshot = options.snapshot || await send('snapshot:latest', {
      url: location.href, source: state.session?.source_domain || location.hostname,
      fingerprint: S.fingerprintFields(state.entries.map(entry => entry.field)), hours: state.settings.restore_window_hours ?? 2,
    }).catch(() => null);
    verify();
    if (!snapshot) { if (options.announce) UI.toast(state.layer, '没有可复原的快照'); return {restored: 0}; }
    if (!state.session?.site || snapshot.site !== state.session.site || snapshot.source_domain !== state.session.source_domain) {
      throw Error('快照与当前项目或来源不匹配，不能复原');
    }
    // 等页面稳定：DOM 500ms 无变动或最多 8 秒。
    await settle();
    verify();
    scan();
    let restored = 0, conflicts = 0, skipped = 0, missing = 0, failed = 0;
    const rounds = options.rounds ?? 3;
    for (let round = 0; round < rounds; round++) {
      verify();
      const planned = S.plan(snapshot, state.entries, {});
      missing = planned.missing.length;
      conflicts += planned.conflicts.length;
      for (const record of planned.missing) if (record.skipped) skipped++;
      if (!planned.matched.length) break;
      for (const item of planned.matched) {
        verify();
        const field = item.entry.field;
        const asset = record => record.asset_sha256 && (context().kit.assets || []).find(candidate =>
          candidate.assetId === record.asset_id && candidate.sha256 === record.asset_sha256);
        if (field.inputType === 'file') {
          const found = item.record.asset_id ? asset(item.record) : null;
          if (!found) {
            failed++;
            state.byHuman.add(item.entry.element);
            state.decisions.set(field.index, {status: 'pending', layer: 'restore', reason: 'asset_changed'});
            continue;
          }
          const applied = await applyValue(item.entry, null, {asset: found, eligible});
          verify();
          if (applied.ok) restored++;
          else failed++;
          continue;
        }
        const applied = await applyValue(item.entry, item.value, {eligible});
        verify();
        if (applied.ok) {
          restored++;
          state.decisions.set(field.index, {status: item.record.needs_confirmation ? 'pending' : 'filled',
            key: item.record.key, conf: 0.96, layer: 'restore', value: item.value});
        } else {
          failed++;
          state.decisions.set(field.index, {status: 'pending', key: item.record.key, conf: 0.6, layer: 'restore', reason: applied.reason || 'fill_failed'});
        }
      }
      scan();
      await BKWidgets.sleep(120);
      verify();
    }
    state.restored = restored;
    render();
    log?.push(restored ? 'info' : 'warn', 'restore', restored ? 'restored' : 'restore_failed',
      {step: snapshot.step_index, fields: restored, conflicts, skipped, by: snapshot.by});
    await log?.flush();
    verify();
    focusCaptcha();
    if (options.announce !== false && restored) UI.toast(state.layer, `已复原 ${restored} 项` + (conflicts ? `；${conflicts} 项与页面现值冲突，未覆盖` : ''));
    return {restored, conflicts, missing, failed};
  }

  async function restoreArchived() {
    const archive = state.session?.archive;
    if (!archive || state.submitted) return;
    if (state.archiveInFlight) return state.archiveInFlight;
    const key = state.session.site + '|' + archive.saved_at + '|' + signature();
    if (state.archiveRestored.has(key)) return;
    state.archiveRestored.add(key);
    state.archiveInFlight = (async () => {
      const frames = archive.frames.filter(frame => frame.url === location.href);
      if (frames.length !== 1) {
        if (TOP) UI.toast(state.layer, '存档页面不匹配或有同址框架歧义，请核对后手动复原', 'warn');
        return;
      }
      const frame = frames[0];
      const plans = frame.steps.map((step, index) => ({index,
        matches: S.plan({...frame, step_index: index}, state.entries).matched.length})).sort((a, b) => b.matches - a.matches);
      if (!plans[0]?.matches || plans[0].matches === plans[1]?.matches) return;
      const result = await restore({snapshot: {...frame, step_index: plans[0].index}, rounds: 1, announce: false});
      if (TOP) UI.toast(state.layer, `存档已复原 ${result.restored} 项` +
        (result.missing || result.failed || result.conflicts ? '；有未复原项，请核对表单' : '；请完成验证并自行提交'),
        result.missing || result.failed || result.conflicts ? 'warn' : 'ok');
    })();
    try { await state.archiveInFlight; } finally { state.archiveInFlight = null; }
  }

  async function settle(timeout = 8000) {
    const started = Date.now();
    let last = Date.now();
    return new Promise(resolve => {
      const observer = new MutationObserver(() => { last = Date.now(); });
      observer.observe(document.documentElement, {childList: true, subtree: true, attributes: true});
      const tick = () => {
        const quiet = Date.now() - last > 500, expired = Date.now() - started > timeout;
        if (quiet || expired) { observer.disconnect(); resolve(); return; }
        setTimeout(tick, 100);
      };
      setTimeout(tick, 100);
    });
  }

  function focusCaptcha() {
    const target = state.entries.find(entry => entry.field.captcha || state.decisions.get(entry.field.index)?.status === 'captcha');
    if (!target) return false;
    target.element.scrollIntoView({behavior: 'smooth', block: 'center'});
    setTimeout(() => target.element.focus?.(), 250);
    return true;
  }

  // ---------- 多步表单自动点下一步 ----------

  function autoNextEnabled() {
    const source = state.session?.source_domain;
    const override = source ? (state.settings.auto_next_sites || {})[source] : undefined;
    if (override !== undefined && override !== null) return !!override;
    return state.settings.auto_next === true;
  }

  async function maybeAutoNext() {
    if (state.submitted || !contentAllowed()) return false;
    const enabled = autoNextEnabled();
    const log = state.log;
    if (!enabled) {
      if (state.counters.captcha === 0 && state.counters.filled && !state.counters.unmatched) {
        log?.push('info', 'auto-next', 'manual_next_required', {step: state.step});
      }
      return false;
    }
    const count = counters();
    if (count.captcha) { log?.push('info', 'auto-next', 'skipped_captcha', {step: state.step}); return false; }
    if (count.confirm || count.unmatched) { log?.push('info', 'auto-next', 'skipped_incomplete', {step: state.step, confirm: count.confirm, unmatched: count.unmatched}); return false; }
    const labels = state.rules?.navigation?.next_labels || ['Next', 'Continue'];
    const buttons = [...document.querySelectorAll('button,[role="button"],input[type=button],input[type=submit],a.button')]
      .filter(node => !state.autoNextDone.has(node) && node.getClientRects().length && !node.disabled);
    const target = buttons.find(node => {
      const text = (node.value || node.textContent || '').trim();
      return text && labels.some(label => text.toLowerCase() === label.toLowerCase()) && !FINAL_WORDS.test(text);
    });
    if (!target) return false;
    state.autoNextDone.add(target);
    log?.push('info', 'user', 'auto_next_clicked', {step: state.step, label: (target.value || target.textContent || '').trim(), by: 'auto-next'});
    target.click();
    await BKWidgets.sleep(600);
    return true;
  }

  // ---------- 事件与观察 ----------

  let watchTimer = null, debounce = null;

  function watch() {
    const observer = new MutationObserver(records => {
      if (!TOP && records.length === 0) return;
      if (debounce) return;
      debounce = setTimeout(async () => {
        debounce = null;
        const before = signature();
        scan();
        if (state.lastSignature && before !== signature()) {
          state.step++;
          state.log?.setStep(state.step);
          state.log?.push('info', 'scan', 'step_changed', {step: state.step});
          await restoreArchived();
          await fillAll({});
        } else {
          render();
        }
        state.lastSignature = signature();
      }, 400);
    });
    observer.observe(document.documentElement, {childList: true, subtree: true});
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => observer.disconnect(), 30000);
    return observer;
  }

  function bindHumanInput() {
    const mark = event => {
      if (!event.isTrusted || state.ownWriteDepth || state.fileWrites.has(event.target)) return;
      state.humanRevision++;
      state.byHuman.add(event.target);
      if (event.target.type === 'file') {
        const entry = state.entries.find(item => item.element === event.target);
        if (entry) delete state.assetIds[entry.field.index];
      }
      state.touched.add(event.target);
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => capture({by: 'manual'}), 300);
    };
    document.addEventListener('input', mark, true);
    document.addEventListener('change', mark, true);
    const humanIntent = event => {
      if (event.isTrusted && !state.ownWriteDepth) state.humanRevision++;
    };
    document.addEventListener('pointerdown', humanIntent, true);
    document.addEventListener('drop', humanIntent, true);
    document.addEventListener('submit', () => {
      if (!contentAllowed()) return;
      state.submitted = true;
      state.log?.push('info', 'user', 'submit_detected', {step: state.step});
      // 立即撤销后台在途会话，不等快照落盘再上报投稿。
      send('submitted', {data: {step: state.step}, item: state.entryItem}).catch(() => {});
      capture({reason: 'submit'});
    }, true);
    window.addEventListener('pagehide', () => { capture({reason: 'pagehide'}); });
    document.addEventListener('focusin', event => {
      if (!state.settings.inline_asset_button) return;
      const entry = state.entries.find(item => item.element === event.target);
      if (!entry || entry.field.sensitive || entry.field.captcha || entry.field.honeypot) return;
      openFieldButton(entry);
    }, true);
    document.addEventListener('keydown', event => {
      humanIntent(event);
      if (!event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'f' && !event.shiftKey) { event.preventDefault(); fillCurrentField(); }
      if (key === 'f' && event.shiftKey) { event.preventDefault(); fillAll({force: false}); }
      if (key === 'a' && !event.shiftKey) { event.preventDefault(); aiUserTrigger(); }
      if (key === 'r') { event.preventDefault(); restore({announce: true}); }
    }, true);
  }

  function openFieldButton(entry) {
    state.button?.stop();
    state.button = UI.fieldButton(state.layer, entry.element, async () => {
      await openPicker(entry);
    });
  }

  // 缩略图按需加载一次，之后弹层直接复用。
  const thumbs = new Map();
  async function ensureThumbs() {
    for (const asset of context().kit.assets || []) {
      if (thumbs.has(asset.id)) continue;
      if (!String(asset.mime || '').startsWith('image/')) {thumbs.set(asset.id, null); continue;}
      try {
        const file = await send('file', {id: asset.id});
        thumbs.set(asset.id, `data:${file.type};base64,${file.data}`);
      } catch {thumbs.set(asset.id, null);}
    }
  }

  async function assetItems(entry) {
    const items = M.suggest(entry, matchCtx());
    await ensureThumbs();
    for (const asset of context().kit.assets || []) {
      const item = {key: asset.key, display: asset.name, length: asset.bytes || 0, limit: -1, conf: 0.5,
        asset: {...asset, url: thumbs.get(asset.id) || ''}, value: {id: asset.id, key: asset.key}, assetId: asset.id};
      items.push(item);
    }
    return items;
  }

  async function openPicker(entry) {
    const items = await assetItems(entry);
    const decision = state.decisions.get(entry.field.index);
    UI.showPopover({layer: state.layer, anchor: entry.element, items,
      title: entry.field.label || '填入这个字段',
      subtitle: [decision?.key ? `匹配：${decision.key}` : '未匹配到素材键',
        entry.field.maxlength >= 0 ? `限 ${entry.field.maxlength} 字` : ''].filter(Boolean).join(' · '),
      onPick: item => pick(entry, item)});
  }

  async function pick(entry, item) {
    const value = item.asset ? {id: item.asset.id, key: item.asset.key} : item.value;
    const applied = await applyValue(entry, value, {asset: item.asset, key: item.key});
    if (applied.ok) {
      state.filled.add(entry.element);
      state.decisions.set(entry.field.index, {status: 'filled', key: item.key, conf: item.conf, layer: 'manual_pick', value: item.value});
      state.log?.field('info', 'user', 'manual_pick', entry.field, {key: item.key, value: item.asset ? item.asset.name : item.display});
      await send('learn', {label: entry.field.label, key: item.key, site: state.session?.site}).catch(() => {});
      await capture({by: 'manual'});
      render();
    } else {
      UI.toast(state.layer, '写入失败：' + (applied.reason || applied.error || '未知原因'));
    }
  }

  async function fillCurrentField() {
    const active = document.activeElement;
    const entry = state.entries.find(item => item.element === active || item.element.contains?.(active));
    if (!entry) { UI.toast(state.layer, '先把光标放到要填的字段上', 'warn'); return; }
    await openPicker(entry);
  }

  // ---------- 启动 ----------

  async function start() {
    state.layer = {layer: null};
    const ui = UI.createLayer();
    state.layer = ui.layer;
    state.marks = UI.createMarks(ui.layer);
    // 监听先于会话请求，避免漏掉启动回包前的人工提交。
    bindHumanInput();
    const mark = BKLogic.marker(location.href);
    state.entryItem = mark?.id || null;
    if (mark) history.replaceState(history.state, '', mark.url);
    let session = null;
    try {
      session = await send('session', {id: mark?.id, url: location.href, authGate: loginPage()});
    } catch (error) {
      if (TOP) UI.toast(ui.layer, '连接本机服务失败：' + error.message);
    }
    if (session) {
      if (!adoptContext(session.context, session.submitted)) return false;
      state.rules = session.rules;
      state.settings = {...(session.settings || {})};
      if (session.context?.auto_next != null) state.settings.auto_next_for = session.context.auto_next;
      state.step = session.step || 0;
    } else {
      state.rules = await send('rules').catch(() => ({})) || {};
      state.settings = await send('settings').catch(() => ({})) || {};
    }
    state.log = BKLog.create({tab: null, frame: TOP ? 0 : 1, site: state.session?.site, source: state.session?.source_domain,
      url: !session || loginPage() ? location.origin + location.pathname : location.href, level: state.settings.log_level || 'info'});
    BKWidgets.debug = (msg, extra) => state.log?.push('debug', 'fill', msg, extra);
    state.log.info('scan', 'page_ready', {platform: F.scan ? undefined : undefined, top: TOP});
    syncFloatingWindow();
    scan();
    state.platform = state.entries[0]?.field.platform || 'generic';
    state.log.push('info', 'scan', 'scanned', {fields: state.entries.length, platform: state.platform, top: TOP});
    state.lastSignature = signature();
    if (state.session && !state.submitted) {
      await restoreArchived();
      await fillAll({});
      const wanted = await send('snapshot:decision', {url: location.href, source: state.session.source_domain,
        fingerprint: S.fingerprintFields(state.entries.map(entry => entry.field))}).catch(() => null);
      state.log.push('info', 'snapshot', 'restore_decision', {decision: wanted || 'none', step: state.step});
      if (wanted === 'auto') await restore({announce: true});
      else if (wanted === 'ask') UI.toast(state.layer, '发现一份较新的快照，可在状态条点“复原快照”取回。', 6000);
    } else if (state.entries.length) {
      render();
    }
    watch();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    state.settings = {...state.settings, floating_window: changes.settings.newValue?.floating_window !== false};
    syncFloatingWindow();
  });

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    const handlers = {
      'page:loginHold': () => {state.loginHold = !!message.held; return {held: state.loginHold};},
      // Agent 在“我已提交”之前读回页面：只建立会话，不触发自动填写。
      'page:adopt': async () => {
        if (!message.context) return {skipped: true};
        if (!adoptContext(message.context, message.submitted)) return {skipped: true};
        state.rules = message.rules || state.rules;
        state.settings = {...(message.settings || state.settings), auto_next_for: message.context.auto_next};
        state.step = message.step || 0;
        state.log?.setName(state.session.site);
        state.log?.setSource(state.session.source_domain);
        scan();
        render();
        return {adopted: true};
      },
      'page:session': async () => {
        // 同标签页的其它 frame 拿到会话后广播过来；采纳后立刻补填。
        if (!message.context || loginPage()) return {skipped: true};
        if (!adoptContext(message.context, message.submitted)) return {skipped: true};
        state.rules = message.rules || state.rules;
        state.settings = {...(message.settings || state.settings), auto_next_for: message.context.auto_next};
        state.step = message.step || 0;
        state.log?.setName(state.session.site);
        state.log?.setSource(state.session.source_domain);
        scan();
        await restoreArchived();
        await fillAll({});
        return {adopted: true};
      },
      'page:activate': async () => {
        const session = await send('session', {url: location.href, site: message.site, authGate: loginPage()});
        if (!session && loginPage()) return {loginRequired: true};
        if (!session) throw Error('这个来源拿不到资料：请从续填列表打开或先在侧边栏选项目');
        if (!adoptContext(session.context, session.submitted)) return false;
        state.rules = session.rules;
        state.settings = {...(session.settings || {}), auto_next_for: session.context?.auto_next};
        scan();
        await fillAll({});
        return {ok: true};
      },
      'page:batch-inspect': () => {
        scan();
        if (state.busy || state.aiBusy) return {hasForm: true, canSubmit: false};
        return BKBatchPage.inspect(document, state.entries, {url: location.href, login: loginPage() || !contentAllowed(),
          attempted: !!message.attempted, timedOut: !!message.timedOut, baseline: message.baseline,
          decisions: state.decisions, byHuman: state.byHuman});
      },
      'page:batch-submit': async () => {
        scan();
        if (!state.session?.record?.id || state.submitted || state.busy || state.aiBusy || !contentAllowed()) throw Error('当前页面不允许自动提交');
        // 同任务的回包会更换对象引用，授权绑定持久身份，不能把等价刷新当作换任务。
        const binding = session => JSON.stringify([session?.site, session?.source_domain, session?.record?.id, session?.submit_url]);
        const bound = binding(state.session), href = location.href;
        const inspect = () => BKBatchPage.inspect(document, state.entries, {url: location.href, login: loginPage(),
          decisions: state.decisions, byHuman: state.byHuman});
        const check = inspect();
        if (!check.canSubmit) throw Error(check.reason || '表单未满足批量提交条件');
        const buttons = [...document.querySelectorAll('button,input[type=submit],[role=button]')].filter(node =>
          F.visible(node) && !node.disabled && /^(?:submit(?:\s+(?:listing|tool|product|application))?|send(?:\s+(?:application|listing))?|publish|提交|发布)$/i.test((node.value || node.textContent || '').trim()));
        if (buttons.length !== 1) throw Error('提交按钮不唯一，转人工核对');
        const target = buttons[0], label = target.value || target.textContent;
        const documentRoot = document.documentElement, buttonRoot = target.getRootNode(), form = target.form;
        const buttonIdentity = () => JSON.stringify([target.type, target.getAttribute('formaction'), target.getAttribute('formmethod'),
          form?.action, form?.method, target.getAttribute('aria-disabled')]);
        const identity = buttonIdentity();
        const fields = state.entries.map(entry => ({element: entry.element, form: entry.element.form,
          semantic: JSON.stringify(entry.field), value: F.read(entry.element, entry.field)}));
        const permit = await send('batch:authorize');
        if (permit?.authorized !== true || permit.id !== state.session.record.id) throw Error('批量单次授权回执不匹配，停止提交');
        scan();
        if (binding(state.session) !== bound || state.submitted || state.busy || state.aiBusy || href !== location.href || !contentAllowed() ||
            document.documentElement !== documentRoot || target.getRootNode() !== buttonRoot || target.form !== form ||
            buttonIdentity() !== identity || !F.visible(target) || !target.isConnected || target.disabled ||
            (target.value || target.textContent) !== label ||
            fields.length !== state.entries.length || fields.some((old, i) => old.element !== state.entries[i].element ||
              old.form !== state.entries[i].element.form || old.semantic !== JSON.stringify(state.entries[i].field) ||
              old.value !== F.read(state.entries[i].element, state.entries[i].field)) || !inspect().canSubmit) {
          throw Error('等待授权期间表单或任务改变，停止提交，请人工核对');
        }
        state.submitted = true;
        target.click();
        return {attempted: true};
      },
      'page:fill': () => fillAll({force: !!message.force}).then(count => ({count})),
      'page:fillField': async () => { await fillAll({only: message.index, force: true}); return {ok: true}; },
      'page:restore': () => restore({announce: true, snapshot: message.snapshot}),
      'page:snapshot': () => capture({reason: 'panel'}).then(snapshot => ({snapshot})),
      'page:archive': async () => {
        if (state.busy || state.aiBusy) throw Error('页面正在填写，请等完成后再存档');
        scan();
        const snapshot = await capture({reason: 'archive'});
        if (!snapshot) return {snapshot: {url: location.href, steps: [{fields: []}], step_index: 0}};
        snapshot.url = location.href;
        snapshot.verification = state.entries.some(entry => entry.field.captcha) ||
          !!document.querySelector('iframe[src*="captcha"],iframe[src*="challenges.cloudflare"],.g-recaptcha,.h-captcha,.cf-turnstile');
        snapshot.has_next = [...document.querySelectorAll('button,input[type=button]')].some(node =>
          F.visible(node) && (state.rules?.navigation?.next_labels || []).includes((node.value || node.textContent || '').trim()));
        return {snapshot};
      },
      'page:state': () => ({count: counters(), decisions: state.entries.map(entry => ({
        index: entry.field.index, label: entry.field.label, key: state.decisions.get(entry.field.index)?.key,
        status: state.decisions.get(entry.field.index)?.status, conf: state.decisions.get(entry.field.index)?.conf,
        reason: state.decisions.get(entry.field.index)?.reason, widget: entry.field.widget,
      })), step: state.step, platform: state.platform,
        ai: aiSummary(), aiEnabled: state.settings.ai_fallback !== false}),
      'page:ai': async () => {
        if (message.action === 'fill') return aiUserTrigger();
        if (message.action === 'apply') {
          const applied = await applyAi({indices: message.indices});
          if (applied.filled && TOP) await maybeAutoNext();
          return applied;
        }
        if (message.action === 'dismiss') {state.ai = null; render(); return {dismissed: true};}
        if (message.action === 'auto') {
          const result = await aiFallback({force: true, applyAuto: false});
          if (result?.enabled === false) return {...result, applied: {filled: 0, skipped: 0}};
          const applied = await applyAi({minConf: message.minConf ?? 0.9});
          if (applied.filled && TOP) await maybeAutoNext();
          return {...result, applied};
        }
        return aiFallback({force: true, applyAuto: false});
      },
      'page:locate': () => {
        const entry = state.entries.find(item => item.field.index === message.index);
        entry?.element.scrollIntoView({behavior: 'smooth', block: 'center'});
        entry?.element.focus?.();
        return {ok: !!entry};
      },
      'page:set': async () => {
        const entry = state.entries.find(item => item.field.index === message.index);
        if (!entry) throw Error('字段不存在');
        const applied = await applyValue(entry, message.value, {key: message.key});
        if (applied.ok) {
          state.decisions.set(entry.field.index, {status: 'filled', key: message.key, conf: 1, layer: 'manual_edit', value: message.value});
          if (message.key) await send('learn', {label: entry.field.label, key: message.key, site: state.session?.site}).catch(() => {});
          await capture({by: 'manual'});
          render();
        }
        return {ok: applied.ok, reason: applied.reason || applied.error};
      },
      // 诊断：把字段对象和各 key 的打分原样交出来，便于对不上时定位。
      'page:inspect': () => {
        const list = message.index === undefined || message.index === null
          ? state.entries : state.entries.filter(entry => entry.field.index === message.index);
        const rules = BKMatch.fieldRules(state.rules || {}).keys || {};
        return list.map(entry => ({
          field: entry.field,
          decision: state.decisions.get(entry.field.index) || null,
          ranking: Object.entries(rules).map(([key, rule]) => [key, BKMatch.scoreKey(entry.field, key, rule)])
            .filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]).slice(0, 6),
          probe: message.probe ? {
            title: document.title, elements: document.querySelectorAll('*').length,
            options: BKWidgets.optionNodes(document).length,
            anyOptionClass: document.querySelectorAll('[class*="option"]').length,
            ownerIsDocument: entry.element.ownerDocument === document,
            widget: entry.field.widget,
          } : undefined,
        }));
      },
      'page:focusCaptcha': () => ({ok: focusCaptcha()}),
      'page:complete': () => { state.complete = !!message.value; return capture({reason: 'complete'}); },
      'page:remember': () => remember().then(result => ({remembered: result?.remembered})),
      'page:steps': async () => {
        const snapshot = await capture({reason: 'steps'});
        return {steps: snapshotSteps(snapshot), complete: state.complete};
      },
      'page:done': async () => {
        const result = await remember();
        return send('done', {data: {steps: result.steps, complete: true}});
      },
      'page:skip': async () => send('skip', {data: {reason: message.reason || '人工跳过'}}),
    };
    const handler = handlers[message?.type];
    if (!handler) return;
    Promise.resolve(handler()).then(value => reply({value})).catch(error => reply({error: error.message}));
    return true;
  });

  // 快照 → 写回格式：只带标签、key 和值，敏感字段在采集时就已经标 skipped。
  function snapshotSteps(snapshot) {
    return (snapshot?.steps || []).map(step => ({fields: (step.fields || []).map(field => ({
      label: field.label, key: field.key, value: field.value, checked: field.checked,
      inputType: field.inputType, widget: field.widget,
    }))}));
  }

  async function remember() {
    const snapshot = await capture({reason: 'remember'});
    const steps = snapshotSteps(snapshot);
    const result = await send('remember', {data: {steps, complete: state.complete}});
    state.log?.push('info', 'user', 'remember', {fields: result?.remembered});
    return {...result, steps};
  }

  start().catch(error => {
    state.log?.push('error', 'error', 'start_failed', {reason: String(error.message)});
    if (TOP) UI.toast(state.layer || {querySelector: () => null}, 'Fast-Backlink 初始化失败：' + error.message);
  });
})();
