// AI 兜底的纯函数：挑出回读为空的残余字段，校验模型返回的建议。
// 不碰 DOM、不发网络请求，便于在 Node 里直接测试。
(function (root) {
  const SKIP_TYPES = new Set(['file', 'checkbox', 'password', 'hidden', 'submit', 'button', 'reset', 'image']);
  const SKIP_WIDGETS = new Set(['file', 'checkbox', 'switch']);
  const CONSENT = /(agree|accept|terms|privacy|consent|条款|同意|授权|subscribe|newsletter|opt.?in)/i;
  const LIMIT = 20;

  function text(value, limit) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function descriptor(entry, read, index) {
    const field = entry.field || {};
    if (field.honeypot || field.captcha || field.sensitive || field.disabled) return null;
    if (SKIP_TYPES.has(field.inputType) || SKIP_WIDGETS.has(field.widget)) return null;
    const consentText = [field.label, field.helpText, field.labelParts?.near].filter(Boolean).join(' ');
    if (CONSENT.test(consentText)) return null;
    let value;
    try { value = read(entry.element, field); } catch { return null; }
    if (value !== undefined && value !== null && String(value).trim() !== '') return null;
    const item = {
      index, label: text(field.label, 200) || text(field.name, 200),
      inputType: field.inputType || 'text', widget: field.widget || '',
      required: !!field.required, maxlength: Number.isFinite(field.maxlength) ? field.maxlength : -1,
    };
    if (!item.label) return null;
    if (field.placeholder) item.placeholder = text(field.placeholder, 160);
    const help = [field.helpText, field.labelParts?.near].filter(Boolean).join(' ');
    if (help) item.helpText = text(help, 220);
    if (field.docLang) item.docLang = String(field.docLang).slice(0, 8);
    if (Array.isArray(field.options) && field.options.length) {
      item.options = field.options.slice(0, 30).map(option => text(option, 80)).filter(Boolean);
    }
    return item;
  }

  /**
   * 回读为空的字段列表；captcha/sensitive/honeypot/文件/勾选/同意条款一律不参与。
   * decisions 是 Map<index, decision>，没有也能工作。
   */
  function residual(entries, decisions, read, options = {}) {
    const limit = Math.max(1, Math.min(Number(options.max || LIMIT), 50));
    const result = [];
    for (const entry of entries || []) {
      const field = entry.field || {};
      const decision = decisions?.get?.(field.index);
      if (decision && ['captcha', 'sensitive', 'honeypot', 'skipped'].includes(decision.status)) continue;
      const item = descriptor(entry, read, field.index);
      if (item) result.push(item);
    }
    // 字段多时优先把必填项交给模型；索引保持不变，回填仍按原字段定位。
    result.sort((a, b) => Number(b.required) - Number(a.required));
    return result.slice(0, limit);
  }

  /** 模型输出防御性校验：索引必须在本次字段里，key 必须在候选白名单，重复取最高置信度。 */
  function normalize(payload, indices, allowed) {
    const items = Array.isArray(payload) ? payload : payload?.suggestions;
    if (!Array.isArray(items)) return [];
    const wanted = indices instanceof Set ? indices : new Set(indices || []);
    const keys = allowed instanceof Set ? allowed : allowed ? new Set(allowed) : null;
    const best = new Map();
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const raw = item.i ?? item.index;
      if (raw === null || raw === undefined || raw === '') continue;
      const index = Number(raw);
      if (!Number.isInteger(index) || !wanted.has(index)) continue;
      const key = item.key;
      if (key !== null && (typeof key !== 'string' || (keys && !keys.has(key)))) continue;
      let conf = Number(item.conf ?? 0.5);
      if (!Number.isFinite(conf)) conf = 0.5;
      conf = Math.max(0, Math.min(1, conf));
      const candidate = {i: index, key, conf: Math.round(conf * 1000) / 1000, why: text(item.why, 80)};
      const previous = best.get(index);
      if (!previous || candidate.conf > previous.conf) best.set(index, candidate);
    }
    return [...best.values()].sort((a, b) => a.i - b.i);
  }

  root.BKAI = {residual, descriptor, normalize};
  if (typeof module !== 'undefined') module.exports = root.BKAI;
})(globalThis);
