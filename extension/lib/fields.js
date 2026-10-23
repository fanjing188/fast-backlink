// 字段采集：多来源标签、约束、控件类型、蜜罐与验证码判定。跑在页面的每个 frame 里。
(function (root) {
  const T = root.BKText;
  const privacyRules = new WeakMap();
  const SEMANTIC_ATTRS = ['aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-braillelabel',
    'aria-brailleroledescription', 'title', 'placeholder', 'data-help'];
  const SEMANTIC_REFS = ['aria-labelledby', 'aria-describedby', 'aria-details', 'aria-errormessage'];
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
  const HONEYPOT_NAMES = /(^|[\s_-])(hp|honeypot|honey|website2|url2|company_?website2|nickname|fax|address2|leave_?blank|do_?not_?fill|bot)([\s_-]|$)/i;
  const CAPTCHA_WORDS = /(captcha|recaptcha|hcaptcha|turnstile|security code|verification code|验证码|security question|are you human|human check|anti-?spam)/i;
  const CAPTCHA_HOSTS = /(recaptcha|hcaptcha|turnstile|challenges\.cloudflare|geetest|yandex\.com\/captcha)/i;
  const RICH = [['quill', '.ql-editor'], ['tinymce', '.tox-edit-area,[id$="_ifr"]'], ['ckeditor', '.ck-editor__editable'],
    ['prosemirror', '.ProseMirror'], ['lexical', '[data-lexical-editor]'], ['tiptap', '.tiptap'],
    ['tinymce', '.mce-content-body'], ['summernote', '.note-editable'], ['slate', '[data-slate-editor]']];
  const MAX_ELEMENTS = 20000;

  function closedRoot(element) {
    try {
      return (globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element)) || null;
    } catch { return null; }
  }

  function roots(doc = document) {
    const list = [doc], seen = new Set([doc]);
    let count = 0;
    for (let index = 0; index < list.length; index++) {
      const scope = list[index];
      let all = [];
      try { all = [...scope.querySelectorAll('*')]; } catch { all = []; }
      for (const element of all) {
        if (++count > MAX_ELEMENTS) return list;
        const shadow = element.shadowRoot || closedRoot(element);
        if (shadow && !seen.has(shadow)) { seen.add(shadow); list.push(shadow); }
      }
    }
    return list;
  }

  function textOf(node) {
    return (node?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function labelText(node, includeCaptions = false) {
    if (!node) return '';
    if (node.nodeType === 3) return node.textContent;
    if (node.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA', 'SCRIPT', 'STYLE'].includes(node.tagName)) return '';
    if (!includeCaptions && ['BUTTON', 'OPTION'].includes(node.tagName)) return '';
    return [...node.childNodes].map(child => labelText(child, includeCaptions)).join('');
  }

  function ownLabel(element) {
    const doc = element.ownerDocument || document;
    const scope = element.getRootNode?.() || doc;
    const wrapped = [...(element.labels || [])].map(node => labelText(node).trim()).filter(Boolean);
    const byId = (element.getAttribute('aria-labelledby') || '').split(/[\t\n\f\r ]+/)
      .map(id => labelText(scope.getElementById?.(id)).trim()).filter(Boolean);
    if (!wrapped.length && !byId.length && !element.getAttribute('aria-label')) {
      let container = element.parentElement;
      for (let depth = 0; container && depth < 3; depth++, container = container.parentElement) {
        const controls = container.querySelectorAll('input,textarea,select,[role="combobox"],[contenteditable]');
        if (controls.length !== 1 || controls[0] !== element) break;
        if (!container.id) continue;
        const labels = [...scope.querySelectorAll('label[for]')].filter(label => label.htmlFor === container.id)
          .map(label => labelText(label).trim()).filter(Boolean);
        if (labels.length) return labels.join(' ');
      }
    }
    return [...wrapped, ...byId].join(' ').trim();
  }

  function nearText(element) {
    const doc = element.ownerDocument || document;
    const tree = element.getRootNode?.() || doc;
    const described = (element.getAttribute('aria-describedby') || '').split(/[\t\n\f\r ]+/)
      .map(id => labelText(tree.getElementById?.(id)).trim()).filter(Boolean).join(' ');
    const parts = [];
    // 往前找最近的一段文字：先看自己的前兄弟，再看父级的前兄弟（富文本编辑器的标签常包在外面）。
    let scope = element, depth = 0;
    while (scope && depth < 3) {
      let node = scope.previousElementSibling, hops = 0;
      while (node && hops < 3) {
        const text = textOf(node);
        if (text && text.length <= 80 && !node.querySelector('input,textarea,select')) {parts.unshift(text); break;}
        node = node.previousElementSibling; hops++;
      }
      if (parts.length) break;
      scope = scope.parentElement; depth++;
    }
    const row = element.closest('tr');
    if (row) {
      const header = row.querySelector('th');
      if (header) parts.push(textOf(header));
      else {
        const table = row.closest('table'), first = table?.querySelector('tr');
        if (first && first !== row) {
          const cells = [...first.children];
          const mine = [...row.children].indexOf(element.closest('td,th'));
          if (mine >= 0 && cells[mine]) parts.push(textOf(cells[mine]));
        }
      }
    }
    const fieldset = element.closest('fieldset');
    if (fieldset) {
      const legend = textOf(fieldset.querySelector('legend'));
      if (legend) parts.push(legend);
    }
    // 只看区块标题（h1 通常是页面标题，不算字段标签）。
    // 标题必须出现在字段之前；legend 只能属于字段自己的 fieldset，避免别的分组把标签带跑。
    let walk = element.parentElement, level = 0, heading = '';
    const ownFieldset = element.closest('fieldset');
    while (walk && level < 6 && !heading) {
      const candidate = walk.querySelector('h2,h3,h4,h5,h6,legend,[class*="title"],[class*="heading"]');
      const text = textOf(candidate);
      const foreignLegend = candidate?.tagName === 'LEGEND' && candidate.parentElement !== ownFieldset;
      const before = !candidate || (candidate.compareDocumentPosition(element) & 4);
      if (text && text.length <= 120 && !candidate?.querySelector('input,textarea,select') &&
          !candidate?.contains(element) && !foreignLegend && before && !parts.includes(text)) heading = text;
      walk = walk.parentElement; level++;
    }
    if (heading) parts.push(heading);
    return {near: parts.join(' ').trim(), described};
  }

  function visible(element) {
    if (element.type === 'hidden') return false;
    if (element.hidden) return false;
    let walk = element, style = null;
    try { style = (element.ownerDocument.defaultView || window).getComputedStyle(element); } catch { style = null; }
    if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
    if (!style && !element.getClientRects().length) return false;
    if (element.closest('[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"]') && !element.getClientRects().length) return false;
    const rects = element.getClientRects();
    if (!rects.length) return false;
    const rect = rects[0];
    if (rect.width <= 1 || rect.height <= 1) return false;
    const view = element.ownerDocument.defaultView || window;
    if (rect.right < -1500 || rect.bottom < -1500 || rect.left > view.innerWidth + 4000) return false;
    return true;
  }

  function offscreen(element) {
    const rects = element.getClientRects();
    if (!rects.length) return false;
    const rect = rects[0], view = element.ownerDocument.defaultView || window;
    return rect.right < 0 || rect.bottom < 0 || rect.left > view.innerWidth || rect.top > view.innerHeight * 4;
  }

  function honeypotBy(element, field) {
    const name = ((element.name || '') + ' ' + (element.id || '') + ' ' + (element.className || '')).toLowerCase();
    if (HONEYPOT_NAMES.test(name)) return 'suspicious_name';
    const tabindex = element.getAttribute('tabindex');
    if (tabindex === '-1' && (HONEYPOT_NAMES.test(name) || element.getAttribute('aria-hidden') === 'true')) return 'tabindex_aria';
    if (element.getAttribute('autocomplete') === 'off' && tabindex === '-1' && !field.label) return 'unlabeled_off_autocomplete';
    return null;
  }

  function richKind(element) {
    for (const [kind, selector] of RICH) {
      if (element.matches?.(selector) || element.closest?.(selector)) return kind;
    }
    return 'richcontent';
  }

  function widgetOf(element) {
    const tag = element.tagName;
    if (element.type === 'file') return 'file';
    if (tag === 'SELECT') return element.multiple ? 'select-multiple' : 'select-one';
    if (element.type === 'radio') return 'radio';
    if (element.type === 'checkbox') return 'checkbox';
    if (tag === 'TEXTAREA') return 'textarea';
    if (['date', 'time', 'datetime-local', 'month', 'week'].includes(element.type)) return 'date';
    if (element.isContentEditable) return richKind(element.closest('.ql-editor,.tox-edit-area,.ck-editor__editable,.ProseMirror,.tiptap,.note-editable') || element);
    const close = selector => element.closest?.(selector);
    if (close('[class*="react-select"],[class*="reactSelect"]')) return 'react-select';
    if (close('.select2-container,[class*="select2"]')) return 'select2';
    if (close('.choices,[class*="choices__"]')) return 'choices';
    if (close('.MuiAutocomplete-root,[class*="MuiAutocomplete"]')) return 'mui-autocomplete';
    if (close('[class*="chips"],[class*="tags-input"],[data-testid*="tag"],[class*="tag-input"]')) return 'tags';
    if (close('[class*="flatpickr"],[class*="datepicker"],[class*="pikaday"]')) return 'date';
    if (close('[role="combobox"]') && element.getAttribute('role') !== 'combobox') return 'custom-select';
    if (element.getAttribute('role') === 'combobox') return 'custom-select';
    if (element.getAttribute('role') === 'switch') return 'switch';
    if (element.getAttribute('role') === 'listbox') return 'custom-select';
    if (element.type === 'number' || element.type === 'range') return 'number';
    if (element.type === 'email') return 'email';
    if (element.type === 'url') return 'url';
    if (element.type === 'tel') return 'tel';
    return 'text';
  }

  function constraints(element) {
    const accept = (element.getAttribute('accept') || '').toLowerCase();
    const help = [element.getAttribute('data-help'), element.getAttribute('title')].filter(Boolean).join(' ');
    return {
      required: !!(element.required || element.getAttribute('aria-required') === 'true'),
      maxlength: Number.isFinite(element.maxLength) ? element.maxLength : -1,
      minlength: element.minLength > 0 ? element.minLength : -1,
      pattern: element.getAttribute('pattern') || '',
      accept, multiple: !!element.multiple,
      min: element.getAttribute('min'), max: element.getAttribute('max'),
      help: help.trim(),
      placeholder: element.getAttribute('placeholder') || '',
      autocomplete: (element.getAttribute('autocomplete') || '').toLowerCase(),
    };
  }

  // 从提示文字里读长度或尺寸要求：'max 160 characters' / '512×512' / '不超过 200 字'。
  function readHints(text) {
    const value = String(text || '');
    const hints = {};
    const limit = value.match(/(?:max|maximum|up to|no more than|不超过|最多)\D{0,12}(\d{2,6})\s*(?:char|characters|characters|字|letters)?/i);
    if (limit) hints.maxlength = Number(limit[1]);
    const dims = value.match(/(\d{2,4})\s*[×x*]\s*(\d{2,4})/);
    if (dims) hints.width = Number(dims[1]), hints.height = Number(dims[2]);
    const size = value.match(/(?:max|under|小于|不超过)\D{0,8}(\d{1,3})\s*(mb|kb)/i);
    if (size) hints.bytes = Number(size[1]) * (size[2].toLowerCase() === 'mb' ? 1024 * 1024 : 1024);
    return hints;
  }

  function captchaNear(element) {
    const doc = element.ownerDocument || document;
    // 只在字段所在的表单/容器里找验证码控件；整页有 recaptcha 不代表每个字段都是验证码。
    const scope = element.closest('form,fieldset') || element.parentElement;
    if (scope?.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="turnstile"],iframe[src*="challenges.cloudflare"],[class*="g-recaptcha"],[class*="h-captcha"],[class*="cf-turnstile"]')) {
      return null;   // 控件级验证码由页面整块交给人工，字段本身照常判类型
    }
    const container = element.closest('form,fieldset,div,section') || doc.body;
    if (!container) return null;
    const text = textOf(container).slice(0, 4000);
    if (CAPTCHA_WORDS.test(text) && element.getClientRects().length) {
      const looksLikeAnswer = /captcha|code|human|验证码/i.test(element.name + ' ' + element.id + ' ' + (element.getAttribute('aria-label') || ''));
      if (looksLikeAnswer || /\d\s*[+\-×*]\s*\d/.test(text)) return 'inline';
    }
    return null;
  }


  function describe(element, rules = {}, options = {}) {
    const doc = element.ownerDocument || document;
    const scope = element.getRootNode?.() || doc;
    const label = ownLabel(element);
    const {near, described} = nearText(element);
    const name = [element.name, element.id].filter(Boolean).join(' ');
    const bits = T.distinctive(T.camel(name + ' ' + (element.className?.toString?.() || ''))).join(' ').slice(0, 200);
    const primary = [label, element.getAttribute('aria-label'), (element.getAttribute('placeholder') || ''),
      near, element.getAttribute('title'), bits].find(text => text && String(text).trim()) || '';
    // 去掉必填星号一类的装饰：存进记忆和日志的要是人能读的文字。
    const clean = String(primary).replace(/\s+/g, ' ').trim().replace(/^[\s*＊·•]+/, '').replace(/[\s*＊]+$/, '');
    const field = {
      label: clean.slice(0, 300),
      labelParts: {own: label, aria: element.getAttribute('aria-label') || '', placeholder: element.getAttribute('placeholder') || '',
        near, described, bits},
      name: name.slice(0, 200), inputType: element.type || (element.isContentEditable ? 'contenteditable' : element.tagName.toLowerCase()),
      widget: widgetOf(element), role: element.getAttribute('role') || (element.tagName === 'SELECT' ? 'combobox' : 'textbox'),
      tag: element.tagName.toLowerCase(), order: options.order ?? 0,
    };
    Object.assign(field, constraints(element));
    field.helpText = [described, field.help].filter(Boolean).join(' ').slice(0, 300);
    Object.assign(field, {hints: readHints(field.helpText + ' ' + field.label + ' ' + field.placeholder)});
    if (field.hints.maxlength && (field.maxlength < 0 || field.hints.maxlength < field.maxlength)) field.maxlength = field.hints.maxlength;
    if (element.options) field.options = [...element.options].filter(option => !option.disabled && option.value !== '').map(option => option.textContent.trim()).filter(Boolean);
    if (field.inputType === 'radio') {
      const scope = element.form || element.getRootNode?.() || doc;
      field.options = [...scope.querySelectorAll('input[type=radio]')]
        .filter(other => other.name === element.name && other.form === element.form).map(other => ownLabel(other) || other.value);
    }
    if (element.getAttribute('list')) {
      const list = scope.getElementById?.(element.getAttribute('list'));
      if (list) field.options = [...list.options].map(option => option.value || option.textContent.trim());
    }
    field.visible = visible(element);
    field.offscreen = offscreen(element);
    field.disabled = !!(element.disabled || element.readOnly);

    field.requiredField = field.required;
    field.docUrl = (doc.location?.href || '').split('#')[0];
    field.frameUrl = field.docUrl;
    // 页面语言：资料包带 i18n 时按它挑版本。
    field.docLang = String(doc.documentElement?.lang || doc.documentElement?.getAttribute?.('xml:lang') || '').toLowerCase().slice(0, 8);
    // 托管表单用自己的题目结构给出更准的标签和稳定标识。
    if (root.BKPlatform && options.platform !== false) {
      const platform = root.BKPlatform.labelFor(element, doc);
      field.platform = platform.platform;
      if (platform.label && platform.label.length >= 2) {
        field.platformLabel = platform.label;
        field.label = platform.label;
        field.labelParts.platform = platform.label;
      }
      if (platform.id) field.platformId = platform.id;
    }
    // 使用最终语义与完整名称判敏感；展示用截断和标签优先级不能隐藏自身ARIA。
    const semantic = {...field, name, className: T.camel(element.className?.toString?.() || ''),
      ownSemantics: [...SEMANTIC_ATTRS.map(attribute => element.getAttribute(attribute) || ''),
        ...SEMANTIC_REFS.flatMap(attribute => (element.getAttribute(attribute) || '').split(/[\t\n\f\r ]+/).filter(Boolean)
          .map(id => labelText(scope.getElementById?.(id), true)))].join(' ')};
    field.honeypot = field.visible ? (honeypotBy(element, field) || null) : (element.name || element.id ? (honeypotBy(element, field) || 'invisible') : 'invisible_nameless');
    field.captcha = CAPTCHA_WORDS.test(T.fieldSemanticText(semantic)) ? 'label' : captchaNear(element);
    field.sensitive = T.fieldSensitivity(semantic, rules) || (field.captcha ? 'captcha' : null);
    privacyRules.set(field, rules);
    return field;
  }

  function candidates(doc = document) {
    const found = [];
    for (const scope of roots(doc)) {
      let list = [];
      try {
        list = [...scope.querySelectorAll('input,textarea,select,[role="combobox"],[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]')];
      } catch { list = []; }
      for (const element of list) found.push(element);
    }
    return found.filter(element => {
      if (SKIP_TYPES.has(element.type) && element.getAttribute('role') !== 'combobox') return false;
      // 包装式 combobox 只保留内部输入框，按钮式 select 则保留按钮自身。
      if (element.getAttribute('role') === 'combobox' && element.querySelector('input,textarea,select')) return false;
      if (element.disabled && element.type !== 'file') return false;
      const tag = element.tagName;
      if (tag === 'INPUT' && element.type === 'search' && !element.name && !element.id && !ownLabel(element)) return false;
      return true;
    });
  }

  function scan(rules = {}, options = {}) {
    const entries = [];
    const seenRadio = new Set();
    const forms = new WeakMap();
    let formSeq = 0;
    candidates(options.doc || document).forEach((element, order) => {
      // 同一组 radio 只保留第一个入口；否则每个选项都会被当成一个待填字段。
      if (element.type === 'radio' && element.name) {
        const formId = element.form ? (forms.get(element.form) ?? (forms.set(element.form, ++formSeq), formSeq)) : 0;
        const group = formId + '|' + element.name;
        if (seenRadio.has(group)) return;
        // 让组里第一个可见的选项代表整组；隐藏的占位 radio 不抢入口。
        if (!visible(element)) return;
        seenRadio.add(group);
      }
      const field = describe(element, rules, {order});
      field.index = entries.length;
      entries.push({element, field});
    });
    return entries;
  }

  function read(element, field) {
    if (field.sensitive) return undefined;
    if (element.isConnected === false) return undefined;
    if (element.type === 'password') return undefined;
    // 动态页面可原位改字段类型或标签；旧描述不能授权读取敏感值。
    const current = describe(element, privacyRules.get(field) || {});
    if (current.sensitive || current.captcha || current.honeypot || current.inputType !== field.inputType) return undefined;
    if (field.inputType === 'file') return [...(element.files || [])].map(file => file.name).join(', ');
    if (field.inputType === 'radio') {
      const checked = radioGroup(element).find(other => other.checked);
      return checked ? (ownLabel(checked) || checked.value || 'on') : '';
    }
    if (field.inputType === 'checkbox') return element.checked ? (ownLabel(element) || field.label || 'on') : '';
    if (field.widget === 'tags') return [...(element.closest('[class*="tags"],[class*="chips"]')?.querySelectorAll('[class*="tag"],[class*="chip"],.token') || [])].map(textOf).filter(Boolean).join(', ');
    if (element.isContentEditable) return textOf(element);
    if (element.options && element.multiple) return [...element.selectedOptions].map(option => option.textContent.trim()).join(', ');
    if (field.widget === 'custom-select' && element.tagName !== 'INPUT') {
      return element.hasAttribute('data-placeholder') || element.getAttribute('aria-placeholder') === textOf(element) ? '' : textOf(element);
    }
    return element.value;
  }

  function events(element, kinds = ['input', 'change']) {
    const view = element.ownerDocument?.defaultView || globalThis;
    for (const kind of kinds) element.dispatchEvent(new view.Event(kind, {bubbles: true, composed: true}));
  }

  function setNative(element, property, value) {
    let proto = Object.getPrototypeOf(element), setter = null;
    while (proto && !setter) { setter = Object.getOwnPropertyDescriptor(proto, property)?.set; proto = Object.getPrototypeOf(proto); }
    if (setter) setter.call(element, value); else element[property] = value;
  }

  function setValue(element, value) {
    setNative(element, 'value', value);
    events(element, ['input', 'change']);
  }

  function setChecked(element, checked = true) {
    setNative(element, 'checked', checked);
    events(element, ['click', 'input', 'change']);
  }

  function setSelect(element, text) {
    const options = [...element.options].filter(option => !option.disabled);
    const match = options.filter(option => option.textContent.trim() === String(text).trim());
    if (match.length !== 1) return false;
    setNative(element, 'value', match[0].value);
    events(element, ['input', 'change']);
    return true;
  }

  function radioGroup(element) {
    const doc = element.ownerDocument || document;
    if (element.name) {
      const root = element.form || element.getRootNode?.() || doc;
      return [...root.querySelectorAll('input[type=radio]')]
        .filter(other => other.name === element.name && other.form === element.form);
    }
    return [...(element.parentElement?.querySelectorAll('input[type=radio]') || [])];
  }

  function setRadio(element, value) {
    const wanted = String(value ?? '').trim();
    if (!wanted) return false;
    const target = radioGroup(element).find(other => {
      const label = ownLabel(other) || other.value || '';
      return String(label).trim() === wanted;
    });
    if (!target) return false;
    setChecked(target, true);
    return !!target.checked;
  }

  function setMultiSelect(element, values) {
    const wanted = (Array.isArray(values) ? values : [values]).map(value => String(value).trim());
    let selected = 0;
    for (const option of element.options) {
      if (option.disabled) continue;
      const on = wanted.includes(option.textContent.trim());
      setNative(option, 'selected', on);
      if (on) selected++;
    }
    events(element, ['input', 'change']);
    return selected > 0;
  }

  async function setFile(element, file) {
    if (!file) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([file.bytes], file.name, {type: file.type}));
    setNative(element, 'files', transfer.files);
    events(element, ['input', 'change']);
    return element.files.length > 0;
  }

  // CDP 回退路径要一个页面内唯一的 CSS 选择器；先试 id/name，再拼路径并验证唯一。
  function selector(element) {
    const doc = element.ownerDocument || document;
    const escape = value => (globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));
    if (element.id) {
      const candidate = '#' + escape(element.id);
      try { if (doc.querySelectorAll(candidate).length === 1) return candidate; } catch { /* 非法 id */ }
    }
    if (element.name) {
      const candidate = `${element.tagName.toLowerCase()}[name="${element.name.replace(/"/g, '\\"')}"]`;
      try { if (doc.querySelectorAll(candidate).length === 1) return candidate; } catch { /* 非法 name */ }
    }
    const parts = [];
    let node = element, depth = 0;
    while (node && node.nodeType === 1 && node !== doc.documentElement && depth < 8) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = [...parent.children].filter(child => child.tagName === node.tagName);
      const segment = siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag;
      parts.unshift(segment);
      const candidate = parts.join('>');
      try { if (doc.querySelectorAll(candidate).length === 1) return candidate; } catch { /* 继续拼 */ }
      node = parent; depth++;
    }
    return parts.join('>');
  }

  function outline(element, color) {    if (!element.dataset) return;
    if (!element.__bkOutline && color) {
      element.__bkOutline = element.style.outline;
      element.__bkOutlinePriority = element.style.getPropertyPriority?.('outline') || '';
      element.style.setProperty('outline', color, 'important');
    } else if (!color && element.__bkOutline !== undefined) {
      element.style.setProperty('outline', element.__bkOutline || '', element.__bkOutlinePriority || '');
      delete element.__bkOutline;
    }
  }

  root.BKFields = {roots, closedRoot, scan, describe, read, setValue, setChecked, setSelect, setRadio, setMultiSelect,
    setFile, events, setNative, ownLabel, labelText, textOf, visible, offscreen, widgetOf, constraints, readHints,
    honeypotBy, captchaNear, outline, candidates, selector};
  if (typeof module !== 'undefined') module.exports = root.BKFields;
})(globalThis);
