const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

test('公开副本的vendor检查只需固定哈希，不依赖作者的本机上游目录', () => {
  const env = {...process.env}; delete env.FBL_DIR;
  const result = spawnSync(process.execPath, ['extension/vendor/fbl/sync-fbl.mjs', '--check'],
    {cwd:path.resolve(__dirname,'../..'), env, encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode,'pinned');
  assert.equal(report.upstreamCompared,false);
  assert.doesNotMatch(result.stdout,/\/Users\/|\\Users\\/);
});
