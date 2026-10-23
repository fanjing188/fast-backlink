// 素材库管理：项目资料包 v2 的分组编辑、媒体上传与校验、问答库与身份档案、导入导出。
const $ = selector => document.querySelector(selector);
const send = async (type, data = {}) => {
  const response = await chrome.runtime.sendMessage({type, ...data});
  if (response?.error) throw Error(response.error);
  return response?.value;
};
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
  return node;
};
const text = value => document.createTextNode(String(value ?? ''));
const icon = name => BKIcon.svg(name);

const VARIANT_LIMITS = [40, 60, 80, 100, 160, 250, 500, 1000, 2000];
const REQUIRED = new Set(['name', 'url', 'tagline', 'description', 'category', 'pricing_model']);
const GROUPS = [
  ['基本信息', 'form', ['name', 'url', 'tagline', 'short_description', 'description', 'features', 'use_cases', 'audience',
    'category', 'tags', 'pricing_model', 'pricing_text', 'price_from', 'launch_date', 'founded_year', 'platforms',
    'languages', 'alternatives', 'open_source', 'license']],
  ['链接', 'link', ['pricing_url', 'docs_url', 'blog_url', 'changelog_url', 'privacy_url', 'terms_url', 'rss_url',
    'sitemap_url', 'demo_url', 'video_url', 'github_url']],
  ['长文本模板', 'key', ['maker_story', 'launch_comment', 'pitch', 'press_boilerplate', 'faq', 'changelog_latest', 'subject', 'message']],
  ['身份与签名', 'globe', ['email', 'signature']],
];
const FIELD_NOTES = {
  name: '产品名；标题与 name 字段都靠它', url: '首页地址；另存 url_bare/domain', tagline: '一句话，≤40 / ≤60 两档',
  short_description: '短描述，≤100 / ≤160 分档', description: '长描述，≤250 / ≤500 / ≤1000 分档',
  category: '主分类 + 候选词（下拉匹配用）', tags: '关键词，逗号分隔', pricing_model: 'Free / Freemium / Paid / Open Source',
  email: '投稿联系邮箱', signature: '署名', features: '3–8 条，逗号分隔', use_cases: '使用场景，逗号分隔',
  platforms: 'Web / Chrome / iOS / Android', languages: '支持语言',
  maker_story: '为什么做（长文本模板，可用 {name} {url}）', launch_comment: '首发评论',
  pitch: '外联正文', press_boilerplate: '媒体介绍', faq: '问答对', changelog_latest: '最近更新',
};
const ASSETS = [
  ['logo', '品牌标志', '512×512 透明底 PNG', 'image/png,image/jpeg,image/svg+xml'],
  ['icon', '应用图标', '32 / 64 px', 'image/png'],
  ['favicon', '站点图标', '32 / 64 px', 'image/png,image/x-icon'],
  ['cover', '封面图', '1200×630（OG / 画廊）', 'image/png,image/jpeg'],
  ['screenshot', '产品截图', '1280×800', 'image/png,image/jpeg'],
  ['demo_gif', '演示动图', '≤5MB', 'image/gif'],
  ['demo_video', '演示视频', 'MP4 16:9 ≤50MB（按计划暂不制作，先留位）', 'video/mp4'],
  ['maker_avatar', '作者头像', '400×400', 'image/png,image/jpeg'],
];
const state = {sites: [], site: null, kit: null, profile: null, errors: [], warnings: [], dirty: false};

BKIcon.hydrate();

function toast(message, tone = 'ok') {
  const box = $('#toasts');
  const item = el('div', {class: `toast ${tone}`}, icon(tone === 'err' ? 'alert' : tone === 'warn' ? 'info' : 'check'), text(message));
  box.append(item);
  setTimeout(() => item.remove(), 3800);
}

function setStatus(message) {$('#status').textContent = message || '';}

function connection(ok) {
  const chip = $('#conn');
  chip.className = `conn ${ok ? '' : 'off'}`;
  chip.lastElementChild.textContent = ok ? '本机' : '离线';
}

async function health() {
  setStatus('检查本机服务…');
  try {
    const info = await send('health');
    setStatus(`本机服务正常 · ${info.name} ${info.version} · 资料包 schema ${info.schema_version}`);
    connection(true);
    return true;
  } catch (error) {
    setStatus(error.message);
    connection(false);
    return false;
  }
}

// ---------- 骨架 ----------

const skeleton = () => el('div', {class: 'loading', 'aria-busy': 'true'},
  el('div', {class: 'skel card', style: 'height:76px'}),
  el('div', {class: 'skel card', style: 'height:220px'}),
  el('div', {class: 'skel card', style: 'height:160px'}));

async function load() {
  const {base} = await chrome.storage.local.get('base');
  $('#address').value = base || '';
  try {
    state.sites = await send('sites');
  } catch (error) {
    setStatus(error.message);
    connection(false);
    $('#editor').replaceChildren(emptyState('link', '读不到项目列表', error.message));
    return;
  }
  const list = $('#sites');
  list.replaceChildren();
  for (const site of state.sites) {
    list.append(el('li', {}, el('button', {'data-site': site, 'aria-current': 'false', class: 'bk-item', onclick: () => open(site)},
      icon('image'), text(site))));
  }
  if (state.sites.length) await open(state.sites[0]);
}

let openVersion = 0;
async function open(site) {
  const version = ++openVersion;
  state.site = site;
  state.kit = null;
  for (const button of document.querySelectorAll('#sites button')) button.setAttribute('aria-current', String(button.dataset.site === site));
  $('#editor').replaceChildren(skeleton());
  try {
    await pendingSaves.get(site);
    if (version !== openVersion) return;
    if (uncertainAssets.has(site) && drafts.has(site)) await recoverAssets(drafts.get(site).kit);
    if (version !== openVersion) return;
    const [kit, profile, kits] = await Promise.all([
      drafts.has(site) ? drafts.get(site).kit : send('kit', {site}), send('profile'), send('kits')]);
    if (version !== openVersion) return;
    state.kit = kit;
    state.profile = profile;
    const mine = kits.find(item => item.site === site);
    state.errors = mine?.errors || [];
    state.warnings = mine?.warnings || [];
  } catch (error) {
    if (version !== openVersion) return;
    $('#editor').replaceChildren(emptyState('alert', '读不到资料包', error.message));
    return;
  }
  render();
}

function emptyState(name, title, body, actions = []) {
  return el('div', {class: 'empty'}, el('div', {class: 'ring'}, icon(name)), el('b', {}, text(title)),
    body ? el('p', {}, text(body)) : null, actions.length ? el('div', {class: 'row'}, ...actions) : null);
}

// ---------- 编辑区 ----------

function render() {
  const kit = state.kit;
  const editor = $('#editor');
  if (!kit) {editor.replaceChildren(emptyState('image', '选一个项目', '左侧项目列表里挑一个开始编辑。')); return;}
  editor.replaceChildren();
  editor.append(el('div', {class: 'card sitecard'},
    el('div', {class: 'glyph'}, icon('image')),
    el('div', {class: 'grow'},
      el('div', {class: 'row between'}, el('h2', {}, text(kit.site)),
        el('div', {class: 'row'}, el('button', {class: 'sm', onclick: () => open(kit.site)}, icon('refresh'), text('重新读取')))),
      el('div', {class: 'meta'},
        el('span', {class: 'pill brand'}, text(`schema v${kit.schema_version}`)),
        el('span', {class: 'pill'}, text(`${Object.keys(kit.fields || {}).length} 个文本字段`)),
        el('span', {class: 'pill'}, text(`${(kit.assets || []).length} 个素材`)),
        el('span', {class: `pill ${state.errors.length ? 'bad' : state.warnings.length ? 'warn' : 'ok'}`},
          text(state.errors.length ? `${state.errors.length} 个必错` : state.warnings.length ? `${state.warnings.length} 个提示` : '完整度通过')))),
    el('button', {class: 'primary', onclick: () => check()}, icon('check'), text('检查完整度'))));

  const nav = el('div', {class: 'groupnav'});
  for (const [title, , keys] of GROUPS) {
    nav.append(el('a', {href: `#group-${title}`, onclick: event => {
      event.preventDefault();
      document.getElementById(`group-${title}`)?.scrollIntoView({behavior: 'smooth', block: 'start'});
    }}, text(`${title} · ${keys.length}`)));
  }
  nav.append(el('a', {href: '#group-media', onclick: event => {event.preventDefault();
    document.getElementById('group-media')?.scrollIntoView({behavior: 'smooth', block: 'start'});}}, text('媒体 · 8')));
  editor.append(nav);

  for (const [title, glyph, keys] of GROUPS) {
    editor.append(el('section', {class: 'card', id: `group-${title}`, style: 'margin-top:12px'},
      el('div', {class: 'head'}, icon(glyph), el('h3', {}, text(title)),
        el('span', {class: 'muted'}, text('改动即时保存'))),
      el('div', {class: 'pad', style: 'padding-top:0;padding-bottom:0'},
        ...keys.map(key => fieldRow(key, kit.fields?.[key])))));
  }

  editor.append(mediaSection());
  editor.append(qaSection());
  editor.append(reportSection());
}

function fieldRow(key, field) {
  const kit = state.kit;
  const value = field?.value ?? (field?.list ? field.list.join(', ') : BKText.chooseVariant(field)) ?? '';
  const variants = field?.variants ? Object.keys(field.variants).map(Number).sort((a, b) => a - b) : [];
  const isLong = String(value).length > 90 || ['description', 'maker_story', 'launch_comment', 'pitch', 'press_boilerplate', 'faq', 'changelog_latest', 'message', 'features', 'use_cases'].includes(key);
  const area = el('textarea', {rows: isLong ? 5 : 1, spellcheck: 'false', 'aria-label': key});
  area.value = String(value);
  const counter = el('span', {class: 'muted'}, text(`${String(value).length} 字符${variants.length ? ' · ' + variants.length + ' 档' : ''}`));
  const save = (next, message) => {
    kit.fields = {...kit.fields, [key]: next};
    counter.textContent = `${String(next.value ?? '').length} 字符${next.variants ? ' · ' + Object.keys(next.variants).length + ' 档' : ''}`;
    saveKit(message, kit);
  };
  area.addEventListener('change', () => {
    const current = kit.fields[key];
    const next = {...(current || {}), value: area.value,
      variants: {...(current?.variants || {}), [String(area.value.length)]: area.value}, i18n: current?.i18n || {}};
    if (current?.list) next.list = area.value.split(/[,，;；\n]/).map(item => item.trim()).filter(Boolean);
    save(next, `已保存 ${key}`);
  });
  const chipRow = el('div', {class: 'vchips'});
  for (const limit of VARIANT_LIMITS) {
    const covered = variants.some(size => size <= limit);
    chipRow.append(el('span', {class: `vchip ${covered ? 'on' : 'off'}`, title: covered ? `≤${limit} 有可用文案` : `≤${limit} 放不下`}, text(String(limit))));
  }
  const langs = Object.keys(field?.i18n || {});
  return el('div', {class: 'fieldrow', id: `field-${key}`},
    el('div', {class: 'about'},
      el('div', {class: 'row'}, el('b', {}, text(key)), REQUIRED.has(key) ? el('span', {class: 'pill bad'}, text('必填')) : null),
      el('div', {class: 'note'}, text(FIELD_NOTES[key] || (field?.list ? '列表字段，逗号分隔' : '文本字段'))),
      counter,
      langs.length ? el('div', {class: 'row'}, el('span', {class: 'pill brand'}, text('多语言 ' + langs.join('/')))) : null),
    el('div', {class: 'edit'},
      area,
      el('div', {class: 'under'},
        chipRow,
        el('button', {class: 'sm ghost', onclick: () => splitVariants(key, area.value)}, text('按长度拆分分档')),
        el('button', {class: 'sm ghost', onclick: () => addTranslation(key)}, text('加翻译')),
        el('button', {class: 'sm ghost', onclick: () => copy(area.value)}, icon('copy'), text('复制')))));
}

function splitVariants(key, value) {
  const body = String(value || '').trim();
  if (!body) return toast('先写主文案', 'warn');
  const variants = {};
  for (const limit of [100, 160, 250, 500, 1000, 2000]) if (body.length <= limit) variants[String(limit)] = body;
  const sentences = body.split(/(?<=[.。!！?？])\s*/).filter(Boolean);
  let built = '';
  for (const sentence of sentences) {
    if (built.length + sentence.length > 250) break;
    built += sentence;
    for (const limit of [100, 160, 250]) if (built.trim().length <= limit && !variants[String(limit)]) variants[String(limit)] = built.trim();
  }
  const updated = {...(state.kit.fields[key] || {}), value: body, variants, i18n: state.kit.fields[key]?.i18n || {}};
  state.kit.fields = {...state.kit.fields, [key]: updated};
  saveKit(`已为 ${key} 生成 ${Object.keys(variants).length} 个分档`);
  render();
}

function addTranslation(key) {
  const field = state.kit.fields[key];
  const lang = (prompt('语言代码（如 zh、ja、de）') || '').trim().toLowerCase();
  if (!lang) return;
  const value = prompt(`用 ${lang} 写这一版的文案（留空则删除该语言）`);
  if (value === null) return;
  const i18n = {...(field?.i18n || {})};
  if (value.trim()) i18n[lang] = value.trim(); else delete i18n[lang];
  const updated = {...(field || {}), i18n};
  state.kit.fields = {...state.kit.fields, [key]: updated};
  saveKit(i18n[lang] ? `已添加 ${lang} 版本` : `已删除 ${lang} 版本`);
  render();
}

// ---------- 媒体 ----------

function mediaSection() {
  const kit = state.kit;
  const section = el('section', {class: 'card', id: 'group-media', style: 'margin-top:12px'},
    el('div', {class: 'head'}, icon('image'), el('h3', {}, text('媒体素材')),
      el('span', {class: 'muted'}, text('拖拽文件到卡片，或点“上传”'))));
  const grid = el('div', {class: 'media-grid pad'});
  for (const [key, title, hint, accept] of ASSETS) {
    const assets = (kit.assets || []).filter(asset => asset.key === key);
    const card = el('div', {class: 'media'});
    const thumb = el('div', {class: 'thumb'});
    if (assets.length) {
      const asset = assets[0];
      if (String(asset.mime || '').startsWith('video/')) {
        const video = el('video', {controls: 'controls', preload: 'metadata'});
        send('file', {site: kit.site, id: asset.id}).then(file => {video.src = `data:${file.type};base64,${file.data}`;}).catch(() => {});
        thumb.append(video);
      } else {
        const image = el('img', {alt: asset.alt || title});
        send('file', {site: kit.site, id: asset.id}).then(file => {image.src = `data:${file.type};base64,${file.data}`;}).catch(() => {});
        thumb.append(image);
      }
    } else {
      thumb.append(icon(key.startsWith('demo_') ? 'video' : 'image'), text('缺素材'));
      card.classList.add('missing');
    }
    const alt = el('input', {type: 'text', value: assets[0]?.alt || '', placeholder: 'alt 文本', 'aria-label': `${title} alt`});
    alt.addEventListener('change', () => {
      const value = alt.value;
      queueKit(kit, async () => {
        const asset = (kit.assets || []).find(item => item.assetId === assets[0]?.assetId);
        if (!asset) throw Error('素材已移除，请重新读取后编辑 alt');
        asset.alt = value;
        await writeKit(kit, `已更新 ${title} 的 alt`);
        if (state.kit === kit) {
          const input = $(`#group-media input[aria-label="${title} alt"]`);
          if (input && document.activeElement !== input) input.value = value;
        }
      });
    });
    const info = assets.length
      ? el('div', {class: 'info'}, el('div', {class: 'name'}, text(`${title} · ${assets[0].name || assets[0].file || key}`)),
        el('div', {class: 'dims'}, text(`${assets[0].w || '?'}×${assets[0].h || '?'} · ${Math.round((assets[0].bytes || 0) / 1024)}KB · ${hint}`)),
        el('div', {class: 'alt'}, alt))
      : el('div', {class: 'info'}, el('div', {class: 'name'}, text(title)),
        el('div', {class: 'dims'}, text(key.startsWith('demo_video') ? '按计划暂不制作；上传后表单可直接用' : hint)));
    const picker = el('input', {type: 'file', accept, hidden: ''});
    picker.addEventListener('change', () => upload(key, picker.files[0], kit));
    const bar = el('div', {class: 'bar'},
      el('button', {class: 'sm', onclick: () => picker.click()}, icon('upload'), text(assets.length ? '替换' : '上传')),
      assets.length ? el('button', {class: 'sm ghost icon', title: '移除', 'aria-label': `移除 ${title}`,
        onclick: () => removeAsset(key, title, kit)}, icon('trash')) : null);
    card.append(thumb, info, bar, picker);
    card.addEventListener('dragover', event => {event.preventDefault(); card.classList.add('over');});
    card.addEventListener('dragleave', () => card.classList.remove('over'));
    card.addEventListener('drop', event => {
      event.preventDefault();
      card.classList.remove('over');
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      if (assets.length && !confirm(`替换 ${title}？`)) return;
      upload(key, file, kit);
    });
    card.addEventListener('click', event => {
      if (event.target.closest('button, input, video')) return;
      picker.click();
    });
    card.style.cursor = 'pointer';
    grid.append(card);
  }
  section.append(grid);
  return section;
}

async function upload(key, file, kit = state.kit) {
  if (!file) return;
  if (file.size > 16_000_000) return toast('文件超过 16MB，视频请压到 50MB 以内后重试', 'warn');
  toast(`上传 ${file.name}…`, 'warn');
  return queueKit(kit, async () => {
    const buffer = await file.arrayBuffer();
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    await writeKit(kit);
    let result;
    try {
      result = await send('asset', {site: kit.site, key, name: file.name, data: btoa(binary), alt: kit.fields?.name?.value || ''});
      if (!result?.asset) throw Error('上传响应缺少素材登记');
    } catch (error) {
      // 响应丢失不能重传，也不能拿上传前的登记继续整包保存。
      uncertainAssets.add(kit.site);
      await recoverAssets(kit);
      if (state.kit === kit) $('#group-media')?.replaceWith(mediaSection());
      toast(`上传回执丢失：${error.message}；已读回素材登记，未重传`, 'warn');
      return;
    }
    // 登记已成功；即使随后读回失败，也不能让下一次文本保存丢掉新素材。
    const uploaded = {...result.asset, assetId: result.asset.id};
    kit.assets = [...(kit.assets || []).filter(asset => asset.assetId !== uploaded.assetId), uploaded]
      .map((asset, index) => ({...asset, id: String(index)}));
    const fresh = await send('kit', {site: kit.site});
    kit.assets = fresh.assets;
    const size = result.asset.w && result.asset.h ? `${result.asset.w}×${result.asset.h}` : '尺寸未知';
    if (state.kit === kit) {
      state.errors = result.errors || [];
      state.warnings = result.warnings || [];
      $('#group-media')?.replaceWith(mediaSection());
    }
    toast(`已上传 ${file.name}（${size}）`, result.errors?.length ? 'warn' : 'ok');
  });
}

async function removeAsset(key, title, kit = state.kit) {
  if (!await confirmSheet(`移除 ${title}？`, '文件会从资料包登记里删掉，磁盘上的文件保留。')) return;
  return queueKit(kit, async () => {
    kit.assets = (kit.assets || []).filter(asset => asset.key !== key)
      .map((asset, index) => ({...asset, id: String(index)}));
    await writeKit(kit, `已移除 ${title}`);
    if (state.kit === kit) $('#group-media')?.replaceWith(mediaSection());
  });
}

function confirmSheet(title, body, okText = '移除', danger = true) {
  return new Promise(resolve => {
    const host = document.createElement('dialog');
    host.className = 'sheet';
    const ok = el('button', {class: danger ? 'danger' : 'primary'}, text(okText));
    host.append(el('div', {class: 'pad stack tight'}, el('h2', {}, text(title)), el('p', {class: 'muted'}, text(body))),
      el('div', {class: 'foot'}, el('button', {class: 'subtle'}, text('取消')), ok));
    document.body.append(host);
    host.showModal();
    host.querySelector('.subtle').onclick = () => {host.close(); host.remove(); resolve(false);};
    ok.onclick = () => {host.close(); host.remove(); resolve(true);};
    host.addEventListener('close', () => {host.remove(); resolve(false);}, {once: true});
  });
}

// ---------- 问答与完整度 ----------

function qaSection() {
  const kit = state.kit;
  const section = el('section', {class: 'card', id: 'group-qa', style: 'margin-top:12px'},
    el('div', {class: 'head'}, icon('info'), el('h3', {}, text('本站问答覆盖')),
      el('span', {class: 'muted'}, text('留空会覆盖共享答案并交人；删除本站覆盖后使用共享答案')), el('div', {class: 'spacer'}),
      el('button', {class: 'sm', onclick: addQa}, icon('plus'), text('加一条'))));
  const body = el('div', {class: 'pad', style: 'padding-top:2px'});
  for (const [question, answer] of Object.entries(kit.qa_overrides || {})) {
    const input = el('input', {value: answer, 'aria-label': question});
    input.addEventListener('change', () => {
      kit.qa_overrides = {...kit.qa_overrides, [question]: input.value};
      saveKit('已保存问答', kit);
    });
    body.append(el('div', {class: 'qa-row'}, el('span', {class: 'mono'}, text(question)), input,
      el('button', {class: 'sm ghost icon', title: '删除', 'aria-label': '删除问答',
        onclick: () => {delete kit.qa_overrides[question]; saveKit('已删除问答', kit); render();}}, icon('trash'))));
  }
  if (!Object.keys(kit.qa_overrides || {}).length) body.append(el('p', {class: 'muted'}, text('还没有本站覆盖，使用全局问答默认值。')));
  section.append(body);
  return section;
}

function addQa() {
  const question = prompt('问题（与页面标签一致或含关键词）');
  if (!question) return;
  const answer = prompt('固定答案（留空会覆盖共享答案并交人）');
  if (answer === null) return;
  state.kit.qa_overrides = {...(state.kit.qa_overrides || {}), [question]: answer};
  saveKit('已添加问答');
  render();
}

function reportSection() {
  const section = el('section', {class: 'card', id: 'check-result', style: 'margin-top:12px'},
    el('div', {class: 'head'}, icon('check'), el('h3', {}, text('完整度检查')),
      el('span', {class: `pill ${state.errors.length ? 'bad' : state.warnings.length ? 'warn' : 'ok'}`},
        text(state.errors.length ? `${state.errors.length} 个必须修` : state.warnings.length ? `${state.warnings.length} 个提示` : '通过')),
      el('div', {class: 'spacer'}),
      el('button', {class: 'sm', onclick: check}, icon('refresh'), text('重新检查'))));
  const body = el('div', {class: 'pad checkreport'});
  if (!state.errors.length && !state.warnings.length) {
    body.append(el('p', {class: 'ok'}, text('没有必须修的问题，素材与分档都齐。')));
  }
  if (state.errors.length) {
    body.append(el('div', {}, el('b', {style: 'color:var(--bad)'}, text('必须修')),
      el('ul', {}, ...state.errors.map(item => el('li', {}, text(item))))));
  }
  if (state.warnings.length) {
    body.append(el('div', {}, el('b', {style: 'color:var(--warn)'}, text('提示')),
      el('ul', {}, ...state.warnings.map(item => el('li', {}, text(item))))));
  }
  section.append(body);
  return section;
}

async function check() {
  const kit = state.kit, version = openVersion;
  if (!kit) return toast('先选一个项目', 'warn');
  try {
    const kits = await send('kits');
    if (version !== openVersion || state.kit !== kit) return;
    const mine = kits.find(item => item.site === kit.site);
    if (!mine) throw Error('读不到这个项目的检查结果');
    state.errors = mine.errors;
    state.warnings = mine.warnings;
    $('#check-result')?.replaceWith(reportSection());
    toast(mine.errors.length ? `${mine.errors.length} 个必须修` : '完整度检查通过', mine.errors.length ? 'warn' : 'ok');
    document.getElementById('check-result')?.scrollIntoView({behavior: 'smooth', block: 'center'});
  } catch (error) {if (version === openVersion && state.kit === kit) toast(error.message, 'err');}
}

// ---------- 保存 ----------

const pendingSaves = new Map();
const drafts = new Map();
const uncertainAssets = new Set();

async function recoverAssets(kit) {
  if (!uncertainAssets.has(kit.site)) return;
  try {
    const fresh = await send('kit', {site: kit.site});
    if (!Array.isArray(fresh.assets)) throw Error('读回缺少素材登记');
    kit.assets = fresh.assets;
    uncertainAssets.delete(kit.site);
  } catch (error) {
    throw Error(`素材登记未核实，已阻止 ${kit.site} 整包覆盖；请重新读取后再保存：${error.message}`);
  }
}

// 每个产品仅串行自己的写入；失败的草稿保留，后续修改仍可重试。
function queueKit(kit, operation) {
  const draft = {kit};
  drafts.set(kit.site, draft);
  const pending = (pendingSaves.get(kit.site) || Promise.resolve()).then(async () => {
    try {
      await recoverAssets(kit);
      await operation(draft);
      if (drafts.get(kit.site) === draft) drafts.delete(kit.site);
      return true;
    } catch (error) {
      toast('保存失败：' + error.message, 'err');
      return false;
    }
  });
  pendingSaves.set(kit.site, pending);
  return pending;
}

function saveKit(message = '已保存', kit = state.kit) {
  return queueKit(kit, () => writeKit(kit, message));
}

async function writeKit(kit, message) {
  const result = await send('kit-save', {site: kit.site, kit: structuredClone(kit)});
  if (state.kit === kit) {
    state.errors = result.errors || [];
    state.warnings = result.warnings || [];
  }
  if (message) toast(message);
}

async function copy(value) {
  try {await navigator.clipboard.writeText(value); toast('已复制');}
  catch {toast('复制失败，请手动选择', 'warn');}
}

// ---------- 身份档案 ----------

function renderProfile() {
  const editor = $('#editor');
  const fields = {...(state.profile?.fields || {})};
  const qa = {...(state.profile?.qa || {})};
  editor.replaceChildren(el('div', {class: 'card sitecard'},
    el('div', {class: 'glyph'}, icon('globe')),
    el('div', {class: 'grow'}, el('h2', {}, text('全局身份档案')),
      el('div', {class: 'meta'}, el('span', {class: 'pill'}, text('所有项目共用')),
        el('span', {class: 'pill line'}, text('存 reports/backlinks/kits/_profile.json'))))));
  const group = (title, glyph, entries, onSave) => {
    const card = el('section', {class: 'card', style: 'margin-top:12px'},
      el('div', {class: 'head'}, icon(glyph), el('h3', {}, text(title))), el('div', {class: 'pad', style: 'padding-top:2px'}));
    for (const [key, value] of entries) {
      const input = el('input', {value: value || '', 'aria-label': key});
      input.addEventListener('change', () => onSave(key, input.value));
      card.append(el('div', {class: 'qa-row'}, el('span', {class: 'mono'}, text(key)), input, el('span')));
    }
    return card;
  };
  const fieldRows = ['maker_name', 'first_name', 'last_name', 'role', 'email', 'company', 'country', 'city',
    'twitter', 'twitter_url', 'linkedin', 'github', 'producthunt', 'youtube', 'discord', 'indiehackers', 'website_personal']
    .map(key => [key, fields[key]]);
  editor.append(group('身份字段', 'globe', fieldRows, (key, value) => {
    fields[key] = value;
    saveProfile({fields, qa});
  }));
  editor.append(group('通用问答库', 'info', Object.entries(qa), (key, value) => {
    qa[key] = value;
    saveProfile({fields, qa});
  }));
  editor.append(el('div', {class: 'pad muted'}, text('MRR/收入、同意条款、付费加速一律留空交人；没查到的事实不要写。')));
}

async function saveProfile(payload) {
  try {
    await send('profile-save', {profile: {...state.profile, ...payload}});
    state.profile = {...state.profile, ...payload};
    toast('身份档案已保存');
  } catch (error) {toast(error.message, 'err');}
}

// ---------- 顶部动作 ----------

$('#save-base').addEventListener('click', async () => {
  try {
    const base = BKLogic.config($('#address').value);
    await chrome.storage.local.set({base});
    setStatus('已保存连接地址');
    await health();
    toast('已保存连接');
  } catch (error) {setStatus(error.message); toast(error.message, 'err');}
});
$('#health').addEventListener('click', health);
$('#edit-profile').addEventListener('click', async () => {
  const version = ++openVersion;
  state.site = null;
  state.kit = null;
  for (const button of document.querySelectorAll('#sites button')) button.setAttribute('aria-current', 'false');
  if (!state.profile) state.profile = await send('profile').catch(() => ({fields: {}, qa: {}}));
  if (version !== openVersion) return;
  renderProfile();
});
$('#edit-qa').addEventListener('click', async () => {
  if (!state.profile) state.profile = await send('profile').catch(() => ({fields: {}, qa: {}}));
  const question = prompt('通用问题（所有项目共用）');
  if (!question) return;
  const answer = prompt('答案（留空表示交人）');
  if (answer === null) return;
  await saveProfile({fields: state.profile.fields || {}, qa: {...(state.profile.qa || {}), [question]: answer}});
});
$('#check').addEventListener('click', check);
$('#export').addEventListener('click', () => {
  if (!state.kit) return toast('先选一个项目', 'warn');
  const blob = new Blob([JSON.stringify(state.kit, null, 2)], {type: 'application/json'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${state.site}-kit.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('已导出 JSON');
});
$('#import').addEventListener('click', () => {
  if (!state.kit) return toast('先选一个项目', 'warn');
  const kit = state.kit, site = kit.site, version = openVersion;
  const current = () => version === openVersion && state.kit === kit;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    return queueKit(kit, async draft => {
      const data = JSON.parse(await file.text());
      const imported = {...data, site: data.site || site};
      if (imported.site !== site) throw Error('产品不匹配，不能跨产品导入');
      await writeKit(imported);
      // 保留原kit引用，让已排队保存和失败草稿都接续已提交的导入，而非旧内容。
      for (const key of Object.keys(kit)) delete kit[key];
      Object.assign(kit, imported);
      if (current()) render();
      const fresh = await send('kit', {site});
      if (current() && drafts.get(site) === draft) {
        Object.assign(kit, fresh);
        // 等待读回时用户可能又开始输入，不能再次重绘正文。
        $('#group-media')?.replaceWith(mediaSection());
      }
      toast('已导入并保存');
    });
  });
  input.click();
});

load().then(health);
