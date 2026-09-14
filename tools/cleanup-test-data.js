/**
 * 清理开发测试产生的数据
 *
 * 用法：
 *   node tools/cleanup-test-data.js                  按名称特征清理测试客户及其关联数据
 *   node tools/cleanup-test-data.js --logs           额外清空全部操作日志
 *   node tools/cleanup-test-data.js --purge-deleted  物理删除回收站里的客户
 *   node tools/cleanup-test-data.js --all --yes      清空全部业务数据（需显式 --yes 确认）
 *
 * ⚠ 安全提示：
 *   本脚本按「名称特征」匹配并**物理删除**客户，属于不可逆操作。
 *   PATTERNS 里只应放测试专用词（如「测试」「验收」），
 *   **绝不要放真实企业名**——早期版本曾误放「独山子石化」「天业集团」，
 *   导致真实客户被一并删除（已移除）。
 *   执行前会列出将要删除的客户，请务必核对。
 */

'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = path.resolve(__dirname, '..', 'data', 'crm.db');

/* 仅限测试专用词。真实企业名一律不得加入此处。 */
const PATTERNS = [
  '%渲染测试%', '%交互测试%', '%契约测试%', '%容错测试%', '%还原验证%',
  '%调试客户%', '%测试客户%', '%特殊字符%', '%诊断%',
  '%阶段三测试%', '%阶段四测试%', '%导入测试%',
  '%验收%', '%探针%', '%内联新增%', '%复现%', '%下拉验证%', '%归属验证%', '%脏数据验证%',
  '%演示%', '%POST探针%'
];
/** 项目/待办等测试数据的名称特征 */
const ITEM_PATTERNS = ['%阶段三测试%', '%阶段三交互%', '%交互测试%', '%契约测试%', '%渲染测试%',
  '%验收%', '%探针%', '%演示%'];

const db = new DatabaseSync(DB_FILE);

/* ------------------------------------------------------------------ */
/* --all：把业务数据清空，只留字典与行政区划（测试脚本从空库起跑用）      */
/* ------------------------------------------------------------------ */
if (process.argv.includes('--all')) {
  /* 这是不可逆的整库清空，必须显式加 --yes，避免误触 */
  if (!process.argv.includes('--yes')) {
    const live = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL').get().n;
    const proj = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL').get().n;
    console.log('⚠ --all 会清空全部业务数据（客户 / 项目 / 回款 / 待办 / 标签 / 日志 / 附件），且不可恢复。');
    console.log(`   当前库中有：客户 ${live} 条、项目 ${proj} 条。`);
    console.log('   确认要清空，请加 --yes 重新执行：');
    console.log('     node tools/cleanup-test-data.js --all --yes');
    db.close();
    process.exit(2);
  }

  /* 第二道闸门：即使加了 --yes，若库里存在"看起来是真实业务数据"的客户
     （名称不含任何测试特征词），也拒绝清空 —— 除非再加 --force。
     这条闸门是为了防止在已录入真实数据的库上误跑验收脚本。 */
  const TEST_FEATURE = /测试|验收|探针|演示|复现|验证|诊断|特殊字符|调试|样例/;
  const allLive = db.prepare('SELECT id, name, short_name FROM customers WHERE deleted_at IS NULL').all();
  const realOnes = allLive.filter((c) => !TEST_FEATURE.test(c.name) && !TEST_FEATURE.test(c.short_name || ''));
  if (realOnes.length && !process.argv.includes('--force')) {
    console.log(`⚠ 检测到 ${realOnes.length} 条**看起来是真实业务数据**的客户（名称不含测试特征词）：`);
    for (const c of realOnes.slice(0, 15)) console.log(`     #${c.id}  ${c.name}`);
    if (realOnes.length > 15) console.log(`     …另有 ${realOnes.length - 15} 条`);
    console.log('\n   --all 会把这些数据一并删除且不可恢复。');
    console.log('   · 若你确认这些也是测试数据，请加 --force：');
    console.log('       node tools/cleanup-test-data.js --all --yes --force');
    console.log('   · 若只想清测试数据、保留真实数据，请改用（不带 --all）：');
    console.log('       node tools/cleanup-test-data.js');
    console.log('   · 建议先导出一份备份：设置 → 备份与恢复 → 立即备份');
    db.close();
    process.exit(3);
  }

  db.exec('BEGIN');
  try {
    const n = {};
    for (const t of ['payments', 'tasks', 'followups', 'contacts', 'customer_tags',
      'attachments', 'activity_logs', 'projects', 'customers', 'tags']) {
      n[t] = db.prepare(`DELETE FROM ${t}`).run().changes;
    }
    /* 清掉测试期间新增的自定义字典项，保留系统内置项 */
    n.dict = db.prepare('DELETE FROM dict WHERE is_system = 0').run().changes;
    /* 报价自定义列是**全局配置**，测试建的列必须带走；
       只删带测试前缀的，使用者自己建的列一律不动。 */
    try {
      n.quotation_fields = db.prepare(
        "DELETE FROM quotation_fields WHERE name LIKE '%【列测试%' OR name LIKE '%测试列%'"
      ).run().changes;
    } catch (_) { /* 老库还没这张表 */ }
    db.exec('COMMIT');
    console.log('已清空全部业务数据：');
    for (const [t, c] of Object.entries(n)) console.log(`  ${t}\t${c} 条`);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('清理失败，已回滚：', e.message);
    process.exit(1);
  }
  const live = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  const sysDict = db.prepare('SELECT COUNT(*) AS n FROM dict WHERE is_system = 1').get().n;
  console.log(`\n剩余客户 ${live} 条（应为 0），系统内置字典 ${sysDict} 项`);
  db.close();
  process.exit(0);
}

/* 找出所有测试客户（含已软删除的） */
const ids = new Set();
for (const p of PATTERNS) {
  const rows = db.prepare('SELECT id FROM customers WHERE name LIKE ? OR short_name LIKE ?').all(p, p);
  for (const r of rows) ids.add(r.id);
}

/* 执行前先列出来让人核对——按名称匹配是不可逆物理删除，必须让人看见删的是什么 */
const preview = ids.size
  ? db.prepare(`SELECT id, name, short_name FROM customers
                WHERE id IN (${[...ids].join(',')}) ORDER BY id LIMIT 40`).all()
  : [];
if (preview.length) {
  console.log(`匹配到测试客户 ${ids.size} 条（将物理删除，不可恢复）：`);
  for (const r of preview) console.log(`  #${r.id}  ${r.name}${r.short_name ? '（' + r.short_name + '）' : ''}`);
  if (ids.size > preview.length) console.log(`  …另有 ${ids.size - preview.length} 条未列出`);
  console.log('');
}

/* 保护：若匹配到的客户里出现"看起来像真实企业"的名字（不含任何测试特征词），
   单独提示出来，避免像早期那样把真实客户误删。 */
const SUSPECT = /(有限公司|股份有限公司|集团|分公司|管理局|水利厅|油田|石化|炼化|化工|钢铁|矿业)/;
const suspects = preview.filter((r) => SUSPECT.test(r.name)
  && !/测试|验收|探针|演示|复现|验证|诊断|特殊字符/.test(r.name));
if (suspects.length) {
  console.log('⚠ 下列匹配项看起来像真实企业（名称里没有测试特征词），请确认是否真要删除：');
  for (const r of suspects) console.log(`  #${r.id}  ${r.name}`);
  if (!process.argv.includes('--force')) {
    console.log('\n如确认要删除，请加 --force 重新执行；否则请检查 PATTERNS 是否过于宽泛。');
    db.close();
    process.exit(2);
  }
  console.log('');
}

db.exec('BEGIN');
try {
  /* ---------- 1. 项目 / 回款 / 待办 ----------
   * 只删与测试客户关联的，以及项目名带测试特征的。
   * ⚠️ 早期版本这里是无条件 DELETE 全部，会连真实项目一起删掉——已修正。 */
  const projIds = new Set();
  for (const p of ITEM_PATTERNS) {
    for (const r of db.prepare('SELECT id FROM projects WHERE name LIKE ?').all(p)) projIds.add(r.id);
  }
  for (const r of db.prepare(
    `SELECT id FROM projects WHERE customer_id IN (SELECT id FROM customers WHERE id IN (${ids.size ? [...ids].join(',') : 'NULL'}))`
  ).all()) projIds.add(r.id);

  let payDeleted = 0;
  let taskDeleted = 0;
  let projDeleted = 0;
  for (const pid of projIds) {
    payDeleted += db.prepare('DELETE FROM payments WHERE project_id = ?').run(pid).changes;
    taskDeleted += db.prepare('DELETE FROM tasks WHERE project_id = ?').run(pid).changes;
    projDeleted += db.prepare('DELETE FROM projects WHERE id = ?').run(pid).changes;
  }
  /* 与测试客户直接关联、但不属于上述项目的待办/回款 */
  for (const cid of ids) {
    taskDeleted += db.prepare('DELETE FROM tasks WHERE customer_id = ? AND project_id IS NULL').run(cid).changes;
    payDeleted += db.prepare('DELETE FROM payments WHERE customer_id = ? AND project_id IS NULL').run(cid).changes;
  }
  db.prepare("DELETE FROM activity_logs WHERE entity_type IN ('project','task')").run();

  /* ---------- 2. 清客户及其关联数据 ---------- */
  const delContacts = db.prepare('DELETE FROM contacts WHERE customer_id = ?');
  const delFollows = db.prepare('DELETE FROM followups WHERE customer_id = ?');
  const delTags = db.prepare('DELETE FROM customer_tags WHERE customer_id = ?');
  const delLogs = db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?");
  const delCust = db.prepare('DELETE FROM customers WHERE id = ?');

  for (const id of ids) {
    delContacts.run(id);
    delFollows.run(id);
    delTags.run(id);
    delLogs.run(id);
    delCust.run(id);
  }

  /* ---------- 3. 测试字典行与标签 ----------
   * 特征覆盖：测试脚本自建的选项名、探针名、内联新增名，以及改名后遗留的「-已改名」后缀。 */
  const dictDeleted = db.prepare(
    `DELETE FROM dict WHERE is_system = 0 AND (
       value LIKE '%测试%' OR value LIKE '%验收%' OR value LIKE '%探针%'
       OR value LIKE '%内联新增%' OR value LIKE '%-已改名'
       OR value LIKE '__deleted_%'
     )`
  ).run().changes;

  const tagDeleted = db.prepare(
    "DELETE FROM tags WHERE name IN ('重点跟进','待开发')"
  ).run().changes;

  db.exec('COMMIT');
  console.log(`已删除项目 ${projDeleted} 个、回款 ${payDeleted} 条、待办 ${taskDeleted} 条`);
  console.log(`已删除客户 ${ids.size} 条、字典残留 ${dictDeleted} 项、测试标签 ${tagDeleted} 个`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('清理失败，已回滚：', e.message);
  process.exit(1);
}

/* 清理孤儿数据（其所属客户已不存在） */
const orphanContacts = db.prepare(
  'DELETE FROM contacts WHERE customer_id NOT IN (SELECT id FROM customers)'
).run().changes;
const orphanFollows = db.prepare(
  'DELETE FROM followups WHERE customer_id NOT IN (SELECT id FROM customers)'
).run().changes;
/* 客户已软删除的跟进记录也一并清掉，避免留下孤儿数据 */
const softDeletedFollows = db.prepare(
  `DELETE FROM followups WHERE customer_id IN (SELECT id FROM customers WHERE deleted_at IS NOT NULL)`
).run().changes;
if (orphanContacts || orphanFollows || softDeletedFollows) {
  console.log(`顺带清理：联系人 ${orphanContacts} 条、孤儿跟进 ${orphanFollows} 条、已删客户的跟进 ${softDeletedFollows} 条`);
}

/* 可选：清空操作日志（--logs），让交付时的数据库完全干净 */
if (process.argv.includes('--logs')) {
  const cleared = db.prepare('DELETE FROM activity_logs').run().changes;
  console.log(`已清空全部操作日志 ${cleared} 条`);
}

/* 可选：物理删除已软删除的客户及其残留关联（--purge-deleted）
 * 交付前用，避免回收站里留着一堆测试期删掉的空壳行。 */
if (process.argv.includes('--purge-deleted')) {
  const trashIds = db.prepare('SELECT id FROM customers WHERE deleted_at IS NOT NULL').all().map((r) => r.id);
  let n = 0;
  for (const id of trashIds) {
    db.prepare('DELETE FROM contacts WHERE customer_id = ?').run(id);
    db.prepare('DELETE FROM followups WHERE customer_id = ?').run(id);
    db.prepare('DELETE FROM customer_tags WHERE customer_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE customer_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE customer_id = ?').run(id);
    db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(id);
    n += db.prepare('DELETE FROM customers WHERE id = ?').run(id).changes;
  }
  const orphanPay = db.prepare('DELETE FROM payments WHERE project_id NOT IN (SELECT id FROM projects)').run().changes;
  /* 附件的磁盘文件在删除时已被移除，这里清掉数据库里的软删除墓碑记录 */
  const attTomb = db.prepare('DELETE FROM attachments WHERE deleted_at IS NOT NULL').run().changes;
  console.log(`已物理删除回收站中的客户 ${n} 条（含残留关联与孤儿回款 ${orphanPay} 条），`
    + `附件墓碑记录 ${attTomb} 条`);
}

/* 现状统计 */
const total = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
const live = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL').get().n;
const dictCat = db.prepare('SELECT COUNT(*) AS n FROM (SELECT DISTINCT category FROM dict WHERE deleted_at IS NULL)').get().n;
const dictItems = db.prepare('SELECT COUNT(*) AS n FROM dict WHERE deleted_at IS NULL').get().n;
const contacts = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
const followups = db.prepare('SELECT COUNT(*) AS n FROM followups').get().n;
const logs = db.prepare('SELECT COUNT(*) AS n FROM activity_logs').get().n;

console.log('');
console.log('--- 当前数据库状态 ---');
console.log(`客户        ${total} 条（未删除 ${live} 条）`);
console.log(`联系人      ${contacts} 条`);
console.log(`跟进记录    ${followups} 条`);
console.log(`操作日志    ${logs} 条`);
console.log(`字典        ${dictCat} 类 / ${dictItems} 项`);

db.close();
