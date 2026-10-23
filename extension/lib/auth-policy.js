// 登录策略由内容脚本和后台共用；页面与模型都不能扩大授权范围。
(function (root) {
  const LOGIN_PATH = /(?:^|\/)(?:log[-_]?in|sign[-_]?(?:in|up)|register|registration|auth|oauth2?|sso|account\/(?:login|signin))(?:\/|$)/i;
  function address(value) {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null; }
    catch { return null; }
  }
  function google(value) {
    const url = address(value);
    return !!url && url.protocol === 'https:' && url.hostname === 'accounts.google.com';
  }
  function loginURL(value) {
    const url = address(value);
    return !!url && (google(value) || LOGIN_PATH.test(url.pathname) || callbackURL(value));
  }
  function callbackURL(value) {
    const url = address(value);
    return !!url && (/(?:^|\/)(?:callback|oauth[-_]?callback)(?:\/|$)/i.test(url.pathname) ||
      url.searchParams.has('code') && url.searchParams.has('state') ||
      /(?:^|[?#&])(?:access_token|id_token|refresh_token|oauth_token)=/i.test(url.search + url.hash));
  }
  function canFill(probe, actual, target) {
    const url = address(actual), wanted = address(target);
    return !!url && !!wanted && url.origin === wanted.origin && !loginURL(actual) &&
      !['login', 'google', 'manual'].includes(probe?.kind);
  }
  function allowedURL(value, origins) {
    const url = address(value);
    return !!url && (google(value) || (url.protocol === 'https:' && origins.includes(url.origin)));
  }
  function choose(probe, email) {
    if (!probe || probe.kind === 'manual') return null;
    const candidates = probe.candidates || [];
    const action = probe.kind === 'google' ? 'account' : candidates.some(c => c.action === 'google') ? 'google' : 'login';
    const matches = candidates.filter(c => c.action === action && (action !== 'account' || String(c.email).toLowerCase() === String(email).toLowerCase()));
    return matches.length === 1 ? matches[0] : null;
  }
  function oauthContext(value, depth = 0) {
    if (!google(value) || depth > 3) return null;
    const url = address(value), params = url.searchParams;
    if (params.has('client_id') && params.has('redirect_uri') && params.has('scope') && params.has('state')) {
      const redirect = address(params.get('redirect_uri'));
      if (!redirect || redirect.protocol !== 'https:') return null;
      return {client: params.get('client_id'), redirect: redirect.href,
        scope: params.get('scope').split(/\s+/).filter(Boolean).sort().join(' '), state: params.get('state')};
    }
    for (const name of ['continue', 'followup']) {
      const nested = params.get(name);
      if (nested && nested.length <= 12000) {const found = oauthContext(nested, depth + 1); if (found) return found;}
    }
    return null;
  }
  function matchesOAuth(expected, value, origins) {
    const actual = oauthContext(value);
    const scopes = new Set(['openid', 'email', 'profile', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile']);
    return !!expected && !!actual && !!actual.state && !!actual.client &&
      origins.includes(new URL(actual.redirect).origin) && actual.scope.split(' ').every(scope => scopes.has(scope)) &&
      ['client', 'redirect', 'scope', 'state'].every(key => actual[key] === expected[key]);
  }
  const api = {address, google, loginURL, callbackURL, canFill, allowedURL, choose, oauthContext, matchesOAuth};
  root.BKAuthPolicy = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
