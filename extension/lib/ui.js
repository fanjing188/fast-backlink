// 页内 UI：字段内按钮、候选弹层、字段标记、底部状态条。全部在封闭 Shadow 里。
// 设计令牌与 vendor/fbl/brand.css 一致（有单测校验），在任意页面上都保持同一套视觉。
(function (root) {
  const TOKENS = {
    '--brand': '#315fc7', '--on-brand': '#ffffff', '--brand-soft': '#e9effb',
    '--bg': '#f4f6f9', '--paper': '#ffffff', '--ink': '#1d2430', '--ink-2': '#4d5868', '--ink-3': '#616b7a',
    '--line': '#dfe4ec', '--line-2': '#eef1f5', '--hover': '#f1f4f8',
    '--ok': '#1f7a4d', '--ok-bg': '#e5f4ec', '--warn': '#8a5d08', '--warn-bg': '#fbf1dc',
    '--bad': '#b4342f', '--bad-bg': '#fbe7e6', '--idle': '#6b7585', '--idle-bg': '#eef1f5',
    '--r': '10px', '--rc': '7px',
  };
  const tokenCss = Object.entries(TOKENS).map(([key, value]) => `${key}:${value}`).join(';');
  const FONT = '-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI","Microsoft YaHei",sans-serif';
  const MONO = '"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace';

  const STYLE = `:host{all:initial;${tokenCss}}
  *{box-sizing:border-box;font-family:${FONT}}
  .layer{position:fixed;inset:0;pointer-events:none;z-index:2147483646;font-size:14px;line-height:1.55;color:var(--ink)}
  .mono{font-family:${MONO};font-variant-numeric:tabular-nums}
  .badge{position:absolute;pointer-events:none;width:18px;height:18px;border-radius:50%;background:var(--paper);
    border:1px solid var(--line);box-shadow:0 1px 3px rgba(16,24,40,.18);display:flex;align-items:center;justify-content:center;color:var(--ink-3)}
  .badge svg{width:12px;height:12px;display:block}
  .badge.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,var(--line))}
  .badge.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}
  .badge.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,var(--line))}
  .badge.idle{color:var(--idle);border-style:dashed}
  .fab{position:absolute;width:22px;height:22px;border-radius:7px;background:var(--paper);border:1px solid var(--line);
    box-shadow:0 2px 8px rgba(16,24,40,.2);cursor:pointer;pointer-events:auto;display:flex;align-items:center;justify-content:center;color:var(--brand);padding:0}
  .fab:hover{background:var(--brand-soft);border-color:var(--brand)}
  .fab:focus-visible{outline:2px solid var(--brand);outline-offset:1px}
  .fab svg{width:13px;height:13px;fill:currentColor;stroke:none}
  .pop{position:absolute;pointer-events:auto;width:min(348px,calc(100vw - 16px));max-height:min(60vh,480px);display:flex;flex-direction:column;
    background:var(--paper);border:1px solid var(--line);border-radius:var(--r);box-shadow:0 12px 40px rgba(16,24,40,.22);
    overflow:hidden;color:var(--ink)}
  .pop header{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--line-2)}
  .pop header .t{flex:1;min-width:0}
  .pop header b{display:block;font-size:14px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pop header small{display:block;color:var(--ink-3);font-size:12px}
  .pop .close{border:0;background:none;color:var(--ink-3);cursor:pointer;padding:6px;border-radius:7px;display:flex;align-items:center;justify-content:center;min-width:32px;min-height:32px}
  .pop .close:hover{background:var(--hover);color:var(--ink)}
  .pop .tools{display:flex;gap:6px;padding:8px 11px 0}
  .pop .search{flex:1;position:relative}
  .pop .search svg{position:absolute;left:8px;top:50%;transform:translateY(-50%);width:13px;height:13px;color:var(--ink-3);fill:none;stroke:currentColor;stroke-width:1.6}
  .pop input[type=search]{width:100%;min-height:36px;border:1px solid var(--line);border-radius:var(--rc);padding:7px 8px 7px 27px;font-size:14px;background:var(--paper);color:var(--ink)}
  .pop input[type=search]:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
  .pop .seg{display:flex;gap:2px;padding:8px 11px;flex-wrap:wrap;border-bottom:1px solid var(--line-2)}
  .pop .seg button{border:1px solid transparent;background:none;border-radius:7px;min-height:32px;padding:4px 8px;font-size:13px;color:var(--ink-2);cursor:pointer}
  .pop .seg button:hover{background:var(--hover)}
  .pop .seg button[aria-pressed=true]{background:var(--brand-soft);color:var(--brand);font-weight:600}
  .pop .items{overflow:auto;padding:6px}
  .pop .item{display:flex;gap:9px;align-items:flex-start;padding:7px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent}
  .pop .item:hover,.pop .item.cur{background:var(--brand-soft);border-color:color-mix(in srgb,var(--brand) 22%,var(--brand-soft))}
  .pop .item img{width:36px;height:36px;object-fit:contain;background:var(--line-2);border-radius:6px;flex:none}
  .pop .item .ico.thumb{width:36px;height:36px;padding:8px;background:var(--line-2);border-radius:6px;color:var(--ink-3);flex:none}
  .pop .item .b{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
  .pop .item .k{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:650;color:var(--brand)}
  .pop .item .conf{font-family:${MONO};font-size:10px;color:var(--ink-3);font-weight:500}
  .pop .item .v{font-size:14px;color:var(--ink);word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .pop .item .m{font-size:12px;color:var(--ink-3);font-family:${MONO}}
  .pop .item .m.over{color:var(--bad);font-weight:600}
  .pop .empty{padding:22px 12px;text-align:center;color:var(--ink-3);font-size:12px}
  .pop footer{display:flex;gap:10px;align-items:center;padding:6px 11px;border-top:1px solid var(--line-2);color:var(--ink-3);font-size:10px}
  .pop footer kbd{border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 4px;font-family:${MONO};font-size:10px;background:var(--paper)}
  .bar{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;pointer-events:auto;display:flex;align-items:center;gap:8px;
    background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:8px;
    box-shadow:0 8px 28px rgba(6,10,18,.24);z-index:2147483647;font-size:13px;white-space:nowrap;max-width:calc(100vw - 16px)}
  .bar .mark{width:16px;height:16px;border-radius:5px;flex:none;background:var(--brand);display:flex;align-items:center;justify-content:center}
  .bar .sum{display:flex;align-items:center;gap:7px;padding-inline-end:4px}
  .bar .sum b{font-weight:650}
  .bar .sum .sep{width:1px;height:12px;background:var(--line)}
  .bar .chip{display:inline-flex;align-items:center;gap:4px;color:var(--ink-2);font-size:12px}
  .bar .chip .dot{width:6px;height:6px;border-radius:50%;background:#94a3b8}
  .bar .chip.ok .dot{background:#34d399}
  .bar .chip.warn .dot{background:#fbbf24}
  .bar .chip.bad .dot{background:#f87171}
  .bar button{border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);padding:6px 10px;font-size:13px;cursor:pointer;
    display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:32px}
  .bar button:hover{background:var(--hover)}
  .bar button.primary{background:var(--brand);border-color:var(--brand);color:var(--on-brand)}
  .bar button.primary:hover{filter:brightness(1.06)}
  .pop button:focus-visible,.bar button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
  .bar button svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
  .bar button.icon-only{padding:4px 7px}
  .bar .collapse{padding:4px 8px}
  .bar.mini .sum .sep,.bar.mini .sum .chip,.bar.mini button:not(.collapse){display:none}
  .toast{position:fixed;left:50%;transform:translateX(-50%);bottom:64px;display:flex;align-items:center;gap:8px;
    background:var(--ink);color:var(--paper);border:1px solid var(--line);padding:8px 13px;border-radius:10px;
    box-shadow:0 10px 30px rgba(6,10,18,.4);z-index:2147483647;font-size:12px;max-width:76vw}
  .toast svg{width:14px;height:14px;flex:none}
  .toast.ok svg{color:#34d399}.toast.warn svg{color:#fbbf24}.toast.err svg{color:#f87171}
  @media (max-width:640px){
    .bar{width:calc(100vw - 16px);display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px}
    .bar>.mark{display:none}
    .bar>.sum{grid-column:1/-1;flex-wrap:wrap;white-space:normal;min-width:0}
    .bar button{padding:4px;min-width:0;font-size:12px}
    .bar.mini{display:flex;width:auto}
  }
  @media (prefers-color-scheme:dark){:host{
    --brand:#99b6ff;--on-brand:#142347;--brand-soft:#243150;
    --bg:#12161d;--paper:#1b2029;--ink:#e8ecf3;--ink-2:#b0b9c8;--ink-3:#96a1b1;
    --line:#2e3644;--line-2:#252c38;--hover:#232a35;
    --ok:#7dcea1;--ok-bg:#183326;--warn:#e4c171;--warn-bg:#352a12;--bad:#ffa3a0;--bad-bg:#3a1d1d;
    --idle:#9aa4b4;--idle-bg:#262d39;color-scheme:dark;
  }}
  @media (prefers-reduced-motion:no-preference){
    .pop{animation:pop-in 140ms cubic-bezier(.2,.7,.3,1)}
    .toast{animation:toast-in 160ms cubic-bezier(.2,.7,.3,1)}
    .bar .sum b{transition:color 200ms}
  }
  @keyframes pop-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  @keyframes toast-in{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}`;

  const COLORS = {green: '#1f7a4d', yellow: '#94650a', red: '#b4342f', purple: '#7b4fd0', gray: '#7c8696'};
  const BADGE_TONE = {ok: 'ok', warn: 'warn', bad: 'bad', idle: 'idle', filled: 'ok', pending: 'warn',
    confirm: 'warn', failed: 'bad', unmatched: 'idle', sensitive: 'warn', captcha: 'warn'};

  function createLayer() {
    document.getElementById('fast-backlink-layer')?.remove();
    const host = document.createElement('div');
    host.id = 'fast-backlink-layer';
    host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0';
    const shadow = host.attachShadow({mode: 'closed'});
    shadow.innerHTML = `<style>${STYLE}</style><div class="layer"></div>`;
    const layer = shadow.querySelector('.layer');
    (document.body || document.documentElement).append(host);
    return {host, shadow, layer};
  }

  function toast(layer, message, tone = 'ok', ms = 2400) {
    layer.querySelector('.toast')?.remove();
    const node = document.createElement('div');
    node.className = `toast ${tone}`;
    const glyph = BKIcon?.svg(tone === 'err' ? 'alert' : tone === 'warn' ? 'info' : 'check');
    if (glyph) node.append(glyph);
    node.append(document.createTextNode(message));
    layer.append(node);
    setTimeout(() => node.remove(), ms);
  }

  // 标记：元素本身用 outline，状态图形放在我们自己的层里，不动页面结构。
  function createMarks(layer) {
    const badges = new Map();
    let raf = null;
    function place() {
      raf = null;
      for (const [element, badge] of badges) {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) {badge.style.display = 'none'; continue;}
        badge.style.display = '';
        badge.style.left = (rect.right - 9) + 'px';
        badge.style.top = (rect.top - 9) + 'px';
      }
    }
    function schedule() {if (!raf) raf = requestAnimationFrame(place);}
    window.addEventListener('scroll', schedule, {passive: true, capture: true});
    window.addEventListener('resize', schedule, {passive: true});

    function set(element, kind, options = {}) {
      const color = COLORS[{ok: 'green', green: 'green', warn: 'yellow', yellow: 'yellow', bad: 'red', red: 'red',
        filled: 'green', pending: 'yellow', confirm: 'yellow', failed: 'red', unmatched: 'gray', sensitive: 'purple',
        captcha: 'purple', purple: 'purple', idle: 'gray', gray: 'gray'}[kind] || kind];
      root.BKFields.outline(element, color ? `2px solid ${color}` : null);
      if (!kind) {
        badges.get(element)?.remove();
        badges.delete(element);
        return;
      }
      let badge = badges.get(element);
      if (!badge) {
        badge = document.createElement('span');
        layer.append(badge);
        badges.set(element, badge);
      }
      badge.className = `badge ${BADGE_TONE[kind] || {captcha: 'warn', green: 'ok', yellow: 'warn', red: 'bad', purple: 'warn', gray: 'idle'}[kind] || 'idle'}`;
      badge.replaceChildren();
      const statusKey = {green: 'filled', ok: 'filled', yellow: 'pending', warn: 'pending', red: 'failed', bad: 'failed',
        purple: 'captcha', captcha: 'captcha', gray: 'unmatched', idle: 'unmatched'}[kind] || kind;
      const glyph = BKIcon?.status(statusKey, {label: false});
      if (glyph) {
        glyph.style.cssText = 'width:12px;height:12px;display:block';
        badge.append(glyph);
      }
      if (options.title) badge.title = options.title;
      schedule();
    }
    function clear() {
      for (const [element] of badges) root.BKFields.outline(element, null);
      badges.forEach(badge => badge.remove());
      badges.clear();
    }
    return {set, clear, refresh: schedule, size: () => badges.size};
  }

  const CATEGORY = {
    text: ['name', 'tagline', 'short_description', 'description', 'features', 'use_cases', 'audience', 'pricing_text', 'maker_story', 'launch_comment', 'pitch', 'press_boilerplate', 'faq', 'changelog_latest', 'message', 'subject'],
    link: ['url', 'github_url', 'demo_url', 'video_url', 'pricing_url', 'docs_url', 'blog_url', 'changelog_url', 'privacy_url', 'terms_url', 'rss_url', 'sitemap_url', 'website_personal'],
    image: ['logo', 'icon', 'favicon', 'cover', 'screenshot', 'maker_avatar'],
    video: ['demo_video', 'demo_gif'],
    qa: ['how_did_you_hear', 'owner', 'team_size', 'funding', 'launch_status', 'is_free', 'category', 'tags', 'pricing_model'],
    identity: ['email', 'full_name', 'first_name', 'last_name', 'role', 'company', 'country', 'city', 'phone', 'twitter', 'linkedin', 'facebook', 'instagram', 'youtube', 'discord', 'producthunt', 'indiehackers', 'signature'],
  };

  /**
   * 候选弹层：推荐 3 项 + 搜索 + 分类页签，支持 ↑↓/Enter/Esc。
   * items: [{key, display, conf, length, limit, over, asset, value}]
   */
  function showPopover(options) {
    const {layer, anchor, items, onPick, title = '填入这个字段', subtitle = ''} = options;
    layer.querySelector('.pop')?.remove();
    const pop = document.createElement('div');
    pop.className = 'pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', title);
    const header = document.createElement('header');
    const titleBox = document.createElement('div');
    titleBox.className = 't';
    const strong = document.createElement('b');
    strong.textContent = title;
    titleBox.append(strong);
    if (subtitle) {const small = document.createElement('small'); small.textContent = subtitle; titleBox.append(small);}
    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.append(BKIcon?.svg('x') || document.createTextNode('×'));
    header.append(titleBox, close);
    pop.append(header);

    const tools = document.createElement('div');
    tools.className = 'tools';
    const searchBox = document.createElement('div');
    searchBox.className = 'search';
    searchBox.append(BKIcon?.svg('search') || document.createTextNode(''));
    const box = document.createElement('input');
    box.type = 'search';
    box.placeholder = '搜索素材…';
    box.setAttribute('aria-label', '搜索素材');
    searchBox.append(box);
    tools.append(searchBox);
    pop.append(tools);

    const tabs = document.createElement('div');
    tabs.className = 'seg';
    const list = document.createElement('div');
    list.className = 'items';
    list.setAttribute('role', 'listbox');
    const footer = document.createElement('footer');
    const hint = document.createElement('span');
    hint.innerHTML = '<kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 填入 · <kbd>Esc</kbd> 关闭';
    footer.append(hint);
    pop.append(tabs, list, footer);

    let active = 'all';
    let rows = [];
    let cursor = 0;

    function draw(filter = '') {
      list.replaceChildren();
      const needle = filter.trim().toLowerCase();
      const allowed = active === 'all' ? null : (CATEGORY[active] || []);
      rows = items.filter(item => (!allowed || allowed.includes(item.key)) &&
        (!needle || String(item.key).includes(needle) || String(item.display ?? '').toLowerCase().includes(needle)));
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '没有能直接用的素材；可在侧边栏选或人工填。';
        list.append(empty);
        return;
      }
      cursor = Math.min(cursor, Math.max(0, Math.min(rows.length, 40) - 1));
      rows.slice(0, 40).forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'item' + (index === cursor ? ' cur' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(index === cursor));
        row.tabIndex = -1;
        if (item.asset) {
          const image = document.createElement('img');
          image.alt = item.display || item.key;
          if (item.asset.url) image.src = item.asset.url;
          row.append(image);
        } else {
          const glyph = BKIcon?.svg('key');
          if (glyph) {glyph.classList.add('thumb'); row.append(glyph);}
        }
        const body = document.createElement('div');
        body.className = 'b';
        const key = document.createElement('div');
        key.className = 'k';
        key.append(document.createTextNode(item.key));
        if (item.conf) {
          const conf = document.createElement('span');
          conf.className = 'conf';
          conf.textContent = `${Math.round(item.conf * 100)}%`;
          key.append(conf);
        }
        const value = document.createElement('div');
        value.className = 'v';
        value.textContent = String(item.display ?? item.value ?? '').slice(0, 300) || '(空)';
        const meta = document.createElement('div');
        meta.className = 'm' + (item.over ? ' over' : '');
        meta.textContent = `${item.length ?? String(item.display ?? '').length} 字符${item.limit >= 0 ? ` / 限 ${item.limit}` : ''}${item.over ? ' · 超长' : ''}`;
        body.append(key, value, meta);
        row.append(body);
        row.onmouseenter = () => {cursor = index; mark();};
        row.onclick = () => {onPick(item); pop.remove();};
        list.append(row);
      });
      mark();
    }
    function mark() {
      [...list.children].forEach((node, index) => node.classList.toggle('cur', index === cursor));
      list.children[cursor]?.scrollIntoView({block: 'nearest'});
    }

    for (const [name, label] of [['all', '推荐'], ['text', '文本'], ['link', '链接'], ['image', '图片'], ['video', '视频'], ['qa', '问答'], ['identity', '身份']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-pressed', String(active === name));
      button.onclick = () => {
        active = name;
        cursor = 0;
        [...tabs.children].forEach(node => node.setAttribute('aria-pressed', String(node === button)));
        draw(box.value);
      };
      tabs.append(button);
    }
    box.addEventListener('input', () => {cursor = 0; draw(box.value);});
    close.onclick = () => pop.remove();
    pop.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {event.preventDefault(); cursor = Math.min(cursor + 1, Math.min(rows.length, 40) - 1); mark();}
      else if (event.key === 'ArrowUp') {event.preventDefault(); cursor = Math.max(cursor - 1, 0); mark();}
      else if (event.key === 'Enter') {event.preventDefault(); if (rows[cursor]) {onPick(rows[cursor]); pop.remove();}}
      else if (event.key === 'Escape') {event.preventDefault(); pop.remove();}
    });
    draw();

    layer.append(pop);
    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left)) + 'px';
    const below = rect.bottom + 6;
    const height = pop.offsetHeight;
    pop.style.top = (below + height < window.innerHeight ? below : Math.max(8, rect.top - height - 6)) + 'px';
    box.focus();
    const outside = event => {
      // 封闭 Shadow 外看到的是宿主，不能把内部操作误判为外部点击。
      if (!pop.contains(event.target) && event.target !== layer.getRootNode().host) {
        pop.remove(); document.removeEventListener('pointerdown', outside, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    return pop;
  }

  function fieldButton(layer, element, onClick) {
    layer.querySelector('.fab')?.remove();
    const button = document.createElement('button');
    button.className = 'fab';
    button.type = 'button';
    button.title = 'Fast-Backlink：挑素材填入（Alt+F）';
    button.setAttribute('aria-label', '挑素材填入');
    button.append(BKIcon?.svg('bolt') || document.createTextNode('⚡'));
    button.onclick = event => {event.preventDefault(); event.stopPropagation(); onClick();};
    layer.append(button);
    const place = () => {
      const rect = element.getBoundingClientRect();
      if (!rect.width) {button.style.display = 'none'; return;}
      button.style.display = '';
      button.style.left = (rect.right - 26) + 'px';
      button.style.top = (rect.top + 3) + 'px';
    };
    place();
    const stop = () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('focusin', onFocus, true);
      button.remove();
    };
    const onFocus = event => {if (event.target !== element) stop();};
    window.addEventListener('scroll', place, {passive: true, capture: true});
    window.addEventListener('resize', place, {passive: true});
    document.addEventListener('focusin', onFocus, true);
    return {element, stop, place};
  }

  function statusBar(options) {
    const host = document.createElement('div');
    host.id = 'fast-backlink-bar';
    host.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;z-index:2147483647';
    const shadow = host.attachShadow({mode: 'closed'});
    shadow.innerHTML = `<style>${STYLE}</style><div class="bar" role="status" aria-live="polite">
      <span class="mark" aria-hidden="true"></span>
      <span class="sum"><b class="text">准备就绪</b></span>
      <button data-act="fill" class="primary" title="填整页（Alt+Shift+F）"></button>
      <button data-act="ai" title="AI 智能填充（Alt+A）"></button>
      <button data-act="restore" title="复原最近快照（Alt+R）"></button>
      <button data-act="panel" title="打开侧边栏"></button>
      <button data-act="collapse" class="collapse" aria-label="收起">收起</button>
    </div>`;
    (document.body || document.documentElement).append(host);
    const bar = shadow.querySelector('.bar');
    const label = shadow.querySelector('.text');
    const fillButton = bar.querySelector('[data-act=fill]');
    const aiButton = bar.querySelector('[data-act=ai]');
    const restoreButton = bar.querySelector('[data-act=restore]');
    const panelButton = bar.querySelector('[data-act=panel]');
    // 品牌标用内联链环图标，不依赖 web_accessible_resources。
    bar.querySelector('.mark').append(BKIcon?.svg('link') || document.createTextNode(''));
    bar.querySelector('.mark svg')?.setAttribute('style', 'width:11px;height:11px;fill:none;stroke:#fff;stroke-width:1.8');
    fillButton.append(BKIcon?.svg('bolt') || document.createTextNode('⚡'), document.createTextNode('填写'));
    aiButton.append(BKIcon?.svg('wand') || document.createTextNode('✦'), document.createTextNode('AI'));
    restoreButton.append(BKIcon?.svg('refresh') || document.createTextNode('↺'), document.createTextNode('复原'));
    panelButton.append(BKIcon?.svg('sliders') || document.createTextNode('▤'), document.createTextNode('面板'));
    bar.addEventListener('click', event => {
      const action = event.target.closest('button')?.dataset?.act ||
        event.target.closest('[data-chip-action]')?.dataset.chipAction;
      if (!action) return;
      if (action === 'collapse') {
        const mini = bar.classList.toggle('mini');
        event.target.textContent = mini ? '展开' : '收起';
        event.target.setAttribute('aria-label', mini ? '展开' : '收起');
        return;
      }
      options.onAction?.(action);
    });
    bar.addEventListener('pointerdown', event => {
      if (event.target.closest('button')) return;
      const rect = bar.getBoundingClientRect(), dx = event.clientX - rect.left, dy = event.clientY - rect.top;
      bar.setPointerCapture(event.pointerId);
      const move = e => {
        bar.style.transform = 'none';
        bar.style.left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, e.clientX - dx)) + 'px';
        bar.style.top = Math.max(4, e.clientY - dy) + 'px';
        bar.style.bottom = 'auto';
      };
      const up = () => bar.removeEventListener('pointermove', move);
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up, {once: true});
    });
    return {
      set(state) {
        label.textContent = state.text || '';
        const chips = Array.isArray(state.chips) ? state.chips : [];
        bar.querySelector('.chips')?.remove();
        if (chips.length) {
          const box = document.createElement('span');
          box.className = 'chips';
          box.style.cssText = 'display:inline-flex;align-items:center;gap:7px';
          for (const chip of chips) {
            const node = document.createElement(chip.action ? 'button' : 'span');
            node.className = `chip ${chip.tone || ''}`;
            if (chip.action) {
              node.type = 'button';
              node.dataset.chipAction = chip.action;
              node.style.cssText = 'background:transparent;border:0;padding:0;color:inherit;font:inherit;cursor:pointer';
            }
            const dot = document.createElement('span');
            dot.className = 'dot';
            node.append(dot, document.createTextNode(chip.label));
            box.append(node);
          }
          label.after(box);
        }
      },
      remove: () => host.remove(),
      host,
    };
  }

  // 供端到端验收读取：状态写进页面 dataset（内容脚本与页面共享 DOM，Playwright 能读到）。
  function publish(state) {
    try {document.documentElement.dataset.bkStatus = JSON.stringify(state);} catch { /* 页面清掉也无所谓 */ }
  }

  root.BKUI = {createLayer, createMarks, showPopover, fieldButton, statusBar, toast, publish, COLORS, CATEGORY, TOKENS, STYLE};
  if (typeof module !== 'undefined') module.exports = root.BKUI;
})(globalThis);
