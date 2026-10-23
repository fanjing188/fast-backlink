const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../lib/text.js');
global.BKText = T;
const P = require('../lib/platforms.js');
global.BKPlatform = P;
const M = require('../lib/match.js');

test('敏感语义独立检查自身标签，不被优先展示的容器标签遮住', () => {
  for (const part of ['own', 'aria', 'placeholder', 'described', 'bits']) {
    const field = {label: 'Keywords', name: 'topics', inputType: 'text', widget: 'tags', labelParts: {[part]: 'Password'}};
    assert.ok(M.sensitivityOf(field, rules), part + '中的敏感语义必须保留');
  }
});

const rules = {
  labels: {name: ['product name'], url: ['website'], description: ['description']},
  sensitive: JSON.parse(fs.readFileSync(path.join(__dirname, '../../rules/keywords.json'), 'utf8')).sensitive,
  fieldRules: JSON.parse(fs.readFileSync(path.join(__dirname, '../../rules/field-rules.json'), 'utf8')),
  learned: {},
};

const context = () => ({
  site: 'probekits', source_domain: 'seesaw.website', submit_url: 'https://seesaw.website/submit',
  record: null, fields: [], steps: [],
  kit: {
    fields: {
      name: {value: 'ProbeKits'},
      url: {value: 'https://probekits.com/'},
      tagline: {variants: {40: 'Free peripheral tests in browser', 60: 'Free browser-based tests for your computer peripherals'}},
      short_description: {value: 'Check mouse, keyboard and webcam signals in your browser. Free, no account.'},
      description: {variants: {100: 'ProbeKits provides free browser-based checks for mouse, keyboard and display input.', 500: 'ProbeKits provides free browser-based checks for mouse, keyboard, display, webcam, microphone, audio and gamepad input. Use the tools without an account or installation. Camera and microphone checks require browser permission.'}},
      category: {value: 'Utilities', alternates: ['Hardware Testing', 'Diagnostics', 'Developer Tools']},
      tags: {list: ['mouse test', 'keyboard test', 'display test']},
      pricing_model: {value: 'Free'},
      pricing_text: {value: 'Free（免费、无账号）'},
      email: {value: 'maker@example.test'},
      launch_date: {value: '2026-09-27'},
      founded_year: {value: '2026'},
      features: {list: ['Mouse test', 'Keyboard test']},
      demo_url: {value: 'https://probekits.com/tools'},
      github_url: {value: 'https://github.com/fanjing188/probekits'},
    },
    profile: {maker_name: 'Fan Jing', first_name: 'Fan', last_name: 'Jing', email: 'maker@example.test',
      twitter: '@fanjing188', twitter_url: 'https://twitter.com/fanjing188', company: 'ProbeKits',
      country: 'China', role: 'Founder', website_personal: 'https://fanjing.dev'},
    assets: [
      {id: '0', key: 'logo', mime: 'image/png', w: 512, h: 512, bytes: 29089, name: 'logo-512.png'},
      {id: '1', key: 'screenshot', mime: 'image/png', w: 1280, h: 800, bytes: 83069, name: 'homepage-1280x800.png'},
      {id: '2', key: 'demo_video', mime: 'video/mp4', w: 1920, h: 1080, bytes: 21000000, name: 'demo.mp4'},
    ],
    qa: {'How did you hear about us': 'Google search', 'Team size': '1', 'Are you the owner': 'Yes', 'Funding': 'Bootstrapped'},
  },
  memory: {fields: [], labels: {}}, recipe: null,
});

const field = (label, extra = {}) => ({label, labelParts: {own: label}, name: '', inputType: 'text', widget: 'text',
  role: 'textbox', maxlength: -1, options: [], ...extra});
const decide = (label, extra = {}, contextExtra = {}) => {
  const session = {...context(), ...contextExtra};
  const current = field(label, extra);
  const ctx = {context: session, rules, settings: {fill_low_confidence: true}, step: 0, field: current};
  return {...M.run({element: {}, field: current}, ctx), field: current, context: session, ctx};
};

test('分层 1–3：记录、记忆、配方按原标签命中，值优先用已保存的', () => {
  const memory = {fields: [{label: 'Your product', key: 'name', value: 'Manual name'}], labels: {}};
  const one = decide('Your product', {}, {memory});
  assert.equal(one.key, 'name');
  assert.equal(one.value, 'Manual name');
  assert.equal(one.layer, 'memory');
  assert.ok(one.conf >= 0.95 && one.status === 'filled');

  const saved = decide('Whatever label', {}, {fields: [{label: 'Whatever label', key: 'description', value: 'Hand typed'}]});
  assert.equal(saved.value, 'Hand typed');
  assert.equal(saved.layer, 'record');

  const recipe = decide('Unusual field name', {}, {recipe: {steps: [{fields: [{label: 'Unusual field name', key: 'tagline'}]}]}});
  assert.equal(recipe.key, 'tagline');
  assert.equal(recipe.layer, 'recipe');
});

test('分层 4：autocomplete 标准值直接映射', () => {
  assert.equal(decide('', {autocomplete: 'email'}).key, 'email');
  assert.equal(decide('', {autocomplete: 'given-name'}).key, 'first_name');
  assert.equal(decide('', {autocomplete: 'organization'}).key, 'company');
  const one = decide('', {autocomplete: 'url'});
  assert.equal(one.key, 'url');
  assert.equal(one.value, 'https://probekits.com/');
});

test('分层 5：同义词带排他词，不把社交/图片当产品网址', () => {
  assert.equal(decide('Website URL').key, 'url');
  assert.equal(decide('Product Name').key, 'name');
  assert.equal(decide('Twitter handle').key, 'twitter');
  assert.equal(decide('Long description').key, 'description');
  assert.equal(decide('Product tagline (max 60 characters)').key, 'tagline');
  assert.equal(decide('Short description').key, 'short_description');
  const logoUrl = decide('Logo URL');
  assert.equal(logoUrl.key, 'logo');
  assert.equal(logoUrl.value, undefined);
  assert.equal(decide('Twitter URL').key, 'twitter');
  assert.equal(decide('LinkedIn profile').key, 'linkedin');
  assert.equal(decide('Company name').key, 'company');
  assert.equal(decide('Select a category').key, 'category');
  assert.equal(decide('Submitter email').key, 'email');
  assert.equal(decide('How did you hear about us').key, 'how_did_you_hear');
});

test('降级与歧义：只靠 name 属性命中的低置信；真并列时交人', () => {
  const weak = decide('', {name: 'contact_email_address', labelParts: {own: '', bits: 'contact email address'}});
  assert.equal(weak.key, 'email');
  assert.ok(weak.conf <= 0.62, String(weak.conf));
  assert.equal(weak.status, 'pending');
  // bits 里同时有 website 和 url，且都来自 name 属性：不是人类可读来源，交人。
  const bits = decide('', {name: 'user_website_url_2', labelParts: {own: '', bits: 'user website url 2'}});
  assert.equal(bits.key, null);
  assert.equal(bits.status, 'unmatched');
  assert.ok(bits.alternatives.length >= 2);
  // 同分且命中长度相同时才是真歧义，交人。
  const custom = {...rules, fieldRules: {keys: {alpha: {synonyms: ['widget']}, beta: {synonyms: ['widget']}}, autocomplete: {}}};
  const tied = M.synonymRanking(field('Widget'), custom);
  assert.ok(tied.ambiguous, JSON.stringify(tied));
  // 同分时命中的同义词更长的一方胜出（website url 胜过 website）。
  const specific = M.synonymRanking(field('Website URL'), rules);
  assert.equal(specific.key, 'url');
  assert.ok(specific.hit >= 11, String(specific.hit));
});

test('置信度分档：≥0.85 自动填、0.5–0.85 待确认、<0.5 不填', () => {
  assert.equal(decide('Product Name').status, 'filled');
  const low = decide('Product Name', {}, {settings: {}});
  assert.equal(low.status, 'filled');
  assert.equal(M.shouldFill('filled'), true);
  assert.equal(M.shouldFill('pending'), true);
  assert.equal(M.shouldFill('pending', {fill_low_confidence: false}), false);
  assert.equal(M.shouldFill('unmatched'), false);
});

test('长度：按 maxlength 选分档，放不下就不填也不截断', () => {
  const short = decide('Description', {maxlength: 45});
  assert.equal(short.value, 'Free peripheral tests in browser');
  const mid = decide('Description', {maxlength: 60});
  assert.equal(mid.value.length <= 60, true);
  assert.ok(mid.value.length > 40);
  const tiny = decide('Description', {maxlength: 5});
  assert.equal(tiny.value, undefined);
  assert.equal(tiny.status, 'pending');
  assert.equal(tiny.reason, 'too_long');
  const roomy = decide('Description', {maxlength: 2000});
  assert.ok(roomy.value.length > 100);
});

test('下拉：分类用候选词，选项歧义交人；复选框从不自动勾同意条款', () => {
  const select = decide('Category', {inputType: 'select-one', widget: 'select-one', options: ['Choose one', 'Hardware Testing', 'Art']});
  assert.equal(select.value, 'Hardware Testing');
  const none = decide('Category', {inputType: 'select-one', widget: 'select-one', options: ['Art', 'Music']});
  assert.equal(none.value, undefined);
  assert.equal(none.reason, 'no_option_match');
  const pricing = decide('Pricing model', {inputType: 'select-one', widget: 'select-one', options: ['Freemium', 'Free', 'Paid']});
  assert.equal(pricing.value, 'Free');
  assert.equal(decide('I agree to the terms', {inputType: 'checkbox', widget: 'checkbox'}).value, undefined);
  assert.equal(decide('Newsletter subscription', {inputType: 'checkbox', widget: 'checkbox'}).value, undefined);
});

test('标签输入、日期、社交句柄、文件素材', () => {
  const tags = decide('Keywords or tags', {widget: 'tags'});
  assert.deepEqual(tags.value, ['mouse test', 'keyboard test', 'display test']);
  const date = decide('Launch date', {inputType: 'date', widget: 'date'});
  assert.equal(date.value, '2026-09-27');
  const handle = decide('Your Twitter handle', {placeholder: '@yourhandle'});
  assert.equal(handle.value, '@fanjing188');
  const url = decide('Twitter profile URL', {placeholder: 'https://twitter.com/you'});
  assert.equal(url.value, 'https://twitter.com/fanjing188');
  const logo = decide('Logo', {inputType: 'file', widget: 'file', accept: 'image/png,image/jpeg'});
  assert.equal(logo.asset.name, 'logo-512.png');
  const video = decide('Demo video', {inputType: 'file', widget: 'file', accept: 'video/mp4'});
  assert.equal(video.asset.name, 'demo.mp4');
  const screenshot = decide('Screenshot', {inputType: 'file', widget: 'file', accept: 'image/*'});
  assert.equal(screenshot.asset.name, 'homepage-1280x800.png');
});

test('敏感、验证码、蜜罐：一律不填', () => {
  assert.equal(decide('Password', {inputType: 'password'}).status, 'sensitive');
  assert.equal(decide('验证码', {}).status, 'captcha');
  assert.equal(decide('Verification code', {}).status, 'captcha');
  assert.equal(decide('Security code').status, 'sensitive');
  assert.equal(decide('Card number', {autocomplete: 'cc-number'}).status, 'sensitive');
  assert.equal(decide('Product Name', {honeypot: 'suspicious_name'}).status, 'honeypot');
  assert.equal(decide('Product Name', {honeypot: 'invisible'}).status, 'honeypot');
  assert.equal(decide('Website', {honeypot: 'invisible'}).status, 'honeypot');
});

test('未知个人事实与明确留空的答案都交人，不能从默认文案补写', () => {
  for (const [label, question] of [['Are you the owner?', 'Are you the owner'], ['Team size', 'Team size'],
    ['Funding', 'Funding'], ['Launch status', 'Launch status'], ['How did you hear about us?', 'How did you hear about us']]) {
    for (const qa of [{}, {[question]: ''}]) {
      const session = context();
      session.kit.qa = qa;
      assert.equal(decide(label, {}, session).status, 'unmatched', `${label} ${JSON.stringify(qa)}`);
    }
  }
});

test('问答库只答固定几种；收入类留空交人', () => {
  const qa = decide('Are you the maker?');
  assert.equal(qa.key, 'owner');
  assert.equal(qa.value, 'Yes');
  assert.equal(decide('Team size').value, '1');
  assert.equal(decide('Funding').value, 'Bootstrapped');
  const mrr = decide('MRR');
  assert.equal(mrr.value, undefined);
  assert.equal(mrr.status, 'unmatched');
  const free = decide('Is it free to use?');
  assert.equal(free.value, 'Yes');
});

test('长文本变量未替换时不填', () => {
  const session = context();
  session.kit.fields.pitch = {value: 'Hello {contact_name}, try {name} at {url}'};
  const entry = {element: {}, field: field('Your pitch')};
  const result = M.run(entry, {context: session, rules, settings: {}, step: 0, field: entry.field});
  assert.equal(result.value, undefined);
  assert.equal(result.reason, 'placeholder_left');
  session.kit.fields.pitch = {value: 'Hello, try {name} free'};
  const replaced = M.run(entry, {context: session, rules, settings: {}, step: 0, field: entry.field});
  assert.equal(replaced.value, 'Hello, try ProbeKits free');
});

test('字段内推荐给出前 3 个候选，含超长标记', () => {
  const entry = {element: {}, field: field('Tell us about your product', {maxlength: 45})};
  const items = M.suggest(entry, {context: context(), rules, settings: {}, step: 0, field: entry.field});
  assert.equal(items.length, 3);
  assert.ok(items[0].conf >= items[1].conf);
  assert.ok(items.some(item => item.key === 'description'));
});

test('平台适配器：用托管表单的题目文字提置信度，但不越过敏感判定', () => {
  const google = field('Untitled question', {platform: 'google-forms', platformLabel: 'Product Name', name: 'entry.123'});
  const result = M.run({element: {}, field: google}, {context: context(), rules, settings: {}, step: 0, field: google});
  assert.equal(result.key, 'name');
  assert.equal(result.layer, 'platform:google-forms');
  assert.ok(result.conf >= 0.85);
  const blank = field('Untitled question', {platform: 'tally', platformLabel: 'Website'});
  assert.equal(M.run({element: {}, field: blank}, {context: context(), rules, settings: {}, step: 0, field: blank}).key, 'url');
});

test('资料包带 i18n 时按页面语言取版本', () => {
  const session = context();
  session.kit.fields.tagline = {variants: {60: 'Free browser-based tests for your computer peripherals'},
    i18n: {zh: '免费的浏览器外设自检工具'}};
  const zh = decide('一句话介绍', {docLang: 'zh-CN'}, {kit: session.kit});
  assert.equal(zh.value, '免费的浏览器外设自检工具');
  const en = decide('Tagline', {}, {kit: session.kit});
  assert.equal(en.value, 'Free browser-based tests for your computer peripherals');
  // 没有对应语言的版本时退回主值
  const de = decide('Tagline', {docLang: 'de'}, {kit: session.kit});
  assert.equal(de.value, 'Free browser-based tests for your computer peripherals');
});

test('学习到的映射在标签命中时生效', () => {
  const learnedRules = {...rules, learned: {'launched when': 'launch_date'}};
  const entry = {element: {}, field: field('Launched when?')};
  const result = M.run(entry, {context: context(), rules: learnedRules, settings: {}, step: 0, field: entry.field});
  assert.equal(result.key, 'launch_date');
  assert.equal(result.layer, 'learned');
});

test('资料包没有的键用来源记忆兜底', () => {
  const session = context();
  session.kit = {...session.kit, profile: {...session.kit.profile}};
  delete session.kit.profile.twitter;
  session.memory = {fields: [{label: 'X handle', key: 'twitter', value: '@from-memory'}], labels: {}};
  assert.equal(M.resolveKey('twitter', {context: session, field: field('X handle')}), '@from-memory');
});

test('AI 返回的标准问答键和 qa:问题原文都能解析', () => {
  const ctx = {context: context(), field: field('How did you hear about us?')};
  assert.equal(M.resolveKey('how_did_you_hear', ctx), 'Google search');
  assert.equal(M.resolveKey('qa:How did you hear about us', ctx), 'Google search');
  assert.equal(M.resolveKey('qa:Team size', ctx), '1');
  assert.equal(M.resolveKey('qa:What is your favorite color?', ctx), null);
  assert.equal(M.resolveKey('domain', ctx), 'probekits.com');
  assert.equal(M.resolveKey('url_bare', ctx), 'probekits.com');
  const custom = {...context()};
  custom.kit = {...custom.kit, qa: {...custom.kit.qa, 'What is your mission?': 'Help people test hardware'}};
  assert.equal(M.resolveKey('qa:What is your mission?', {context: custom, field: ctx.field}), 'Help people test hardware');
});
