// 可恢复的扩展执行器；每次 tick 只推进已持久领取的条目，不重放提交。
(function (root) {
  function create({request, storage, tabs, inspect, submit, archive, open, now = Date.now, ownerId}) {
    let busy = false;
    async function result(job, value) {
      if (value.result === 'manual') {
        try { value.frames = await archive(job.tabId); }
        catch (error) { value.reason += '；未存档，勿关标签：' + error.message; }
      }
      const saved = await request('batch_result', {}, {...job, ...value});
      if (value.result === 'success' || value.result === 'failed' || value.result === 'manual' && saved.archive_saved) {
        await tabs.remove(job.tabId).catch(() => {});
      }
      return saved;
    }
    async function tick() {
      if (busy) return;
      busy = true;
      try {
        const owner = await ownerId();
        const saved = await storage.get('batchJobs');
        const active = saved.batchJobs || {};
        const batches = await request('batch_status');
        for (const [id, job] of Object.entries(active)) {
          const batch = batches.find(b => b.id === job.batch_id);
          const current = batch?.jobs.find(j => j.id === id);
          if (!current || current.state !== 'running') {delete active[id]; continue;}
          job.attempted = !!current.attempted_at;
          let tab;
          try {tab = await tabs.get(job.tabId);} catch {tab = null;}
          let outcome;
          const timedOut = now() - job.started * 1000 >= 179000;
          if (!tab) outcome = {result: job.attempted ? 'unknown' : 'failed', reason: '标签页已关闭或浏览器重启'};
          else {
            try {
              const state = await inspect(job.tabId, {attempted: job.attempted, timedOut, baseline: job.baseline, job});
              outcome = state.result ? state : null;
              if (!outcome && !job.attempted && state.canSubmit && batch.state === 'running') {
                job.baseline = state.feedback;
                await storage.set({batchJobs: active});
                // 提交前持久授权在内容脚本回调里完成，超时或重复请求一律拒绝。
                await submit(job.tabId, state.frameId);
              }
              if (!outcome && timedOut) outcome = {result: 'unknown', reason: '单页3分钟超时；不自动重试'};
            } catch (error) {
              if (timedOut) outcome = {result: 'unknown', reason: '页面无反馈：' + error.message};
            }
          }
          if (outcome) {await result(job, outcome); delete active[id]; await storage.set({batchJobs: active});}
        }
        await storage.set({batchJobs: active});
        // 先创建本批全部后台标签，下一次 tick 才填表与判断。
        const claimed = await request('batch_claim', {}, {owner});
        const opening = [];
        for (const job of claimed) {
          try {
            const tab = await tabs.create({url: job.url + (job.url.includes('#') ? '&' : '#') + 'bk=' + job.id, active: false});
            active[job.id] = {...job, tabId: tab.id};
            await storage.set({batchJobs: active});
            opening.push({tabId: tab.id, job});
          } catch (error) {
            await request('batch_result', {}, {...job, result: 'failed', reason: '页面打不开：' + error.message});
            if (active[job.id]) {await tabs.remove(active[job.id].tabId).catch(() => {}); delete active[job.id];}
          }
        }
        await Promise.all(opening.map(async ({tabId, job}) => {
          try {await open(tabId, job);}
          catch (error) {
            await request('batch_result', {}, {...job, result: 'failed', reason: '页面打不开：' + error.message});
            await tabs.remove(tabId).catch(() => {}); delete active[job.id];
          }
        }));
        await storage.set({batchJobs: active});
      } finally {busy = false;}
    }
    return {tick};
  }
  root.BKBatch = {create};
  if (typeof module !== 'undefined') module.exports = root.BKBatch;
})(globalThis);
