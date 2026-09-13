/**
 * 备份目录清理：验收测试期间产生了大量测试数据备份，
 * 这里保留每类最新的 N 份，其余删除；镜像目录同步处理。
 *
 * 用法：
 *   node tools/cleanup-backups.js            保留主目录最新 2 份、镜像最新 1 份
 *   node tools/cleanup-backups.js --keep 5   自定义保留份数
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'data', 'backups');
const MIRROR = path.join(MAIN, 'mirror');

const argKeep = process.argv.indexOf('--keep');
const KEEP_MAIN = argKeep > 0 ? Number(process.argv[argKeep + 1]) || 2 : 2;
const KEEP_MIRROR = 1;

function clean(dir, keep, label) {
  if (!fs.existsSync(dir)) {
    console.log(`${label}：目录不存在，跳过`);
    return { removed: 0, kept: 0 };
  }
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  const keepSet = new Set(files.slice(0, keep).map((x) => x.f));
  let removed = 0;
  for (const x of files) {
    if (keepSet.has(x.f)) continue;
    fs.rmSync(path.join(dir, x.f), { force: true });
    const manifest = path.join(dir, x.f.replace(/\.db$/, '.json'));
    if (fs.existsSync(manifest)) fs.rmSync(manifest, { force: true });
    removed++;
  }
  console.log(`${label}：原有 ${files.length} 份，保留 ${Math.min(keep, files.length)} 份，删除 ${removed} 份`);
  for (const x of files.slice(0, keep)) console.log(`   保留 ${x.f}`);
  return { removed, kept: Math.min(keep, files.length) };
}

console.log('=== 备份目录清理 ===');
const a = clean(MAIN, KEEP_MAIN, '主备份目录 data/backups');
const b = clean(MIRROR, KEEP_MIRROR, '镜像目录 data/backups/mirror');
console.log(`\n合计删除 ${a.removed + b.removed} 份，保留 ${a.kept + b.kept} 份。`);
