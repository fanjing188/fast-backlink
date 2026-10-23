(function (root) {
  const normalize = value => String(value ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  function sensitive(field, rules) {
    const text = ['key', 'label', 'name', 'inputType', 'type', 'fieldKind', 'autocomplete'].map(k => field[k] || '').join(' ').toLowerCase();
    return Object.entries(rules.sensitive).find(([, words]) => words.some(w => text.includes(w)))?.[0];
  }
  function semantic(field, rules) {
    if (rules.labels[field.key] || field.key === 'label') return field.key;
    const label = normalize(field.groupLabel || field.label);
    if (/\b(first|last|contact) name\b/.test(label)) return;
    if (/\b(url|web\s*site|homepage|domain)\b/.test(label)) return 'url';
    if (/e[ -]?mail/.test(label)) return 'email';
    return Object.entries(rules.labels).flatMap(([key, words]) => words.filter(w => label.includes(w)).map(w => [w.length, key])).sort((a,b) => b[0]-a[0] || b[1].localeCompare(a[1]))[0]?.[1];
  }
  function option(value, options) {
    const exact = options.filter(o => o.trim() === String(value ?? '').trim());
    if (exact.length === 1) return exact[0];
    const words = s => new Set(normalize(s).match(/[\p{L}\p{N}_]+/gu) || []);
    const choices = String(value ?? '').split(/\s*\/\s*|,\s*|（/).map(words);
    const scores = options.filter(o => o.trim()).map(o => {
      const tokens = words(o);
      return [Math.max(...choices.map(c => [...tokens].filter(t => c.has(t)).length / Math.max(1,tokens.size))), o];
    }).sort((a,b) => b[0]-a[0]);
    if (scores[0]?.[0] > 0 && (!scores[1] || scores[0][0] > scores[1][0])) return scores[0][1];
  }
  function match(field, context, rules, step = 0) {
    if (sensitive(field, rules)) return;
    const saved = step === (context.record?.step || 0) ? context.fields || [] : context.steps?.[step]?.fields || [];
    const one = list => { const found = list.filter(f => f.label === field.label); return found.length === 1 ? found[0] : undefined; };
    const memory = context.memory || {fields: [], labels: {}};
    const exact = one(saved) || one(memory.fields);
    const recipeField = one(context.recipe?.steps?.[step]?.fields || []);
    const key = exact?.key || memory.labels[field.label] || recipeField?.key || semantic(field, rules);
    let value = exact?.value;
    if (value === undefined) {
      const choices = memory.fields.filter(f => f.key === key);
      if (choices.length === 1) value = choices[0].value;
      else if (choices.length > 1) return;
      else value = context.kit[key]?.value;
    }
    if (field.inputType === 'file') return context.files.find(f => f.key === key);
    if (field.inputType === 'checkbox') return (Array.isArray(value) ? value : [value]).includes(field.label) ? field.label : undefined;
    if (field.inputType === 'radio') return option(value, field.options || [field.label]) === field.label ? field.label : undefined;
    if (field.options?.length) return option(value, field.options);
    if (value === undefined || value === null || value === '') return;
    const limit = field.maxlength;
    if (limit >= 0 && String(value).length > limit) {
      if (exact || !['description','short_description','tagline'].includes(key)) return;
      value = ['description','short_description','tagline'].map(k => context.kit[k]?.value).filter(v => v && v.length <= limit).sort((a,b) => b.length-a.length)[0];
    }
    if (['subject','message'].includes(key) && /\{[^}]+\}/.test(value)) return;
    return value;
  }
  function marker(href) {
    const url = new URL(href), fragment = url.hash.slice(1);
    const parts = fragment.split('&'), index = parts.findIndex(p => /^bk=[0-9a-f]{32}$/.test(p));
    if (index < 0) return;
    const id = parts[index].slice(3);
    parts.splice(index,1); url.hash = parts.join('&');
    return {id, url: url.href};
  }
  function config(value) {
    const u = new URL(value.trim());
    // 只允许本机 127.0.0.1（端口不限，便于测试服务与主服务并存）加一个令牌路径。
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !/^\/[\w-]{32,}\/$/.test(u.pathname) || u.username || u.password) {
      throw Error('请粘贴 http://127.0.0.1 的完整续填列表地址（含令牌）');
    }
    return u.origin + u.pathname;
  }
  root.BKLogic = {normalize, sensitive, semantic, option, match, marker, config};
  if (typeof module !== 'undefined') module.exports = root.BKLogic;
})(globalThis);
