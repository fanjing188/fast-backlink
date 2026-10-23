// 图标：与 Fast-browser-link 同一套 16px 线性图标（stroke 1.6），另外补几个填表专用图形。
// 只创建 SVG 节点，不拼 HTML 字符串；扩展页与封闭 Shadow 层都能用。
(function (root) {
  const ICONS = {
    // —— 与 FBL ui-design.mjs 一致的部分 ——
    gear: [['circle', {cx: '8', cy: '8', r: '2.2'}],
      ['path', {d: 'M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6'}]],
    check: [['path', {d: 'm3.5 8.3 3 3 6-6.6'}]],
    x: [['path', {d: 'm4.5 4.5 7 7M11.5 4.5l-7 7'}]],
    lock: [['rect', {x: '3.5', y: '7', width: '9', height: '6.5', rx: '1.5'}],
      ['path', {d: 'M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7'}]],
    stop: [['rect', {x: '4.5', y: '4.5', width: '7', height: '7', rx: '1.2'}]],
    chev: [['path', {d: 'm6 4 4 4-4 4'}]],
    down: [['path', {d: 'm4 6 4 4 4-4'}]],
    back: [['path', {d: 'm10 4-4 4 4 4'}]],
    log: [['path', {d: 'M3 4h10M3 8h10M3 12h6'}]],
    search: [['circle', {cx: '7', cy: '7', r: '4'}], ['path', {d: 'm10 10 3 3'}]],
    globe: [['circle', {cx: '8', cy: '8', r: '5.5'}],
      ['path', {d: 'M2.5 8h11M8 2.5c1.8 1.6 2.6 3.5 2.6 5.5S9.8 11.9 8 13.5c-1.8-1.6-2.6-3.5-2.6-5.5S6.2 4.1 8 2.5'}]],
    table: [['rect', {x: '2.5', y: '3', width: '11', height: '10', rx: '1.5'}], ['path', {d: 'M2.5 6.5h11M6.5 6.5V13'}]],
    copy: [['rect', {x: '5.5', y: '5.5', width: '7.5', height: '7.5', rx: '1.3'}],
      ['path', {d: 'M10.5 5.5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5'}]],
    ext: [['path', {d: 'M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5'}]],
    refresh: [['path', {d: 'M12.8 6.5A5 5 0 0 0 3.6 5.4M3.2 9.5a5 5 0 0 0 9.2 1.1'}],
      ['path', {d: 'M3.3 2.8v2.8h2.8M12.7 13.2v-2.8H9.9'}]],
    play: [['path', {d: 'M5.5 3.8v8.4L12 8z'}]],
    trend: [['path', {d: 'm2.5 11.5 3.5-3.5 2.5 2.5 5-5.5'}], ['path', {d: 'M10 5h3.5v3.5'}]],
    // —— 填表专用 ——
    bolt: [['path', {d: 'M8.6 2 4.2 9.1h3.2L7 14l4.6-7.4H8.4z'}]],
    form: [['rect', {x: '2.8', y: '2.5', width: '10.4', height: '11', rx: '1.6'}],
      ['path', {d: 'M5.2 6h5.6M5.2 9h5.6M5.2 12h3.2'}]],
    image: [['rect', {x: '2.5', y: '3', width: '11', height: '10', rx: '1.6'}],
      ['circle', {cx: '6', cy: '6.4', r: '1.1'}], ['path', {d: 'm3.2 11.4 3-3 2.2 2.2 1.8-1.8 2.6 2.6'}]],
    video: [['rect', {x: '2.5', y: '4', width: '8', height: '8', rx: '1.6'}], ['path', {d: 'm10.5 7 3-1.8v5.6l-3-1.8z'}]],
    clock: [['circle', {cx: '8', cy: '8', r: '5.6'}], ['path', {d: 'M8 4.8V8l2.2 1.6'}]],
    list: [['path', {d: 'M5.5 4.5h8M5.5 8h8M5.5 11.5h8'}], ['circle', {cx: '3', cy: '4.5', r: '.9'}],
      ['circle', {cx: '3', cy: '8', r: '.9'}], ['circle', {cx: '3', cy: '11.5', r: '.9'}]],
    sliders: [['path', {d: 'M3 4.5h10M3 8h10M3 11.5h10'}], ['circle', {cx: '6', cy: '4.5', r: '1.4'}],
      ['circle', {cx: '10', cy: '8', r: '1.4'}], ['circle', {cx: '5', cy: '11.5', r: '1.4'}]],
    wand: [['path', {d: 'm2.8 13.2 8-8'}],
      ['path', {d: 'M10.4 2.2v2.2M9.3 3.3h2.2M13 5.4v2M12 6.4h2M12.6 10.6v2M11.6 11.6h2'}]],
    eye: [['path', {d: 'M1.8 8S4.2 4.2 8 4.2 14.2 8 14.2 8 11.8 11.8 8 11.8 1.8 8 1.8 8z'}],
      ['circle', {cx: '8', cy: '8', r: '1.9'}]],
    upload: [['path', {d: 'M8 10.8V3.4M5.2 6.2 8 3.4l2.8 2.8'}], ['path', {d: 'M2.8 11.4v1.2a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-1.2'}]],
    download: [['path', {d: 'M8 3.2v7.4M5.2 7.8 8 10.6l2.8-2.8'}], ['path', {d: 'M2.8 11.4v1.2a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-1.2'}]],
    key: [['circle', {cx: '5.6', cy: '8', r: '2.6'}], ['path', {d: 'M8.2 8H14M12 8v2.2M10 8v1.6'}]],
    link: [['path', {d: 'M6.4 9.6a3 3 0 0 0 4.2 0l1.8-1.8a3 3 0 0 0-4.2-4.2l-1 1'}],
      ['path', {d: 'M9.6 6.4a3 3 0 0 0-4.2 0L3.6 8.2a3 3 0 0 0 4.2 4.2l1-1'}]],
    alert: [['path', {d: 'M8 2.4 14 13H2z'}], ['path', {d: 'M8 6.4v3.2'}], ['circle', {cx: '8', cy: '11.2', r: '.7'}]],
    info: [['circle', {cx: '8', cy: '8', r: '5.6'}], ['path', {d: 'M8 7.2v3.4'}], ['circle', {cx: '8', cy: '5.2', r: '.7'}]],
    plus: [['path', {d: 'M8 3.6v8.8M3.6 8h8.8'}]],
    trash: [['path', {d: 'M3.2 4.6h9.6M6 4.6V3.2h4v1.4M4.4 4.6l.6 8.2h6l.6-8.2'}]],
    external: [['path', {d: 'M9.5 2.8h3.7v3.7M13.2 2.8 8 8'}],
      ['path', {d: 'M11.6 9.4v3a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2V5.6a1.2 1.2 0 0 1 1.2-1.2h3'}]],
  };

  const NS = 'http://www.w3.org/2000/svg';

  function node(name, attrs = {}) {
    const element = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    return element;
  }

  function svg(name, options = {}) {
    const shape = ICONS[name];
    if (!shape) return null;
    const element = node('svg', {viewBox: '0 0 16 16', class: options.class || 'ico', 'aria-hidden': options.label ? 'false' : 'true',
      role: options.label ? 'img' : 'presentation', focusable: 'false', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'});
    if (options.label) {
      const title = node('title');
      title.textContent = options.label;
      element.append(title);
    }
    for (const [tag, attrs] of shape) element.append(node(tag, attrs));
    return element;
  }

  // 状态图形：只靠颜色不够，形状也要能区分（与 FBL 的状态语义一致）。
  const STATUS = {
    filled: {tone: 'ok', shape: 'check', zh: '已填'},
    pending: {tone: 'warn', shape: 'dot', zh: '待确认'},
    confirm: {tone: 'warn', shape: 'dot', zh: '待确认'},
    unmatched: {tone: 'idle', shape: 'plus', zh: '未匹配'},
    captcha: {tone: 'special', shape: 'shield', zh: '验证码'},
    sensitive: {tone: 'special', shape: 'lock', zh: '敏感'},
    honeypot: {tone: 'idle', shape: 'ghost', zh: '蜜罐'},
    skipped: {tone: 'idle', shape: 'minus', zh: '跳过'},
    failed: {tone: 'bad', shape: 'alert', zh: '失败'},
  };

  function status(name, options = {}) {
    const spec = STATUS[name] || STATUS.unmatched;
    const element = document.createElement('span');
    element.setAttribute('class', `st ${spec.tone}`);
    element.setAttribute('title', options.title || spec.zh);
    const glyph = node('svg', {viewBox: '0 0 12 12', class: 'g', 'aria-hidden': 'true', focusable: 'false'});
    const paint = {fill: 'currentColor', stroke: 'none'};
    const line = {fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'};
    if (spec.shape === 'check') {
      element.append(glyph);
      glyph.append(node('circle', {cx: '6', cy: '6', r: '5.4', ...paint}));
      glyph.append(node('path', {d: 'm3.5 6.2 1.7 1.7 3.3-3.7', stroke: 'var(--paper)', 'stroke-width': '1.5', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'}));
    } else if (spec.shape === 'dot') {
      glyph.append(node('circle', {cx: '6', cy: '6', r: '5', ...paint}), node('circle', {cx: '6', cy: '6', r: '2.2', fill: 'var(--paper)'}));
      element.append(glyph);
    } else if (spec.shape === 'shield') {
      glyph.append(node('path', {d: 'M6 .9 10.6 2.6v3.2c0 2.6-1.9 4.6-4.6 5.3-2.7-.7-4.6-2.7-4.6-5.3V2.6z', ...paint}));
      glyph.append(node('path', {d: 'M4.2 6.1h3.6M4.2 7.9h2.4', stroke: 'var(--paper)', 'stroke-width': '1.1', 'stroke-linecap': 'round'}));
      element.append(glyph);
    } else if (spec.shape === 'lock') {
      glyph.append(node('rect', {x: '2.4', y: '5.2', width: '7.2', height: '5.6', rx: '1.4', ...paint}));
      glyph.append(node('path', {d: 'M4.2 5.2V3.9a1.8 1.8 0 0 1 3.6 0v1.3', stroke: 'var(--paper)', 'stroke-width': '1.4', fill: 'none'}));
      element.append(glyph);
    } else if (spec.shape === 'plus') {
      glyph.append(node('circle', {cx: '6', cy: '6', r: '4.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-dasharray': '2 1.6'}));
      glyph.append(node('path', {d: 'M6 4.2v3.6M4.2 6h3.6', ...line}));
      element.append(glyph);
    } else if (spec.shape === 'minus') {
      glyph.append(node('circle', {cx: '6', cy: '6', r: '4.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-dasharray': '2 1.6'}));
      glyph.append(node('path', {d: 'M4.2 6h3.6', ...line}));
      element.append(glyph);
    } else if (spec.shape === 'alert') {
      glyph.append(node('path', {d: 'M6 1 11.4 10.6H.6z', ...paint}));
      glyph.append(node('path', {d: 'M6 4.4v2.6', stroke: 'var(--paper)', 'stroke-width': '1.5', 'stroke-linecap': 'round'}));
      element.append(glyph);
    } else if (spec.shape === 'ghost') {
      glyph.append(node('circle', {cx: '6', cy: '6', r: '4.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2'}));
      glyph.append(node('path', {d: 'M4.4 6.2c.5-.7 1-.7 1.6 0 .6.7 1.1.7 1.6 0', ...line}));
      element.append(glyph);
    }
    if (options.label !== false) element.append(document.createTextNode(options.label || spec.zh));
    return element;
  }

  // 把 <span data-icon> 换成图标；按钮上的 data-icon 只插入图形、保留按钮本身（id/事件都还在）。
  function hydrate(scope = document) {
    for (const element of scope.querySelectorAll('[data-icon]')) {
      const glyph = svg(element.dataset.icon);
      if (!glyph) continue;
      if (element.tagName === 'SPAN') element.replaceWith(glyph);
      else {element.prepend(glyph); element.removeAttribute('data-icon');}
    }
  }

  root.BKIcon = {icons: ICONS, svg, node, status, STATUS, hydrate};
  if (typeof module !== 'undefined') module.exports = root.BKIcon;
})(globalThis);
