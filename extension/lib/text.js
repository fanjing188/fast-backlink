// 纯文本工具：归一、分词、相似度、分档选取、日期/社交句柄格式。可在 node 里直接测。
(function (root) {
  const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'your', 'you', 'my', 'is', 'are', 'please', 'enter', 'input', 'field', 'required', 'optional', '请', '输入', '必填']);
  const CAMEL = s => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  function normalize(value) {
    return String(value ?? '').toLowerCase().normalize('NFKC').replace(/[_\-–—/\\|()[\]{}:：*＊"'`~!?？,，.。;；<>@#$%^&+=]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function tokens(value) {
    const raw = normalize(value).match(/[\p{L}\p{N}_]+/gu) || [];
    return raw.filter(token => token.length > 1 || /[\p{N}]/u.test(token));
  }

  function distinctive(value) {
    return tokens(value).filter(token => !STOP.has(token));
  }

  function tokenScore(needle, haystack) {
    const need = distinctive(needle), hay = new Set(distinctive(haystack));
    if (!need.length || !hay.size) return 0;
    const hit = need.filter(token => hay.has(token)).length;
    return hit / need.length;
  }

  function similarity(a, b) {
    const left = distinctive(a).sort(), right = distinctive(b).sort();
    if (!left.length && !right.length) return 0;
    const pool = new Set([...left, ...right]);
    let same = 0;
    for (const token of pool) same += Math.min(left.filter(x => x === token).length, right.filter(x => x === token).length);
    const total = left.length + right.length - same;
    return total ? same / total : 0;
  }

  function shorten(value, limit) {
    if (value.length <= limit) return value;
    return value.slice(0, limit);
  }

  function truncateAtSentence(value, limit) {
    const text = String(value ?? '');
    if (text.length <= limit) return text;
    const head = text.slice(0, limit + 1);
    for (const mark of ['. ', '。', '! ', '！', '? ', '？', '; ', '；\n', '\n']) {
      const at = head.lastIndexOf(mark);
      if (at > limit * 0.5) return head.slice(0, at + mark.trimEnd().length);
    }
    return head.slice(0, limit).replace(/[\s,，、;；:：-]+$/, '');
  }

  // 资料包字段可能是 {value} / {variants:{长度:文本}} / {list:[...]} / {i18n}。
  function texts(field) {
    if (field == null) return [];
    if (typeof field === 'string') return [field];
    if (Array.isArray(field)) return field.map(String);
    if (typeof field !== 'object') return [String(field)];
    const found = [];
    for (const value of Object.values(field.variants || {})) if (typeof value === 'string') found.push(value);
    if (typeof field.value === 'string') found.push(field.value);
    if (Array.isArray(field.list)) found.push(field.list.join(', '));
    return [...new Set(found.filter(Boolean))];
  }

  function localized(field, lang) {
    if (!field || typeof field !== 'object' || !field.i18n) return field;
    if (lang && field.i18n[lang]) return {...field, value: field.i18n[lang], list: field.list, variants: field.variants};
    return field;
  }

  // 按上限挑最长且不超的分档；都没有能放下的就返回 null（不截断，交人）。
  function chooseVariant(field, options = {}) {
    const {limit = -1, min = 0} = options;
    const found = texts(field);
    if (!found.length) return null;
    const sorted = [...found].sort((a, b) => a.length - b.length);
    if (limit >= 0) {
      const fits = sorted.filter(text => text.length <= limit);
      return fits.length ? fits[fits.length - 1] : null;
    }
    // 没有上限时用主值（最长）；只有明确要“至少 min 字”时才挑刚好够的那一档。
    if (min > 0) {
      const fits = sorted.filter(text => text.length >= min);
      if (fits.length) return fits[0];
    }
    return sorted[sorted.length - 1];
  }

  function listOf(field) {
    if (field == null) return [];
    if (Array.isArray(field)) return field.map(String);
    if (typeof field === 'string') return field.split(/[,，;；\n]/).map(x => x.trim()).filter(Boolean);
    if (Array.isArray(field.list)) return field.list.map(String);
    return String(field.value || '').split(/[,，;；\n]/).map(x => x.trim()).filter(Boolean);
  }

  const number = value => {
    const found = String(value ?? '').replace(/[^\d.]/g, '');
    return found ? Number(found) : null;
  };

  function social(value, wantHandle) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (wantHandle) {
      const handle = text.match(/(?:twitter\.com|x\.com|@)\/?([A-Za-z0-9_]{2,20})/);
      return handle ? '@' + handle[1] : text.replace(/^@?/, '@');
    }
    if (/^https?:\/\//i.test(text)) return text;
    if (/^@?[A-Za-z0-9_]{2,20}$/.test(text)) return 'https://twitter.com/' + text.replace(/^@/, '');
    return text;
  }

  function urlOf(value, bare = false) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (bare) return text.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    return /^https?:\/\//i.test(text) ? text : 'https://' + text;
  }

  function formatDate(value, field = {}) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const parts = text.match(/(\d{4})\D?(\d{1,2})?\D?(\d{1,2})?/);
    if (!parts) return text;
    const [, year, month, day] = parts;
    const pad = x => String(x).padStart(2, '0');
    const type = field.inputType || '';
    if (type === 'month') return month ? `${year}-${pad(month)}` : year;
    if (type === 'date' || type === 'datetime-local') return month && day ? `${year}-${pad(month)}-${pad(day)}` : null;
    const hint = normalize((field.placeholder || '') + ' ' + (field.label || ''));
    if (hint.includes('mm dd yyyy') || hint.includes('month day')) return month && day ? `${pad(month)}/${pad(day)}/${year}` : null;
    if (hint.includes('dd mm') || hint.includes('day month')) return month && day ? `${pad(day)}/${pad(month)}/${year}` : null;
    if (hint.includes('yyyy mm') || hint.includes('iso')) return month && day ? `${year}-${pad(month)}-${pad(day)}` : year;
    return month && day ? `${year}-${pad(month)}-${pad(day)}` : year;
  }

  function optionMatch(value, options) {
    const target = String(value ?? '').trim();
    const cleaned = (options || []).map(text => String(text)).filter(text => text.trim());
    if (!target || !cleaned.length) return null;
    const exact = cleaned.filter(text => text.trim() === target);
    if (exact.length === 1) return exact[0];
    const loose = cleaned.filter(text => normalize(text) === normalize(target));
    if (loose.length === 1) return loose[0];
    const choices = target.split(/\s*\/\s*|,\s*|（|\(/).map(part => new Set(tokens(part))).filter(set => set.size);
    const scored = cleaned.map(text => {
      const set = new Set(tokens(text));
      if (!set.size) return [0, text];
      return [Math.max(...choices.map(choice => [...choice].filter(token => set.has(token)).length / choice.size)), text];
    }).sort((a, b) => b[0] - a[0]);
    if (scored[0][0] > 0 && (!scored[1] || scored[0][0] > scored[1][0])) return scored[0][1];
    return null;
  }

  // 目录站常见问题：只答固定几种，收入和付费加速一律交人。
  function qaKey(label, qa = {}) {
    const text = normalize(label);
    if (!text) return null;
    if (/(how did you (hear|find)|where did you hear|heard about us|怎么知道|了解到)/.test(text)) return 'how_did_you_hear';
    if (/(are you the (owner|maker|founder)|is this your (product|site)|owner of)/.test(text)) return 'owner';
    if (/(team size|how many (people|employees)|公司规模)/.test(text)) return 'team_size';
    if (/(funding|backed|investor|融资)/.test(text)) return 'funding';
    if (/(launch status|stage|已经上线)/.test(text)) return 'launch_status';
    if (/(is it free|免费吗|pricing model is)/.test(text)) return 'is_free';
    return null;
  }

  function answerFor(key, context = {}) {
    const overrides = context.qa || {};
    // 自定义问答直接用问题原文做键；标准问题继续走下面的固定分支。
    if (overrides[key] !== undefined) return overrides[key];
    const pick = name => overrides[name] ?? null;
    if (key === 'how_did_you_hear') return pick('How did you hear about us');
    if (key === 'owner') return pick('Are you the owner');
    if (key === 'team_size') return pick('Team size');
    if (key === 'funding') return pick('Funding');
    if (key === 'launch_status') return pick('Launch status');
    if (key === 'is_free') {
      const pricing = normalize(root.BKText.chooseVariant((context.kit?.fields || {}).pricing_model || (context.kit?.fields || {}).pricing, {}) || '');
      return pricing.includes('free') ? 'Yes' : null;
    }
    return null;
  }

  function fieldSemanticText(field) {
    const parts = field.labelParts || {};
    return [field.key, field.label, parts.own, parts.aria, parts.placeholder, parts.described, parts.platform, parts.bits,
      field.name, field.className, field.inputType, field.widget, field.autocomplete, field.placeholder, field.help, field.ownSemantics]
      .map(value => value || '').join(' ').toLowerCase().replace(/\s+/g, ' ');
  }

  function fieldSensitivity(field, rules) {
    const text = fieldSemanticText(field);
    return Object.entries((rules || {}).sensitive || {})
      .find(([, words]) => words.some(word => text.includes(word)))?.[0] || null;
  }

  root.BKText = {normalize, tokens, distinctive, tokenScore, similarity, shorten, truncateAtSentence, texts, fieldSemanticText, fieldSensitivity,
    localized, chooseVariant, listOf, number, social, urlOf, formatDate, optionMatch, qaKey, answerFor, camel: CAMEL};
  if (typeof module !== 'undefined') module.exports = root.BKText;
})(globalThis);
