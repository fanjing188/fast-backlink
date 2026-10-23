// 内容脚本侧的 FBL 移植：内容脚本不能加载 ES 模块，所以这里放等价实现。
// 对应的上游原件在 extension/vendor/fbl/：password-values.mjs、target-recovery.mjs。
// 校验：node extension/vendor/fbl/sync-fbl.mjs --check 比对上游哈希，上游改动会在同步时被发现。
(function (root) {
  // 等价于 vendor/fbl/password-values.mjs 的 passwordValues()
  function passwordValues(doc = document) {
    const values = new Set(), roots = [doc], seen = new Set();
    while (roots.length) {
      const scope = roots.pop();
      if (!scope || seen.has(scope)) continue;
      seen.add(scope);
      let nodes = [];
      try { nodes = [...scope.querySelectorAll('*')]; } catch { nodes = []; }
      for (const node of nodes) {
        if (node.localName === 'input' && node.type === 'password') {
          if (node.value) values.add(node.value);
          if (node.getAttribute('value')) values.add(node.getAttribute('value'));
        }
        const shadow = node.shadowRoot || globalThis.chrome?.dom?.openOrClosedShadowRoot?.(node);
        if (shadow) roots.push(shadow);
        if (node.localName === 'iframe') {
          try { if (node.contentDocument) roots.push(node.contentDocument); } catch { /* 跨域读不到 */ }
        }
      }
    }
    return [...values];
  }

  // 等价于 vendor/fbl/password-values.mjs 的 omitPasswordValues()
  function omitPasswordValues(value, values) {
    if (typeof value === 'string') {
      for (const password of [...values].filter(Boolean).sort((a, b) => b.length - a.length)) {
        value = value.split(password).join('[password]');
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(item => omitPasswordValues(item, values));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, omitPasswordValues(item, values)]));
    }
    return value;
  }

  // 等价于 vendor/fbl/target-recovery.mjs 的 rankTargets()
  function rankTargets(items, hint = {}) {
    const name = String(hint.name || '').trim().toLowerCase();
    return items.map(item => {
      const text = String(item.name || '').trim().toLowerCase();
      let method = 'none', score = 0;
      if (hint.ref && item.ref === hint.ref) { method = 'ref'; score = 1000; }
      else if (name && text === name && item.role === hint.role) { method = 'role+name'; score = 800; }
      else if (name && text.includes(name)) { method = 'text'; score = 600; }
      else if (!name && hint.role && item.role === hint.role) { method = 'role'; score = 400; }
      return {...item, method, score};
    }).sort((a, b) => b.score - a.score);
  }

  root.BKVendor = {passwordValues, omitPasswordValues, rankTargets};
  if (typeof module !== 'undefined') module.exports = root.BKVendor;
})(globalThis);
