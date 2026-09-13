/**
 * 数据库结构迁移验证
 *
 * 场景：模拟一个 v1 结构的旧数据库（含 reg_capital 列与数据），
 *       验证升级到 v2 时：
 *         1. 自动备份旧库
 *         2. 正确删除 reg_capital 列
 *         3. 其余字段与业务数据完整保留
 *         4. 版本号更新为 2
 *         5. 重复执行不会重复迁移（幂等）
 *
 * 用法：node tools/test-migration.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { initDatabase, closeDatabase, SCHEMA_VERSION } = require('../server/db');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

/**
 * 从当前的 customers 建表语句反推出 v1 结构：
 * 在`scale`列之后插回 `reg_capital` 列。
 * 这样旧库除该字段外与真实 v1 完全一致，避免手工列字段漏项。
 */
function buildLegacyCustomersDDL() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
  const m = src.match(/CREATE TABLE IF NOT EXISTS customers \(([\s\S]*?)\n  \)`/);
  if (!m) throw new Error('未能从 db.js 中解析出 customers 建表语句');

  const lines = m[1].split('\n');
  const out = [];
  for (const line of lines) {
    out.push(line);
    if (/^\s*scale\s+TEXT/.test(line)) {
      out.push('    reg_capital       REAL NOT NULL DEFAULT 0,');
    }
  }
  return `CREATE TABLE IF NOT EXISTS customers (${out.join('\n')}\n  )`;
}

/* 造一个「旧库」：v1 结构 —— 客户表带 reg_capital，版本号记为 1 */
function makeLegacyDb(file) {
  const db = new DatabaseSync(file);
  db.exec(buildLegacyCustomersDDL());
  db.exec(`CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
  )`);
  db.prepare('INSERT INTO schema_version (version, applied_at, note) VALUES (1, ?, ?)')
    .run('2026-01-01T00:00:00', '初始建库');

  const ins = db.prepare(
    `INSERT INTO customers (name, short_name, type, industry, scale, reg_capital, annual_demand, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const ts = '2026-01-15T09:00:00';
  ins.run('中国石油独山子石化分公司', '独山子石化', '终端用户', '石油', '大型', 500000, 800, ts, ts);
  ins.run('新疆天成阀门销售有限公司', '天成阀门', '贸易商/经销商', '化工', '中型', 1000, 120, ts, ts);
  ins.run('宝钢集团新疆八一钢铁有限公司', '八一钢铁', '终端用户', '冶金', '大型', 2000000, 1500, ts, ts);
  db.close();
}

(async () => {
  console.log('=== 数据库结构迁移验证（v1 → v2）===\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crmmig-'));
  const dataDir = path.join(tmp, 'data');
  const backupDir = path.join(dataDir, 'backups');
  const dbFile = path.join(dataDir, 'crm.db');

  /* 必须先建好 data 目录再放旧库文件：
     initDatabase 以「文件是否已存在」判定新库/旧库，
     真实运行流程是 server.js 先 prepareDirs() 再建库，这里保持一致。 */
  fs.mkdirSync(backupDir, { recursive: true });
  makeLegacyDb(dbFile);

  /* 迁移前状态 */
  const before = new DatabaseSync(dbFile);
  const beforeCols = before.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  const beforeRows = before.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  const beforeVer = before.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  before.close();

  check('测试库已构造为 v1 结构（含 reg_capital 列）',
    beforeCols.includes('reg_capital') && beforeRows === 3 && beforeVer === 1,
    `版本 v${beforeVer}，${beforeRows} 条客户，含 reg_capital=${beforeCols.includes('reg_capital')}`);

  /* 执行迁移 */
  const info = initDatabase({ dataDir, dbFile, backupDir });

  check('迁移被正确识别并逐级执行',
    info.migrated === true && info.fromVersion === 1 && info.schemaVersion === SCHEMA_VERSION,
    `v${info.fromVersion} → v${info.schemaVersion}（代码当前 v${SCHEMA_VERSION}），执行 ${info.migrations.length} 步：${info.migrations.join('；')}`);

  check('迁移前自动备份了旧库',
    !!info.backedUpTo && fs.existsSync(info.backedUpTo),
    info.backedUpTo ? path.basename(info.backedUpTo) + `（${Math.round(fs.statSync(info.backedUpTo).size / 1024)} KB）` : '未生成备份');

  /* 备份文件应当是迁移前的结构（仍含 reg_capital） */
  if (info.backedUpTo) {
    const bak = new DatabaseSync(info.backedUpTo, { readOnly: true });
    const bakCols = bak.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
    const bakRows = bak.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
    const bakReg = bak.prepare('SELECT name, reg_capital FROM customers ORDER BY id LIMIT 1').get();
    bak.close();
    check('备份文件保留迁移前完整结构（可随时回滚）',
      bakCols.includes('reg_capital') && bakRows === 3 && bakReg.reg_capital === 500000,
      `备份含 reg_capital=${bakCols.includes('reg_capital')}，${bakRows} 条数据，首条注册资金=${bakReg.reg_capital}`);
  } else {
    check('备份文件保留迁移前完整结构（可随时回滚）', false, '无备份文件');
  }

  /* 迁移后校验 */
  const db = info.db;
  const afterCols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  const afterCount = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  const afterVer = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  const first = db.prepare('SELECT name, short_name, industry, scale, annual_demand FROM customers WHERE id = 1').get();
  const names = db.prepare('SELECT name FROM customers ORDER BY id').all().map((r) => r.name);

  check('reg_capital 列已被删除',
    !afterCols.includes('reg_capital'),
    `客户表共 ${afterCols.length} 列，已无 reg_capital`);

  check('业务数据完整保留（3 条客户未丢失）',
    afterCount === 3 && names.length === 3,
    `${afterCount} 条：${names.map((n) => n.slice(0, 8)).join(' / ')}`);

  check('其余字段值未被破坏',
    first && first.short_name === '独山子石化' && first.industry === '石油'
      && first.scale === '大型' && first.annual_demand === 800,
    `简称=${first && first.short_name}，行业=${first && first.industry}，规模=${first && first.scale}，年需求=${first && first.annual_demand}`);

  check('版本号已更新为代码当前版本',
    afterVer === SCHEMA_VERSION,
    `schema_version = ${afterVer}（代码当前 v${SCHEMA_VERSION}）`);

  /* 新库应直接是 v2 结构（不经过迁移） */
  const freshDir = path.join(tmp, 'fresh');
  const fresh = initDatabase({
    dataDir: freshDir,
    dbFile: path.join(freshDir, 'crm.db'),
    backupDir: path.join(freshDir, 'backups')
  });
  const freshCols = fresh.db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  check('全新数据库直接建为最新结构（不会留下已删除字段）',
    !freshCols.includes('reg_capital') && fresh.created === true
      && fresh.schemaVersion === SCHEMA_VERSION && fresh.backedUpTo === null,
    `全新建库=${fresh.created}，版本 v${fresh.schemaVersion}，含 reg_capital=${freshCols.includes('reg_capital')}，无谓备份=${fresh.backedUpTo === null}`);
  closeDatabase(fresh.db);

  /* 幂等性：再次初始化不应重复迁移 */
  closeDatabase(db);
  const again = initDatabase({ dataDir, dbFile, backupDir });
  check('重复启动不会重复迁移（幂等）',
    again.migrations.length === 0 && again.schemaVersion === SCHEMA_VERSION,
    `迁移步骤=${again.migrations.length}，版本 v${again.schemaVersion}`);
  closeDatabase(again.db);

  /* 清理 */
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
