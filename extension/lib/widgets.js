// 自定义控件适配器：每次派发前重核绑定，动作不确定时只回读、不自动重放。
(function (root) {
  const F = root.BKFields;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let queue = Promise.resolve();

  // 所有交互串行，避免两个控件同时开菜单互相抢焦点。
  function serial(task) {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  }

  const formAction = element => !!element?.form && /^(submit|reset|image)$/.test(element.type || '');

  function ensure(element, options = {}) {
    const control = options.control || element;
    if (!control?.isConnected || control.disabled || control.readOnly ||
        /^(password|hidden|file)$/.test(control.type || '') || formAction(control) || formAction(element) ||
        (options.eligible && !options.eligible())) {
      const error = new Error('target_changed');
      error.code = 'target_changed';
      throw error;
    }
  }

  function write(element, options, action) {
    ensure(element, options);
    return options.writeSync ? options.writeSync(action) : action();
  }

  function typeInto(input, text, options = {}) {
    ensure(input, options);
    input.focus();
    write(input, options, () => {F.setNative(input, 'value', ''); F.events(input, ['input']);});
    write(input, options, () => {F.setNative(input, 'value', String(text)); F.events(input, ['input']);});
    write(input, options, () => F.events(input, ['keyup']));
  }

  async function press(element, key, options = {}) {
    const event = {key, code: key, bubbles: true, cancelable: true, composed: true};
    if (key === 'Enter') Object.assign(event, {keyCode: 13, which: 13});
    if (key === 'Escape') Object.assign(event, {keyCode: 27, which: 27});
    for (const type of ['keydown', 'keyup']) {
      write(element, options, () => element.dispatchEvent(new (element.ownerDocument.defaultView.KeyboardEvent)(type, event)));
    }
  }

  async function clickNode(node, options = {}) {
    if (!node) return false;
    const view = node.ownerDocument.defaultView;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      ensure(node, options);
      if (!node.isConnected || (options.targetCurrent && !options.targetCurrent())) return false;
      const EventClass = type.startsWith('pointer') ? view.PointerEvent || view.MouseEvent : view.MouseEvent;
      node.dispatchEvent(new EventClass(type, {bubbles: true, cancelable: true, composed: true, view}));
    }
    return true;
  }

  async function waitFor(find, timeout = 1500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = find();
      if (found) return found;
      await sleep(50);
    }
    return null;
  }

  const trace = (msg, extra) => {try {root.BKWidgets?.debug?.(msg, extra);} catch { /* 日志失败不影响填表 */ }};

  // 控件自己展示的“已选值”；有它就以它为准，不能只看输入框文字。
  function selectedValue(container) {
    const node = container.querySelector('[class*="single-value"],[class*="singleValue"],[class*="selected-value"],' +
      '.select2-selection__rendered,.choices__item--selectable,[role="option"][aria-selected="true"],[data-value][aria-selected="true"]');
    const text = node ? (node.textContent || '').trim() : '';
    // 空字符串不算“选中了”，要交回上层按回读判断。
    return text || null;
  }

  function optionNodes(scope) {
    return [...(scope || document).querySelectorAll('[role="option"],[class*="__option"],[class*="option"],[class*="choices__item--choice"],li[data-value],.select2-results__option')]
      .filter(node => node.getClientRects().length && (node.textContent || '').trim());
  }

  // react-select / MUI / choices：点开菜单再点项；读回不一致就交人，不换通道重放。
  async function combobox(element, field, value, options = {}) {
    options = {...options, control: element};
    // 从父链上找控件容器；输入框自己的 class 可能就带 react-select，不能算容器。
    const container = element.closest('.react-select,.reactSelect,[class*="react-select-container"],.MuiAutocomplete-root,.choices') ||
      element.parentElement?.closest('[class*="react-select"],[class*="reactSelect"],[class*="MuiAutocomplete"],[class*="choices__"]') ||
      (element.getAttribute('role') === 'combobox' ? element.parentElement : element.closest('[role="combobox"]')) ||
      element.parentElement;
    const wanted = String(value), scope = element.getRootNode();
    const normalize = text => String(text || '').trim().toLocaleLowerCase();
    const candidates = [...new Set([wanted, ...(options.candidates || []).map(String)])];
    const link = () => element.getAttribute('aria-controls') || element.getAttribute('aria-owns') || '';
    let originalLink = link();
    const actionOptions = {...options, eligible: () => {
      const current = link();
      if (!originalLink && current) originalLink = current;
      return (!originalLink || current === originalLink) && (!options.eligible || options.eligible());
    }};
    const nodes = () => {
      if (!element.isConnected || (originalLink && link() !== originalLink)) return [];
      const ids = link().trim().split(/\s+/).filter(Boolean);
      if (!ids.length) return optionNodes(container);
      const menus = ids.map(id => [...scope.querySelectorAll('[id]')].filter(node => node.id === id));
      if (menus.some(matches => matches.length !== 1 || matches[0].getAttribute('role') !== 'listbox')) return [];
      return menus.flatMap(([menu]) => optionNodes(menu));
    };
    const match = list => {
      for (const needle of candidates) {
        const matches = list.filter(node => normalize(node.textContent) === normalize(needle));
        if (matches.length > 1) return {ambiguous: true};
        if (matches.length === 1) return {target: matches[0]};
      }
      return null;
    };
    // 只打开一次；portal 可延迟挂载，但必须由该控件明确关联。
    ensure(element, actionOptions);
    element.focus();
    await clickNode(element, actionOptions);
    let found = await waitFor(() => {ensure(element, actionOptions); return match(nodes());}, 600);
    if (!found && element.tagName === 'INPUT' && !element.readOnly) {
      typeInto(element, wanted, actionOptions);
      found = await waitFor(() => {ensure(element, actionOptions); return match(nodes());});
    }
    if (found?.ambiguous) return {ok: false, reason: 'ambiguous_option', method: 'combobox'};
    const target = found?.target;
    if (!target || !nodes().includes(target) || target.getAttribute('aria-disabled') === 'true' || target.disabled) {
      return {ok: false, reason: 'option_unavailable', method: 'combobox'};
    }
    const picked = target.textContent.trim();
    await clickNode(target, {...actionOptions, targetCurrent: () => nodes().includes(target) &&
      normalize(target.textContent) === normalize(picked) && target.getAttribute('aria-disabled') !== 'true' && !target.disabled});
    // 回车可能触发表单提交；点击已选项后只回读，不再派发第二个动作。
    const selected = await waitFor(() => {
      ensure(element, options);
      const displayed = selectedValue(container);
      if (!element.isConnected || (!displayed && originalLink && link() !== originalLink)) return null;
      const value = displayed || (element.tagName === 'INPUT' ? element.value : element.textContent.trim());
      const committed = displayed || target.getAttribute('aria-selected') === 'true' || !nodes().length;
      return committed && normalize(value) === normalize(picked) ? value : null;
    });
    trace('combobox_clicked', {picked, selected});
    return {ok: !!selected, method: 'combobox-click', selected, reason: selected ? '' : 'selection_unverified'};
  }

  async function select2(element, field, value, options = {}) {
    const select = element.tagName === 'SELECT' ? element : element.closest('.select2-container')?.previousElementSibling;
    if (select && select.tagName === 'SELECT') {
      write(element, options, () => F.setSelect(select, value));
      const jQuery = select.ownerDocument.defaultView?.jQuery;
      if (jQuery) {
        ensure(element, options);
        try { write(element, options, () => jQuery(select).val(select.value).trigger('change')); } catch { /* jQuery 被改过也不影响原生 change */ }
      }
      return {ok: true, method: 'select2-native'};
    }
    return combobox(element, field, value, options);
  }

  async function tags(element, field, values, options = {}) {
    const list = Array.isArray(values) ? values : String(values).split(/[,，;；\n]/).map(x => x.trim()).filter(Boolean);
    const container = element.closest('[class*="tags"],[class*="chips"],[class*="token"]') || element.parentElement;
    const max = Number(container.getAttribute?.('data-max') || element.getAttribute('maxlength') || 0);
    const limit = Number.isFinite(max) && max > 0 ? max : Infinity;
    for (const value of list.slice(0, limit)) {
      typeInto(element, value, options);
      await press(element, 'Enter', options);
      await sleep(60);
      ensure(element, options);
      if (/[,，]/.test(element.value || '')) {   // 有的标签输入用逗号分隔
        typeInto(element, value + ',', options);
        await sleep(40);
      }
    }
    return {ok: true, method: 'tags-enter', count: list.length};
  }

  function richEditor(element, options = {}) {
    const doc = element.ownerDocument;
    const view = doc.defaultView || {};
    const tinymce = view.tinymce;
    if (tinymce?.get) {
      const id = element.id || element.closest('.tox')?.querySelector('textarea')?.id;
      const editor = id ? tinymce.get(id) : null;
      if (editor?.setContent) return {kind: 'tinymce', set: text => write(element, options, () => editor.setContent(text))};
    }
    const host = element.closest('.ql-editor,.ck-editor__editable,.ProseMirror,.tiptap,.note-editable,.mce-content-body,[data-lexical-editor]') || element;
    return {kind: 'contenteditable', element: host, set: text => {
      ensure(element, options);
      host.focus();
      ensure(element, options);
      const active = host.getRootNode()?.activeElement || doc.activeElement;
      if (active !== host && !host.contains(active)) return false;
      const selection = doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(host);
      selection.removeAllRanges(); selection.addRange(range);
      const ok = write(element, options, () => doc.execCommand?.('insertText', false, text));
      if (!ok) {
        write(element, options, () => {host.textContent = text; F.events(host, ['input', 'change']);});
      }
      return true;
    }};
  }

  function nativeSelectMultiple(element, field, values, options = {}) {
    const wanted = (Array.isArray(values) ? values : [values]).map(String);
    let chosen = 0;
    for (const option of element.options) {
      const match = wanted.some(value => value.trim() === option.textContent.trim());
      write(element, options, () => {option.selected = match;});
      if (match) chosen++;
    }
    write(element, options, () => F.events(element, ['input', 'change']));
    return {ok: chosen > 0, method: 'select-multiple', count: chosen};
  }

  /**
   * 尝试用控件自己的方式写值。返回 null 表示这不是自定义控件，交给默认 DOM 写入。
   */
  async function set(element, field, value, options = {}) {
    if (value === undefined || value === null || value === '') return null;
    const widget = field.widget;
    options = {...options, control: element};
    return serial(async () => {
      try {
        ensure(element, options);
        if (widget === 'react-select' || widget === 'mui-autocomplete' || widget === 'choices' || widget === 'custom-select') {
          return await combobox(element, field, value, options);
        }
        if (widget === 'select2') return await select2(element, field, value, options);
        if (widget === 'select-multiple' && element.options) return nativeSelectMultiple(element, field, value, options);
        if (widget === 'tags') return await tags(element, field, value, options);
        if (['quill', 'tinymce', 'ckeditor', 'prosemirror', 'lexical', 'tiptap', 'richcontent', 'summernote', 'slate'].includes(widget) || element.isContentEditable) {
          const editor = richEditor(element, options);
          return {ok: editor.set(String(value)) !== false, method: 'rich:' + editor.kind};
        }
        if (widget === 'date' && element.getAttribute('class')?.match(/flatpickr|datepicker|pikaday/i)) {
          typeInto(element, String(value), options);
          await press(element, 'Escape', options);
          return {ok: true, method: 'date-type'};
        }
        return null;
      } catch (error) {
        return {ok: false, method: 'adapter_error', reason: error?.code || 'adapter_error', error: String(error?.message || error)};
      }
    });
  }

  root.BKWidgets = {set, combobox, select2, tags, richEditor, optionNodes, selectedValue, press, clickNode, sleep, serial, debug: null};
  if (typeof module !== 'undefined') module.exports = root.BKWidgets;
})(globalThis);
