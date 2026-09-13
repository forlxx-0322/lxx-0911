/**
 * 业务服务层 —— 客户 / 联系人 / 标签 / 跟进记录
 *
 * 设计要点：
 *   1. 字段白名单写入：前端多传的字段一律忽略，避免写坏数据库
 *   2. SQL 全部参数化；排序字段走白名单映射，杜绝注入
 *   3. 派生字段（跟进次数 / 最近跟进 / 累计成交额）由本层统一维护
 *   4. 所有写操作写 activity_logs，支持详情页「变更记录」
 */

'use strict';

const { plain, plainAll, now } = require('../db');

/* ------------------------------------------------------------------ */
/* 字段白名单                                                          */
/* ------------------------------------------------------------------ */

/** 客户表可写字段（不含 id / 派生字段 / 软删除标记 / 时间戳） */
const CUSTOMER_FIELDS = [
  // 基础
  'name', 'short_name', 'type', 'industry', 'source', 'level', 'status', 'owner',
  // 联系
  'phone', 'fax', 'website', 'email', 'wechat', 'credit_code',
  // 地址
  'province', 'city', 'district', 'address', 'zip_code',
  // 企业概况
  'enterprise_nature', 'parent_group', 'scale', 'founded_at',
  'employees', 'legal_person', 'is_listed',
  // 行业属性
  'purchase_mode', 'end_user', 'design_institute', 'epc_contractor', 'valve_types',
  'drive_mode', 'body_material', 'pressure_rating', 'size_range', 'design_standard',
  'connection_type', 'cert_required',
  // 采购与商务
  'annual_demand', 'purchase_cycle', 'account_period', 'warranty_ratio',
  'warranty_months', 'payer', 'tender_platform',
  // 资质合规
  'qualification', 'has_ts_license', 'has_explosion_proof', 'quality_grade',
  'supplier_code', 'credit_rating',
  // 业务关系与地图
  'introducer', 'competitor', 'longitude', 'latitude', 'region_code',
  'customer_since', 'next_follow_at', 'remark'
];

const CONTACT_FIELDS = [
  'customer_id', 'name', 'position', 'department', 'mobile', 'phone', 'wechat',
  'email', 'is_decision', 'is_primary', 'influence', 'birthday', 'remark'
];

const FOLLOWUP_FIELDS = [
  'customer_id', 'project_id', 'followed_at', 'method', 'content', 'result',
  'next_plan', 'next_at'
];

const TAG_FIELDS = ['name', 'color', 'sort'];

/** 数值字段：非法值归一为 0；经纬度可为空（NULL 表示未定位） */
const NUMERIC_FIELDS = new Set([
  'annual_demand', 'warranty_ratio', 'warranty_months'
]);
/** 可为 NULL 的数值字段（未定位时不参与地图渲染） */
const NULLABLE_NUMERIC_FIELDS = new Set(['longitude', 'latitude']);
/** 整型字段 */
const INT_FIELDS = new Set(['is_listed', 'has_ts_license', 'has_explosion_proof', 'is_decision', 'is_primary', 'project_id']);
/** 允许排序的列（白名单映射，防注入） */
const SORT_MAP = {
  next_follow_at: 'c.next_follow_at',
  created_at: 'c.created_at',
  updated_at: 'c.updated_at',
  deal_amount: 'c.deal_amount',
  annual_demand: 'c.annual_demand',
  name: 'c.name',
  level: 'c.level',
  status: 'c.status'
};
/** 允许筛选的等值字段 */
const EQ_FILTERS = [
  'type', 'industry', 'status', 'level', 'source', 'purchase_mode',
  'enterprise_nature', 'province', 'city', 'district', 'credit_rating',
  'region_code'
];
/** 客户等级排序权重（A 在前） */
const LEVEL_ORDER = "CASE c.level WHEN 'A 重点客户' THEN 1 WHEN 'B 普通客户' THEN 2 WHEN 'C 潜在客户' THEN 3 ELSE 4 END";

/**
 * 中文排序器。
 * SQLite 默认 BINARY 排序按 UTF-8 字节序处理中文（中国 → 宝钢 → 新疆），
 * 不符合中文阅读习惯；这里用 ICU 的拼音排序在内存中处理。
 */
const ZH_COLLATOR = new Intl.Collator('zh-Hans-CN', { sensitivity: 'variant', numeric: true });

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function badRequest(message, code) {
  const e = new Error(message);
  e.code = code || 'BAD_REQUEST';
  e.status = 400;
  return e;
}

function notFound(message) {
  const e = new Error(message || '记录不存在');
  e.code = 'NOT_FOUND';
  e.status = 404;
  return e;
}

/** 按白名单裁剪 payload，并做类型归一 */
function pick(payload, fields) {
  const out = {};
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(payload, f)) continue;
    let v = payload[f];
    if (v === undefined) continue;

    /* 可空数值字段（经纬度）：空值保留为 NULL，非法值也置 NULL */
    if (NULLABLE_NUMERIC_FIELDS.has(f)) {
      if (v === null || v === '' || v === 'null') { out[f] = null; continue; }
      const n = Number(v);
      out[f] = isFinite(n) ? n : null;
      continue;
    }

    /* 数值与整型字段：这些列是 NOT NULL DEFAULT 0，非法值必须归一为 0 而非 NULL */
    if (NUMERIC_FIELDS.has(f) || INT_FIELDS.has(f)) {
      if (v === null || v === '') { out[f] = 0; continue; }
      const n = Number(v);
      if (!isFinite(n)) { out[f] = 0; continue; }
      out[f] = INT_FIELDS.has(f) ? Math.trunc(n) : n;
      continue;
    }

    if (v === null) { out[f] = null; continue; }
    if (typeof v === 'boolean') { out[f] = v ? 1 : 0; continue; }
    if (typeof v === 'string') { out[f] = v.trim(); continue; }
    if (typeof v === 'number') { out[f] = v; continue; }
    out[f] = String(v).trim();
  }
  return out;
}

/** 写操作日志 */
function logActivity(db, entityType, entityId, action, summary, detail) {
  db.prepare(
    `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(entityType, entityId || null, action, summary || '', detail ? JSON.stringify(detail) : '', now());
}

/** 读取字典选项（按分类分组）
 *  @param {object} db
 *  @param {boolean} includeDisabled true=管理页用，返回全部分类的所有项（含 enabled 标记）；
 *                                   false=表单下拉用，只返回启用中的项
 */
function readDict(db, includeDisabled) {
  const rows = db.prepare(
    `SELECT id, category, value, color, sort, enabled, is_system
     FROM dict
     WHERE deleted_at IS NULL ${includeDisabled ? '' : 'AND enabled = 1'}
     ORDER BY category, sort, id`
  ).all();
  const map = {};
  for (const r of rows) {
    (map[r.category] = map[r.category] || []).push(plain(r));
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* 列表查询                                                            */
/* ------------------------------------------------------------------ */

/**
 * 客户列表
 * @param {object} db
 * @param {object} q  查询参数
 */
function listCustomers(db, q) {
  const where = ['c.deleted_at IS NULL'];
  const params = [];

  /* 关键词：客户名 / 简称 / 电话 / 信用代码 / 供应商编码 / 联系人姓名与手机 */
  if (q.q) {
    const kw = `%${String(q.q).trim()}%`;
    where.push(`(c.name LIKE ? OR c.short_name LIKE ? OR c.phone LIKE ? OR c.credit_code LIKE ?
                 OR c.supplier_code LIKE ? OR c.end_user LIKE ? OR c.design_institute LIKE ?
                 OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.customer_id = c.id
                            AND ct.deleted_at IS NULL AND (ct.name LIKE ? OR ct.mobile LIKE ?)))`);
    params.push(kw, kw, kw, kw, kw, kw, kw, kw, kw);
  }

  /* 等值筛选 */
  for (const f of EQ_FILTERS) {
    if (q[f]) { where.push(`c.${f} = ?`); params.push(q[f]); }
  }

  /* 认证要求：多选值存逗号串，用 LIKE 近似匹配 */
  if (q.cert_required) {
    where.push('c.cert_required LIKE ?');
    params.push(`%${q.cert_required}%`);
  }

  /* 标签筛选（命中任一） */
  if (q.tag_id) {
    where.push(`EXISTS (SELECT 1 FROM customer_tags ctg WHERE ctg.customer_id = c.id AND ctg.tag_id = ?)`);
    params.push(Number(q.tag_id));
  }

  /* 快捷筛选 */
  if (q.quick === 'level_a')     where.push(`c.level = 'A 重点客户'`);
  if (q.quick === 'design')      where.push(`c.type = '设计院'`);
  if (q.quick === 'has_debt')    where.push(`EXISTS (
      SELECT 1 FROM projects p WHERE p.customer_id = c.id AND p.deleted_at IS NULL
        AND p.contract_amount > 0
        AND p.contract_amount > COALESCE((SELECT SUM(pm.amount) FROM payments pm
              WHERE pm.project_id = p.id AND pm.type = '实收'), 0))`);
  if (q.quick === 'stale30')     where.push(`(c.last_follow_at IS NULL OR c.last_follow_at < datetime('now','localtime','-30 days'))`);
  if (q.quick === 'overdue')     where.push(`(c.next_follow_at IS NOT NULL AND c.next_follow_at < datetime('now','localtime'))`);
  if (q.quick === 'today')       where.push(`(c.next_follow_at IS NOT NULL AND date(c.next_follow_at) <= date('now','localtime'))`);
  if (q.quick === 'no_follow')   where.push(`c.follow_count = 0`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  /* 总数 */
  const total = db.prepare(`SELECT COUNT(*) AS n FROM customers c ${whereSql}`).get(...params).n;

  /* 分页参数 */
  const pageSize = Math.min(Math.max(Number(q.pageSize) || 20, 1), 500);
  const page = Math.max(Number(q.page) || 1, 1);
  const offset = (page - 1) * pageSize;

  /* ------------------------------------------------------------------
   * 按名称排序：SQLite 默认 BINARY 按 UTF-8 字节序排中文（中国→宝钢→新疆），
   * 不符合中文阅读习惯。改为两段式：先只取 id 在内存中按拼音排序，
   * 再按页取详情。仅对 name 走这条路，其余排序仍在数据库内完成。
   * ---------------------------------------------------------------- */
  let idPage = null;
  if (q.sort === 'name') {
    const dir = String(q.order || 'asc').toLowerCase() === 'asc' ? 1 : -1;
    const idRows = db.prepare(`SELECT c.id, c.name FROM customers c ${whereSql}`).all(...params);
    idRows.sort((a, b) => {
      const r = ZH_COLLATOR.compare(String(a.name || ''), String(b.name || ''));
      return r !== 0 ? r * dir : (b.id - a.id) * dir;
    });
    idPage = idRows.slice(offset, offset + pageSize).map((r) => r.id);
  }

  /* 组装排序子句（非名称排序时使用） */
  let orderSql;
  if (q.sort === 'level') {
    orderSql = `${LEVEL_ORDER} ASC, c.id DESC`;
  } else if (SORT_MAP[q.sort] && q.sort !== 'name') {
    const dir = String(q.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    /* 下次跟进时间：无值的排最后 */
    const nulls = q.sort === 'next_follow_at' ? `(c.next_follow_at IS NULL) ASC,` : '';
    orderSql = `${nulls} ${SORT_MAP[q.sort]} ${dir}, c.id DESC`;
  } else if (q.sort === 'name') {
    orderSql = 'c.id ASC';  // 占位；实际顺序由 idPage 决定
  } else {
    orderSql = 'c.updated_at DESC, c.id DESC';
  }

  /* 无匹配结果时直接返回，避免无效查询 */
  if (idPage && idPage.length === 0) {
    return { list: [], total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  const pageClause = idPage
    ? `c.id IN (${idPage.map(() => '?').join(', ')})`
    : '1 = 1';
  const listParams = idPage ? params.concat(idPage) : params.concat([pageSize, offset]);

  /* 列表行的字段集合。
     注意：列表页的「编辑」是拿列表行当初始值的，因此这里必须包含
     编辑表单会用到的字段——否则表单里缺失的字段是空值，
     整体保存时会把库里已有的值覆盖成空（曾导致"详细地址保存后自动清空"）。
     这里取"表格显示字段 + 编辑表单字段"的并集。 */
  const rows = db.prepare(`
    SELECT c.id, c.name, c.short_name, c.type, c.industry, c.source, c.level, c.status,
           c.phone, c.fax, c.email, c.website, c.wechat, c.credit_code, c.owner,
           c.province, c.city, c.district, c.address, c.zip_code,
           c.region_code, c.region_name,
           c.longitude, c.latitude,
           c.enterprise_nature, c.parent_group, c.scale, c.employees,
           c.legal_person, c.founded_at, c.is_listed,
           c.purchase_mode, c.end_user, c.design_institute, c.epc_contractor,
           c.valve_types, c.drive_mode, c.body_material, c.pressure_rating,
           c.size_range, c.design_standard, c.connection_type, c.cert_required,
           c.annual_demand, c.purchase_cycle, c.account_period,
           c.warranty_ratio, c.warranty_months, c.payer, c.tender_platform,
           c.qualification, c.has_ts_license, c.has_explosion_proof, c.quality_grade,
           c.supplier_code, c.credit_rating, c.introducer, c.competitor,
           c.customer_since, c.remark,
           c.next_follow_at, c.last_follow_at, c.follow_count, c.deal_amount,
           c.updated_at, c.created_at,
           (SELECT ct.name FROM contacts ct WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL
              ORDER BY ct.is_primary DESC, ct.id ASC LIMIT 1) AS primary_contact,
           (SELECT ct.mobile FROM contacts ct WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL
              ORDER BY ct.is_primary DESC, ct.id ASC LIMIT 1) AS primary_mobile,
           (SELECT COUNT(*) FROM contacts ct WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL) AS contact_count,
           (SELECT COUNT(*) FROM projects p WHERE p.customer_id = c.id AND p.deleted_at IS NULL) AS project_count,
           (SELECT COALESCE(SUM(p.contract_amount),0) FROM projects p
              WHERE p.customer_id = c.id AND p.deleted_at IS NULL) AS contract_total,
           (SELECT COALESCE(SUM(pm.amount),0) FROM payments pm
              JOIN projects p2 ON p2.id = pm.project_id
              WHERE p2.customer_id = c.id AND pm.type = '实收' AND p2.deleted_at IS NULL) AS received_total
    FROM customers c
    ${whereSql}
    ${idPage ? `AND ${pageClause}` : ''}
    ORDER BY ${orderSql}
    ${idPage ? '' : 'LIMIT ? OFFSET ?'}
  `).all(...listParams);

  let list = plainAll(rows).map((r) => {
    r.debt_total = Math.round((r.contract_total - r.received_total) * 100) / 100;
    r.overdue = !!(r.next_follow_at && new Date(String(r.next_follow_at).replace(' ', 'T')).getTime() < Date.now());
    return r;
  });

  /* 名称排序时按内存中的 id 顺序重排 */
  if (idPage) {
    const pos = new Map(idPage.map((id, i) => [id, i]));
    list.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  }

  return { list, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/* ------------------------------------------------------------------ */
/* 详情                                                                */
/* ------------------------------------------------------------------ */

function getCustomer(db, id) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
  if (!c || c.deleted_at) throw notFound('客户不存在或已删除');
  const customer = plain(c);

  customer.contacts = plainAll(db.prepare(
    `SELECT * FROM contacts WHERE customer_id = ? AND deleted_at IS NULL
     ORDER BY is_primary DESC, is_decision DESC, id ASC`
  ).all(customer.id));

  customer.tags = plainAll(db.prepare(
    `SELECT t.id, t.name, t.color FROM tags t
     JOIN customer_tags ct ON ct.tag_id = t.id WHERE ct.customer_id = ?
     ORDER BY t.sort, t.id`
  ).all(customer.id));

  customer.followups = plainAll(db.prepare(
    `SELECT f.*, p.name AS project_name FROM followups f
     LEFT JOIN projects p ON p.id = f.project_id
     WHERE f.customer_id = ? AND f.deleted_at IS NULL
     ORDER BY f.followed_at DESC, f.id DESC LIMIT 200`
  ).all(customer.id));

  customer.projects = plainAll(db.prepare(`
    SELECT p.id, p.name, p.stage, p.progress, p.contract_amount, p.payment_status,
           p.bid_date, p.bid_result, p.signed_at, p.delivery_date,
           COALESCE((SELECT SUM(pm.amount) FROM payments pm
                     WHERE pm.project_id = p.id AND pm.type = '实收'), 0) AS received
    FROM projects p WHERE p.customer_id = ? AND p.deleted_at IS NULL
    ORDER BY p.id DESC
  `).all(customer.id)).map((p) => {
    p.debt = Math.round((p.contract_amount - p.received) * 100) / 100;
    p.rate = p.contract_amount > 0 ? Math.round((p.received / p.contract_amount) * 1000) / 10 : 0;
    return p;
  });

  customer.tasks = plainAll(db.prepare(
    `SELECT id, title, due_at, priority, status, source FROM tasks
     WHERE customer_id = ? AND deleted_at IS NULL AND status = '待办'
     ORDER BY (due_at IS NULL) ASC, due_at ASC LIMIT 50`
  ).all(customer.id));

  customer.logs = plainAll(db.prepare(
    `SELECT id, action, summary, created_at FROM activity_logs
     WHERE entity_type = 'customer' AND entity_id = ?
     ORDER BY id DESC LIMIT 100`
  ).all(customer.id));

  /* 汇总 */
  customer.summary = {
    contact_count: customer.contacts.length,
    project_count: customer.projects.length,
    contract_total: customer.projects.reduce((s, p) => s + (p.contract_amount || 0), 0),
    received_total: customer.projects.reduce((s, p) => s + (p.received || 0), 0),
    debt_total: customer.projects.reduce((s, p) => s + (p.debt || 0), 0),
    follow_count: customer.follow_count || 0,
    task_count: customer.tasks.length
  };

  return customer;
}

/* ------------------------------------------------------------------ */
/* 保存客户                                                            */
/* ------------------------------------------------------------------ */

/** 查重：同名或同电话（排除自身） */
function findDuplicates(db, name, phone, excludeId) {
  const hits = [];
  const ex = excludeId ? 'AND id <> ?' : '';
  if (name) {
    const rows = db.prepare(
      `SELECT id, name, short_name, phone, status FROM customers
       WHERE deleted_at IS NULL AND name = ? ${ex} LIMIT 5`
    ).all(...(excludeId ? [name, excludeId] : [name]));
    for (const r of rows) hits.push(Object.assign(plain(r), { match: 'name' }));
  }
  if (phone) {
    const rows = db.prepare(
      `SELECT id, name, short_name, phone, status FROM customers
       WHERE deleted_at IS NULL AND phone = ? AND phone <> '' ${ex} LIMIT 5`
    ).all(...(excludeId ? [phone, excludeId] : [phone]));
    for (const r of rows) {
      if (!hits.some((h) => h.id === r.id)) hits.push(Object.assign(plain(r), { match: 'phone' }));
    }
  }
  return hits;
}

/**
 * 新增或更新客户
 * @returns {{id:number, created:boolean, duplicates:Array, changed:string[]}}
 */
function saveCustomer(db, payload) {
  const data = pick(payload, CUSTOMER_FIELDS);
  const id = payload.id ? Number(payload.id) : null;

  const ts = now();

  db.exec('BEGIN');
  try {
    if (id) {
      /* ---------- 更新：允许局部更新，只校验本次提交的字段 ---------- */
      const before = db.prepare('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!before) throw notFound('客户不存在或已删除');

      /* 若本次提交了名称，则名称不允许改成空 */
      if (Object.prototype.hasOwnProperty.call(data, 'name') && !(data.name || '').trim()) {
        throw badRequest('客户名称（全称）为必填项', 'NAME_REQUIRED');
      }

      const duplicates = findDuplicates(db, data.name || before.name, data.phone || '', id);

      const keys = Object.keys(data);
      if (keys.length) {
        db.prepare(
          `UPDATE customers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
        ).run(...keys.map((k) => data[k]), ts, id);
      }

      /* 记录变更明细，便于详情页「变更记录」展示 */
      const changed = [];
      for (const k of keys) {
        const oldV = before[k];
        const newV = data[k];
        const a = oldV === null || oldV === undefined ? '' : String(oldV);
        const b = newV === null || newV === undefined ? '' : String(newV);
        if (a !== b) changed.push({ field: k, from: a, to: b });
      }
      if (changed.length) {
        const FIELD_LABEL = {
          name: '名称', short_name: '简称', type: '主体类型', industry: '下游行业',
          source: '来源', level: '等级', status: '状态', owner: '归属',
          phone: '电话', email: '邮箱', wechat: '微信', address: '地址',
          purchase_mode: '采购模式', annual_demand: '年需求量', account_period: '账期',
          cert_required: '认证要求', supplier_code: '供应商编码', next_follow_at: '下次跟进',
          remark: '备注'
        };
        const summary = changed.slice(0, 3)
          .map((c) => `${FIELD_LABEL[c.field] || c.field}：${c.from || '空'} → ${c.to || '空'}`)
          .join('；');
        logActivity(db, 'customer', id, 'update',
          `修改 ${changed.length} 项 —— ${summary}${changed.length > 3 ? ' 等' : ''}`, changed);
      }

      /* 标签 */
      if (Array.isArray(payload.tag_ids)) applyTags(db, id, payload.tag_ids);

      /* 地址或坐标变化后，重新匹配归属地州 */
      if (keys.some((k) => ['city', 'district', 'province', 'region_code'].includes(k))) {
        if (data.region_code) {
          /* 前端明确指定了归属，按 code 补齐名称。
             但历史上前端下拉把「地州名」当值传过，会出现 region_code 里存名字的情况，
             这里统一纠正成编码；名字也认不出时才回退到按地址匹配。 */
          const resolved = resolveRegionInput(db, data.region_code);
          if (resolved) {
            db.prepare('UPDATE customers SET region_code = ?, region_name = ? WHERE id = ?')
              .run(resolved.code, resolved.name, id);
          } else {
            db.prepare('UPDATE customers SET region_code = ?, region_name = ? WHERE id = ?')
              .run('', '', id);
            syncCustomerRegion(db, id);
          }
        } else {
          syncCustomerRegion(db, id);
        }
      }

      db.exec('COMMIT');
      return { id, created: false, duplicates, changed: changed.map((c) => c.field) };
    }

    /* ---------- 新增 ---------- */
    const name = (data.name || '').trim();
    if (!name) throw badRequest('客户名称（全称）为必填项', 'NAME_REQUIRED');
    const duplicates = findDuplicates(db, name, data.phone || '', null);

    data.created_at = ts;
    data.updated_at = ts;
    const keys = Object.keys(data);
    const info = db.prepare(
      `INSERT INTO customers (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    ).run(...keys.map((k) => data[k]));

    const newId = Number(info.lastInsertRowid);
    if (Array.isArray(payload.tag_ids)) applyTags(db, newId, payload.tag_ids);
    logActivity(db, 'customer', newId, 'create', `新建客户：${name}`, null);

    /* 归属地州：优先用指定的 code，否则按地址文本匹配 */
    if (data.region_code) {
      const resolved = resolveRegionInput(db, data.region_code);
      if (resolved) {
        db.prepare('UPDATE customers SET region_code = ?, region_name = ? WHERE id = ?')
          .run(resolved.code, resolved.name, newId);
      } else {
        db.prepare("UPDATE customers SET region_code = '', region_name = '' WHERE id = ?").run(newId);
        syncCustomerRegion(db, newId);
      }
    } else {
      syncCustomerRegion(db, newId);
    }

    db.exec('COMMIT');
    return { id: newId, created: true, duplicates, changed: [] };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 覆盖式设置客户标签 */
function applyTags(db, customerId, tagIds) {
  db.prepare('DELETE FROM customer_tags WHERE customer_id = ?').run(customerId);
  const ins = db.prepare('INSERT OR IGNORE INTO customer_tags (customer_id, tag_id, created_at) VALUES (?, ?, ?)');
  const ts = now();
  for (const t of tagIds) {
    const tid = Number(t);
    if (Number.isInteger(tid) && tid > 0) ins.run(customerId, tid, ts);
  }
}

/**
 * 依据客户的省/市/区县自动归属到地州（region_code）
 *
 * 说明：region 表里地州是 level='city'、县市区是 level='district'。
 * 客户在界面上填的是「市 / 地区」与「区 / 县」，这里做名称匹配后写入 region_code，
 * 供地图统计与按区域筛选使用。匹配不到就保持为空（不猜）。
 *
 * 真实填法很随意，因此匹配顺序按「越具体越优先」排：
 *   ① 区县字段 → 二级区划（如「天山区」「库车市」「莎车县」）
 *   ② 区县字段 → 地州（有人把地州填在区县里）
 *   ③ 市字段   → 二级区划（**关键**：库尔勒/独山子/乌鲁木齐县这类本身是县级，
 *                用户很自然会把它们填在「市/地区」里，区县留空）
 *   ④ 市字段   → 地州（含简称：昌吉州、巴州）
 *   ⑤ 兜底：把地址全字段拼起来做包含匹配
 * 匹配到的二级区划用它的 parent_code 作为地州；若 parent 与用户填的地州不一致，
 * 则以用户填的地州为准（避免「昌吉州/库尔勒市」这种矛盾填法把客户归错地方）。
 */

/** 去括号补充说明：「乌鲁木齐市高新区（新市区）」→「乌鲁木齐市高新区」 */
function stripParen(s) {
  return String(s || '').replace(/[（(][^）)]*[）)]/g, '').trim();
}

/**
 * 把用户传来的「归属地州」值解析成 { code, name }。
 *
 * 为什么要这层：该字段应存地州编码（地图按 code 聚合），
 * 但早期前端下拉把「地州名」当值传，库里因此出现过 region_code='克拉玛依市' 这种数据。
 * 这里同时接受编码与名称，统一返回编码；两者都认不出返回 null（由调用方回退到按地址匹配）。
 */
function resolveRegionInput(db, input) {
  const v = String(input == null ? '' : input).trim();
  if (!v) return null;
  /* 1) 就是编码 */
  const byCode = db.prepare('SELECT code, name FROM region WHERE code = ?').get(v);
  if (byCode) return { code: byCode.code, name: byCode.name };
  /* 2) 是地州名（含简称） */
  const byName = db.prepare(
    "SELECT code, name FROM region WHERE level = 'city' AND name = ? LIMIT 1"
  ).get(v);
  if (byName) return { code: byName.code, name: byName.name };
  const short = stripParen(v).replace(/(回族自治州|蒙古自治州|哈萨克自治州|柯尔克孜自治州|自治州|地区|市|州)$/, '');
  if (short && short !== v) {
    const byShort = db.prepare(
      "SELECT code, name FROM region WHERE level = 'city' AND (name = ? OR name LIKE ?) LIMIT 1"
    ).get(short, short + '%');
    if (byShort) return { code: byShort.code, name: byShort.name };
  }
  /* 3) 干脆就是简称、且没带任何后缀（如「乌鲁木齐」「巴音郭楞」）：
        用地州名前缀匹配，取最短的一条避免误配到更长的名字。 */
  const bare = stripParen(v);
  if (bare.length >= 2) {
    const byPrefix = db.prepare(
      `SELECT code, name FROM region
       WHERE level = 'city' AND name LIKE ?
       ORDER BY LENGTH(name) ASC LIMIT 1`
    ).get(bare + '%');
    if (byPrefix) return { code: byPrefix.code, name: byPrefix.name };
  }
  return null;
}

/**
 * 纠历史脏数据：region_code 里存了地州名而不是编码的行，统一改成编码。
 * 幂等，可在启动时安全调用。
 */
function fixLegacyRegionCodes(db) {
  const bad = db.prepare(
    `SELECT c.id, c.region_code FROM customers c
     WHERE c.region_code <> ''
       AND NOT EXISTS (SELECT 1 FROM region r WHERE r.code = c.region_code)`
  ).all();
  let fixed = 0;
  const upd = db.prepare('UPDATE customers SET region_code = ?, region_name = ? WHERE id = ?');
  for (const row of bad) {
    const r = resolveRegionInput(db, row.region_code);
    if (r) { upd.run(r.code, r.name, row.id); fixed++; }
  }
  return fixed;
}

function syncCustomerRegion(db, customerId) {
  const c = db.prepare(
    'SELECT id, province, city, district, address, region_code FROM customers WHERE id = ?'
  ).get(Number(customerId));
  if (!c) return null;

  const hasRegion = !!c.region_code;

  const cityText = String(c.city || '').trim();
  const distText = String(c.district || '').trim();
  const addrText = String(c.address || '').trim();
  const provText = String(c.province || '').trim();

  if (!cityText && !distText && !addrText) {
    if (hasRegion) {
      db.prepare("UPDATE customers SET region_code = '', region_name = '' WHERE id = ?").run(c.id);
    }
    return null;
  }

  /* ---------- 匹配用的查表语句 ---------- */
  const byDistrictName = db.prepare(
    "SELECT code, name, parent_code FROM region WHERE level = 'district' AND name = ? LIMIT 1"
  );
  const byCityName = db.prepare(
    "SELECT code, name FROM region WHERE level = 'city' AND name = ? LIMIT 1"
  );
  const byCityLike = db.prepare(
    "SELECT code, name FROM region WHERE level = 'city' AND name LIKE ? ORDER BY code LIMIT 1"
  );
  const nameOf = db.prepare('SELECT name FROM region WHERE code = ?');
  const parentOf = db.prepare('SELECT code, name FROM region WHERE code = ?');

  /** 找二级区划（县市区），支持去掉「区/县/市」后缀再试一次 */
  function findDistrict(text) {
    const t = stripParen(text);
    if (!t) return null;
    let hit = byDistrictName.get(t);
    if (!hit) {
      const bare = t.replace(/(区|县|市)$/, '');
      if (bare && bare !== t) hit = byDistrictName.get(bare);
    }
    /* 再试去掉空白与"自治县/自治旗"等后缀 */
    if (!hit) {
      const bare2 = t.replace(/(自治县|自治旗|新区|经济开发区|经济技术开发区|工业园区)$/, '').trim();
      if (bare2 && bare2 !== t) hit = byDistrictName.get(bare2);
    }
    return hit || null;
  }

  /** 找地州，支持常见简称 */
  function findPrefecture(text) {
    const t = stripParen(text);
    if (!t) return null;
    let hit = byCityName.get(t);
    if (hit) return hit;
    const short = t.replace(/(回族自治州|蒙古自治州|哈萨克自治州|柯尔克孜自治州|自治州|地区|市|州)$/, '');
    if (short && short !== t) {
      hit = byCityName.get(short) || byCityLike.get(short + '%');
      if (hit) return hit;
    }
    /* 「乌鲁木齐市高新区」这类：取前 3~4 个字试地州前缀 */
    for (const n of [4, 3]) {
      if (t.length > n) {
        const p = t.slice(0, n);
        const h = byCityName.get(p) || byCityLike.get(p + '%');
        if (h) return h;
      }
    }
    return null;
  }

  /* ---------- 依次尝试 ---------- */
  let code = '';
  let name = '';
  let via = '';

  /* ③④ 先看市字段（最常见的错填位置），保证「用户明确填了地州」时以它为准 */
  const preFromCity = cityText ? findPrefecture(cityText) : null;
  /* ① 区县字段的二级区划 */
  const distHit = distText ? findDistrict(distText) : null;
  /* 区县字段直接就是地州（有人把地州填在区县里） */
  const preFromDist = distText ? findPrefecture(distText) : null;
  /* 市字段其实是二级区划（库尔勒市 / 独山子区 / 乌鲁木齐县） */
  const distFromCity = cityText ? findDistrict(cityText) : null;

  if (distHit) {
    /* 区县是明确的二级区划：默认归到它的上级地州；
       但若用户同时填了地州且与上级不一致，以用户填的地州为准。 */
    if (preFromCity && preFromCity.code !== distHit.parent_code) {
      code = preFromCity.code; name = preFromCity.name; via = 'city';
    } else {
      code = distHit.parent_code;
      const p = parentOf.get(code);
      name = p ? p.name : '';
      via = 'district';
    }
  } else if (preFromCity) {
    code = preFromCity.code; name = preFromCity.name; via = 'city';
  } else if (distFromCity) {
    /* 用户把县级市/区/县填在了「市/地区」里，区县留空 */
    code = distFromCity.parent_code;
    const p = parentOf.get(code);
    name = p ? p.name : '';
    via = 'city-as-district';
  } else if (preFromDist) {
    code = preFromDist.code; name = preFromDist.name; via = 'district-as-city';
  } else {
    /* ⑤ 兜底：把 province/city/district/address 拼起来做包含匹配 */
    const blob = [provText, cityText, distText, addrText].filter(Boolean).join(' ');
    const shortBlob = stripParen(blob);
    if (shortBlob) {
      for (const r of db.prepare("SELECT code, name FROM region WHERE level = 'city' ORDER BY LENGTH(name) DESC").all()) {
        const bare = r.name.replace(/(回族自治州|蒙古自治州|哈萨克自治州|柯尔克孜自治州|自治州|地区|市)$/, '');
        if (shortBlob.includes(r.name) || (bare.length >= 2 && shortBlob.includes(bare))) {
          code = r.code; name = r.name; via = 'blob';
          break;
        }
      }
    }
  }

  if (code) {
    if (code !== c.region_code) {
      db.prepare('UPDATE customers SET region_code = ?, region_name = ? WHERE id = ?')
        .run(code, name || (nameOf.get(code) || {}).name || '', c.id);
    }
    return { code, name, via };
  }

  if (hasRegion) {
    /* 地址改了但匹配不上，清空旧归属，避免统计错位 */
    db.prepare("UPDATE customers SET region_code = '', region_name = '' WHERE id = ?").run(c.id);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 删除 / 还原                                                         */
/* ------------------------------------------------------------------ */

function deleteCustomers(db, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (!list.length) throw badRequest('未指定要删除的客户');
  const ts = now();

  db.exec('BEGIN');
  try {
    const get = db.prepare('SELECT id, name FROM customers WHERE id = ? AND deleted_at IS NULL');
    const upd = db.prepare('UPDATE customers SET deleted_at = ?, updated_at = ? WHERE id = ?');
    const undone = [];
    for (const id of list) {
      const c = get.get(id);
      if (!c) continue;
      upd.run(ts, ts, id);
      logActivity(db, 'customer', id, 'delete', `删除客户：${c.name}（可在回收站还原）`, null);
      undone.push(c.name);
    }
    db.exec('COMMIT');
    return { count: undone.length, names: undone };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

function restoreCustomers(db, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (!list.length) throw badRequest('未指定要还原的客户');
  const ts = now();

  db.exec('BEGIN');
  try {
    const get = db.prepare('SELECT id, name FROM customers WHERE id = ?');
    const upd = db.prepare('UPDATE customers SET deleted_at = NULL, updated_at = ? WHERE id = ?');
    let count = 0;
    for (const id of list) {
      const c = get.get(id);
      if (!c) continue;
      upd.run(ts, id);
      logActivity(db, 'customer', id, 'restore', `还原客户：${c.name}`, null);
      count++;
    }
    db.exec('COMMIT');
    return { count };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 批量操作：打标签 / 改状态 / 改等级 */
function bulkUpdate(db, ids, action) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (!list.length) throw badRequest('未选中任何客户');
  const ts = now();

  db.exec('BEGIN');
  try {
    let count = 0;
    if (action.type === 'status') {
      if (!action.value) throw badRequest('未指定要设置的状态');
      const upd = db.prepare('UPDATE customers SET status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL');
      const get = db.prepare('SELECT name FROM customers WHERE id = ?');
      for (const id of list) {
        upd.run(action.value, ts, id);
        count++;
        logActivity(db, 'customer', id, 'update', `批量改状态为「${action.value}」：${(get.get(id) || {}).name || id}`, null);
      }
    } else if (action.type === 'level') {
      if (!action.value) throw badRequest('未指定要设置的等级');
      const upd = db.prepare('UPDATE customers SET level = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL');
      for (const id of list) { upd.run(action.value, ts, id); count++; }
      logActivity(db, 'customer', null, 'bulk', `批量设置等级「${action.value}」共 ${count} 家客户`, null);
    } else if (action.type === 'tag') {
      if (!action.tag_id) throw badRequest('未指定标签');
      const ins = db.prepare('INSERT OR IGNORE INTO customer_tags (customer_id, tag_id, created_at) VALUES (?, ?, ?)');
      for (const id of list) { ins.run(id, Number(action.tag_id), ts); count++; }
      logActivity(db, 'customer', null, 'bulk', `批量打标签，共 ${count} 家客户`, null);
    } else if (action.type === 'untag') {
      if (!action.tag_id) throw badRequest('未指定标签');
      const del = db.prepare('DELETE FROM customer_tags WHERE customer_id = ? AND tag_id = ?');
      for (const id of list) { del.run(id, Number(action.tag_id)); count++; }
    } else if (action.type === 'owner') {
      const upd = db.prepare('UPDATE customers SET owner = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL');
      for (const id of list) { upd.run(String(action.value || ''), ts, id); count++; }
    } else {
      throw badRequest('不支持的批量操作类型：' + action.type);
    }
    db.exec('COMMIT');
    return { count };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 联系人                                                              */
/* ------------------------------------------------------------------ */

function saveContact(db, payload) {
  const data = pick(payload, CONTACT_FIELDS);
  const id = payload.id ? Number(payload.id) : null;
  const customerId = Number(data.customer_id || payload.customer_id);
  if (!Number.isInteger(customerId) || customerId <= 0) throw badRequest('缺少所属客户');
  data.customer_id = customerId;
  if (!(data.name || '').trim()) throw badRequest('联系人姓名为必填项', 'NAME_REQUIRED');

  const ts = now();
  db.exec('BEGIN');
  try {
    if (id) {
      const keys = Object.keys(data);
      db.prepare(`UPDATE contacts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => data[k]), ts, id);
      if (data.is_primary === 1) clearOtherPrimary(db, customerId, id);
      logActivity(db, 'contact', customerId, 'update', `更新联系人：${data.name}`, null);
      db.exec('COMMIT');
      return { id, created: false };
    }

    data.created_at = ts;
    data.updated_at = ts;
    const keys = Object.keys(data);
    const info = db.prepare(
      `INSERT INTO contacts (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    ).run(...keys.map((k) => data[k]));
    const newId = Number(info.lastInsertRowid);
    if (data.is_primary === 1) clearOtherPrimary(db, customerId, newId);
    logActivity(db, 'contact', customerId, 'create', `新增联系人：${data.name}${data.position ? '（' + data.position + '）' : ''}`, null);
    db.exec('COMMIT');
    return { id: newId, created: true };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 保证一个客户只有一个主联系人 */
function clearOtherPrimary(db, customerId, keepId) {
  db.prepare('UPDATE contacts SET is_primary = 0 WHERE customer_id = ? AND id <> ?').run(customerId, keepId);
}

function deleteContact(db, id) {
  const ts = now();
  const c = db.prepare('SELECT id, name, customer_id FROM contacts WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!c) throw notFound('联系人不存在');
  db.prepare('UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, c.id);
  logActivity(db, 'contact', c.customer_id, 'delete', `删除联系人：${c.name}`, null);
  return { count: 1 };
}

/* ------------------------------------------------------------------ */
/* 跟进记录                                                            */
/* ------------------------------------------------------------------ */

/**
 * 保存跟进记录，并同步回填客户的：
 *   last_follow_at / follow_count / next_follow_at
 * 若填写了下次跟进时间，自动生成一条待办。
 */
function saveFollowup(db, payload) {
  const data = pick(payload, FOLLOWUP_FIELDS);
  const id = payload.id ? Number(payload.id) : null;
  const customerId = Number(data.customer_id || payload.customer_id);
  if (!Number.isInteger(customerId) || customerId <= 0) throw badRequest('缺少所属客户');
  data.customer_id = customerId;
  if (!(data.content || '').trim()) throw badRequest('跟进内容为必填项', 'CONTENT_REQUIRED');
  if (!data.followed_at) data.followed_at = now();
  if (!data.method) data.method = '电话';

  const ts = now();
  let taskCreated = false;
  let newId = null;

  db.exec('BEGIN');
  try {
    if (id) {
      const keys = Object.keys(data);
      db.prepare(`UPDATE followups SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => data[k]), ts, id);
    } else {
      data.created_at = ts;
      data.updated_at = ts;
      const keys = Object.keys(data);
      const info = db.prepare(
        `INSERT INTO followups (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
      ).run(...keys.map((k) => data[k]));
      newId = Number(info.lastInsertRowid);
    }

    const fid = id || newId;
    syncCustomerFollowStats(db, customerId, ts);
    logActivity(db, 'customer', customerId, 'followup',
      `记录跟进（${data.method}）：${(data.content || '').slice(0, 40)}${(data.content || '').length > 40 ? '…' : ''}`, null);

    /* 下次跟进时间 → 自动生成待办 */
    if (data.next_at) {
      const dup = db.prepare(
        `SELECT id FROM tasks WHERE customer_id = ? AND source = '跟进计划' AND status = '待办'
         AND due_at = ? AND deleted_at IS NULL`
      ).get(customerId, data.next_at);
      if (!dup) {
        const title = data.next_plan
          ? `跟进计划：${String(data.next_plan).slice(0, 60)}`
          : '客户跟进提醒';
        db.prepare(
          `INSERT INTO tasks (title, customer_id, project_id, due_at, priority, status, source, remark, created_at, updated_at)
           VALUES (?, ?, ?, ?, '中', '待办', '跟进计划', '', ?, ?)`
        ).run(title, customerId, data.project_id || null, data.next_at, ts, ts);
        taskCreated = true;
      }
    }

    db.exec('COMMIT');
    return { id: fid, created: !id, taskCreated };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 依据跟进记录重算客户的跟进统计与下次跟进时间 */
function syncCustomerFollowStats(db, customerId, ts) {
  const agg = db.prepare(
    `SELECT COUNT(*) AS n, MAX(followed_at) AS last_at FROM followups
     WHERE customer_id = ? AND deleted_at IS NULL`
  ).get(customerId);

  /* 下次跟进时间取最近一条「有下次时间」的跟进记录 */
  const next = db.prepare(
    `SELECT next_at FROM followups
     WHERE customer_id = ? AND deleted_at IS NULL AND next_at IS NOT NULL AND next_at <> ''
     ORDER BY next_at ASC LIMIT 1`
  ).get(customerId);

  const derived = next ? next.next_at : null;

  /* 关键：不为空才覆盖客户上的 next_follow_at。
     因为该字段也可由用户在客户表单上手动设置（如「三个月后再联系」），
     若无条件覆盖，用户手动设的日期会在记录一条不带下次时间的跟进后被清空——
     导致首页「今日待跟进」与列表逾期标红失效。 */
  db.prepare(
    `UPDATE customers
        SET follow_count = ?,
            last_follow_at = ?,
            next_follow_at = COALESCE(?, next_follow_at),
            updated_at = ?
      WHERE id = ?`
  ).run(agg.n || 0, agg.last_at || null, derived, ts || now(), customerId);

  const current = db.prepare('SELECT next_follow_at FROM customers WHERE id = ?').get(customerId);
  return {
    follow_count: agg.n || 0,
    last_follow_at: agg.last_at || null,
    next_follow_at: current ? current.next_follow_at : derived
  };
}

function deleteFollowup(db, id) {
  const ts = now();
  const f = db.prepare('SELECT id, customer_id, content FROM followups WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!f) throw notFound('跟进记录不存在');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE followups SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, f.id);
    syncCustomerFollowStats(db, f.customer_id, ts);
    logActivity(db, 'customer', f.customer_id, 'followup_delete',
      `删除一条跟进记录：${String(f.content || '').slice(0, 30)}`, null);
    db.exec('COMMIT');
    return { count: 1 };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 标签                                                                */
/* ------------------------------------------------------------------ */

function listTags(db) {
  return plainAll(db.prepare(`
    SELECT t.id, t.name, t.color, t.sort,
           (SELECT COUNT(*) FROM customer_tags ct
              JOIN customers c ON c.id = ct.customer_id AND c.deleted_at IS NULL
            WHERE ct.tag_id = t.id) AS customer_count
    FROM tags t ORDER BY t.sort, t.id
  `).all());
}

function saveTag(db, payload) {
  const data = pick(payload, TAG_FIELDS);
  const id = payload.id ? Number(payload.id) : null;
  if (!(data.name || '').trim()) throw badRequest('标签名称不能为空');
  const ts = now();
  if (id) {
    db.prepare('UPDATE tags SET name = ?, color = ?, sort = ?, updated_at = ? WHERE id = ?')
      .run(data.name, data.color || '#4b7bec', Number(data.sort) || 0, ts, id);
    return { id, created: false };
  }
  const dup = db.prepare('SELECT id FROM tags WHERE name = ?').get(data.name);
  if (dup) throw badRequest('标签「' + data.name + '」已存在', 'DUPLICATE');
  const info = db.prepare('INSERT INTO tags (name, color, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(data.name, data.color || '#4b7bec', Number(data.sort) || 0, ts, ts);
  return { id: Number(info.lastInsertRowid), created: true };
}

function deleteTag(db, id) {
  const tid = Number(id);
  const t = db.prepare('SELECT id, name FROM tags WHERE id = ?').get(tid);
  if (!t) throw notFound('标签不存在');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM customer_tags WHERE tag_id = ?').run(tid);
    db.prepare('DELETE FROM tags WHERE id = ?').run(tid);
    db.exec('COMMIT');
    return { count: 1, name: t.name };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 字典：完整增删改（表单内联新增 + 设置页管理共用）                     */
/* ------------------------------------------------------------------ */

/**
 * 新增字典选项（支持表单内联新增）
 * @returns {{id:number, value:string, existed:boolean, reenabled?:boolean, restored?:boolean}}
 */
function quickAddDict(db, category, value, options) {
  const opts = options || {};
  const cat = String(category || '').trim();
  const val = String(value || '').trim();
  if (!cat) throw badRequest('缺少字典分类');
  if (!val) throw badRequest('选项名称不能为空');
  if (val.length > 60) throw badRequest('选项名称过长（最多 60 字）');

  const dup = db.prepare(
    'SELECT id, value, enabled, deleted_at FROM dict WHERE category = ? AND value = ?'
  ).get(cat, val);

  const ts = now();

  if (dup && !dup.deleted_at) {
    if (opts.forceNew) {
      /* 设置页「新增」遇到同名：明确拒绝，避免用户以为建了两条 */
      throw badRequest(`「${val}」已存在`, 'DUPLICATE');
    }
    /* 已存在但被停用 → 重新启用，避免用户以为「点了没反应」 */
    if (!dup.enabled) {
      db.prepare('UPDATE dict SET enabled = 1, updated_at = ? WHERE id = ?').run(ts, dup.id);
      return { id: dup.id, value: dup.value, existed: true, reenabled: true };
    }
    return { id: dup.id, value: dup.value, existed: true };
  }

  if (dup && dup.deleted_at) {
    if (!opts.forceNew) {
      /* 历史上引用过该选项的数据仍在 → 复活原记录，保证显示不乱 */
      db.prepare('UPDATE dict SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?')
        .run(ts, dup.id);
      return { id: dup.id, value: dup.value, existed: true, restored: true };
    }
    /* 强制新建：先把旧的软删除行改名，让出唯一约束，再插入新行 */
    db.prepare('UPDATE dict SET value = ?, updated_at = ? WHERE id = ?')
      .run(`__deleted_${dup.id}__${dup.value}`.slice(0, 120), ts, dup.id);
  }

  const maxSort = db.prepare(
    'SELECT COALESCE(MAX(sort), 0) AS s FROM dict WHERE category = ?'
  ).get(cat).s;
  const info = db.prepare(
    `INSERT INTO dict (category, value, color, sort, enabled, is_system, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 0, ?, ?)`
  ).run(cat, val, String(opts.color || ''), Number(maxSort) + 10, ts, ts);

  logActivity(db, 'dict', Number(info.lastInsertRowid), 'create',
    `新增字典选项：${cat} → ${val}`, null);
  return { id: Number(info.lastInsertRowid), value: val, existed: false };
}

/** 更新字典选项。改名不影响历史数据（历史数据存的是选项文本，改名后各表同步刷新） */
function updateDict(db, id, payload) {
  const did = Number(id);
  const row = db.prepare('SELECT * FROM dict WHERE id = ?').get(did);
  if (!row || row.deleted_at) throw notFound('字典选项不存在');

  const sets = [];
  const params = [];
  let newVal = row.value;

  if (payload.value !== undefined) {
    const v = String(payload.value).trim();
    if (!v) throw badRequest('选项名称不能为空');
    const dup = db.prepare(
      'SELECT id FROM dict WHERE category = ? AND value = ? AND id <> ? AND deleted_at IS NULL'
    ).get(row.category, v, did);
    if (dup) throw badRequest(`同一分类下已存在「${v}」`, 'DUPLICATE');
    sets.push('value = ?'); params.push(v);
    newVal = v;
  }
  if (payload.color !== undefined) { sets.push('color = ?'); params.push(String(payload.color || '')); }
  if (payload.sort !== undefined) { sets.push('sort = ?'); params.push(Number(payload.sort) || 0); }
  if (payload.enabled !== undefined) { sets.push('enabled = ?'); params.push(payload.enabled ? 1 : 0); }

  if (!sets.length) return { id: did, changed: 0, value: newVal };

  sets.push('updated_at = ?');
  params.push(now(), did);
  db.prepare(`UPDATE dict SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  /* 改名时同步刷新业务表中的历史值，避免出现「老数据仍是旧名字」 */
  let synced = 0;
  if (newVal !== row.value) {
    synced = renameInBusinessTables(db, row.category, row.value, newVal);
    logActivity(db, 'dict', did, 'update',
      `字典改名：${row.value} → ${newVal}（同步更新 ${synced} 条历史数据）`, null);
  } else {
    logActivity(db, 'dict', did, 'update', `更新字典选项：${newVal}`, null);
  }

  return { id: did, changed: sets.length - 1, value: newVal, synced };
}

/** 字典改名后同步业务表中的历史值 */
function renameInBusinessTables(db, category, oldVal, newVal) {
  const MAPPING = {
    industry:            ['customers', 'industry'],
    customer_type:       ['customers', 'type'],
    customer_status:     ['customers', 'status'],
    customer_level:      ['customers', 'level'],
    customer_source:     ['customers', 'source'],
    purchase_mode:       ['customers', 'purchase_mode'],
    enterprise_nature:   ['customers', 'enterprise_nature'],
    credit_rating_src:   ['customers', 'credit_rating'],
    account_period:      ['customers', 'account_period'],
    project_stage:       ['projects', 'stage'],
    bid_result:          ['projects', 'bid_result'],
    follow_method:       ['followups', 'method'],
    follow_result:       ['followups', 'result'],
    contact_position:    ['contacts', 'position'],
    contact_influence:   ['contacts', 'influence'],
    payment_method:      ['payments', 'method']
  };
  const hit = MAPPING[category];
  if (!hit) return 0;
  const [table, column] = hit;
  const info = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(newVal, oldVal);
  return Number(info.changes || 0);
}

/**
 * 删除字典选项。
 * 系统内置选项（is_system=1）只允许停用，不允许删除，避免误删行业/阶段等核心选项。
 */
function deleteDict(db, id) {
  const did = Number(id);
  const row = db.prepare('SELECT * FROM dict WHERE id = ?').get(did);
  if (!row || row.deleted_at) throw notFound('字典选项不存在');

  if (row.is_system) {
    db.prepare('UPDATE dict SET enabled = 0, updated_at = ? WHERE id = ?').run(now(), did);
    logActivity(db, 'dict', did, 'disable',
      `系统内置选项「${row.value}」已停用（内置项不可删除）`, null);
    return { id: did, deleted: false, disabled: true, value: row.value, isSystem: true };
  }

  const ts = now();
  db.prepare('UPDATE dict SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?').run(ts, ts, did);
  logActivity(db, 'dict', did, 'delete', `删除字典选项：${row.value}`, null);
  return { id: did, deleted: true, disabled: true, value: row.value, isSystem: false };
}

/** 统计某字典选项被业务数据引用的次数（删除前提示用） */
function countDictUsage(db, category, value) {
  const MAPPING = {
    industry:          ['customers', 'industry'],
    customer_type:     ['customers', 'type'],
    customer_status:   ['customers', 'status'],
    customer_level:    ['customers', 'level'],
    customer_source:   ['customers', 'source'],
    purchase_mode:     ['customers', 'purchase_mode'],
    enterprise_nature: ['customers', 'enterprise_nature'],
    project_stage:     ['projects', 'stage'],
    follow_method:     ['followups', 'method'],
    follow_result:     ['followups', 'result']
  };
  const hit = MAPPING[category];
  if (!hit) return 0;
  const [table, column] = hit;
  return db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ? AND deleted_at IS NULL`
  ).get(value).n;
}

/* ------------------------------------------------------------------ */
/* 操作日志查询                                                        */
/* ------------------------------------------------------------------ */

const ENTITY_LABEL = {
  customer: '客户', contact: '联系人', project: '项目', task: '待办',
  dict: '字典', tag: '标签', import: '导入', payment: '回款'
};
const ACTION_LABEL = {
  create: '新建', update: '修改', delete: '删除', restore: '还原',
  followup: '跟进', followup_delete: '删除跟进', payment: '回款',
  bulk: '批量', disable: '停用', import: '导入'
};

function listLogs(db, q) {
  const where = ['1 = 1'];
  const params = [];

  if (q.entity_type) { where.push('entity_type = ?'); params.push(q.entity_type); }
  if (q.action) { where.push('action = ?'); params.push(q.action); }
  if (q.entity_id) { where.push('entity_id = ?'); params.push(Number(q.entity_id)); }
  if (q.q) {
    const kw = `%${String(q.q).trim()}%`;
    where.push('(summary LIKE ? OR detail LIKE ?)');
    params.push(kw, kw);
  }
  if (q.date_from) { where.push('date(created_at) >= ?'); params.push(q.date_from); }
  if (q.date_to) { where.push('date(created_at) <= ?'); params.push(q.date_to); }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM activity_logs ${whereSql}`).get(...params).n;

  const pageSize = Math.min(Math.max(Number(q.pageSize) || 50, 1), 500);
  const page = Math.max(Number(q.page) || 1, 1);
  const offset = (page - 1) * pageSize;

  const rows = plainAll(db.prepare(`
    SELECT id, entity_type, entity_id, action, summary, created_at
    FROM activity_logs ${whereSql}
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset)).map((r) => Object.assign(r, {
    entity_label: ENTITY_LABEL[r.entity_type] || r.entity_type,
    action_label: ACTION_LABEL[r.action] || r.action
  }));

  /* 统计各类型数量（用于界面筛选下拉） */
  const byEntity = plainAll(db.prepare(
    'SELECT entity_type, COUNT(*) AS n FROM activity_logs GROUP BY entity_type ORDER BY n DESC'
  ).all());
  const byAction = plainAll(db.prepare(
    'SELECT action, COUNT(*) AS n FROM activity_logs GROUP BY action ORDER BY n DESC'
  ).all());

  return {
    list: rows,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    stats: {
      by_entity: byEntity.map((r) => Object.assign(r, { label: ENTITY_LABEL[r.entity_type] || r.entity_type })),
      by_action: byAction.map((r) => Object.assign(r, { label: ACTION_LABEL[r.action] || r.action }))
    }
  };
}

/* ------------------------------------------------------------------ */
/* 回收站                                                              */
/* ------------------------------------------------------------------ */

function listTrash(db, entityType) {
  const type = entityType || 'customer';
  if (type === 'customer') {
    return plainAll(db.prepare(
      `SELECT id, name AS title, short_name AS sub, deleted_at FROM customers
       WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200`
    ).all());
  }
  if (type === 'followup') {
    return plainAll(db.prepare(
      `SELECT f.id, f.content AS title, c.name AS sub, f.deleted_at
       FROM followups f LEFT JOIN customers c ON c.id = f.customer_id
       WHERE f.deleted_at IS NOT NULL ORDER BY f.deleted_at DESC LIMIT 200`
    ).all());
  }
  if (type === 'contact') {
    return plainAll(db.prepare(
      `SELECT ct.id, ct.name AS title, c.name AS sub, ct.deleted_at
       FROM contacts ct LEFT JOIN customers c ON c.id = ct.customer_id
       WHERE ct.deleted_at IS NOT NULL ORDER BY ct.deleted_at DESC LIMIT 200`
    ).all());
  }
  if (type === 'project') {
    return plainAll(db.prepare(
      `SELECT p.id, p.name AS title, c.name AS sub, p.deleted_at
       FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
       WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC LIMIT 200`
    ).all());
  }
  if (type === 'task') {
    return plainAll(db.prepare(
      `SELECT t.id, t.title AS title, t.source AS sub, t.deleted_at
       FROM tasks t WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC LIMIT 200`
    ).all());
  }
  return [];
}

module.exports = {
  CUSTOMER_FIELDS,
  CONTACT_FIELDS,
  FOLLOWUP_FIELDS,
  readDict,
  listCustomers,
  getCustomer,
  saveCustomer,
  deleteCustomers,
  restoreCustomers,
  bulkUpdate,
  saveContact,
  deleteContact,
  saveFollowup,
  deleteFollowup,
  syncCustomerFollowStats,
  listTags,
  saveTag,
  deleteTag,
  quickAddDict,
  updateDict,
  deleteDict,
  countDictUsage,
  listTrash,
  listLogs,
  syncCustomerRegion,
  fixLegacyRegionCodes,
  ENTITY_LABEL,
  ACTION_LABEL,
  logActivity,
  findDuplicates
};
