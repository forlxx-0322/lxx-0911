/**
 * 在数据库副本上验证 v4 → v5 迁移，不碰真实库。
 *
 * 用法：node tools/test-migration-v5.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const REAL_DB = path.join(ROOT, 'data', 'crm.db');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

(async () => {
  console.log('=== v4 → v5 迁移验证（在副本上进行）===\n');

  /* 1. 复制真实库到临时目录 */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig5-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(REAL_DB, path.join(dataDir, 'crm.db'));
  fs.mkdirSync(path.join(dataDir, 'attachments'), { recursive: true });

  /* 2. 记录迁移前的数据量与结构版本 */
  const before = new DatabaseSync(path.join(dataDir, 'crm.db'), { readOnly: true });
  const vBefore = before.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  const countsBefore = {
    customers: before.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
    contacts: before.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
    followups: before.prepare('SELECT COUNT(*) AS n FROM followups').get().n,
    tasks: before.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
    projects: before.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
    payments: before.prepare('SELECT COUNT(*) AS n FROM payments').get().n,
    dict: before.prepare('SELECT COUNT(*) AS n FROM dict').get().n
  };
  const tablesBefore = before.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const projectsColsBefore = before.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  const firstCustomer = before.prepare('SELECT id, name, address, region_code FROM customers ORDER BY id LIMIT 1').get();
  before.close();

  console.log(`迁移前：结构版本 v${vBefore}，表 ${tablesBefore.length} 张`);
  console.log(`        客户 ${countsBefore.customers}、联系人 ${countsBefore.contacts}、跟进 ${countsBefore.followups}、待办 ${countsBefore.tasks}、字典 ${countsBefore.dict}`);
  console.log('');

  check('副本中的库是 v4（迁移前状态）', vBefore === 4, `v${vBefore}`);

  /* 3. 用副本目录跑一次真实的建库/迁移流程 */
  const origRoot = process.env.CRM_ROOT;
  process.env.CRM_ROOT = tmp;
  /* 清掉模块缓存，确保 db.js 用新的 CRM_ROOT 重新解析路径 */
  Object.keys(require.cache).forEach((k) => {
    if (k.includes(path.join('server', 'db.js'))) delete require.cache[k];
  });

  let info = null;
  try {
    const dbMod = require(path.join(ROOT, 'server', 'db.js'));
    info = dbMod.initDatabase({
      dataDir,
      dbFile: path.join(dataDir, 'crm.db'),
      backupDir: path.join(dataDir, 'backups')
    });
    console.log(`迁移结果：v${info.fromVersion} → v${info.schemaVersion}，执行 ${info.migrations.length} 步`);
    for (const line of info.migrations) console.log('  · ' + line);
    console.log('');
  } catch (e) {
    console.error('迁移失败：' + (e.stack || e.message));
    process.exit(1);
  } finally {
    if (origRoot === undefined) delete process.env.CRM_ROOT; else process.env.CRM_ROOT = origRoot;
  }

  /* 4. 校验结果 */
  const after = new DatabaseSync(path.join(dataDir, 'crm.db'), { readOnly: true });
  const vAfter = after.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  const tablesAfter = after.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const countsAfter = {
    customers: after.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
    contacts: after.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
    followups: after.prepare('SELECT COUNT(*) AS n FROM followups').get().n,
    tasks: after.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
    projects: after.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
    payments: after.prepare('SELECT COUNT(*) AS n FROM payments').get().n,
    dict: after.prepare('SELECT COUNT(*) AS n FROM dict').get().n
  };
  const firstCustomerAfter = after.prepare('SELECT id, name, address, region_code FROM customers ORDER BY id LIMIT 1').get();
  const projectsColsAfter = after.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  const quoCols = after.prepare('PRAGMA table_info(quotations)').all().map((c) => c.name);
  const itemCols = after.prepare('PRAGMA table_info(quotation_items)').all().map((c) => c.name);
  const quoIdx = after.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('quotations','quotation_items')").all().map((r) => r.name);
  const quoteDict = after.prepare("SELECT value, enabled FROM dict WHERE category='quotation_status' AND deleted_at IS NULL ORDER BY sort").all();
  const settings = after.prepare("SELECT key, value FROM settings WHERE key IN ('remind_email_on','smtp_host','follow_remind_time','quote_no_prefix')").all();
  after.close();

  check('结构版本已升到 v5', vAfter === 5, `v${vAfter}`);
  check('新建 quotations 表', tablesAfter.includes('quotations'), `列数 ${quoCols.length}`);
  check('新建 quotation_items 表', tablesAfter.includes('quotation_items'), `列数 ${itemCols.length}`);
  check('报价单索引已建立', quoIdx.length >= 6, quoIdx.join('、'));
  check('quotations 必需列齐全',
    ['id', 'project_id', 'customer_id', 'quote_no', 'version', 'status', 'total_amount', 'competitor_price', 'lose_reason', 'deleted_at']
      .every((c) => quoCols.includes(c)),
    quoCols.length + ' 列');
  check('quotation_items 必需列齐全',
    ['quotation_id', 'seq', 'valve_type', 'size_range', 'pressure_rating', 'body_material', 'quantity', 'unit_price', 'discount', 'subtotal']
      .every((c) => itemCols.includes(c)),
    itemCols.length + ' 列');

  check('报价单状态字典已预置 5 项',
    quoteDict.length === 5 && quoteDict.every((d) => d.enabled === 1),
    quoteDict.map((d) => d.value).join('、'));

  check('提醒与 SMTP 设置项已预置',
    settings.length === 4, settings.map((s) => `${s.key}=${s.value}`).join('；'));

  /* 关键：既有业务数据一条不少。
     注意 dict（字典）会按设计增加——迁移预置了 5 个报价单状态项，
     所以只校验业务数据，字典单独断言。 */
  let dataOk = true;
  const diffs = [];
  for (const [k, v] of Object.entries(countsBefore)) {
    if (k === 'dict') continue;
    if (countsAfter[k] !== v) { dataOk = false; diffs.push(`${k}: ${v} → ${countsAfter[k]}`); }
  }
  check('既有业务数据一条未变', dataOk, diffs.length ? diffs.join('；') : '客户/联系人/跟进/待办/项目/回款计数一致');

  /* 字典只应有新增，不应有减少 */
  check('字典项只增不减（迁移预置 5 个报价单状态）',
    countsAfter.dict === countsBefore.dict + 5,
    `字典 ${countsBefore.dict} → ${countsAfter.dict}（+${countsAfter.dict - countsBefore.dict}）`);

  check('既有客户数据内容未变（地址、归属保留）',
    firstCustomer && firstCustomerAfter
    && firstCustomer.id === firstCustomerAfter.id
    && firstCustomer.address === firstCustomerAfter.address
    && firstCustomer.region_code === firstCustomerAfter.region_code,
    firstCustomerAfter ? `#${firstCustomerAfter.id} ${firstCustomerAfter.name}，地址="${firstCustomerAfter.address}"，归属=${firstCustomerAfter.region_code}` : '无客户');

  /* 本批不应改动 projects 表 */
  check('未改动 projects 表结构（本批不加列）',
    projectsColsAfter.length === projectsColsBefore.length
    && projectsColsBefore.every((c) => projectsColsAfter.includes(c)),
    `${projectsColsBefore.length} 列保持`);

  /* 5. 幂等性：再跑一次不应重复迁移 */
  process.env.CRM_ROOT = tmp;
  let info2 = null;
  try {
    Object.keys(require.cache).forEach((k) => {
      if (k.includes(path.join('server', 'db.js'))) delete require.cache[k];
    });
    const dbMod2 = require(path.join(ROOT, 'server', 'db.js'));
    info2 = dbMod2.initDatabase({
      dataDir,
      dbFile: path.join(dataDir, 'crm.db'),
      backupDir: path.join(dataDir, 'backups')
    });
  } finally {
    if (origRoot === undefined) delete process.env.CRM_ROOT; else process.env.CRM_ROOT = origRoot;
  }
  check('重复启动不会重复迁移（幂等）',
    info2.migrations.length === 0 && info2.schemaVersion === 5,
    `二次启动执行 ${info2.migrations.length} 步，版本 v${info2.schemaVersion}`);

  /* 清理 */
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'migration-v5-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常：', e.stack || e); process.exit(1); });
