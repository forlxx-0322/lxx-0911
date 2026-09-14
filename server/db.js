/**
 * 数据库层 —— 客户管理系统
 *
 * 职责：
 *   1. 建立 SQLite 连接（Node 内置 node:sqlite，零依赖）
 *   2. 建全 13 张表与索引
 *   3. 结构版本管理（schema_version）+ 迁移前自动备份
 *   4. 写入初始字典数据与系统设置
 *
 * 编码约定：本文件与所有 .js 文件统一 UTF-8 无 BOM。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 7;

/* ------------------------------------------------------------------ */
/* 13 张表结构                                                          */
/* ------------------------------------------------------------------ */

const TABLES = [

  /* 1. 客户主表 —— 8 区块，阀门行业定制 */
  `CREATE TABLE IF NOT EXISTS customers (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    short_name        TEXT NOT NULL DEFAULT '',
    type              TEXT NOT NULL DEFAULT '',
    industry          TEXT NOT NULL DEFAULT '',
    source            TEXT NOT NULL DEFAULT '',
    level             TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT '潜在',
    owner             TEXT NOT NULL DEFAULT '',
    phone             TEXT NOT NULL DEFAULT '',
    fax               TEXT NOT NULL DEFAULT '',
    website           TEXT NOT NULL DEFAULT '',
    email             TEXT NOT NULL DEFAULT '',
    wechat            TEXT NOT NULL DEFAULT '',
    credit_code       TEXT NOT NULL DEFAULT '',
    province          TEXT NOT NULL DEFAULT '',
    city              TEXT NOT NULL DEFAULT '',
    district          TEXT NOT NULL DEFAULT '',
    address           TEXT NOT NULL DEFAULT '',
    zip_code          TEXT NOT NULL DEFAULT '',
    enterprise_nature TEXT NOT NULL DEFAULT '',
    parent_group      TEXT NOT NULL DEFAULT '',
    scale             TEXT NOT NULL DEFAULT '',
    founded_at        TEXT,
    employees         TEXT NOT NULL DEFAULT '',
    legal_person      TEXT NOT NULL DEFAULT '',
    is_listed         INTEGER NOT NULL DEFAULT 0,
    purchase_mode     TEXT NOT NULL DEFAULT '',
    end_user          TEXT NOT NULL DEFAULT '',
    design_institute  TEXT NOT NULL DEFAULT '',
    epc_contractor    TEXT NOT NULL DEFAULT '',
    valve_types       TEXT NOT NULL DEFAULT '',
    drive_mode        TEXT NOT NULL DEFAULT '',
    body_material     TEXT NOT NULL DEFAULT '',
    pressure_rating   TEXT NOT NULL DEFAULT '',
    size_range        TEXT NOT NULL DEFAULT '',
    design_standard   TEXT NOT NULL DEFAULT '',
    connection_type   TEXT NOT NULL DEFAULT '',
    cert_required     TEXT NOT NULL DEFAULT '',
    annual_demand     REAL NOT NULL DEFAULT 0,
    purchase_cycle    TEXT NOT NULL DEFAULT '',
    account_period    TEXT NOT NULL DEFAULT '',
    warranty_ratio    REAL NOT NULL DEFAULT 0,
    warranty_months   INTEGER NOT NULL DEFAULT 0,
    payer             TEXT NOT NULL DEFAULT '',
    tender_platform   TEXT NOT NULL DEFAULT '',
    qualification     TEXT NOT NULL DEFAULT '',
    has_ts_license    INTEGER NOT NULL DEFAULT 0,
    has_explosion_proof INTEGER NOT NULL DEFAULT 0,
    quality_grade     TEXT NOT NULL DEFAULT '',
    supplier_code     TEXT NOT NULL DEFAULT '',
    credit_rating     TEXT NOT NULL DEFAULT '',
    introducer        TEXT NOT NULL DEFAULT '',
    competitor        TEXT NOT NULL DEFAULT '',
    longitude         REAL,
    latitude          REAL,
    region_code       TEXT NOT NULL DEFAULT '',
    region_name       TEXT NOT NULL DEFAULT '',
    customer_since    TEXT,
    last_order_at     TEXT,
    next_follow_at    TEXT,
    last_follow_at    TEXT,
    follow_count      INTEGER NOT NULL DEFAULT 0,
    deal_amount       REAL NOT NULL DEFAULT 0,
    remark            TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT
  )`,

  /* 2. 联系人 —— 一客户多人 */
  `CREATE TABLE IF NOT EXISTS contacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    name        TEXT NOT NULL,
    position    TEXT NOT NULL DEFAULT '',
    department  TEXT NOT NULL DEFAULT '',
    mobile      TEXT NOT NULL DEFAULT '',
    phone       TEXT NOT NULL DEFAULT '',
    wechat      TEXT NOT NULL DEFAULT '',
    email       TEXT NOT NULL DEFAULT '',
    is_decision INTEGER NOT NULL DEFAULT 0,
    is_primary  INTEGER NOT NULL DEFAULT 0,
    influence   TEXT NOT NULL DEFAULT '',
    birthday    TEXT,
    remark      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,

  /* 3. 标签 */
  `CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT '#4b7bec',
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /* 4. 客户-标签关联 */
  `CREATE TABLE IF NOT EXISTS customer_tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    tag_id      INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (customer_id, tag_id)
  )`,

  /* 5. 跟进记录 */
  `CREATE TABLE IF NOT EXISTS followups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    project_id  INTEGER,
    followed_at TEXT NOT NULL,
    method      TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL DEFAULT '',
    result      TEXT NOT NULL DEFAULT '',
    next_plan   TEXT NOT NULL DEFAULT '',
    next_at     TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,

  /* 6. 项目 */
  `CREATE TABLE IF NOT EXISTS projects (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    customer_id       INTEGER NOT NULL,
    stage             TEXT NOT NULL DEFAULT '信息收集',
    progress          INTEGER NOT NULL DEFAULT 0,
    end_user          TEXT NOT NULL DEFAULT '',
    design_institute  TEXT NOT NULL DEFAULT '',
    valve_needs       TEXT NOT NULL DEFAULT '',
    quantity          INTEGER NOT NULL DEFAULT 0,
    contract_amount   REAL NOT NULL DEFAULT 0,
    signed_at         TEXT,
    bid_date          TEXT,
    bid_result        TEXT NOT NULL DEFAULT '',
    win_rate_note     TEXT NOT NULL DEFAULT '',
    start_date        TEXT,
    end_date          TEXT,
    delivery_date     TEXT,
    owner             TEXT NOT NULL DEFAULT '',
    received_amount   REAL NOT NULL DEFAULT 0,
    payment_status    TEXT NOT NULL DEFAULT '未开始',
    remark            TEXT NOT NULL DEFAULT '',
    data_origin       TEXT NOT NULL DEFAULT '手动录入',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT
  )`,

  /* 7. 回款 —— 计划与实收共用，type 区分 */
  `CREATE TABLE IF NOT EXISTS payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL,
    customer_id INTEGER,
    type        TEXT NOT NULL,
    amount      REAL NOT NULL DEFAULT 0,
    plan_date   TEXT,
    actual_date TEXT,
    method      TEXT NOT NULL DEFAULT '',
    plan_id     INTEGER,
    voucher     TEXT NOT NULL DEFAULT '',
    remark      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`,

  /* 8. 待办事项 */
  `CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    customer_id INTEGER,
    project_id  INTEGER,
    due_at      TEXT,
    priority    TEXT NOT NULL DEFAULT '中',
    status      TEXT NOT NULL DEFAULT '待办',
    done_at     TEXT,
    source      TEXT NOT NULL DEFAULT '手动',
    remark      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,

  /* 9. 附件 */
  `CREATE TABLE IF NOT EXISTS attachments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL,
    owner_id   INTEGER NOT NULL,
    file_name  TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    file_size  INTEGER NOT NULL DEFAULT 0,
    mime_type  TEXT NOT NULL DEFAULT '',
    category   TEXT NOT NULL DEFAULT '其他',
    remark     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  /* 10. 操作日志 */
  `CREATE TABLE IF NOT EXISTS activity_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER,
    action      TEXT NOT NULL,
    summary     TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
  )`,

  /* 11. 字典 —— 全部下拉选项，可在界面自定义增删改 */
  `CREATE TABLE IF NOT EXISTS dict (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL,
    value      TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '',
    sort       INTEGER NOT NULL DEFAULT 0,
    enabled    INTEGER NOT NULL DEFAULT 1,
    is_system  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  /* 12. 系统设置 */
  `CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    remark     TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,

  /* 13. 行政区划（地图模块用） */
  `CREATE TABLE IF NOT EXISTS region (
    code           TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    level          TEXT NOT NULL,
    parent_code    TEXT NOT NULL DEFAULT '',
    longitude      REAL,
    latitude       REAL,
    geojson_path   TEXT NOT NULL DEFAULT '',
    sort           INTEGER NOT NULL DEFAULT 0,
    customer_count INTEGER NOT NULL DEFAULT 0
  )`,

  /* 14. 采集来源（招标信息采集模块）
   * 当前实现为「邮件订阅解析」路线：订阅各招标平台的邮件推送，本地解析。
   * 枚举类型（subscription / public_api / licensed_api / whitelist_crawl）为将来扩展预留，
   * 但只有 subscription 有实现；其余类型即使用户手工写入也拒绝执行。 */
  `CREATE TABLE IF NOT EXISTS collect_sources (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    type           TEXT NOT NULL DEFAULT 'subscription',
    enabled        INTEGER NOT NULL DEFAULT 0,
    config_json    TEXT NOT NULL DEFAULT '{}',
    last_run_at    TEXT NOT NULL DEFAULT '',
    last_status    TEXT NOT NULL DEFAULT '',
    last_message   TEXT NOT NULL DEFAULT '',
    last_new_count INTEGER NOT NULL DEFAULT 0,
    last_upd_count INTEGER NOT NULL DEFAULT 0,
    fail_streak    INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    deleted_at     TEXT
  )`,

  /* 15. 采集暂存区（人工审核前不写入正式库） */
  `CREATE TABLE IF NOT EXISTS collect_staging (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id          INTEGER,
    source_name        TEXT NOT NULL DEFAULT '',
    notice_id          TEXT NOT NULL DEFAULT '',
    title              TEXT NOT NULL DEFAULT '',
    project_name       TEXT NOT NULL DEFAULT '',
    project_code       TEXT NOT NULL DEFAULT '',
    region_code        TEXT NOT NULL DEFAULT '',
    region_name        TEXT NOT NULL DEFAULT '',
    location           TEXT NOT NULL DEFAULT '',
    amount             REAL,
    industry           TEXT NOT NULL DEFAULT '',
    tenderee           TEXT NOT NULL DEFAULT '',
    agency             TEXT NOT NULL DEFAULT '',
    design_institute   TEXT NOT NULL DEFAULT '',
    bid_date           TEXT NOT NULL DEFAULT '',
    notice_type        TEXT NOT NULL DEFAULT '',
    source_url         TEXT NOT NULL DEFAULT '',
    source_platform    TEXT NOT NULL DEFAULT '',
    mail_subject       TEXT NOT NULL DEFAULT '',
    mail_from          TEXT NOT NULL DEFAULT '',
    mail_date          TEXT NOT NULL DEFAULT '',
    mail_uid           TEXT NOT NULL DEFAULT '',
    raw_excerpt        TEXT NOT NULL DEFAULT '',
    has_personal_info  INTEGER NOT NULL DEFAULT 0,
    personal_fields    TEXT NOT NULL DEFAULT '',
    keyword_hits       TEXT NOT NULL DEFAULT '',
    matched_customer   TEXT NOT NULL DEFAULT '',
    match_score        INTEGER NOT NULL DEFAULT 0,
    content_hash       TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'pending',
    reject_reason      TEXT NOT NULL DEFAULT '',
    project_id         INTEGER,
    collected_at       TEXT NOT NULL,
    reviewed_at        TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    deleted_at         TEXT
  )`,

  /* 16. 采集日志（审计，保留 ≥180 天） */
  `CREATE TABLE IF NOT EXISTS collect_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   INTEGER,
    source_name TEXT NOT NULL DEFAULT '',
    level       TEXT NOT NULL DEFAULT 'info',
    action      TEXT NOT NULL DEFAULT '',
    message     TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '',
    item_count  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  )`,

  /* 17. 报价单主表（v5 新增）
   * 报价合计 total_amount 由服务端按明细重算后写入，不接受手工填写。 */
  `CREATE TABLE IF NOT EXISTS quotations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id       INTEGER NOT NULL,
    customer_id      INTEGER,
    quote_no         TEXT NOT NULL DEFAULT '',
    version          INTEGER NOT NULL DEFAULT 1,
    parent_id        INTEGER,
    quote_date       TEXT NOT NULL DEFAULT '',
    valid_until      TEXT NOT NULL DEFAULT '',
    currency         TEXT NOT NULL DEFAULT '人民币',
    status           TEXT NOT NULL DEFAULT '草稿',
    total_amount     REAL NOT NULL DEFAULT 0,
    tax_note         TEXT NOT NULL DEFAULT '',
    delivery_note    TEXT NOT NULL DEFAULT '',
    payment_note     TEXT NOT NULL DEFAULT '',
    competitor       TEXT NOT NULL DEFAULT '',
    competitor_price REAL NOT NULL DEFAULT 0,
    lose_reason      TEXT NOT NULL DEFAULT '',
    remark           TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    deleted_at       TEXT
  )`,

  /* 18. 报价明细行（v5 新增） */
  `CREATE TABLE IF NOT EXISTS quotation_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    quotation_id    INTEGER NOT NULL,
    seq             INTEGER NOT NULL DEFAULT 1,
    item_name       TEXT NOT NULL DEFAULT '',
    valve_type      TEXT NOT NULL DEFAULT '',
    size_range      TEXT NOT NULL DEFAULT '',
    pressure_rating TEXT NOT NULL DEFAULT '',
    body_material   TEXT NOT NULL DEFAULT '',
    connection_type TEXT NOT NULL DEFAULT '',
    quantity        REAL NOT NULL DEFAULT 0,
    unit            TEXT NOT NULL DEFAULT '台',
    unit_price      REAL NOT NULL DEFAULT 0,
    discount        REAL NOT NULL DEFAULT 0,
    subtotal        REAL NOT NULL DEFAULT 0,
    delivery_days   INTEGER NOT NULL DEFAULT 0,
    remark          TEXT NOT NULL DEFAULT '',
    extra           TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL
  )`,

  /* 19. 报价模板（v6 新增）
   * 模板 = 一组常用规格，避免每次报价都从零敲明细行。 */
  `CREATE TABLE IF NOT EXISTS quotation_templates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    category      TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    unit          TEXT NOT NULL DEFAULT '台',
    use_count     INTEGER NOT NULL DEFAULT 0,
    last_used_at  TEXT NOT NULL DEFAULT '',
    sort          INTEGER NOT NULL DEFAULT 0,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT
  )`,

  /* 20. 报价模板明细行（v6 新增）
   * 结构与 quotation_items 对齐，但**不含价格**：
   * 模板沉淀的是"常用规格"，单价随项目与行情变，套用后由使用者填。 */
  `CREATE TABLE IF NOT EXISTS quotation_template_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id     INTEGER NOT NULL,
    seq             INTEGER NOT NULL DEFAULT 1,
    item_name       TEXT NOT NULL DEFAULT '',
    valve_type      TEXT NOT NULL DEFAULT '',
    size_range      TEXT NOT NULL DEFAULT '',
    pressure_rating TEXT NOT NULL DEFAULT '',
    body_material   TEXT NOT NULL DEFAULT '',
    connection_type TEXT NOT NULL DEFAULT '',
    quantity        REAL NOT NULL DEFAULT 1,
    unit            TEXT NOT NULL DEFAULT '台',
    delivery_days   INTEGER NOT NULL DEFAULT 0,
    remark          TEXT NOT NULL DEFAULT '',
    extra           TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL
  )`,

  /* 21. 报价自定义列（v7 新增）
   *
   * 为什么用「列定义 + JSON 明细」而不是给明细表加列：
   *   介质、设计压力、设计温度、操作压力/温度、环境温度、泄露等级、阀门标准、
   *   执行器型号、定位器、电磁阀、限位开关、过滤减压阀、气控阀…… 这些字段
   *   因客户而异，且**列数不封顶**。若每个新列都 ALTER TABLE，
   *   一是要不停迁移，二是列名会随用户改名而失控。
   *   所以：列定义存本表，明细行的值存 `extra` 字段（JSON，键=列 id）。
   *
   * 键用列 id 而不是列名，是为了**改名不丢值**：
   *   「泄露等级」改成「泄漏等级」，历史报价单里的值照样跟着显示。 */
  `CREATE TABLE IF NOT EXISTS quotation_fields (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'text',   -- text(文本) | number(数字) | select(下拉候选)
    options     TEXT NOT NULL DEFAULT '',       -- kind=select 时的候选值，逗号分隔
    unit        TEXT NOT NULL DEFAULT '',       -- 单位（如 MPa / ℃），导出时并进表头
    sort        INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    remark      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`];

/* ------------------------------------------------------------------ */
/* 索引                                                                */
/* ------------------------------------------------------------------ */

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_customers_name           ON customers(name)',
  'CREATE INDEX IF NOT EXISTS idx_customers_short_name     ON customers(short_name)',
  'CREATE INDEX IF NOT EXISTS idx_customers_phone          ON customers(phone)',
  'CREATE INDEX IF NOT EXISTS idx_customers_status         ON customers(status)',
  'CREATE INDEX IF NOT EXISTS idx_customers_type           ON customers(type)',
  'CREATE INDEX IF NOT EXISTS idx_customers_industry       ON customers(industry)',
  'CREATE INDEX IF NOT EXISTS idx_customers_next_follow    ON customers(next_follow_at)',
  'CREATE INDEX IF NOT EXISTS idx_customers_supplier_code  ON customers(supplier_code)',
  /* 注意：region_code 的索引不放在这里 —— 旧库（v2）还没有该列，
     而建索引发生在迁移之前，会报 no such column。
     该索引在 v3 迁移脚本内部创建。 */
  'CREATE INDEX IF NOT EXISTS idx_customers_deleted        ON customers(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_contacts_customer        ON contacts(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_contacts_deleted         ON contacts(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_customer_tags_customer   ON customer_tags(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_customer_tags_tag        ON customer_tags(tag_id)',
  'CREATE INDEX IF NOT EXISTS idx_followups_customer       ON followups(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_followups_project        ON followups(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_followups_followed_at    ON followups(followed_at)',
  'CREATE INDEX IF NOT EXISTS idx_projects_customer        ON projects(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_projects_stage           ON projects(stage)',
  'CREATE INDEX IF NOT EXISTS idx_projects_bid_date        ON projects(bid_date)',
  'CREATE INDEX IF NOT EXISTS idx_projects_deleted         ON projects(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_payments_project         ON payments(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_payments_customer        ON payments(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_payments_type            ON payments(type)',
  'CREATE INDEX IF NOT EXISTS idx_payments_plan_date       ON payments(plan_date)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_status             ON tasks(status)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_due_at             ON tasks(due_at)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_customer           ON tasks(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_project            ON tasks(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_deleted            ON tasks(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_owner        ON attachments(owner_type, owner_id)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_deleted      ON attachments(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_logs_entity              ON activity_logs(entity_type, entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_logs_created             ON activity_logs(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_dict_category            ON dict(category, sort)',
  'CREATE INDEX IF NOT EXISTS idx_dict_deleted             ON dict(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_region_parent            ON region(parent_code)',
  /* 报价单索引：按项目查列表、按客户跨项目比价、按状态筛选用 */
  'CREATE INDEX IF NOT EXISTS idx_quotations_project       ON quotations(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_quotations_customer      ON quotations(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_quotations_status        ON quotations(status)',
  'CREATE INDEX IF NOT EXISTS idx_quotations_no            ON quotations(quote_no)',
  'CREATE INDEX IF NOT EXISTS idx_quotations_deleted       ON quotations(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_quo_items_quotation      ON quotation_items(quotation_id, seq)',
  /* 报价模板索引 */
  'CREATE INDEX IF NOT EXISTS idx_quotation_templates_sort  ON quotation_templates(sort, id)',
  'CREATE INDEX IF NOT EXISTS idx_quotation_templates_del   ON quotation_templates(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_quotation_templates_cat   ON quotation_templates(category)',
  'CREATE INDEX IF NOT EXISTS idx_quo_tpl_items_template    ON quotation_template_items(template_id, seq)',
  /* 报价自定义列（v7）：按删除标记 + 排序取列 */
  'CREATE INDEX IF NOT EXISTS idx_quotation_fields_sort     ON quotation_fields(deleted_at, sort, id)'
];

/* ------------------------------------------------------------------ */
/* 结构迁移脚本                                                        */
/*                                                                     */
/* 约定：数组下标 + 1 = 目标版本号。例如 MIGRATIONS[1] 把库从 v1 升到 v2。 */
/* 执行顺序：先按最新结构 CREATE TABLE IF NOT EXISTS（新库直接是最终结构）， */
/*           再把旧库按版本号逐级迁移。                                  */
/* 说明：SQLite 不支持 DROP COLUMN 时回退方案是「建新表→搬数据→换名」，   */
/*       当前环境为 SQLite 3.53.4，支持 ALTER TABLE DROP COLUMN，直接用。 */
/* ------------------------------------------------------------------ */

const MIGRATIONS = [
  /* v1 → v2：删除客户表的「注册资金」字段（按需求移除，不再使用） */
  {
    version: 2,
    note: '删除 customers.reg_capital 字段',
    run(db) {
      const cols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
      if (cols.includes('reg_capital')) {
        db.exec('ALTER TABLE customers DROP COLUMN reg_capital');
        return '已删除列 reg_capital';
      }
      return '列 reg_capital 不存在，跳过';
    }
  },

  /* v2 → v3：客户表增加行政区划归属（地图统计与筛选使用） */
  {
    version: 3,
    note: '客户表增加 region_code / region_name 字段',
    run(db) {
      const cols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
      const added = [];
      if (!cols.includes('region_code')) {
        db.exec("ALTER TABLE customers ADD COLUMN region_code TEXT NOT NULL DEFAULT ''");
        added.push('region_code');
      }
      if (!cols.includes('region_name')) {
        db.exec("ALTER TABLE customers ADD COLUMN region_name TEXT NOT NULL DEFAULT ''");
        added.push('region_name');
      }
      /* 建立索引，地图统计与按区域筛选都要用 */
      db.exec("CREATE INDEX IF NOT EXISTS idx_customers_region ON customers(region_code)");

      /* 已有数据回填：按客户所在城市名称匹配行政区划 */
      let filled = 0;
      try {
        const rows = db.prepare(
          `SELECT id, city, district FROM customers
           WHERE deleted_at IS NULL AND (region_code IS NULL OR region_code = '')`
        ).all();
        const findByDistrict = db.prepare(
          "SELECT code, name, parent_code FROM region WHERE level = 'district' AND name = ? LIMIT 1"
        );
        const findByCity = db.prepare(
          "SELECT code, name FROM region WHERE level = 'city' AND (name = ? OR name LIKE ?) LIMIT 1"
        );
        const upd = db.prepare('UPDATE customers SET region_code = ?, region_name = ? WHERE id = ?');

        for (const r of rows) {
          const city = String(r.city || '').replace(/(市|地区|自治州|蒙古自治州|哈萨克自治州|柯尔克孜自治州|回族自治州)$/, '');
          const dist = String(r.district || '');
          let hit = null;

          /* 先按区县精确匹配（更细），再按地州匹配 */
          if (dist) {
            const d = findByDistrict.get(dist)
              || findByDistrict.get(dist.replace(/(区|县|市)$/, ''));
            if (d) hit = { code: d.parent_code, name: '' };
          }
          if (!hit && city) {
            const c = findByCity.get(r.city, city + '%');
            if (c) hit = { code: c.code, name: c.name };
          }
          if (hit) {
            /* 补齐区域名称 */
            const nm = hit.name || (db.prepare('SELECT name FROM region WHERE code = ?').get(hit.code) || {}).name || '';
            upd.run(hit.code, nm, r.id);
            filled++;
          }
        }
      } catch (_) { /* 首次迁移时 region 表可能还没有数据，忽略 */ }

      return `新增列 ${added.join('、') || '无'}${filled ? `，回填 ${filled} 条客户归属` : ''}`;
    }
  },

  /* v3 → v4：招标信息采集模块（邮件订阅解析路线）
   * 新增 3 张表 + 项目表 5 个溯源字段。
   * 注意：本模块默认关闭，且只实现订阅邮件解析；不写任何库内数据即可安全回退。 */
  {
    version: 4,
    note: '新增招标采集模块：collect_sources / collect_staging / collect_logs 与项目表溯源字段',
    run(db) {
      const created = [];

      db.exec(`CREATE TABLE IF NOT EXISTS collect_sources (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT NOT NULL,
        type           TEXT NOT NULL DEFAULT 'subscription',
        enabled        INTEGER NOT NULL DEFAULT 0,
        config_json    TEXT NOT NULL DEFAULT '{}',
        last_run_at    TEXT NOT NULL DEFAULT '',
        last_status    TEXT NOT NULL DEFAULT '',
        last_message   TEXT NOT NULL DEFAULT '',
        last_new_count INTEGER NOT NULL DEFAULT 0,
        last_upd_count INTEGER NOT NULL DEFAULT 0,
        fail_streak    INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        deleted_at     TEXT
      )`);
      created.push('collect_sources');

      db.exec(`CREATE TABLE IF NOT EXISTS collect_staging (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id          INTEGER,
        source_name        TEXT NOT NULL DEFAULT '',
        notice_id          TEXT NOT NULL DEFAULT '',
        title              TEXT NOT NULL DEFAULT '',
        project_name       TEXT NOT NULL DEFAULT '',
        project_code       TEXT NOT NULL DEFAULT '',
        region_code        TEXT NOT NULL DEFAULT '',
        region_name        TEXT NOT NULL DEFAULT '',
        location           TEXT NOT NULL DEFAULT '',
        amount             REAL,
        industry           TEXT NOT NULL DEFAULT '',
        tenderee           TEXT NOT NULL DEFAULT '',
        agency             TEXT NOT NULL DEFAULT '',
        design_institute   TEXT NOT NULL DEFAULT '',
        bid_date           TEXT NOT NULL DEFAULT '',
        notice_type        TEXT NOT NULL DEFAULT '',
        source_url         TEXT NOT NULL DEFAULT '',
        source_platform    TEXT NOT NULL DEFAULT '',
        mail_subject       TEXT NOT NULL DEFAULT '',
        mail_from          TEXT NOT NULL DEFAULT '',
        mail_date          TEXT NOT NULL DEFAULT '',
        mail_uid           TEXT NOT NULL DEFAULT '',
        raw_excerpt        TEXT NOT NULL DEFAULT '',
        has_personal_info  INTEGER NOT NULL DEFAULT 0,
        personal_fields    TEXT NOT NULL DEFAULT '',
        keyword_hits       TEXT NOT NULL DEFAULT '',
        matched_customer   TEXT NOT NULL DEFAULT '',
        match_score        INTEGER NOT NULL DEFAULT 0,
        content_hash       TEXT NOT NULL DEFAULT '',
        status             TEXT NOT NULL DEFAULT 'pending',
        reject_reason      TEXT NOT NULL DEFAULT '',
        project_id         INTEGER,
        collected_at       TEXT NOT NULL,
        reviewed_at        TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        deleted_at         TEXT
      )`);
      created.push('collect_staging');

      db.exec(`CREATE TABLE IF NOT EXISTS collect_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id   INTEGER,
        source_name TEXT NOT NULL DEFAULT '',
        level       TEXT NOT NULL DEFAULT 'info',
        action      TEXT NOT NULL DEFAULT '',
        message     TEXT NOT NULL DEFAULT '',
        detail      TEXT NOT NULL DEFAULT '',
        item_count  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      )`);
      created.push('collect_logs');

      /* 索引 */
      for (const sql of [
        'CREATE INDEX IF NOT EXISTS idx_collect_sources_enabled  ON collect_sources(enabled, deleted_at)',
        'CREATE INDEX IF NOT EXISTS idx_collect_staging_status   ON collect_staging(status, deleted_at)',
        'CREATE INDEX IF NOT EXISTS idx_collect_staging_notice   ON collect_staging(notice_id)',
        'CREATE INDEX IF NOT EXISTS idx_collect_staging_hash     ON collect_staging(content_hash)',
        'CREATE INDEX IF NOT EXISTS idx_collect_staging_source   ON collect_staging(source_id)',
        'CREATE INDEX IF NOT EXISTS idx_collect_staging_collect  ON collect_staging(collected_at)',
        'CREATE INDEX IF NOT EXISTS idx_collect_logs_created     ON collect_logs(created_at)',
        'CREATE INDEX IF NOT EXISTS idx_collect_logs_source      ON collect_logs(source_id)'
      ]) db.exec(sql);

      /* 项目表溯源字段：采集入库的项目必须能追到来源 */
      const cols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
      const addCols = [
        ['source_url', "TEXT NOT NULL DEFAULT ''"],
        ['source_platform', "TEXT NOT NULL DEFAULT ''"],
        ['collected_at', "TEXT NOT NULL DEFAULT ''"],
        ['source_notice_id', "TEXT NOT NULL DEFAULT ''"],
        ['confidence', 'INTEGER NOT NULL DEFAULT 0']
      ];
      const added = [];
      for (const [name, def] of addCols) {
        if (!cols.includes(name)) {
          db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${def}`);
          added.push(name);
        }
      }

      /* 采集来源初始全部禁用（附录 A.5 铁律二：默认关闭） */
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const preset = [
        ['新疆公共资源交易网 · 邮件订阅', '{"platform":"新疆公共资源交易网","keywords":"阀门,球阀,闸阀,蝶阀,截止阀,止回阀,调节阀","region":"新疆"}'],
        ['中国政府采购网 · 邮件订阅', '{"platform":"中国政府采购网","keywords":"阀门,球阀,闸阀","region":"新疆"}'],
        ['各地州公共资源交易网 · 邮件订阅', '{"platform":"地州交易网","keywords":"阀门,球阀,闸阀","region":"新疆"}']
      ];
      let presetAdded = 0;
      const exists = db.prepare('SELECT id FROM collect_sources WHERE name = ?');
      const ins = db.prepare(`INSERT INTO collect_sources (name, type, enabled, config_json, created_at, updated_at)
                              VALUES (?, 'subscription', 0, ?, ?, ?)`);
      for (const [name, cfg] of preset) {
        if (!exists.get(name)) { ins.run(name, cfg, now, now); presetAdded++; }
      }

      return `新增表 ${created.join('、')}；项目表新增列 ${added.join('、') || '无'}；预置来源 ${presetAdded} 个（默认禁用）`;
    }
  },

  /* v4 → v5：报价单管理
   * 新增 quotations（报价单主表）与 quotation_items（明细行）两张表。
   * 纯建表，不改动任何既有表的列，因此可安全回退（删表即可，数据无损失）。 */
  {
    version: 5,
    note: '新增报价单管理：quotations / quotation_items 两张表',
    run(db) {
      const created = [];

      db.exec(`CREATE TABLE IF NOT EXISTS quotations (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id       INTEGER NOT NULL,
        customer_id      INTEGER,
        quote_no         TEXT NOT NULL DEFAULT '',
        version          INTEGER NOT NULL DEFAULT 1,
        parent_id        INTEGER,
        quote_date       TEXT NOT NULL DEFAULT '',
        valid_until      TEXT NOT NULL DEFAULT '',
        currency         TEXT NOT NULL DEFAULT '人民币',
        status           TEXT NOT NULL DEFAULT '草稿',
        total_amount     REAL NOT NULL DEFAULT 0,
        tax_note         TEXT NOT NULL DEFAULT '',
        delivery_note    TEXT NOT NULL DEFAULT '',
        payment_note     TEXT NOT NULL DEFAULT '',
        competitor       TEXT NOT NULL DEFAULT '',
        competitor_price REAL NOT NULL DEFAULT 0,
        lose_reason      TEXT NOT NULL DEFAULT '',
        remark           TEXT NOT NULL DEFAULT '',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        deleted_at       TEXT
      )`);
      created.push('quotations');

      db.exec(`CREATE TABLE IF NOT EXISTS quotation_items (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        quotation_id    INTEGER NOT NULL,
        seq             INTEGER NOT NULL DEFAULT 1,
        item_name       TEXT NOT NULL DEFAULT '',
        valve_type      TEXT NOT NULL DEFAULT '',
        size_range      TEXT NOT NULL DEFAULT '',
        pressure_rating TEXT NOT NULL DEFAULT '',
        body_material   TEXT NOT NULL DEFAULT '',
        connection_type TEXT NOT NULL DEFAULT '',
        quantity        REAL NOT NULL DEFAULT 0,
        unit            TEXT NOT NULL DEFAULT '台',
        unit_price      REAL NOT NULL DEFAULT 0,
        discount        REAL NOT NULL DEFAULT 0,
        subtotal        REAL NOT NULL DEFAULT 0,
        delivery_days   INTEGER NOT NULL DEFAULT 0,
        remark          TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      )`);
      created.push('quotation_items');

      for (const sql of [
        'CREATE INDEX IF NOT EXISTS idx_quotations_project   ON quotations(project_id)',
        'CREATE INDEX IF NOT EXISTS idx_quotations_customer  ON quotations(customer_id)',
        'CREATE INDEX IF NOT EXISTS idx_quotations_status    ON quotations(status)',
        'CREATE INDEX IF NOT EXISTS idx_quotations_no        ON quotations(quote_no)',
        'CREATE INDEX IF NOT EXISTS idx_quotations_deleted   ON quotations(deleted_at)',
        'CREATE INDEX IF NOT EXISTS idx_quo_items_quotation  ON quotation_items(quotation_id, seq)'
      ]) db.exec(sql);

      /* 报价单状态字典：与客户状态等一样进字典表，便于后续自定义 */
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const statuses = [
        ['草稿', '#94a3b8', 10],
        ['已报出', '#3b82f6', 20],
        ['已中标', '#22c55e', 30],
        ['已落标', '#ef4444', 40],
        ['已过期', '#a8a29e', 50]
      ];
      let dictAdded = 0;
      const findDict = db.prepare('SELECT id, deleted_at FROM dict WHERE category = ? AND value = ?');
      const insDict = db.prepare(
        `INSERT INTO dict (category, value, color, sort, enabled, is_system, created_at, updated_at)
         VALUES ('quotation_status', ?, ?, ?, 1, 1, ?, ?)`
      );
      for (const [v, color, sort] of statuses) {
        const hit = findDict.get('quotation_status', v);
        if (!hit) { insDict.run(v, color, sort, now, now); dictAdded++; }
        else if (hit.deleted_at) {
          db.prepare('UPDATE dict SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?').run(now, hit.id);
          dictAdded++;
        }
      }

      return `新增表 ${created.join('、')}；预置报价单状态字典 ${dictAdded} 项`;
    }
  },

  /* v5 → v6：报价模板
   * 新增 quotation_templates / quotation_template_items 两张表。
   * 纯建表，不改动任何既有表的列，可安全回退（删表即可）。 */
  {
    version: 6,
    note: '新增报价模板：quotation_templates / quotation_template_items 两张表',
    run(db) {
      const created = [];

      db.exec(`CREATE TABLE IF NOT EXISTS quotation_templates (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        category      TEXT NOT NULL DEFAULT '',
        description   TEXT NOT NULL DEFAULT '',
        unit          TEXT NOT NULL DEFAULT '台',
        use_count     INTEGER NOT NULL DEFAULT 0,
        last_used_at  TEXT NOT NULL DEFAULT '',
        sort          INTEGER NOT NULL DEFAULT 0,
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        deleted_at    TEXT
      )`);
      created.push('quotation_templates');

      db.exec(`CREATE TABLE IF NOT EXISTS quotation_template_items (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id     INTEGER NOT NULL,
        seq             INTEGER NOT NULL DEFAULT 1,
        item_name       TEXT NOT NULL DEFAULT '',
        valve_type      TEXT NOT NULL DEFAULT '',
        size_range      TEXT NOT NULL DEFAULT '',
        pressure_rating TEXT NOT NULL DEFAULT '',
        body_material   TEXT NOT NULL DEFAULT '',
        connection_type TEXT NOT NULL DEFAULT '',
        quantity        REAL NOT NULL DEFAULT 1,
        unit            TEXT NOT NULL DEFAULT '台',
        delivery_days   INTEGER NOT NULL DEFAULT 0,
        remark          TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      )`);
      created.push('quotation_template_items');

      for (const sql of [
        'CREATE INDEX IF NOT EXISTS idx_quotation_templates_sort  ON quotation_templates(sort, id)',
        'CREATE INDEX IF NOT EXISTS idx_quotation_templates_del   ON quotation_templates(deleted_at)',
        'CREATE INDEX IF NOT EXISTS idx_quotation_templates_cat   ON quotation_templates(category)',
        'CREATE INDEX IF NOT EXISTS idx_quo_tpl_items_template    ON quotation_template_items(template_id, seq)'
      ]) db.exec(sql);

      return `新增表 ${created.join('、')}`;
    }
  },

  /* v6 → v7：报价自定义列
   *
   * 做两件事：
   *   1. 新增 quotation_fields（列定义表）
   *   2. 给 quotation_items / quotation_template_items 各加一列 extra（JSON 值）
   *
   * 纯新增（不改既有列、不回填、不动既有数据），旧版本读这两张表时
   * 多出的 extra 列不影响既有查询；即便不恢复备份，删掉 extra 列也能退回 v6。 */
  {
    version: 7,
    note: '报价自定义列：新增 quotation_fields 表，明细表加 extra 列',
    run(db) {
      const done = [];

      const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all()
        .some((c) => c.name === col);

      for (const table of ['quotation_items', 'quotation_template_items']) {
        if (!hasCol(table, 'extra')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'`);
          done.push(`${table}.extra`);
        }
      }

      db.exec(`CREATE TABLE IF NOT EXISTS quotation_fields (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'text',
        options     TEXT NOT NULL DEFAULT '',
        unit        TEXT NOT NULL DEFAULT '',
        sort        INTEGER NOT NULL DEFAULT 0,
        enabled     INTEGER NOT NULL DEFAULT 1,
        remark      TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT
      )`);
      done.push('quotation_fields');

      db.exec('CREATE INDEX IF NOT EXISTS idx_quotation_fields_sort ON quotation_fields(deleted_at, sort, id)');

      return `新增列 ${done.join('、')}`;
    }
  }
];

/** 按版本号逐级迁移，返回执行过的步骤说明 */
function runMigrations(db, fromVersion) {
  const applied = [];
  for (const m of MIGRATIONS) {
    if (m.version <= fromVersion) continue;
    const ts = now();
    try {
      const detail = m.run(db) || '';
      db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at, note) VALUES (?, ?, ?)')
        .run(m.version, ts, m.note);
      applied.push(`v${m.version} ${m.note}${detail ? '（' + detail + '）' : ''}`);
    } catch (e) {
      throw new Error(`迁移到 v${m.version} 失败：${e.message}`);
    }
  }
  return applied;
}

/* ------------------------------------------------------------------ */
/* 字典初始数据 —— 18 类，全部可在界面增删改                              */
/* ------------------------------------------------------------------ */

const DICT_SEED = {
  /* A. 客户画像类 */
  industry: ['石油', '化工', '电力', '冶金', '水处理', '船舶', '造纸', '制糖', '食品饮料', '制药',
    '空分', '天然气', '煤化工', 'LNG', '热力供暖', '环保脱硫脱硝', '新能源', '核电', '矿山',
    '纺织印染', '水泥建材', '其他'],
  customer_type: ['终端用户', '设计院', '工程公司/EPC总包', '贸易商/经销商', '阀门厂家OEM配套',
    '市政水务单位', '其他'],
  purchase_mode: ['终端直采', 'EPC总包配套', '设计院上图', '贸易商分销', '框架协议', '年度招标', '电商平台'],
  enterprise_nature: ['央企', '国企', '民营企业', '外资企业', '合资企业', '上市公司', '政府机构', '事业单位', '其他'],
  customer_source: ['老客户介绍', '朋友推荐', '设计院推荐', '工程公司配套', '展会', 'B2B平台',
    '电话开发', '网络推广', '主动上门', '招投标', '其他'],

  /* B. 阀门产品参数类 */
  valve_type: ['球阀', '闸阀', '截止阀', '止回阀', '蝶阀', '调节阀', '安全阀', '疏水阀', '减压阀',
    '隔膜阀', '旋塞阀', '柱塞阀', '排污阀', '仪表阀', '其他'],
  drive_mode: ['手动', '气动', '电动', '液动', '电液联动', '气液联动', '涡轮传动'],
  body_material: ['碳钢 WCB', '不锈钢 304', '不锈钢 316', '不锈钢 316L', '双相钢 2205', '双相钢 2507',
    '合金钢 WC6/WC9', '低温钢 LCB', '铸铁', '球墨铸铁', '铜', '衬氟', '塑料 PVC/PP/CPVC', '钛材', '其他'],
  pressure_rating: ['PN10', 'PN16', 'PN25', 'PN40', 'PN64', 'PN100', 'PN160',
    'Class150', 'Class300', 'Class600', 'Class900', 'Class1500', 'Class2500', '10K', '20K'],
  size_range: ['DN15', 'DN20', 'DN25', 'DN32', 'DN40', 'DN50', 'DN65', 'DN80', 'DN100', 'DN125',
    'DN150', 'DN200', 'DN250', 'DN300', 'DN350', 'DN400', 'DN500', 'DN600', 'DN800', 'DN1000以上'],
  design_standard: ['GB', 'JB', 'HG', 'API', 'ANSI/ASME', 'DIN', 'JIS', 'EN', 'ISO', '其他'],
  connection_type: ['法兰连接', '对焊连接', '承插焊', '螺纹连接', '对夹式', '卡箍', '卡套'],
  cert_required: ['特种设备制造许可证 TS', 'API 6D', 'API 608', 'API 600', 'API 609', 'CE', 'PED',
    'SIL', '防爆认证 ATEX/IECEx', '防火认证 API 607/6FA', '饮用水卫生认证', '其他'],

  /* C. 商务与流程类 */
  account_period: ['款到发货', '预付30%+发货前付清', '预付30%+验收后付清', '月结30天',
    '月结60天', '月结90天', '货到付款', '按进度付款'],
  customer_level: ['A 重点客户', 'B 普通客户', 'C 潜在客户'],
  customer_status: ['潜在', '跟进中', '已报价', '已成交', '暂停合作', '已流失'],
  project_stage: ['信息收集', '初步接洽', '技术交流', '方案选型', '询价报价', '投标/议价',
    '已中标/已签约', '生产执行', '发货交付', '安装调试', '验收结项', '质保期内', '已暂停', '已终止'],
  follow_method: ['电话', '微信', '邮件', '上门拜访', '技术交流', '参加展会', '投标/开标',
    '客户来访考察', '寄送样品/资料', '其他'],
  follow_result: ['有意向', '需再跟进', '已技术交流', '已选型', '已报价', '已投标', '待决策',
    '已中标', '已成交', '价格无优势', '技术不满足', '暂搁置', '无需求'],
  payment_method: ['银行转账', '承兑汇票', '电汇', '现金', '微信', '支付宝', '信用证 L/C', '其他'],

  /* D. 人员与联系人 */
  contact_position: ['总经理', '副总经理', '采购经理', '采购员', '技术总工', '技术工程师',
    '设计选型工程师', '设备部主管', '项目经理', '工程部经理', '库管', '财务', '其他'],
  contact_influence: ['关键决策', '技术把关', '推荐影响', '一般对接']
};

/* 字典分类的中文显示名 */
const DICT_LABEL = {
  industry: '下游行业',
  customer_type: '客户主体类型',
  purchase_mode: '采购模式',
  enterprise_nature: '企业性质',
  customer_source: '客户来源',
  valve_type: '阀门类型',
  drive_mode: '驱动方式',
  body_material: '阀体材质',
  pressure_rating: '压力等级',
  size_range: '公称口径',
  design_standard: '设计标准',
  connection_type: '连接方式',
  cert_required: '认证要求',
  account_period: '账期',
  customer_level: '客户等级',
  customer_status: '客户状态',
  project_stage: '项目阶段',
  follow_method: '跟进方式',
  follow_result: '跟进结果',
  payment_method: '收款方式',
  contact_position: '联系人职位',
  contact_influence: '联系人影响力'
};

/* ------------------------------------------------------------------ */
/* 系统设置初始值                                                       */
/* ------------------------------------------------------------------ */

const SETTINGS_SEED = [
  ['app_name', '客户管理系统', '软件名称'],
  ['company_name', '', '我方公司名称'],
  ['port', '8899', '服务端口'],
  ['follow_remind_days', '3', '跟进提醒提前天数'],
  ['follow_remind_time', '09:00', '每天开始提醒的时间'],
  ['follow_remind_quiet', '18:00', '几点后不再弹新提醒（角标保留）'],
  ['follow_remind_on_start', '1', '启动时立即检查一次（补未开机漏掉的）'],
  ['remind_email_on', '0', '是否启用邮件提醒（默认关闭）'],
  ['remind_email_time', '08:30', '每天发送提醒邮件的时间'],
  ['remind_email_to', '', '提醒邮件收件地址（留空则发给发件人自己）'],
  ['smtp_provider', 'qq', 'SMTP 服务商预设'],
  ['smtp_host', 'smtp.qq.com', 'SMTP 服务器地址'],
  ['smtp_port', '465', 'SMTP 端口（465 隐式 TLS）'],
  ['smtp_user', '', 'SMTP 登录账号（邮箱地址）'],
  ['smtp_pass', '', 'SMTP 授权码（不是登录密码）'],
  ['quote_no_prefix', 'BJ', '报价单号前缀'],
  ['quote_company', '', '报价单抬头公司名（留空用「我方公司名称」）'],
  ['quote_contact', '', '报价单联系方式'],
  /* 报价明细的列顺序（JSON 数组：内置列 key 或 f:<自定义列id>）。
     留空 = 用默认顺序；在报价单/报价模板的表头上就能调，不需要动这里。 */
  ['quotation_column_order', '', '报价明细列顺序（留空用默认顺序）'],
  /* 邮件提醒的运行时状态（由 notify 模块维护，便于重启后仍能判断与降级） */
  ['remind_email_fail_streak', '0', '邮件提醒连续失败次数'],
  ['remind_email_last_at', '', '邮件提醒上次尝试时间'],
  ['remind_email_last_ok', '', '邮件提醒上次是否成功'],
  ['remind_email_last_msg', '', '邮件提醒上次结果说明'],
  ['remind_email_last_day', '', '邮件提醒上次发送日期（当日去重）'],
  ['payment_remind_days', '7', '回款提醒提前天数'],
  ['birthday_remind', '1', '是否启用生日提醒'],
  ['page_size', '20', '列表每页条数'],
  ['theme', 'light', '界面主题 light/dark'],
  ['backup_keep', '30', '主备份保留份数'],
  ['backup_mirror_keep', '7', '镜像备份保留份数'],
  ['backup_auto', '1', '是否启用每日自动备份'],
  ['attachment_max_mb', '50', '单个附件大小上限(MB)'],
  ['map_approval_no', '', '地图审图号（对外使用时必须填写）']
];

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 统一的本地时间字符串：YYYY-MM-DDTHH:mm:ss */
function now() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把 node:sqlite 返回的 null-prototype 对象转成普通对象 */
function plain(row) {
  return row ? Object.assign({}, row) : row;
}
function plainAll(rows) {
  return rows.map(plain);
}

/* ------------------------------------------------------------------ */
/* 数据库初始化                                                        */
/* ------------------------------------------------------------------ */

/**
 * 打开数据库、建表、迁移、灌入初始数据。
 * @param {object} paths  { dataDir, dbFile, backupDir }
 * @returns {{ db: DatabaseSync, created: boolean, migrated: boolean, fromVersion: number,
 *             tables: number, dictCount: number, backedUpTo: string|null }}
 */
function initDatabase(paths) {
  const { dataDir, dbFile, backupDir } = paths;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const existedBefore = fs.existsSync(dbFile);

  /* 第一遍：只读探测现有结构版本，随即关闭 */
  let fromVersion = 0;
  if (existedBefore) {
    const probe = new DatabaseSync(dbFile);
    try {
      const has = probe.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_version'"
      ).get().n;
      if (has) {
        const v = probe.prepare('SELECT MAX(version) AS v FROM schema_version').get();
        fromVersion = (v && v.v) ? v.v : 0;
      }
    } catch (_) {
      fromVersion = 0;
    }
    try { probe.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) { /* 忽略 */ }
    probe.close();
  }

  /* 需要升级旧库时：先备份，再打开并迁移 */
  let backedUpTo = null;
  if (existedBefore && fromVersion > 0 && fromVersion < SCHEMA_VERSION) {
    const stamp = now().replace(/[:T]/g, '-');
    backedUpTo = path.join(backupDir, `before-migrate-v${fromVersion}-${stamp}.db`);
    fs.copyFileSync(dbFile, backedUpTo);
  }

  /* 第二遍：正式打开并建表 / 迁移 */
  const db = new DatabaseSync(dbFile);

  db.exec('PRAGMA journal_mode = WAL');      // 读写并发，崩溃安全
  db.exec('PRAGMA busy_timeout = 5000');     // 锁等待 5 秒，避免瞬时 SQLITE_BUSY
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');    // WAL 下的推荐值：安全与速度平衡

  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT ''
  )`);

  /* 建表 + 建索引（幂等）。新库这一步就已是最新结构 */
  for (const sql of TABLES) db.exec(sql);
  for (const sql of INDEXES) db.exec(sql);

  /* 旧库：按版本号逐级迁移结构（迁移脚本内部自己负责新增列上的索引） */
  const migrations = runMigrations(db, fromVersion);

  /* 灌入字典与设置（仅补充缺失项，不覆盖你已修改的内容） */
  const ts = now();
  const dictCount = seedDict(db, ts);
  seedSettings(db, ts);

  /* 全新数据库：直接记录为最新版本 */
  if (fromVersion === 0) {
    db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at, note) VALUES (?, ?, ?)')
      .run(SCHEMA_VERSION, ts, '初始建库');
  }

  const tableCount = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).get().n;

  const verRow = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  const finalVersion = (verRow && verRow.v) || SCHEMA_VERSION;

  return {
    db,
    created: !existedBefore,
    migrated: migrations.length > 0,
    migrations,
    fromVersion,
    schemaVersion: finalVersion,
    tables: tableCount,
    dictCount,
    backedUpTo
  };
}

/** 补充缺失的字典项，返回本次新增条数 */
function seedDict(db, ts) {
  const exists = db.prepare(
    'SELECT id, enabled, deleted_at FROM dict WHERE category = ? AND value = ?'
  );
  const insert = db.prepare(
    `INSERT INTO dict (category, value, color, sort, enabled, is_system, created_at, updated_at)
     VALUES (?, ?, '', ?, 1, 1, ?, ?)`
  );
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const [category, values] of Object.entries(DICT_SEED)) {
      values.forEach((value, i) => {
        const hit = exists.get(category, value);
        if (!hit) {
          insert.run(category, value, (i + 1) * 10, ts, ts);
          added++;
        } else if (hit.deleted_at) {
          // 曾被删除的系统项：恢复它，避免缺项
          db.prepare('UPDATE dict SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?')
            .run(ts, hit.id);
        }
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

/** 补充缺失的设置项 */
function seedSettings(db, ts) {
  const exists = db.prepare('SELECT 1 AS x FROM settings WHERE key = ?');
  const insert = db.prepare(
    'INSERT INTO settings (key, value, remark, updated_at) VALUES (?, ?, ?, ?)'
  );
  db.exec('BEGIN');
  try {
    for (const [key, value, remark] of SETTINGS_SEED) {
      if (!exists.get(key)) insert.run(key, value, remark, ts);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 读取全部设置，返回 { key: value } */
function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** 关闭数据库：先做 WAL 检查点，保证数据全部落盘 */
function closeDatabase(db) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (_) { /* 忽略 */ }
  try {
    db.close();
  } catch (_) { /* 忽略 */ }
}

module.exports = {
  SCHEMA_VERSION,
  DICT_LABEL,
  DICT_SEED,
  initDatabase,
  getSettings,
  closeDatabase,
  plain,
  plainAll,
  now
};
