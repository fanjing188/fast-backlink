// 日志：内容脚本里缓冲、批量交给后台；后台写 IndexedDB 并转 JSONL 落盘。
(function (root) {
  const CATEGORIES = ['scan', 'match', 'ai', 'fill', 'verify', 'upload', 'snapshot', 'restore', 'captcha', 'user', 'service', 'error', 'perf', 'auto-next'];
  const LEVELS = {debug: 10, info: 20, warn: 30, error: 40};
  const VALUE_LIMIT = 200;
  const SECRET_KEYS = new Set(['password', 'captcha', 'payment', 'phone', 'ownership']);

  function safeValue(value, key) {
    if (value === undefined || value === null) return null;
    if (SECRET_KEYS.has(key)) return '<敏感值不记录>';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > VALUE_LIMIT ? text.slice(0, VALUE_LIMIT) + '…' : text;
  }

  function entry(level, cat, msg, extra, base) {
    return {
      ts: new Date().toISOString(), level, cat: CATEGORIES.includes(cat) ? cat : 'error', msg: msg || '',
      run: base.run, tab: base.tab ?? null, frame: base.frame ?? 0, site: base.site || '', source: base.source || '',
      step: base.step ?? 0, url: base.url || '', ...extra,
    };
  }

  function create(options = {}) {
    const base = {run: options.run || 'r_' + Math.random().toString(36).slice(2, 8), tab: options.tab, frame: options.frame,
      site: options.site, source: options.source, step: options.step, url: options.url};
    const sink = options.sink || (async entries => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) await chrome.runtime.sendMessage({type: 'log', entries});
    });
    const floor = LEVELS[options.level || 'info'] || 20;
    let buffer = [], timer = null, stats = {};

    function push(level, cat, msg, extra = {}) {
      if ((LEVELS[level] || 20) < floor) return null;
      const item = entry(level, cat, msg, extra, base);
      buffer.push(item);
      if (buffer.length >= 50) flush();
      else if (!timer) timer = setTimeout(flush, 5000);
      return item;
    }

    async function flush() {
      clearTimeout(timer); timer = null;
      if (!buffer.length) return 0;
      const batch = buffer;
      buffer = [];
      try { await sink(batch); return batch.length; } catch { return 0; }
    }

    function tally(key, delta = 1) { stats[key] = (stats[key] || 0) + delta; }

    return {
      base, push, flush, tally,
      debug: (cat, msg, extra) => push('debug', cat, msg, extra),
      info: (cat, msg, extra) => push('info', cat, msg, extra),
      warn: (cat, msg, extra) => push('warn', cat, msg, extra),
      error: (cat, msg, extra) => push('error', cat, msg, extra),
      field: (level, cat, msg, field, extra = {}) => push(level, cat, msg, {
        field: {label: field?.label, key: extra.key ?? field?.key, widget: field?.widget, maxlength: field?.maxlength},
        ...extra, value: safeValue(extra.value, extra.key ?? field?.key),
      }),
      setName: name => { base.site = name || base.site; },
      setStep: step => { base.step = step; },
      setSource: name => { base.source = name || base.source; },
      pending: () => buffer.length,
      stats: () => ({...stats}),
    };
  }

  // 后台侧：一批日志写 IDB，再交给服务落 JSONL。
  function createStore({maxEntries = 20000, maxDays = 14, send} = {}) {
    let pending = 0, timer = null, delivering = false;
    async function ingest(entries) {
      if (!Array.isArray(entries) || !entries.length) return 0;
      const db = root.BKIdb;
      for (const item of entries) await db.put('logs', item);
      await db.trimLogs(maxEntries, maxDays);
      pending += entries.length;
      if (pending >= 50) return deliver();
      if (!timer) timer = setTimeout(() => deliver().catch(() => {}), 5000);
      return entries.length;
    }
    async function deliver() {
      clearTimeout(timer); timer = null;
      if (delivering || !pending) return 0;
      delivering = true;
      try {
        const items = await root.BKIdb.all('logs');
        const batch = items.slice(-Math.max(pending, 1));
        if (send) await send(batch);
        pending = 0;
        return batch.length;
      } finally { delivering = false; }
    }
    return {ingest, deliver, pendingCount: () => pending};
  }

  root.BKLog = {create, createStore, safeValue, CATEGORIES, LEVELS, VALUE_LIMIT};
  if (typeof module !== 'undefined') module.exports = root.BKLog;
})(globalThis);
