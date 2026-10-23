// IndexedDB 小封装：日志环形缓冲、快照多版本、元数据。扩展页和后台共用。
(function (root) {
  const DB_NAME = 'fast-backlink', DB_VERSION = 1;
  let handle = null;

  function open() {
    if (handle) return Promise.resolve(handle);
    handle = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('logs')) {
          const logs = db.createObjectStore('logs', {keyPath: 'seq', autoIncrement: true});
          logs.createIndex('ts', 'ts');
        }
        if (!db.objectStoreNames.contains('snapshots')) {
          const snapshots = db.createObjectStore('snapshots', {keyPath: 'key'});
          snapshots.createIndex('created_at', 'created_at');
          snapshots.createIndex('form', 'form');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath: 'k'});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return handle;
  }

  const wrap = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  async function store(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  async function put(name, value) { return wrap((await store(name, 'readwrite')).put(value)); }
  async function get(name, key) { return wrap((await store(name, 'readonly')).get(key)); }
  async function all(name) { return wrap((await store(name, 'readonly')).getAll()); }
  async function count(name) { return wrap((await store(name, 'readonly')).count()); }
  async function remove(name, key) { return wrap((await store(name, 'readwrite')).delete(key)); }

  async function byIndex(name, index, value) {
    const target = await store(name, 'readonly');
    return wrap(target.index(index).getAll(value));
  }

  // 日志超过上限就删最旧的，保持环形缓冲。
  async function trimLogs(max, days) {
    const target = await store('logs', 'readwrite');
    const total = await wrap(target.count());
    if (total <= max) {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const cursor = target.index('ts').openCursor(IDBKeyRange.upperBound(cutoff));
      let removed = 0;
      await new Promise(resolve => {
        cursor.onsuccess = () => {
          const point = cursor.result;
          if (!point) return resolve();
          point.delete(); removed++;
          point.continue();
        };
        cursor.onerror = () => resolve();
      });
      return removed;
    }
    const extra = total - max;
    const cursor = target.openCursor();
    let removed = 0;
    await new Promise(resolve => {
      cursor.onsuccess = () => {
        const point = cursor.result;
        if (!point || removed >= extra) return resolve();
        point.delete(); removed++;
        point.continue();
      };
      cursor.onerror = () => resolve();
    });
    return removed;
  }

  async function trimSnapshots(keep, days) {
    const items = await all('snapshots');
    const cutoff = Date.now() - days * 86400000;
    const grouped = new Map();
    const removed = [];
    for (const item of items) {
      const stamp = Date.parse(item.created_at || 0);
      if (!Number.isFinite(stamp) || stamp < cutoff) { removed.push(item.key); continue; }
      const group = item.site + '|' + item.form;
      const bucket = grouped.get(group) || [];
      bucket.push(item); grouped.set(group, bucket);
    }
    for (const bucket of grouped.values()) {
      bucket.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      for (const item of bucket.slice(keep)) removed.push(item.key);
    }
    for (const key of removed) await remove('snapshots', key);
    return removed.length;
  }

  root.BKIdb = {open, put, get, all, count, remove, byIndex, trimLogs, trimSnapshots, DB_NAME};
  if (typeof module !== 'undefined' && typeof indexedDB === 'undefined') module.exports = root.BKIdb;
})(globalThis);
