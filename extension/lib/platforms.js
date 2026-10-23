// 表单平台适配器：认出托管表单，并从平台自己的结构里取“题目文字”和稳定标识。
(function (root) {
  const T = root.BKText;
  const PLATFORMS = [
    ['google-forms', el => el.closest('[role="listitem"]'), el => el.closest('[role="listitem"]')?.querySelector('[role="heading"]')],
    ['tally', el => el.closest('[data-block-id],.tally-block'), el => el.closest('[data-block-id],.tally-block')?.querySelector('[data-title],[data-question],h1,h2,h3,legend,strong')],
    ['typeform', el => el.closest('[data-qa-block],.typeform-block,.question'), el => el.closest('[data-qa-block],.typeform-block,.question')?.querySelector('.question-title,[class*="question-title"],[class*="title"]')],
    ['gravity-forms', el => el.closest('.gfield'), el => el.closest('.gfield')?.querySelector('.gfield_label,legend')],
    ['hubspot', el => el.closest('.hs-form-field,.hs-form-field'), el => el.closest('.hs-form-field')?.querySelector('label,legend')],
    ['jotform', el => el.closest('.form-line,[id^="cid_"]'), el => el.closest('.form-line,[id^="cid_"]')?.querySelector('label,legend')],
    ['wpforms', el => el.closest('.wpforms-field'), el => el.closest('.wpforms-field')?.querySelector('.wpforms-field-label,label,legend')],
    ['airtable', el => el.closest('.cell,[data-colname]'), el => el.closest('.cell,[data-colname]')?.querySelector('[class*="label"],[class*="question"],.cell-header')],
    ['fillout', el => el.closest('[data-fillout-id]'), el => el.closest('[data-fillout-id]')?.querySelector('[data-title],[data-question],[class*="question"],[class*="label"],h1,h2,h3')],
    ['contact-form-7', el => el.closest('.wpcf7-form-control-wrap'), el => el.closest('.wpcf7-form-control-wrap')?.querySelector('.wpcf7-label')],
    ['forminator', el => el.closest('.forminator-field'), el => el.closest('.forminator-field')?.querySelector('.forminator-label')],
    ['fluent-forms', el => el.closest('.ff-el-group'), el => el.closest('.ff-el-group')?.querySelector('.ff-el-input--label')],
    ['ninja-forms', el => el.closest('.nf-field-container'), el => el.closest('.nf-field-container')?.querySelector('.nf-field-label')],
    ['webflow', el => el.closest('.w-form-field,[data-field],.form-field'), el => el.closest('.w-form-field,[data-field],.form-field')?.querySelector('label,legend')],
    ['formspree', el => el.closest('form'), el => null],
  ];
  const STRUCTURES = [
    ['contact-form-7', '.wpcf7-form-control-wrap'], ['forminator', '.forminator-field'],
    ['fluent-forms', '.ff-el-group'], ['ninja-forms', '.nf-field-container'], ['webflow', '.w-form'],
  ];
  const HOSTS = {
    'docs.google.com': 'google-forms', 'forms.gle': 'google-forms', 'tally.so': 'tally', 'form.typeform.com': 'typeform',
    'typeform.com': 'typeform', 'jotform.com': 'jotform', 'hsforms.com': 'hubspot', 'hsforms.net': 'hubspot',
    'airtable.com': 'airtable', 'fillout.com': 'fillout', 'webflow.com': 'webflow', 'formspree.io': 'formspree',
  };

  function detect(doc = document) {
    try {
      const host = (doc.location?.hostname || '').replace(/^www\./, '');
      if (HOSTS[host]) return HOSTS[host];
      const local = STRUCTURES.find(([, selector]) => doc.querySelector(selector));
      if (local) return local[0];
      const html = doc.documentElement?.innerHTML || '';
      if (/freebirdFormviewer|docs\.google\.com\/forms/.test(html)) return 'google-forms';
      if (/tally\.so|tally-form/.test(html)) return 'tally';
      if (/typeform/.test(html)) return 'typeform';
      if (/gform_|gravityforms/.test(html)) return 'gravity-forms';
      if (/hs-form|hsforms/.test(html)) return 'hubspot';
      if (/wpforms/.test(html)) return 'wpforms';
      if (/jotform/.test(html)) return 'jotform';
      if (/airtable/.test(html)) return 'airtable';
      if (/fillout/.test(html)) return 'fillout';
    } catch { /* 拿不到就按通用页面处理 */ }
    return 'generic';
  }

  function stableId(element, platform) {
    const attrs = ['data-block-id', 'data-fillout-id', 'data-item-id', 'data-qa', 'data-name', 'name', 'id'];
    for (const attr of attrs) {
      const value = element.getAttribute?.(attr);
      if (value) return attr + '=' + value;
    }
    const item = PLATFORMS.find(([name]) => name === platform)?.[1]?.(element);
    if (item) {
      const index = [...(item.parentElement?.children || [])].indexOf(item);
      return platform + '-block-' + index;
    }
    return null;
  }

  function labelFor(element, doc = element.ownerDocument || document) {
    const platform = STRUCTURES.find(([, selector]) => element.closest(selector))?.[0] || detect(doc);
    const entry = PLATFORMS.find(([name]) => name === platform);
    // 显式关联属于当前字段，不能被整张表或复合题块的首个标题覆盖。
    let label = !['radio', 'checkbox'].includes(element.type) ?
      (root.BKFields?.ownLabel(element) || element.getAttribute('aria-label') || '') : '';
    if (entry && !label) {
      const container = entry[1](element);
      const node = entry[2](element);
      if (container && container.contains(element) && node) {
        // 有的平台把题目放在属性里（Tally 的 data-title、Fillout 的 data-question）。
        label = String(node.getAttribute?.('data-title') || node.getAttribute?.('data-question') ||
          node.textContent || node.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
      }
      if (!label && container) {
        // 题块里第一个非控件文本，通常是题目；Exclude 选项/帮助文字。
        const texts = [...container.querySelectorAll('[data-title],[data-question],label,legend,h1,h2,h3,h4,p,span,strong')]
          .filter(node => !node.querySelector('input,textarea,select') && !node.contains(element))
          .map(node => String(node.getAttribute?.('data-title') || node.getAttribute?.('data-question') || node.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(text => text && text.length <= 160);
        if (texts.length) label = texts[0];
      }
    }
    label = label.replace(/^\d+[.、)]\s*/, '').replace(/\s*\*+\s*$/, '').replace(/^(required|必填)\s*/i, '').trim();
    return {platform, label, id: stableId(element, platform)};
  }

  // 平台题目文字比邻近文本可信，但仍要过同义词表；命中时提高置信度而不是跳过评分。
  function key(field, context = {}) {
    if (!field.platform || field.platform === 'generic' || !field.platformLabel) return null;
    if (!root.BKMatch) return null;
    const synthetic = {...field, label: field.platformLabel, labelParts: {own: field.platformLabel}};
    const ranked = root.BKMatch.synonymRanking(synthetic, context.rules || {});
    if (!ranked?.key) return null;
    return {key: ranked.key, conf: Math.min(0.9, ranked.conf + 0.06), platform: field.platform};
  }

  root.BKPlatform = {detect, labelFor, stableId, key, PLATFORMS};
  if (typeof module !== 'undefined') module.exports = root.BKPlatform;
})(globalThis);
