// 匹配分层：记忆 → 记录 → 配方 → 平台适配 → autocomplete → 学习映射 → 加权同义词 → 类型推断。
// 每层给 key 和置信度，值再按控件类型与约束转换；这里不碰 DOM，纯函数便于测试。
(function (root) {
  const T = root.BKText;
  const HIGH = 0.85, LOW = 0.5;

  function fieldRules(rules) {
    if (rules.fieldRules) return rules.fieldRules;
    const keys = {};
    for (const [key, words] of Object.entries(rules.labels || {})) keys[key] = {synonyms: words, patterns: [], weight: 1};
    return {keys, autocomplete: {}, qa_answers: {}};
  }

  function sources(field) {
    const parts = field.labelParts || {};
    // field.label 可能就是从 name/class 拆出来的，不能既当 bits 又当人类可读证据。
    const human = [parts.own, parts.aria, parts.near, parts.described, parts.placeholder]
      .filter(Boolean).map(T.normalize).filter(Boolean);
    const all = [...human, T.normalize(parts.bits)].filter(Boolean);
    return {human: [...new Set(human)], all: [...new Set(all)]};
  }

  function containsPhrase(text, phrase) {
    const needle = T.normalize(phrase);
    if (!needle) return false;
    if (text === needle) return 'exact';
    if (text.includes(needle)) {
      const at = text.indexOf(needle);
      const before = at === 0 ? ' ' : text[at - 1], after = text[at + needle.length] || ' ';
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return 'word';
      return 'contains';
    }
    return false;
  }

  // 与 scoreKey 同源，但额外回报“命中的同义词长度”，用于同分时选更具体的那一个。
  function scoreDetail(field, key, rule) {
    const detail = {score: 0, hit: 0, human: false};
    const {human, all} = sources(field);
    if (!human.length && !all.length) return detail;
    for (const phrase of rule.exclude || []) {
      if (human.some(text => containsPhrase(text, phrase))) return detail;
    }
    let best = 0, hit = 0, fromHuman = false;
    const consider = (score, length, humanHit) => {
      if (score > best) {best = score; hit = length; fromHuman = humanHit;}
      else if (score === best) {hit = Math.max(hit, length); fromHuman = fromHuman || humanHit;}
    };
    for (const synonym of rule.synonyms || []) {
      for (const text of human) {
        const found = containsPhrase(text, synonym);
        if (found === 'exact') consider(0.9 * (rule.weight ?? 1), synonym.length, true);
        else if (found === 'word') consider(0.86 * (rule.weight ?? 1), synonym.length, true);
        else if (found === 'contains') consider(0.78 * (rule.weight ?? 1), synonym.length, true);
      }
      for (const text of all) {
        const score = T.tokenScore(synonym, text);
        if (score >= 1) consider(0.7 * (rule.weight ?? 1), synonym.length, false);
        else if (score >= 0.75) consider(0.6 * (rule.weight ?? 1), synonym.length, false);
      }
    }
    for (const pattern of rule.patterns || []) {
      let expression = null;
      try { expression = new RegExp(pattern, 'i'); } catch { expression = null; }
      if (!expression) continue;
      if (human.some(text => expression.test(text))) consider(0.84 * (rule.weight ?? 1), pattern.length, true);
      else if (all.some(text => expression.test(text))) consider(0.6 * (rule.weight ?? 1), pattern.length, false);
    }
    if (best && !human.some(text => (rule.synonyms || []).some(synonym => containsPhrase(text, synonym)))) best = Math.min(best, 0.62);
    return {score: Number(best.toFixed(3)), hit, human: fromHuman};
  }

  // 第 7 层：加权同义词 + 正则。人类可读来源优先，name/class 拆出来的词只能算弱证据。
  function scoreKey(field, key, rule) {
    const {human, all} = sources(field);
    if (!human.length && !all.length) return 0;
    const excludes = rule.exclude || [];
    for (const phrase of excludes) {
      if (human.some(text => containsPhrase(text, phrase))) return 0;
    }
    let best = 0;
    for (const synonym of rule.synonyms || []) {
      for (const text of human) {
        const hit = containsPhrase(text, synonym);
        if (hit === 'exact') best = Math.max(best, 0.9 * (rule.weight ?? 1));
        else if (hit === 'word') best = Math.max(best, 0.86 * (rule.weight ?? 1));
        else if (hit === 'contains') best = Math.max(best, 0.78 * (rule.weight ?? 1));
      }
      for (const text of all) {
        const score = T.tokenScore(synonym, text);
        if (score >= 1) best = Math.max(best, 0.7 * (rule.weight ?? 1));
        else if (score >= 0.75) best = Math.max(best, 0.6 * (rule.weight ?? 1));
      }
    }
    for (const pattern of rule.patterns || []) {
      let expression = null;
      try { expression = new RegExp(pattern, 'i'); } catch { expression = null; }
      if (!expression) continue;
      if (human.some(text => expression.test(text))) best = Math.max(best, 0.84 * (rule.weight ?? 1));
      else if (all.some(text => expression.test(text))) best = Math.max(best, 0.6 * (rule.weight ?? 1));
    }
    // 只靠 name/id 命中的，降一档并设上限，避免“name 属性里有 url 就当成网址”。
    if (best && !human.some(text => (rule.synonyms || []).some(synonym => containsPhrase(text, synonym)))) best = Math.min(best, 0.62);
    return Number(best.toFixed(3));
  }

  const ASSET_KEYS = ['logo', 'icon', 'favicon', 'cover', 'screenshot', 'demo_gif', 'demo_video', 'maker_avatar'];

  function synonymRanking(field, rules, options = {}) {
    const table = fieldRules(rules).keys || {};
    const ranked = Object.entries(table)
      .filter(([key]) => !options.only || options.only.includes(key))
      .map(([key, rule]) => {
        const detail = scoreDetail(field, key, rule);
        return {key, conf: detail.score, hit: detail.hit, human: detail.human, layer: 'synonym'};
      })
      .filter(item => item.conf > 0)
      .sort((a, b) => b.conf - a.conf || b.hit - a.hit);
    if (!ranked.length) return null;
    const [first, second] = ranked;
    if (second && first.conf - second.conf < 0.03) {
      // 只有在人类可读来源上命中、且同义词更长（更具体）时才分胜负；否则交人。
      if (first.human && second.human && first.hit > second.hit) return first;
      return {ambiguous: ranked.slice(0, 3)};
    }
    return first;
  }

  function autocompleteKey(field, rules) {
    const value = String(field.autocomplete || '').toLowerCase().split(/\s+/).pop();
    const map = fieldRules(rules).autocomplete || {};
    return map[value] || null;
  }

  function typedKey(field) {
    if (field.inputType === 'email' || field.widget === 'email') return 'email';
    if (field.inputType === 'url' || field.widget === 'url') return 'url';
    if (field.accept?.includes('video')) return 'demo_video';
    if (field.accept?.includes('image') && field.inputType === 'file') return 'logo';
    return null;
  }

  function byLabel(list, label) {
    const wanted = T.normalize(label);
    const hits = (list || []).filter(item => T.normalize(item.label) === wanted);
    return hits.length === 1 ? hits[0] : undefined;
  }

  function savedFor(context, step) {
    const record = context.record;
    // 只取当前步的保存值；记录里的扁平字段是当前步的备用视图。
    if (step === (record?.step ?? 0)) return context.fields?.length ? context.fields : (context.steps?.[step]?.fields || []);
    return context.steps?.[step]?.fields || [];
  }

  // 分层找 key；命中即停，返回 {key, conf, layer, saved}
  function findKey(field, ctx) {
    const {context, rules, step = 0} = ctx;
    const record = byLabel(savedFor(context, step), field.label);
    if (record) return {key: record.key && record.key !== 'label' ? record.key : null, conf: 0.98, layer: 'record', saved: record};
    const memory = context.memory || {fields: [], labels: {}};
    const remembered = byLabel(memory.fields, field.label);
    if (remembered) return {key: remembered.key && remembered.key !== 'label' ? remembered.key : null, conf: 0.96, layer: 'memory', saved: remembered};
    const recipe = byLabel(context.recipe?.steps?.[step]?.fields, field.label);
    if (recipe) return {key: recipe.key, conf: 0.94, layer: 'recipe'};
    const label = T.normalize(field.label);
    if (label && memory.labels?.[field.label]) return {key: memory.labels[field.label], conf: 0.9, layer: 'memory_label'};
    if (root.BKPlatform && field.platform && field.platform !== 'generic') {
      const platform = root.BKPlatform.key(field, {rules});
      if (platform) return {key: platform.key, conf: platform.conf, layer: 'platform:' + platform.platform};
    }
    // 复选框只认原标签精确记忆，不从同义词或类型猜；同意条款一类一律交人。
    if (field.inputType === 'checkbox') return {key: null, conf: 0, layer: 'checkbox_memory_only'};
    const auto = autocompleteKey(field, rules);
    if (auto) return {key: auto, conf: 0.9, layer: 'autocomplete'};
    const learned = (rules.learned || {})[T.normalize(field.label)];
    if (learned && field.labelParts?.bits) return {key: learned, conf: 0.86, layer: 'learned'};
    if (learned) {
      const human = sources(field).human;
      if (human.some(text => text === T.normalize(field.label))) return {key: learned, conf: 0.84, layer: 'learned'};
    }
    const synonyms = synonymRanking(field, rules, field.inputType === 'file' ? {only: ASSET_KEYS} : {});
    if (synonyms?.key) return synonyms;
    if (synonyms?.ambiguous) return {key: null, conf: synonyms.ambiguous[0].conf * 0.6, layer: 'synonym_ambiguous', alternatives: synonyms.ambiguous};
    const typed = typedKey(field);
    if (typed) return {key: typed, conf: 0.6, layer: 'typed'};
    const qa = T.qaKey(field.label, {});
    if (qa) return {key: qa, conf: 0.8, layer: 'qa_pattern'};
    return {key: null, conf: 0, layer: 'none'};
  }

  function substitute(text, context) {
    const fields = context.kit?.fields || {};
    const values = {
      name: T.chooseVariant(fields.name, {}),
      url: T.chooseVariant(fields.url, {}),
      domain: T.chooseVariant(fields.domain, {}) || String(T.chooseVariant(fields.url, {}) || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
      tagline: T.chooseVariant(fields.tagline, {}),
      source_name: context.source_domain || '',
    };
    return String(text).replace(/\{(\w+)\}/g, (whole, key) => (values[key] === undefined || values[key] === null ? whole : String(values[key])));
  }

  // 页面语言命中时用 i18n 版本，否则用主值（默认 en）。
  function localizedField(field, lang) {
    if (!field || typeof field !== 'object' || !lang || !field.i18n) return field;
    const text = field.i18n[lang] || field.i18n[lang.split('-')[0]];
    if (!text) return field;
    // 命中语言就只用该语言的文案，不把英文分档混进来。
    return {...field, value: text, variants: {[String(text.length)]: text}};
  }

  function resolveKey(key, ctx) {
    const {context, step = 0} = ctx;
    const kit = context.kit?.fields || {};
    const profile = context.kit?.profile || {};
    const qa = context.kit?.qa || {};
    const lang = String(ctx.field?.docLang || '').toLowerCase();
    const pick = (table, name, options) => (table[name] === undefined ? null : T.chooseVariant(localizedField(table[name], lang), options));
    if (key === 'url_bare') return T.urlOf(pick(kit, 'url', {}) || pick(profile, name, {}), true);
    if (key === 'domain') return pick(kit, 'domain', {}) || String(T.urlOf(pick(kit, 'url', {}), true) || '').split('/')[0];
    if (key?.startsWith('qa:')) {
      const question = key.slice(3);
      return T.answerFor(T.qaKey(question) || question, {kit: context.kit, qa});
    }
    if (['how_did_you_hear', 'owner', 'team_size', 'funding', 'launch_status', 'is_free'].includes(key)) {
      const direct = qa[key] || qa[T.qaKey(key, {})];
      return direct !== undefined ? direct : T.answerFor(key, {kit: context.kit, qa});
    }
    if (key === 'full_name') return pick(profile, 'maker_name', {}) || [pick(profile, 'first_name', {}), pick(profile, 'last_name', {})].filter(Boolean).join(' ');
    const order = ['kit', 'profile'];
    for (const source of order) {
      const table = source === 'kit' ? kit : profile;
      const value = pick(table, key, {});
      if (value) return value;
    }
    // 资料包没有这个键时，用本来源上次人工填过的同键值兜底。
    const remembered = (context.memory?.fields || [])
      .find(item => item.key === key && item.value !== undefined && item.value !== null && item.value !== '');
    if (remembered) return remembered.value;
    return null;
  }

  function assetForKey(key, ctx) {
    const assets = ctx.context.kit?.assets || [];
    if (!assets.length) return null;
    const wants = {logo: ['logo'], icon: ['icon', 'logo'], favicon: ['favicon', 'icon', 'logo'],
      cover: ['cover', 'screenshot'], screenshot: ['screenshot', 'cover'],
      demo_gif: ['demo_gif'], demo_video: ['demo_video'], maker_avatar: ['maker_avatar', 'logo']};
    const field = ctx.field || {};
    const accept = String(field.accept || '');
    const candidates = assets.filter(asset => {
      const wanted = (wants[key] || [key]).includes(asset.key);
      if (!wanted) return false;
      if (accept.includes('video')) return String(asset.mime || '').startsWith('video/');
      if (accept.includes('image') || field.inputType === 'file') return String(asset.mime || '').startsWith('image/') || accept.includes('video');
      return true;
    });
    if (!candidates.length) return null;
    if (key === 'screenshot' || key === 'cover') {
      const limit = field.hints?.bytes;
      const fitting = candidates.filter(asset => !limit || !asset.bytes || asset.bytes <= limit);
      // 有尺寸提示时优先选最接近的。
      if (field.hints?.width) {
        const ranked = [...candidates].sort((a, b) => {
          const distance = asset => Math.abs((asset.w || 0) - field.hints.width) + Math.abs((asset.h || 0) - field.hints.height);
          return distance(a) - distance(b);
        });
        return ranked[0];
      }
      return (fitting.length ? fitting : candidates)[0];
    }
    return candidates[0];
  }

  function convert(key, value, ctx) {
    const field = ctx.field, widget = field.widget || '';
    if (value === null || value === undefined) return {value: null, reason: 'no_value'};
    if (['select-one', 'custom-select', 'radio'].includes(widget) || field.inputType === 'radio') {
      const labelText = [field.label, field.helpText, field.labelParts?.near].filter(Boolean).join(' ');
      if ((widget === 'radio' || field.inputType === 'radio') && /(agree|accept|terms|privacy|consent|条款|同意|授权|subscribe|newsletter|opt.?in)/i.test(labelText)) {
        return {value: null, reason: 'need_human'};
      }
      const options = field.options || [];
      if (!options.length) return {value: key === 'category' || key === 'pricing_model' ? value : null, reason: 'no_options', fallback: value};
      // 主值优先，其次才是分类替代词：站点有我们的分类就用它，没有才退而求其次。
      const pool = key === 'category'
        ? [value, ...T.listOf(value), ...T.listOf(ctx.context.kit?.fields?.category?.alternates)]
        : [value, ...T.listOf(value)];
      for (const candidate of pool) {
        const found = T.optionMatch(candidate, options);
        if (found) return {value: found, reason: 'option_match', matched: candidate};
      }
      return {value: null, reason: 'no_option_match'};
    }
    if (widget === 'select-multiple') {
      const wanted = T.listOf(value).concat(String(value).split(/\s*,\s*/));
      const chosen = wanted.map(item => T.optionMatch(item, field.options || [])).filter(Boolean);
      return chosen.length ? {value: [...new Set(chosen)], reason: 'option_match'} : {value: null, reason: 'no_option_match'};
    }
    if (widget === 'checkbox' || field.inputType === 'checkbox') {
      const exact = (ctx.context.memory?.fields || []).some(item => item.label === field.label && item.value);
      const label = T.normalize(field.label);
      const consent = /(agree|accept|terms|privacy|consent|条款|同意|授权|subscribe|newsletter|opt.?in)/i.test(label);
      if (consent || !exact) return {value: null, reason: 'need_human'};
      return {value: true, reason: 'memory_exact'};
    }
    if (widget === 'tags') return {value: T.listOf(value), reason: 'list'};
    if (widget === 'number' || field.inputType === 'number') {
      const number = T.number(value);
      return number === null ? {value: null, reason: 'not_a_number'} : {value: number, reason: 'number'};
    }
    if (widget === 'date' || ['date', 'month', 'datetime-local'].includes(field.inputType)) {
      const date = T.formatDate(value, field);
      return date ? {value: date, reason: 'date'} : {value: null, reason: 'date_unparsed'};
    }
    if (['twitter', 'facebook', 'instagram', 'linkedin', 'youtube'].includes(key)) {
      const wantsHandle = /handle|username|@|账号/i.test(field.label + ' ' + field.placeholder);
      return {value: T.social(value, wantsHandle), reason: 'social'};
    }
    if (['url', 'github_url', 'demo_url', 'video_url', 'pricing_url', 'docs_url', 'blog_url', 'changelog_url',
      'privacy_url', 'terms_url', 'rss_url', 'sitemap_url', 'website_personal'].includes(key)) {
      const bare = /without https|no https|domain only|不要 https|不带 http/i.test(field.label + ' ' + field.placeholder + ' ' + field.helpText);
      return {value: T.urlOf(value, bare), reason: 'url'};
    }
    const text = Array.isArray(value) ? value.join('\n') : String(substitute(value, ctx.context));
    if (/\{[^}]+\}/.test(text)) return {value: null, reason: 'placeholder_left'};
    const limit = Number(field.maxlength ?? -1);
    if (limit >= 0 && text.length > limit) {
      // 放不下就先换本字段的分档，再考虑更短的同类文案；都不行才交人，绝不截断。
      const fits = item => item.length <= limit && item.length >= Math.min(limit * 0.3, 20);
      const own = (ctx.ownVariants || []).filter(fits);
      if (own.length) return {value: own[own.length - 1], reason: 'variant_fit', conf: 0.95};
      const pool = (ctx.variantPool || []).filter(fits);
      if (pool.length) return {value: pool[pool.length - 1], reason: 'variant_fit', conf: 0.9};
      return {value: null, reason: 'too_long', length: text.length, limit};
    }
    if (limit >= 0 && text.length < limit * 0.5 && ['short_description', 'tagline', 'description'].includes(key)) {
      const longer = (ctx.variantPool || []).filter(item => item.length <= limit && item.length > text.length).pop();
      if (longer) return {value: longer, reason: 'variant_fill', conf: 0.95};
    }
    return {value: text, reason: 'text'};
  }

  // 同一字段的分档在最前；描述类字段可以互相借用更短的版本，功能列表之类不参与。
  const TEXT_FAMILY = {
    description: ['description', 'short_description', 'tagline'],
    short_description: ['short_description', 'tagline', 'description'],
    tagline: ['tagline', 'short_description', 'description'],
  };

  function variantPool(key, ctx) {
    const table = {...(ctx.context.kit?.fields || {}), ...(ctx.context.kit?.profile || {})};
    const pools = [];
    for (const name of TEXT_FAMILY[key] || [key]) pools.push(...T.texts(table[name]));
    return [...new Set(pools)].filter(Boolean).sort((a, b) => a.length - b.length);
  }

  function ownVariants(key, ctx) {
    const table = {...(ctx.context.kit?.fields || {}), ...(ctx.context.kit?.profile || {})};
    return T.texts(table[key]).sort((a, b) => a.length - b.length);
  }

  function valueFor(key, ctx) {
    const saved = ctx.found?.saved;
    if (saved && saved.value !== undefined && saved.value !== null && saved.value !== '') return {raw: saved.value, from: 'saved'};
    const value = resolveKey(key, ctx);
    if (value) return {raw: value, from: 'kit'};
    return {raw: null, from: 'none'};
  }

  /**
   * 主入口：给一个字段，返回该怎么处理。
   * status: filled（≥0.85）/ pending（0.5–0.85 待确认）/ unmatched（<0.5）/ sensitive / captcha / honeypot / skipped
   */
  function run(entry, ctx) {
    const field = entry.field;
    // 把字段本身也放进上下文：取语言（docLang）、给控件候选、回读判断都要用。
    ctx = {...ctx, field};
    const settings = ctx.settings || {};
    if (field.honeypot) return {status: 'honeypot', key: null, conf: 0, layer: 'honeypot', reason: field.honeypot};
    // 采到敏感词就必须拦；即使采集层漏标，也在填之前再判一次。验证码单独成一类。
    const sensitiveKind = field.sensitive || sensitivityOf(field, ctx.rules);
    if (field.captcha || sensitiveKind === 'captcha') return {status: 'captcha', key: null, conf: 0, layer: 'captcha', reason: '验证码交人'};
    if (sensitiveKind) return {status: 'sensitive', key: sensitiveKind, conf: 0, layer: 'sensitive', reason: sensitiveKind};
    if (field.disabled) return {status: 'skipped', key: null, conf: 0, layer: 'disabled', reason: '字段不可编辑'};
    const found = findKey(field, ctx);
    if (field.inputType === 'file') {
      const key = found.key || 'logo';
      const asset = assetForKey(key, {context: ctx.context, field});
      if (!asset) return {status: 'pending', key, conf: found.conf, layer: found.layer, reason: 'missing_asset'};
      return {status: 'filled', key, conf: Math.max(found.conf, 0.9), layer: found.layer, asset};
    }
    if (!found.key) return {status: 'unmatched', key: null, conf: found.conf, layer: found.layer, reason: 'no_key', alternatives: found.alternatives};
    const {raw, from} = valueFor(found.key, {...ctx, found});
    if (raw === null || raw === undefined || raw === '') {
      const qa = T.answerFor(found.key, {kit: ctx.context.kit, qa: ctx.context.kit?.qa});
      if (qa) return {status: found.conf >= HIGH ? 'filled' : 'pending', key: found.key, conf: Math.min(found.conf, 0.8), layer: 'qa_answer', value: qa, from: 'qa'};
      return {status: 'unmatched', key: found.key, conf: found.conf, layer: found.layer, reason: 'no_value'};
    }
    const converted = convert(found.key, raw, {...ctx, found,
      variantPool: variantPool(found.key, ctx), ownVariants: ownVariants(found.key, ctx)});
    if (converted.value === null || converted.value === undefined) {
      const needHuman = ['need_human', 'too_long', 'no_option_match'].includes(converted.reason);
      return {status: 'pending', key: found.key, conf: found.conf, layer: found.layer, reason: converted.reason,
        length: converted.length, limit: converted.limit, needHuman};
    }
    const conf = Math.min(found.conf, converted.conf ?? 1);
    const status = conf >= HIGH ? 'filled' : conf >= LOW ? 'pending' : 'unmatched';
    return {status, key: found.key, conf, layer: found.layer, value: converted.value, from, reason: converted.reason,
      converted: converted.reason};
  }

  function sensitivityOf(field, rules) {
    return T.fieldSensitivity(field, rules);
  }

  // 字段内弹层用的推荐：前 N 个候选，带字数与超长提示。
  function suggest(entry, ctx, limit = 3) {
    const field = entry.field;
    if (field.sensitive || field.captcha) return [];
    const rules = fieldRules(ctx.rules);
    const scored = [];
    for (const key of Object.keys(rules.keys)) {
      if (key === 'twitter_follow') continue;
      if (['password', 'captcha', 'credit_card', 'otp'].includes(key)) continue;
      const conf = scoreKey(field, key, rules.keys[key]);
      const asset = key === 'placeholder';
      const isFile = field.inputType === 'file';
      const value = isFile ? assetForKey(key, {context: ctx.context, field}) : resolveKey(key, ctx);
      if (value === null || value === undefined) continue;
      const text = isFile ? (value.name || '') : Array.isArray(value) ? value.join(', ') : String(value);
      const limit = Number(field.maxlength ?? -1);
      const converted = isFile ? null : convert(key, value, {...ctx, field, variantPool: variantPool(key, ctx), ownVariants: ownVariants(key, ctx)});
      scored.push({
        key, label: key, value: converted && converted.value !== null ? converted.value : value,
        display: Array.isArray(converted?.value) ? converted.value.join(', ') : String(converted?.value ?? text),
        conf: Number((conf || (isFile ? 0.6 : 0.3)).toFixed(3)), length: text.length, limit,
        over: limit >= 0 && text.length > limit, reason: converted?.reason || 'asset', asset: isFile,
      });
      void asset;
    }
    const line = run(entry, {...ctx});
    return scored.sort((a, b) => b.conf - a.conf || a.length - b.length).slice(0, limit).map(item => ({...item, current: item.key === line.key}));
  }

  function shouldFill(status, settings = {}, decision = {}) {
    if (status === 'filled') return true;
    // 待确认可以自动填，但“交人”的原因（超长/选项对不上/需要人工勾选）不填。
    if (status === 'pending') return settings.fill_low_confidence !== false && !decision.needHuman;
    return false;
  }

  // 自定义控件要先开菜单才能看到选项，这里给它一串候选：本字段的替代名在前。
  function optionCandidates(key, value, context) {
    const field = (context.kit?.fields || {})[key] || {};
    const pool = [value, ...(field.alternates || []), ...(Array.isArray(field.list) ? field.list : [])];
    return [...new Set(pool.filter(item => item !== null && item !== undefined).map(String))];
  }

  root.BKMatch = {HIGH, LOW, run, suggest, findKey, scoreKey, scoreDetail, synonymRanking, convert, resolveKey, localizedField, assetForKey,
    variantPool, ownVariants, TEXT_FAMILY, shouldFill, substitute, fieldRules, autocompleteKey, sensitivityOf, optionCandidates};
  if (typeof module !== 'undefined') module.exports = root.BKMatch;
})(globalThis);
