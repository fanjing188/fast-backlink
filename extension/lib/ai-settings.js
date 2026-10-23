// AI 设置沿用侧栏控件；草稿只存在当前表单，密钥仅交给本机服务。
(function (root) {
  function create({el, text, send, status, onSaved}) {
    let saved = status, dirty = false, busy = false;
    const input = (name, type, attrs = {}) => el('input', {type, name, ...attrs});
    const enabled = input('enabled', 'checkbox', {class: 'smooth-switch', 'aria-label': '启用 AI 智能填充'});
    const address = input('base_url', 'url', {placeholder: 'https://api.example.com/v1', autocomplete: 'off', spellcheck: 'false'});
    const model = input('model', 'text', {placeholder: '填写服务商提供的模型 ID', autocomplete: 'off', spellcheck: 'false'});
    const key = input('api_key', 'password', {autocomplete: 'new-password', spellcheck: 'false'});
    const timeout = input('timeout', 'number', {min: '1', max: '120', step: '1', required: ''});
    const jsonMode = input('json_mode', 'checkbox');
    const clearKey = input('clear_api_key', 'checkbox');
    const feedback = el('div', {id: 'ai-feedback', role: 'status', 'aria-live': 'polite', class: 'muted'});
    const summary = el('p', {class: 'muted'});
    const field = (label, control, hint) => {
      control.setAttribute('aria-label', label);
      return el('label', {class: 'field'}, el('span', {}, text(label)), control,
        hint ? el('small', {class: 'muted'}, text(hint)) : null);
    };
    const save = el('button', {type: 'submit', class: 'primary'}, text('保存配置'));
    const test = el('button', {type: 'button', onclick: () => run(false)}, text('测试连通'));
    const form = el('form', {id: 'ai-config', class: 'settings-group', autocomplete: 'off'},
      el('h3', {}, text('AI 智能填充')), summary,
      el('label', {class: 'switch bk-switch'},
        el('span', {class: 'txt'}, el('b', {}, text('启用 AI 智能填充'))), enabled),
      field('API 地址', address, 'OpenAI 兼容接口的基础地址，通常以 /v1 结尾；自动追加 /chat/completions。'),
      field('模型名称', model),
      field('API 密钥', key, '仅保存在本机服务，不回显；留空保留已有密钥。更换 API 地址时须重新填写或移除密钥。'),
      el('details', {}, el('summary', {}, text('高级设置')),
        el('div', {class: 'stack tight'},
          field('请求超时（秒）', timeout),
          el('label', {class: 'row'}, jsonMode, text('要求 JSON 响应')),
          el('label', {class: 'row'}, clearKey, text('移除已有密钥（本机无鉴权接口）')))),
      el('div', {class: 'ai-actions'}, save, test), feedback,
      el('p', {class: 'muted'}, text('测试使用当前填写的配置，发送一条合成请求，不含产品资料。测试不会保存；保存后立即生效。')));

    function message(value, tone = '') {
      feedback.textContent = value;
      feedback.dataset.tone = tone;
    }
    function populate(next) {
      saved = next;
      enabled.checked = !!next?.enabled;
      address.value = next?.base_url || '';
      model.value = next?.model || '';
      timeout.value = String((next?.timeout_ms || 15000) / 1000);
      jsonMode.checked = next?.json_mode !== false;
      key.placeholder = next?.has_key ? '已保存密钥；留空保留' : '输入 API 密钥；本机无鉴权可留空';
      summary.textContent = !next ? '本机服务未连接，请先在产品资料页保存本机连接。'
        : !next.enabled ? '当前未启用；填写配置并保存后即可使用。'
        : next.configured ? `已启用 · ${next.model}` : '配置未完成，请补全后保存。';
    }
    form.refreshStatus = next => {
      if (!dirty && !busy && !form.contains(document.activeElement)) populate(next);
    };
    form.addEventListener('input', () => {
      dirty = true;
      message('配置已修改，保存后生效。');
    });
    form.addEventListener('submit', event => {event.preventDefault(); run(true);});

    async function run(persist) {
      if (busy || !form.reportValidity()) return;
      if (saved?.has_key && address.value.trim().replace(/\/+$/, '') !== (saved.base_url || '').replace(/\/+$/, '')
          && !key.value.trim() && !clearKey.checked) {
        message('更换 API 地址时请重新填写密钥，或勾选移除已有密钥。', 'error');
        return;
      }
      busy = true;
      form.setAttribute('aria-busy', 'true');
      const controls = [...form.querySelectorAll('input, button')];
      const patch = {enabled: enabled.checked, base_url: address.value.trim(), model: model.value.trim(),
        api_key: key.value, timeout_ms: Number(timeout.value) * 1000, json_mode: jsonMode.checked,
        clear_api_key: clearKey.checked};
      for (const control of controls) control.disabled = true;
      message(persist ? '正在保存配置…' : '正在测试接口与模型…');
      try {
        if (persist) {
          await send('ai:configure', {patch});
          // 写入后读回服务状态，未知回执不自动重发保存。
          const info = await send('panel:state');
          if (!info?.aiStatus) throw Error('保存已返回，但状态读回失败；请重新读取确认，不要重复保存。');
          key.value = '';
          clearKey.checked = false;
          dirty = false;
          populate(info.aiStatus);
          onSaved(info.aiStatus);
          message('配置已保存，立即生效。', 'ok');
        } else {
          const result = await send('ai:test', {patch});
          message(result.ok ? `连接成功 · ${result.model} · ${result.ms} ms${dirty ? '（草稿尚未保存）' : ''}`
            : `连接失败：${result.error}`, result.ok ? 'ok' : 'error');
        }
      } catch (error) {
        message(error.message, 'error');
      } finally {
        busy = false;
        form.removeAttribute('aria-busy');
        for (const control of controls) control.disabled = false;
      }
    }
    populate(saved);
    return form;
  }
  root.BKAISettings = {create};
})(globalThis);
