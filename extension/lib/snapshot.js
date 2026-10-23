// 快照：指纹、多重定位标识、复原打分与冲突判断。不碰存储，只做数据。
(function (root) {
  const T = root.BKText;
  const SENSITIVE_SKIP = new Set(['password', 'captcha', 'payment', 'phone', 'ownership']);

  function hash(text) {
    let value = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value.toString(16).padStart(8, '0');
  }

  function fingerprintFields(fields) {
    return hash(fields.map(field => [T.normalize(field.label), field.inputType, field.widget, field.name].join('|')).join('\n'));
  }

  function locator(element, field) {
    const path = [];
    let node = element, depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      const parent = node.parentElement;
      const position = parent ? [...parent.children].indexOf(node) : 0;
      path.unshift(`${node.tagName.toLowerCase()}:nth-child(${position + 1})`);
      node = parent; depth++;
    }
    return {
      name: element.name || '', id: element.id || '',
      label: field.label || '', autocomplete: field.autocomplete || '',
      inputType: field.inputType, widget: field.widget,
      platformId: field.platformId || '', index: field.index ?? field.order ?? -1,
      path: path.join('>'),
    };
  }

  function fieldValue(entry) {
    const field = entry.field;
    if (field.captcha) return {skipped: 'captcha'};
    if (SENSITIVE_SKIP.has(field.sensitive)) return {skipped: 'sensitive'};
    if (['radio', 'checkbox'].includes(field.inputType) &&
        /(agree|accept|terms|privacy|consent|条款|同意|授权|subscribe|newsletter|opt.?in)/i.test(field.label || '')) return {skipped: 'sensitive'};
    if (field.inputType === 'file') return {asset_id: entry.assetId?.id || entry.assetId || null,
      asset_sha256: entry.assetId?.sha256 || null, value: ''};
    if (field.inputType === 'checkbox') return {checked: !!entry.element.checked, value: entry.element.checked ? (field.label || 'on') : ''};
    const value = root.BKFields.read(entry.element, field);
    return {value: value === undefined ? '' : String(value)};
  }

  function capture(options) {
    const {entries, site, source_domain, url, stepIndex = 0, by = 'extension', complete = false, assetIds = {}} = options;
    const steps = [];
    // 蜜罐和不可编辑字段既不填也不复原，不进快照。
    const visible = entries.filter(entry => !entry.field.honeypot && !entry.field.disabled);
    for (let index = 0; index <= stepIndex; index++) steps.push({fields: []});
    const usedFields = [];
    for (const entry of visible) {
      const field = entry.field;
      const saved = fieldValue({...entry, assetId: assetIds[field.index]});
      const record = {
        locator: locator(entry.element, field), label: field.label, key: entry.key || field.key || null,
        inputType: field.inputType, widget: field.widget, order: field.index ?? 0, required: !!field.required,
        needs_confirmation: !!entry.needsConfirmation,
      };
      if (saved.skipped) record.skipped = saved.skipped;
      else Object.assign(record, saved);
      steps[stepIndex].fields.push(record);
      usedFields.push(field);
    }
    const current = steps[stepIndex];
    return {
      id: Date.now().toString(36) + hash(String(url || '') + Math.random()),
      created_at: new Date().toISOString(),
      site, source_domain: source_domain || '',
      url: String(url || '').split('#')[0],
      form_fingerprint: fingerprintFields(usedFields),
      step_index: stepIndex, by, complete, steps,
    };
  }

  function normalizedLocator(record) {
    return record?.locator || {};
  }

  // 复原打分：多重标识相加，单靠序号或路径不足以下结论。
  function score(record, entry) {
    const where = normalizedLocator(record), field = entry.field, element = entry.element;
    let total = 0;
    if (where.platformId && field.platformId && where.platformId === field.platformId) total += 45;
    if (where.name && element.name && where.name === element.name) total += 40;
    if (where.id && element.id && where.id === element.id) total += 35;
    if (where.label && T.normalize(where.label) === T.normalize(field.label)) total += 30;
    if (where.autocomplete && where.autocomplete === field.autocomplete) total += 20;
    if (where.inputType === field.inputType) total += 10;
    if (where.widget === field.widget) total += 8;
    if (where.index >= 0 && where.index === field.index) total += 5;
    if (where.path && where.path === locator(element, field).path) total += 4;
    return total;
  }

  const THRESHOLD = 30;

  /**
   * 把快照的一步映射到当前页面的字段：
   * matched: [{record, entry, score}]；missing: 找不到的；conflicts: 页面已有人工新值的。
   */
  function plan(snapshot, entries, options = {}) {
    const step = snapshot.steps?.[snapshot.step_index || 0] || {fields: []};
    const used = new Set();
    const matched = [], missing = [], conflicts = [], skipped = [];
    for (const record of step.fields || []) {
      if (record.skipped) { skipped.push(record); continue; }
      const ranked = entries.filter(entry => !used.has(entry.element) && !entry.field.honeypot && !entry.field.disabled &&
        !entry.field.sensitive && !entry.field.captcha &&
        (!record.locator?.inputType || record.locator.inputType === entry.field.inputType))
        .map(entry => ({entry, score: score(record, entry)}))
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];
      if (!best || best.score < THRESHOLD || best.score === ranked[1]?.score) { missing.push(record); continue; }
      used.add(best.entry.element);
      let value = record.value;
      if (record.checked !== undefined) value = record.checked;
      const existing = root.BKFields.read(best.entry.element, best.entry.field);
      if (existing && String(existing).trim() && String(existing).trim() !== String(value ?? '').trim()) {
        conflicts.push({record, entry: best.entry, existing});
        continue;
      }
      matched.push({record, entry: best.entry, score: best.score, value});
    }
    return {matched, missing, conflicts, skipped, fingerprint: fingerprintFields(entries.map(entry => entry.field))};
  }

  function diff(current, snapshot) {
    const rows = [];
    const records = snapshot.steps?.[snapshot.step_index || 0]?.fields || [];
    for (const record of records) {
      if (record.skipped) continue;
      rows.push({label: record.label, key: record.key, snapshot: record.value ?? record.checked ?? '', current: '', state: 'missing'});
    }
    for (const entry of current) {
      const row = rows.find(item => T.normalize(item.label) === T.normalize(entry.field.label));
      const value = root.BKFields.read(entry.element, entry.field);
      if (row) {
        row.current = value === undefined ? '' : String(value);
        row.state = row.current.trim() === String(row.snapshot).trim() ? 'same' : 'changed';
      } else {
        rows.push({label: entry.field.label, key: null, snapshot: '', current: String(value ?? ''), state: 'new'});
      }
    }
    return rows;
  }

  root.BKSnapshot = {capture, plan, score, diff, fingerprintFields, locator, hash, THRESHOLD};
  if (typeof module !== 'undefined') module.exports = root.BKSnapshot;
})(globalThis);
