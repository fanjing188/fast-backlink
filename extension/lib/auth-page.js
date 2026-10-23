// 登录页面只提供有界候选；不会读取输入值、Cookie、授权码或密码。
(function (root) {
  const P = root.BKAuthPolicy;
  const GOOGLE = /(?:continue|sign\s*(?:in|up)|log\s*in|register|使用|通过|继续|登录|注册).{0,35}google|google.{0,20}(?:登录|注册)/i;
  const LOGIN = /^(?:log\s*in|sign\s*(?:in|up)|register|登录|登入|注册)(?:\s|$)/i;
  // randomUUID限安全上下文；普通HTTP投稿页也必须能完成原有填写。
  const docId = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('-');
  document.documentElement.dataset.bkAuthReady = docId;
  let targets = new Map();
  const visible = node => {
    const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
    return !!rect.width && !!rect.height && css.visibility !== 'hidden' && css.display !== 'none' && !node.closest('[inert]');
  };
  const label = node => String(node.getAttribute('aria-label') || node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
  function inspect() {
    const isGoogle = P.google(location.href);
    const controls = [...document.querySelectorAll('input,textarea,[contenteditable=true]')].filter(visible);
    const buttons = [...document.querySelectorAll('button,a[href],[role=button],input[type=button],input[type=submit]')].filter(visible);
    const candidates = [], next = new Map();
    function add(node, action, name, email = '') {
      if (node.disabled || node.getAttribute('aria-disabled') === 'true' || candidates.length >= 30) return;
      const id = `${docId}-${candidates.length}`;
      const href = node.closest('a[href]')?.href || '';
      next.set(id, {node, name: label(node), action, email, href});
      candidates.push({id, action, label: name.slice(0, 100), ...(email ? {email} : {}), ...(href ? {href} : {})});
    }
    if (isGoogle) {
      for (const node of document.querySelectorAll('[data-identifier],[data-email]')) {
        if (!visible(node)) continue;
        const email = node.getAttribute('data-identifier') || node.getAttribute('data-email') || '';
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !candidates.some(c => c.email === email)) add(node, 'account', '已登录的 Google 账号', email);
      }
    } else {
      for (const node of buttons) {
        const name = label(node);
        if (GOOGLE.test(name)) add(node, 'google', name);
        else if (LOGIN.test(name) && (node.tagName === 'A' || !node.closest('form'))) add(node, 'login', name);
      }
    }
    const captcha = !!document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"],.g-recaptcha,.h-captcha,.cf-turnstile');
    const password = controls.some(node => node.type === 'password');
    const challenge = password || controls.some(node => node.autocomplete === 'one-time-code' || /(?:^|[_-])otp(?:$|[_-])/i.test(node.name || node.id));
    const consent = isGoogle && !candidates.length || controls.some(node => node.type === 'checkbox' && /agree|accept|terms|consent|同意|条款/i.test(label(node.closest('label') || node)));
    const dataInputs = controls.filter(node => !['hidden', 'checkbox', 'radio', 'password', 'search', 'button', 'submit'].includes(node.type));
    const productFields = dataInputs.some(node => /product\s*name|website\s*url|产品名称|网站地址/i.test(
      [...(node.labels || [])].map(label).join(' ') + ' ' + label(node.closest('label') || node)));
    const authSubmit = buttons.some(node => LOGIN.test(label(node)) && node.closest('form'));
    const contentForm = !isGoogle && !P.loginURL(location.href) && !authSubmit && (productFields || (!password && (dataInputs.length >= 2 ||
      dataInputs.some(node => node.tagName === 'TEXTAREA' || node.isContentEditable || node.type === 'url'))));
    const gated = isGoogle || P.loginURL(location.href) || ((candidates.length || challenge) && !contentForm);
    const kind = (gated && (captcha || consent)) || (isGoogle && challenge) ? 'manual'
      : isGoogle ? 'google' : gated ? 'login' : contentForm ? 'form' : 'unknown';
    targets = next;
    return {document: docId, kind, candidates, authenticated: buttons.some(node => /^(?:log\s*out|sign\s*out|退出登录|登出)$/i.test(label(node))),
      reason: captcha ? '请手动完成验证码或风控' : kind === 'manual' ? '请手动完成授权、密码或验证' : '',
      url: location.origin + location.pathname};
  }
  function target(id, expectedDocument) {
    const saved = targets.get(id);
    if (expectedDocument !== docId || !saved || !saved.node.isConnected || !visible(saved.node) || label(saved.node) !== saved.name) throw Error('登录目标已变化，请重新读取');
    const probe = inspect();
    const fresh = targets.get(id);
    if (probe.kind === 'manual' || !fresh || fresh.node !== saved.node || fresh.action !== saved.action || fresh.email !== saved.email || fresh.href !== saved.href) throw Error('登录状态已变化，请重新读取');
    const node = saved.node;
    if (node.disabled || node.getAttribute('aria-disabled') === 'true') throw Error('登录按钮不可用');
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!hit || !(hit === node || node.contains(hit))) throw Error('登录目标被遮挡');
    node.setAttribute('data-bk-auth-target', id);
    return {selector: `[data-bk-auth-target="${id}"]`, document: docId, label: saved.name, url: location.href, href: saved.href};
  }
  root.BKAuthPage = {inspect, target};
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!['auth:probe', 'auth:target'].includes(message.type)) return;
    try { reply({value: message.type === 'auth:probe' ? inspect() : target(message.id, message.document)}); }
    catch (error) { reply({error: error.message}); }
  });
})(globalThis);
