// 侧栏的本站Google登录授权，复用应用控件，不把账号同步到本机日志或AI。
(function (root) {
  function card({auth, tab, send, refresh, toast, el, text}) {
    if (!auth || !tab) return null;
    const task = auth.task, active = task && !['complete', 'cancelled'].includes(task.state);
    const gated = ['login', 'google', 'manual'].includes(auth.kind);
    const box = el('details', {id: 'auth-card', class: 'card'});
    box.open = gated || !!task && task.state !== 'complete';
    box.append(el('summary', {class: 'pad'}, text('Google 登录／注册')));
    const body = el('div', {class: 'pad stack tight'});
    body.hidden = !box.open;
    box.addEventListener('toggle', () => {body.hidden = !box.open;});
    const labels = {running: '正在检查登录页面', waiting: '正在等待登录结果', manual: '需要你处理', complete: '已接回投稿表单', cancelled: '登录已停止'};
    body.append(el('p', {class: 'muted', role: 'status'}, text(task ? `${labels[task.state] || task.state}。${task.reason || ''}`
      : '指定一个已在浏览器登录的 Google 账号。首次授权、密码和验证码由你完成。')));
    if (!auth.authorized) {
      const target = el('input', {id: 'auth-target', type: 'url', value: auth.target || tab.url, required: '', autocomplete: 'off'});
      const email = el('input', {id: 'auth-email', type: 'email', value: auth.email || '', required: '', autocomplete: 'off'});
      body.append(el('label', {class: 'stack tight'}, text('原投稿地址'), target), el('label', {class: 'stack tight'}, text('已授权的 Google 邮箱'), email));
      const scope = el('p', {class: 'muted'});
      const showScope = () => {
        try {scope.textContent = `允许登录／注册：${[...new Set([new URL(target.value).origin, new URL(tab.url).origin])].join('、')}；以及 accounts.google.com。`;} catch {scope.textContent = '请输入原投稿页的 HTTPS 地址。';}
      };
      showScope(); target.addEventListener('input', showScope); body.append(scope);
      body.append(el('button', {id: 'auth-save', class: 'primary', onclick: async event => {
        if (!email.reportValidity() || !target.reportValidity()) return;
        event.currentTarget.disabled = true;
        try {
          await send('auth:grant', {tabId: tab.id, email: email.value, target: target.value});
          await send('auth:start', {tabId: tab.id}); await refresh();
        } catch (error) {toast(error.message, 'err'); event.currentTarget.disabled = false;}
      }}, text('授权本站并开始')));
    } else {
      body.append(el('p', {class: 'muted', style: 'overflow-wrap:anywhere'}, text(`本站授权账号：${auth.email}`)));
      const actions = el('div', {class: 'row wrap'});
      const action = (id, label, type, extra = {}) => el('button', {id, class: 'sm', onclick: async event => {
        event.currentTarget.disabled = true;
        try {await send(type, {tabId: tab.id, ...extra}); await refresh();}
        catch (error) {toast(error.message, 'err'); event.currentTarget.disabled = false;}
      }}, text(label));
      if (!active) actions.append(action('auth-start', '登录并继续', 'auth:start'));
      if (active) actions.append(action('auth-resume', '继续检查', 'auth:resume'), action('auth-stop', '停止', 'auth:cancel'));
      actions.append(action('auth-revoke', '撤销本站授权', 'auth:grant', {enabled: false}));
      body.append(actions);
    }
    box.append(body);
    return box;
  }
  root.BKAuthPanel = {card};
})(globalThis);
