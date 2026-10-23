#!/usr/bin/env node
// 从 Fast-browser-link 的发布目录同步 vendor/fbl/。不手改 vendor 里的文件，只整体拷贝。
// 用法：node extension/vendor/fbl/sync-fbl.mjs [--check]
//   --check 默认只核固定副本；显式设置FBL_DIR时比对上游。同步也必须显式设置FBL_DIR。
import {createHash} from 'node:crypto';
import {readFile, writeFile, copyFile, access} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes('--check');
const versionPath = join(here, 'VERSION.json');
const version = JSON.parse(await readFile(versionPath, 'utf8'));
const upstream = process.env.FBL_DIR;
const sha = data => createHash('sha256').update(data).digest('hex');

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

if (check && !upstream) {
  const mismatched = [];
  for (const [name, record] of Object.entries(version.files)) {
    const target = join(here, name);
    if (!(await exists(target)) || sha(await readFile(target)) !== record.sha256) mismatched.push(name);
  }
  console.log(JSON.stringify({mode: 'pinned', upstreamCompared: false, mismatched, check: true}, null, 2));
  process.exit(mismatched.length ? 1 : 0);
}
if (!upstream || !(await exists(upstream))) {
  console.error('请设置 FBL_DIR 指向已获授权的 native-extension 目录。固定副本校验无需上游目录：使用 --check。');
  process.exit(2);
}

const report = {upstream, changed: [], same: [], missing: []};
for (const name of Object.keys(version.files)) {
  const source = resolve(upstream, name);
  if (!(await exists(source))) { report.missing.push(name); continue; }
  const incoming = await readFile(source);
  const target = join(here, name);
  const current = await exists(target) ? await readFile(target) : null;
  const record = {sha256: sha(incoming), bytes: incoming.length, lines: incoming.toString('utf8').split('\n').length};
  if (current && sha(current) === record.sha256) { report.same.push(name); version.files[name] = record; continue; }
  report.changed.push(name);
  if (!check) {
    await copyFile(source, target);
    version.files[name] = record;
  }
}
if (!check && report.changed.length) {
  version.synced_at = new Date().toISOString().slice(0, 10);
  await writeFile(versionPath, JSON.stringify(version, null, 2) + '\n');
}
console.log(JSON.stringify({...report, check, synced_at: version.synced_at}, null, 2));
process.exit(report.missing.length || (check && report.changed.length) ? 1 : 0);
