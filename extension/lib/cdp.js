// 按需附着的 CDP 层：可信输入、按键、鼠标点击、按路径上传、跨域 iframe 自动附着。
// 命令序列照搬 native-extension/core.mjs（见 vendor/fbl/PROVENANCE.md），做完立即 detach。
import {rankTargets, recoveryReason} from '../vendor/fbl/target-recovery.mjs';

const VERSION = '1.3';
const leases = new Map();          // tabId -> {count, timer, childSessions:Set}
const DETACH_IDLE_MS = 20000;

function session(tabId) {
  return leases.get(tabId);
}

chrome.debugger.onDetach.addListener(source => {
  if (source?.tabId != null) leases.delete(source.tabId);
});

async function releaseLater(tabId) {
  const lease = leases.get(tabId);
  if (!lease) return;
  clearTimeout(lease.timer);
  lease.timer = setTimeout(() => {
    if ((leases.get(tabId)?.count ?? 0) <= 0) detach(tabId).catch(() => {});
  }, DETACH_IDLE_MS);
}

export async function attach(tabId) {
  const existing = leases.get(tabId);
  if (existing) { existing.count++; clearTimeout(existing.timer); return existing; }
  try {
    await chrome.debugger.attach({tabId}, VERSION);
  } catch (error) {
    // 已被其它扩展占用时给出和上游一致的错误串，便于判断（例如 Fast-browser-link 正在调试同一页）。
    if (!String(error?.message || error).includes('Another debugger is already attached')) {
      if (!leases.has(tabId)) throw error;
    }
  }
  const lease = session(tabId);
  if (lease) { lease.count++; return lease; }
  const fresh = {count: 1, timer: null, childSessions: new Set()};
  leases.set(tabId, fresh);
  return fresh;
}

export async function detach(tabId) {
  const lease = leases.get(tabId);
  if (!lease) return;
  lease.count = 0;
  clearTimeout(lease.timer);
  for (const sessionId of lease.childSessions) await send(tabId, 'Target.detachFromTarget', {sessionId}).catch(() => {});
  leases.delete(tabId);
  await chrome.debugger.detach({tabId}).catch(() => {});
}

export async function send(tabId, method, params = {}, sessionId) {
  const target = sessionId ? {tabId, sessionId} : {tabId};
  return chrome.debugger.sendCommand(target, method, params);
}

export async function withDebugger(tabId, work) {
  await attach(tabId);
  try {
    return await work({send: (method, params, sessionId) => send(tabId, method, params, sessionId), tabId});
  } finally {
    const lease = leases.get(tabId);
    if (lease) { lease.count = Math.max(0, lease.count - 1); await releaseLater(tabId); }
  }
}

async function nodeFor(tabId, selector, expect = {}) {
  await send(tabId, 'DOM.enable');
  const {root} = await send(tabId, 'DOM.getDocument', {depth: 0});
  const found = await send(tabId, 'DOM.querySelectorAll', {nodeId: root.nodeId, selector});
  if (found?.nodeIds?.length !== 1) throw Error('TARGET_NOT_UNIQUE');
  const nodeId = found.nodeIds[0];
  const {node} = await send(tabId, 'DOM.describeNode', {nodeId});
  const attributes = {};
  for (let index = 0; index < (node?.attributes || []).length; index += 2) attributes[node.attributes[index]] = node.attributes[index + 1];
  if (expect.tag && node.nodeName !== expect.tag.toUpperCase()) throw Error('TARGET_CHANGED');
  if (expect.type && attributes.type !== expect.type) throw Error('TARGET_CHANGED');
  const {object} = await send(tabId, 'DOM.resolveNode', {nodeId});
  return {nodeId, node, attributes, objectId: object.objectId};
}

async function call(tabId, objectId, declaration, args = []) {
  const response = await send(tabId, 'Runtime.callFunctionOn', {
    objectId, functionDeclaration: declaration, arguments: args.map(value => ({value})), returnByValue: true, awaitPromise: true,
  });
  if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || 'CALL_FAILED');
  return response.result?.value;
}

// 先聚焦并把插入点放到末尾（或全选），再用 Input.insertText 一次性输入。
const PREPARE = `function(mode){
  this.scrollIntoView({block:'center'}); this.focus();
  if (mode === 'select' && typeof this.select === 'function') this.select();
  else if (mode === 'select' && this.isContentEditable) {
    const range = this.ownerDocument.createRange(); range.selectNodeContents(this);
    const selection = this.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  } else if (this.isContentEditable) {
    const range = this.ownerDocument.createRange(); range.selectNodeContents(this); range.collapse(false);
    const selection = this.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  } else if (typeof this.setSelectionRange === 'function') {
    try { this.setSelectionRange(this.value.length, this.value.length); } catch {}
  }
  return true;
}`;
const READ = `function(){ return this.isContentEditable ? (this.textContent||'') : (this.value ?? this.textContent ?? ''); }`;

export async function trustedFill(tabId, selector, text, options = {}) {
  return withDebugger(tabId, async () => {
    const {objectId} = await nodeFor(tabId, selector, options.expect || {});
    try {
      await send(tabId, 'Emulation.setFocusEmulationEnabled', {enabled: true});
      await call(tabId, objectId, PREPARE, [options.clear ? 'select' : 'end']);
      if (text) {
        await send(tabId, 'Input.insertText', {text: String(text)});
      } else if (options.clear) {
        await send(tabId, 'Input.dispatchKeyEvent', {type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8});
        await send(tabId, 'Input.dispatchKeyEvent', {type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8});
      }
      let readback = null, matched = false, attempts = 0;
      // 异步编辑器连续两次回读一致才算成功；超时如实报未知，不重发。
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && attempts < 12) {
        attempts++;
        readback = await call(tabId, objectId, READ);
        const text2 = String(readback ?? '');
        if (text && text2.includes(String(text).slice(0, Math.min(24, String(text).length))) && matched) return {ok: true, readback: text2};
        matched = !!text && text2.includes(String(text).slice(0, Math.min(24, String(text).length)));
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      return text ? {ok: matched, readback, outcomeUnknown: !matched} : {ok: !String(readback || '').trim(), readback};
    } finally {
      await send(tabId, 'Runtime.releaseObject', {objectId}).catch(() => {});
      await send(tabId, 'Emulation.setFocusEmulationEnabled', {enabled: false}).catch(() => {});
    }
  });
}

const KEYS = {Enter: [13, '\r'], Tab: [9, ''], Escape: [27, ''], ArrowDown: [40, ''], ArrowUp: [38, ''], Backspace: [8, '']};

export async function pressKey(tabId, selector, key) {
  const [code, text] = KEYS[key] || [];
  if (!code) throw Error('unsupported key');
  return withDebugger(tabId, async () => {
    if (selector) {
      const {objectId} = await nodeFor(tabId, selector);
      try { await call(tabId, objectId, PREPARE, ['end']); }
      finally { await send(tabId, 'Runtime.releaseObject', {objectId}).catch(() => {}); }
    }
    await send(tabId, 'Emulation.setFocusEmulationEnabled', {enabled: true});
    const base = {key, code: key === 'Enter' ? 'Enter' : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code};
    await send(tabId, 'Input.dispatchKeyEvent', {type: 'keyDown', ...base, ...(text ? {text, unmodifiedText: text} : {})});
    await send(tabId, 'Input.dispatchKeyEvent', {type: 'keyUp', ...base});
    await send(tabId, 'Emulation.setFocusEmulationEnabled', {enabled: false}).catch(() => {});
    return {ok: true, key};
  });
}

export async function clickElement(tabId, selector, options = {}) {
  return withDebugger(tabId, async () => {
    const {objectId} = await nodeFor(tabId, selector);
    let box;
    try {
      box = await call(tabId, objectId, `function(expected){
        this.scrollIntoView({block:'center'});
        const rect = this.getBoundingClientRect();
        if (expected) {
          const name = String(this.getAttribute('aria-label') || this.innerText || this.textContent || '').replace(/\\s+/g, ' ').trim();
          const hit = this.ownerDocument.elementFromPoint(rect.left + rect.width/2, rect.top + rect.height/2);
          if (location.href !== expected.url || document.documentElement.dataset.bkAuthReady !== expected.document ||
              (expected.href && this.closest('a[href]')?.href !== expected.href) ||
              name !== expected.label || this.disabled || this.getAttribute('aria-disabled') === 'true' ||
              !hit || !(hit === this || this.contains(hit))) throw Error('AUTH_TARGET_CHANGED');
        }
        return {x: rect.left + rect.width/2, y: rect.top + rect.height/2, width: rect.width, height: rect.height};
      }`, [options.auth || null]);
    } finally { await send(tabId, 'Runtime.releaseObject', {objectId}).catch(() => {}); }
    if (!box || !box.width) throw Error('TARGET_ZERO_SIZE');
    if (options.authorize && !await options.authorize()) throw Error('AUTH_CANCELLED');
    const point = {x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1};
    await send(tabId, 'Input.dispatchMouseEvent', {type: 'mousePressed', ...point});
    await send(tabId, 'Input.dispatchMouseEvent', {type: 'mouseReleased', ...point});
    return {ok: true, point};
  });
}

export async function uploadByPath(tabId, selector, filePath, allowedRoot) {
  if (!/^\/.+/.test(String(filePath))) throw Error('ARTIFACT_PATH_DENIED');
  if (allowedRoot && !String(filePath).startsWith(allowedRoot)) throw Error('ARTIFACT_PATH_DENIED');
  return withDebugger(tabId, async () => {
    const {nodeId, node, attributes} = await nodeFor(tabId, selector, {tag: 'input', type: 'file'});
    // 上游同样的守则：只认唯一的文件输入，且派发前确认文档没换。
    if (node.nodeName !== 'INPUT' || attributes.type !== 'file') throw Error('NOT_FILE_INPUT');
    await send(tabId, 'DOM.setFileInputFiles', {nodeId, files: [filePath]});
    const {object} = await send(tabId, 'DOM.resolveNode', {nodeId});
    let names = [];
    try {
      names = await call(tabId, object.objectId, `function(){ return Array.from(this.files||[], file => file.name); }`);
    } finally { await send(tabId, 'Runtime.releaseObject', {objectId: object.objectId}).catch(() => {}); }
    const expected = String(filePath).split('/').at(-1);
    return {ok: Array.isArray(names) && names.includes(expected), names, expected};
  });
}

// 跨域 iframe 的备用路径：主路径是内容脚本 all_frames 各跑一份。
export async function ensureAutoAttach(tabId) {
  return withDebugger(tabId, async ({send: sendTo}) => {
    await sendTo('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
    return {ok: true};
  });
}

export function isDebugging(tabId) {
  return leases.has(tabId);
}

export {rankTargets, recoveryReason};
