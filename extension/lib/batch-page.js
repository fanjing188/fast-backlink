// 只判断当前可见反馈；提交动作的授权与一次性记录由后台负责。
(function (root) {
  function classify({url = '', attempted = false, login = false, captcha = false, payment = false,
    email = false, missing = [], error = '', success = '', hasForm = true, timedOut = false, baseline}) {
    if (login) return {result: 'manual', reason: '登录'};
    if (captcha) return {result: 'manual', reason: '验证码'};
    if (payment) return {result: 'manual', reason: '付款'};
    if (email) return {result: 'manual', reason: '邮箱验证'};
    if (attempted && error) return {result: 'failed', reason: error};
    const negative = /\b(?:not|never|failed|unable|unsuccessful)\b|未提交|未收到|失败/i.test(success);
    const confirmation = /thank you\b|\b(?:successfully submitted|(?:your\s+)?(?:submission|application|listing)\s+(?:(?:has been|was|is)\s+)?(?:received|submitted))\b|提交成功|已收到|成功提交/i.test(success);
    const newFeedback = !baseline || baseline.success !== success;
    const destination = /(?:\/|^)(?:thank[-_]?you|submission[-_]?received|submitted|success)(?:[/.?#_-]|$)/i.test(url);
    if (attempted && !negative && (destination && (!baseline || baseline.url !== url) || confirmation && newFeedback)) {
      return {result: 'success', reason: '页面确认收稿'};
    }
    if (!attempted && missing.length) return {result: 'manual', reason: '缺资料：' + missing.join('、')};
    if (!attempted && !hasForm) return {result: 'failed', reason: '找不到表单'};
    if (timedOut) return {result: 'unknown', reason: '提交后无明确反馈或单页超时；不自动重试'};
    return null;
  }

  function inspect(document, entries, options = {}) {
    const visible = node => !!node?.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const nodes = selector => [...document.querySelectorAll(selector)].filter(visible);
    const feedback = selector => nodes(selector).map(node => node.textContent || '').join(' ').slice(0, 1500);
    const fields = entries.filter(entry => visible(entry.element) && !entry.field.honeypot && !entry.field.disabled);
    const missing = fields.filter(entry => entry.field.required && !entry.field.captcha &&
      (entry.field.sensitive || entry.element.validity?.valid === false || !root.BKFields.read(entry.element, entry.field) ||
       entry.needsConfirmation || !options.byHuman?.has(entry.element) &&
       ['pending', 'confirm'].includes(options.decisions?.get(entry.field.index)?.status))).map(entry => entry.field.label || '必填项');
    const captcha = nodes('iframe[src*="captcha"],iframe[src*="challenges.cloudflare"],.g-recaptcha,.h-captcha,.cf-turnstile').length > 0 || fields.some(e => e.field.captcha);
    const payment = fields.some(e => e.field.sensitive === 'payment') || nodes('[autocomplete^="cc-"]').length > 0;
    const email = /verify (?:your )?email|check your inbox|邮箱验证|验证邮件|确认邮箱/i.test(feedback('[role="alert"],[role="status"],h1,h2,.verification'));
    const error = feedback('[role="alert"],.error,.errors,.invalid-feedback,[aria-invalid="true"]');
    const success = feedback('[role="status"],.success,.alert-success,h1,h2,main p');
    const hasForm = fields.some(e => !e.field.sensitive && !e.field.captcha);
    const result = classify({...options, captcha, payment, email, missing, error, success, hasForm});
    const buttons = nodes('button,input[type="submit"],[role="button"]').filter(node => !node.disabled &&
      /^(?:submit(?:\s+(?:listing|tool|product|application))?|send(?:\s+(?:application|listing))?|publish|提交|发布)$/i.test((node.value || node.textContent || '').trim()));
    return {...(result || {}), hasForm, feedback: {url: options.url || '', success},
      canSubmit: !result && !options.attempted && buttons.length === 1};
  }

  root.BKBatchPage = {classify, inspect};
  if (typeof module !== 'undefined') module.exports = root.BKBatchPage;
})(globalThis);
