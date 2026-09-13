/**
 * 从备份中单独取回某一家客户及其关联数据。
 *
 * 为什么不用「整库恢复」：整库恢复会把数据库回滚到备份时刻，
 * 连带丢掉备份之后的所有改动（其它客户、字典、设置等）。
 * 误删单一客户时，只回填这一家更安全。
 *
 * 用法：
 *   node tools/restore-customer-from-backup.js <备份文件名> [客户名关键字]
 *   node tools/restore-customer-from-backup.js crm-20260913-185802-3390c.db "独山子石化"
 *
 * 特性：
 *   - 默认 dry-run（只报告将写入什么）；加 --apply 才真正写入
 *   - 关联数据（联系人/跟进/待办/标签/项目）一并回填，并做 ID 重映射
 *   - 遇到同名客户时跳过，避免造出重复客户
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'crm.db');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const positional = args.filter((a) => !a.startsWith('--'));
const BACKUP_NAME = positional[0];
const KEYWORD = positional[1] || '独山子石化';

if (!BACKUP_NAME) {
  console.error('用法：node tools/restore-customer-from-backup.js <备份文件名> [客户名关键字] [--apply]');
  console.error('先跑 node tools/find-customer-in-backups.js 查看可用备份。');
  process.exit(2);
}

/* 备份文件可能在主目录或镜像目录 */
const CANDIDATES = [
  path.join(ROOT, 'data', 'backups', BACKUP_NAME),
  path.join(ROOT, 'data', 'backups', 'mirror', BACKUP_NAME)
];
const BACKUP = CANDIDATES.find((p) => fs.existsSync(p));
if (!BACKUP) {
  console.error(`找不到备份文件：${BACKUP_NAME}`);
  process.exit(2);
}

const now = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const src = new DatabaseSync(BACKUP, { readOnly: true });
const dst = new DatabaseSync(DB_FILE);

/** 读取表的所有列名 */
function cols(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

/** 在目标库插入一行，返回新 id（自动忽略自增主键与目标库不存在的列） */
function insertRow(table, row) {
  const dstCols = cols(dst, table);
  const keys = Object.keys(row).filter((k) => k !== 'id' && dstCols.includes(k));
  const info = dst.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...keys.map((k) => row[k]));
  return Number(info.lastInsertRowid);
}

console.log('=== 从备份回填客户 ===');
console.log(`备份：${path.relative(ROOT, BACKUP)}`);
console.log(`关键字：${KEYWORD}`);
console.log(`模式：${APPLY ? '实际写入（--apply）' : '预演（只报告，不写入）'}\n`);

/* 1) 在备份里找客户 */
const found = src.prepare(
  'SELECT * FROM customers WHERE name LIKE ? OR short_name LIKE ? ORDER BY id'
).all(`%${KEYWORD}%`, `%${KEYWORD}%`);

if (!found.length) {
  console.log('备份里没有匹配的客户。');
  src.close(); dst.close();
  process.exit(1);
}

/* 优先取关联数据最多的那一条（可能有同名的空壳记录） */
const score = (c) => {
  const n = (sql) => { try { return src.prepare(sql).get(c.id).n; } catch (_) { return 0; } };
  return n('SELECT COUNT(*) AS n FROM contacts WHERE customer_id = ?')
    + n('SELECT COUNT(*) AS n FROM followups WHERE customer_id = ?')
    + n('SELECT COUNT(*) AS n FROM projects WHERE customer_id = ?')
    + n('SELECT COUNT(*) AS n FROM tasks WHERE customer_id = ?')
    + n('SELECT COUNT(*) AS n FROM customer_tags WHERE customer_id = ?');
};
const pick = found.reduce((a, b) => (score(b) > score(a) ? b : a));
const srcId = pick.id;

console.log(`选中备份中的客户 #${srcId}：${pick.name}`);
console.log(`  地址：${pick.city || '—'} / ${pick.district || '—'}`);
console.log(`  归属：${pick.region_code || '—'} ${pick.region_name || ''}`);

/* 2) 检查目标库是否已有同名客户 */
const dup = dst.prepare('SELECT id, deleted_at FROM customers WHERE name = ?').all(pick.name);
if (dup.length) {
  console.log(`\n目标库中已存在同名客户 ${dup.length} 条（id: ${dup.map((x) => x.id).join(', ')}），不重复写入。`);
  console.log('如需强制回填，请先删除或改名后再执行。');
  src.close(); dst.close();
  process.exit(0);
}

/* 3) 收集关联数据 */
const rel = {
  contacts: src.prepare('SELECT * FROM contacts WHERE customer_id = ?').all(srcId),
  followups: src.prepare('SELECT * FROM followups WHERE customer_id = ?').all(srcId),
  customer_tags: src.prepare('SELECT * FROM customer_tags WHERE customer_id = ?').all(srcId),
  tasks: src.prepare('SELECT * FROM tasks WHERE customer_id = ?').all(srcId),
  projects: src.prepare('SELECT * FROM projects WHERE customer_id = ?').all(srcId),
  attachments: src.prepare("SELECT * FROM attachments WHERE owner_type = 'customer' AND owner_id = ?").all(srcId)
};
console.log('\n将回填的关联数据：');
for (const [k, v] of Object.entries(rel)) console.log(`  ${k}: ${v.length} 条`);

if (!APPLY) {
  console.log('\n这是预演。确认无误后加 --apply 实际执行：');
  console.log(`  node tools/restore-customer-from-backup.js ${BACKUP_NAME} "${KEYWORD}" --apply`);
  src.close(); dst.close();
  process.exit(0);
}

/**
 * 把从备份读到的一行整理成"回填后应为"的样子：
 *   - 清掉 deleted_at（回填的目的是让数据重新可用，不该带着删除标记）
 *   - 清掉旧的 id（目标库会分配新 id）
 */
function forInsert(row) {
  const out = Object.assign({}, row);
  delete out.id;
  if ('deleted_at' in out) out.deleted_at = null;
  return out;
}

/* 4) 实际写入 */
const ts = now();
dst.exec('BEGIN');
try {
  const newId = insertRow('customers', Object.assign(forInsert(pick), { updated_at: ts }));

  /* 关联数据重建，并把 customer_id 指向新 id；同样清掉删除标记 */
  let nContact = 0; let nFollow = 0; let nTag = 0; let nTask = 0; let nProj = 0;
  for (const r of rel.contacts) { insertRow('contacts', Object.assign(forInsert(r), { customer_id: newId })); nContact++; }
  for (const r of rel.followups) { insertRow('followups', Object.assign(forInsert(r), { customer_id: newId })); nFollow++; }
  for (const r of rel.customer_tags) { insertRow('customer_tags', Object.assign(forInsert(r), { customer_id: newId })); nTag++; }
  for (const r of rel.tasks) { insertRow('tasks', Object.assign(forInsert(r), { customer_id: newId })); nTask++; }

  /* 项目回填需重映射：项目详情里可能引用其它表，这里只回填项目本身 */
  for (const r of rel.projects) { insertRow('projects', Object.assign(forInsert(r), { customer_id: newId })); nProj++; }

  /* 附件：数据库记录回填，但磁盘文件早已被删除，因此只回填元信息会指向空文件，
     这里明确跳过，并在结果里告知用户。 */

  /* 补一条操作日志，说明数据来源，便于日后追溯 */
  dst.prepare(
    `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
     VALUES ('customer', ?, 'restore_extra', ?, ?, ?)`
  ).run(newId, `从备份回填客户：${pick.name}`, JSON.stringify({
    from_backup: BACKUP_NAME, source_customer_id: srcId,
    contacts: nContact, followups: nFollow, tags: nTag, tasks: nTask, projects: nProj
  }), ts);

  dst.exec('COMMIT');
  console.log(`\n✓ 已回填客户 #${newId}：${pick.name}`);
  console.log(`  联系人 ${nContact}、跟进 ${nFollow}、标签 ${nTag}、待办 ${nTask}、项目 ${nProj}`);
  if (rel.attachments.length) {
    console.log(`  注意：该客户原有 ${rel.attachments.length} 个附件，磁盘文件已不在，未回填；如需要请从别处拷贝到 data/attachments 后手动登记。`);
  }

  /* 5) 回填后重新计算归属地州，确保与当前匹配逻辑一致 */
  try {
    const crm = require(path.join(ROOT, 'server', 'services', 'crm.js'));
    const r = crm.syncCustomerRegion(dst, newId);
    const after = dst.prepare('SELECT region_code, region_name FROM customers WHERE id = ?').get(newId);
    console.log(`  归属地州：${after.region_code || '（空）'} ${after.region_name || ''}${r ? '（已按地址重新匹配）' : ''}`);
  } catch (e) {
    console.log('  （归属地州重算失败，可稍后在界面上重新保存该客户）' + e.message);
  }
} catch (e) {
  try { dst.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
  console.error('\n✗ 回填失败，已回滚：' + e.message);
  src.close(); dst.close();
  process.exit(1);
}

src.close();
dst.close();
