/**
 * 业务服务层 —— 项目 / 回款 / 待办
 *
 * 核心设计（方案第 2.5–2.7 节）：
 *   1. 欠款、回款率、回款状态**全部实时算出**，不接受人工填写的「已回款」
 *   2. 登记实收后自动重算项目 received_amount / payment_status，并同步客户累计成交额
 *   3. 新建回款计划时按提醒天数自动生成待办
 *   4. 计划是否已核销 = 该计划下关联的实收金额 ≥ 计划金额（实时判定，不存标记位）
 */

'use strict';

const { plain, plainAll, now } = require('../db');
const { logActivity } = require('./crm');

/* ------------------------------------------------------------------ */
/* 字段白名单                                                          */
/* ------------------------------------------------------------------ */

const PROJECT_FIELDS = [
  'name', 'customer_id', 'stage', 'progress', 'end_user', 'design_institute',
  'valve_needs', 'quantity', 'contract_amount', 'signed_at', 'bid_date',
  'bid_result', 'win_rate_note', 'start_date', 'end_date', 'delivery_date',
  'owner', 'remark'
];

const PAYMENT_FIELDS = [
  'project_id', 'customer_id', 'type', 'amount', 'plan_date', 'actual_date',
  'method', 'plan_id', 'voucher', 'remark'
];

const TASK_FIELDS = [
  'title', 'customer_id', 'project_id', 'due_at', 'priority', 'status',
  'done_at', 'source', 'remark'
];

const NUMERIC_FIELDS = new Set(['contract_amount', 'amount', 'quantity', 'progress']);
const INT_FIELDS = new Set(['customer_id', 'project_id', 'plan_id']);

/** 允许排序的列 */
const SORT_MAP = {
  updated_at: 'p.updated_at',
  created_at: 'p.created_at',
  contract_amount: 'p.contract_amount',
  signed_at: 'p.signed_at',
  bid_date: 'p.bid_date',
  delivery_date: 'p.delivery_date',
  end_date: 'p.end_date',
  progress: 'p.progress'
};

/** 项目阶段默认顺序（用于看板与排序权重） */
const STAGE_ORDER = [
  '信息收集', '初步接洽', '技术交流', '方案选型', '询价报价', '投标/议价',
  '已中标/已签约', '生产执行', '发货交付', '安装调试', '验收结项',
  '质保期内', '已暂停', '已终止'
];
/** 视为「进行中」的阶段（已暂停/已终止不计入） */
const ACTIVE_STAGES = STAGE_ORDER.filter((s) => s !== '已暂停' && s !== '已终止');
/** 视为「已成交」的阶段（用于客户成交额统计） */
const WON_STAGES = [
  '已中标/已签约', '生产执行', '发货交付', '安装调试', '验收结项', '质保期内'
];

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

function pick(payload, fields) {
  const out = {};
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(payload, f)) continue;
    let v = payload[f];
    if (v === undefined) continue;

    if (NUMERIC_FIELDS.has(f) || INT_FIELDS.has(f)) {
      if (v === null || v === '') { out[f] = 0; continue; }
      const n = Number(v);
      out[f] = isFinite(n) ? (INT_FIELDS.has(f) ? Math.trunc(n) : n) : 0;
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

/** 本地日期 YYYY-MM-DD */
function today() {
  return now().slice(0, 10);
}

/** 日期加减天数 */
function addDays(dateStr, days) {
  const d = new Date(String(dateStr).replace(' ', 'T'));
  d.setDate(d.getDate() + Number(days || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* 项目：列表                                                          */
/* ------------------------------------------------------------------ */

function listProjects(db, q) {
  const where = ['p.deleted_at IS NULL'];
  const params = [];

  if (q.q) {
    const kw = `%${String(q.q).trim()}%`;
    where.push(`(p.name LIKE ? OR p.end_user LIKE ? OR p.design_institute LIKE ?
                 OR p.valve_needs LIKE ? OR c.name LIKE ? OR c.short_name LIKE ?)`);
    params.push(kw, kw, kw, kw, kw, kw);
  }
  if (q.customer_id) { where.push('p.customer_id = ?'); params.push(Number(q.customer_id)); }
  if (q.stage) { where.push('p.stage = ?'); params.push(q.stage); }
  if (q.bid_result) { where.push('p.bid_result = ?'); params.push(q.bid_result); }
  if (q.owner) { where.push('p.owner = ?'); params.push(q.owner); }

  /* 日期区间 */
  if (q.date_field && q.date_from) {
    const col = ['bid_date', 'signed_at', 'delivery_date', 'end_date'].includes(q.date_field)
      ? q.date_field : 'created_at';
    where.push(`p.${col} >= ?`); params.push(q.date_from);
  }
  if (q.date_field && q.date_to) {
    const col = ['bid_date', 'signed_at', 'delivery_date', 'end_date'].includes(q.date_field)
      ? q.date_field : 'created_at';
    where.push(`p.${col} <= ?`); params.push(q.date_to);
  }

  /* 回款状态（实时判定） */
  if (q.payment_status === '未开始') {
    where.push(`p.contract_amount = 0`);
  } else if (q.payment_status === '已结清') {
    where.push(`p.contract_amount > 0 AND p.contract_amount <= COALESCE((SELECT SUM(pm.amount) FROM payments pm
      WHERE pm.project_id = p.id AND pm.type = '实收'), 0)`);
  } else if (q.payment_status === '部分回款') {
    where.push(`p.contract_amount > 0 AND COALESCE((SELECT SUM(pm.amount) FROM payments pm
      WHERE pm.project_id = p.id AND pm.type = '实收'), 0) > 0
      AND p.contract_amount > COALESCE((SELECT SUM(pm.amount) FROM payments pm
      WHERE pm.project_id = p.id AND pm.type = '实收'), 0)`);
  } else if (q.payment_status === '有欠款') {
    where.push(`p.contract_amount > COALESCE((SELECT SUM(pm.amount) FROM payments pm
      WHERE pm.project_id = p.id AND pm.type = '实收'), 0)`);
  }

  /* 快捷筛选 */
  if (q.quick === 'active') {
    where.push(`p.stage NOT IN ('已暂停','已终止')`);
  } else if (q.quick === 'overdue_payment') {
    where.push(`EXISTS (SELECT 1 FROM payments pm WHERE pm.project_id = p.id AND pm.type = '计划'
      AND pm.plan_date IS NOT NULL AND pm.plan_date <> '' AND pm.plan_date < date('now','localtime')
      AND pm.amount > COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
        WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0))`);
    where.push('p.deleted_at IS NULL');
  } else if (q.quick === 'bidding') {
    where.push(`p.stage IN ('询价报价','投标/议价')`);
  } else if (q.quick === 'upcoming_bid') {
    where.push(`p.bid_date IS NOT NULL AND p.bid_date <> '' AND p.bid_date >= date('now','localtime')
      AND p.bid_date <= date('now','localtime','+7 days')`);
  } else if (q.quick === 'unsigned') {
    where.push(`p.contract_amount = 0 AND p.stage NOT IN ('已终止','已暂停')`);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM projects p LEFT JOIN customers c ON c.id = p.customer_id ${whereSql}`
  ).get(...params).n;

  const pageSize = Math.min(Math.max(Number(q.pageSize) || 20, 1), 500);
  const page = Math.max(Number(q.page) || 1, 1);
  const offset = (page - 1) * pageSize;

  let orderSql;
  if (q.sort === 'stage') {
    const cases = STAGE_ORDER.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ');
    orderSql = `CASE p.stage ${cases} ELSE 99 END ASC, p.id DESC`;
  } else if (SORT_MAP[q.sort]) {
    const dir = String(q.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const nulls = ['signed_at', 'bid_date', 'delivery_date', 'end_date'].includes(q.sort)
      ? `(p.${q.sort} IS NULL OR p.${q.sort} = '') ASC,` : '';
    orderSql = `${nulls} ${SORT_MAP[q.sort]} ${dir}, p.id DESC`;
  } else {
    orderSql = 'p.updated_at DESC, p.id DESC';
  }

  /* 列表行的字段集合。
     与客户列表同理：列表页的「编辑」拿列表行当初始值，
     因此这里必须覆盖编辑表单会用到的全部可写字段，
     否则从列表页编辑会把库里已有值覆盖成空。 */
  const rows = db.prepare(`
    SELECT p.id, p.name, p.customer_id, p.stage, p.progress, p.contract_amount,
           p.signed_at, p.bid_date, p.bid_result, p.delivery_date, p.end_date,
           p.payment_status, p.owner, p.end_user, p.design_institute, p.quantity,
           p.valve_needs, p.win_rate_note, p.start_date, p.remark,
           p.data_origin, p.updated_at, p.created_at,
           c.name AS customer_name, c.short_name AS customer_short,
           COALESCE((SELECT SUM(pm.amount) FROM payments pm
                     WHERE pm.project_id = p.id AND pm.type = '实收'), 0) AS received_amount,
           (SELECT COUNT(*) FROM payments pm WHERE pm.project_id = p.id AND pm.type = '计划') AS plan_count,
           (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = '待办' AND t.deleted_at IS NULL) AS task_count,
           (SELECT MIN(pm.plan_date) FROM payments pm WHERE pm.project_id = p.id AND pm.type = '计划'
              AND pm.plan_date IS NOT NULL AND pm.plan_date <> '' AND pm.plan_date < date('now','localtime')
              AND pm.amount > COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
                WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0)) AS overdue_date
    FROM projects p
    LEFT JOIN customers c ON c.id = p.customer_id
    ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const list = plainAll(rows).map((r) => finalizeProjectRow(r));

  /* 汇总（与筛选条件一致，用于列表页顶部总计） */
  const sumRow = db.prepare(`
    SELECT COALESCE(SUM(p.contract_amount), 0) AS contract_total,
           COALESCE(SUM(COALESCE((SELECT SUM(pm.amount) FROM payments pm
             WHERE pm.project_id = p.id AND pm.type = '实收'), 0)), 0) AS received_total
    FROM projects p LEFT JOIN customers c ON c.id = p.customer_id ${whereSql}
  `).get(...params);

  return {
    list,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    summary: {
      contract_total: Math.round(sumRow.contract_total * 100) / 100,
      received_total: Math.round(sumRow.received_total * 100) / 100,
      debt_total: Math.round((sumRow.contract_total - sumRow.received_total) * 100) / 100
    }
  };
}

/** 计算单行的欠款、回款率、回款状态 */
function finalizeProjectRow(r) {
  const contract = Number(r.contract_amount) || 0;
  const received = Number(r.received_amount) || 0;
  r.received_amount = Math.round(received * 100) / 100;
  r.debt_amount = Math.round((contract - received) * 100) / 100;
  if (contract > 0) {
    r.payment_rate = Math.round((received / contract) * 1000) / 10;
    r.payment_status = received <= 0 ? '未开始' : (received >= contract ? '已结清' : '部分回款');
  } else {
    r.payment_rate = 0;
    r.payment_status = '未签约';
  }
  r.overdue_payment = !!r.overdue_date;
  r.is_active = ACTIVE_STAGES.includes(r.stage);
  return r;
}

/* ------------------------------------------------------------------ */
/* 项目：看板（按阶段分组）                                             */
/* ------------------------------------------------------------------ */

function boardProjects(db, q) {
  /* 看板一次取全部匹配项目（阶段三不做分页，500 条量级无压力） */
  const res = listProjects(db, Object.assign({}, q, { page: 1, pageSize: 500 }));
  const columns = STAGE_ORDER.map((stage) => {
    const items = res.list.filter((p) => p.stage === stage);
    return {
      stage,
      count: items.length,
      contract_total: Math.round(items.reduce((s, p) => s + (Number(p.contract_amount) || 0), 0) * 100) / 100,
      items
    };
  });
  return { columns, total: res.total, summary: res.summary, truncated: res.total > 500 };
}

/* ------------------------------------------------------------------ */
/* 项目：详情                                                          */
/* ------------------------------------------------------------------ */

function getProject(db, id) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
  if (!row || row.deleted_at) throw notFound('项目不存在或已删除');
  const project = plain(row);

  const customer = db.prepare(
    'SELECT id, name, short_name, type, industry, level, status FROM customers WHERE id = ?'
  ).get(project.customer_id);
  project.customer = customer ? plain(customer) : null;

  /* 回款计划：含已核销金额与状态 */
  project.plans = plainAll(db.prepare(`
    SELECT pm.*, COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
             WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0) AS settled_amount
    FROM payments pm
    WHERE pm.project_id = ? AND pm.type = '计划'
    ORDER BY (pm.plan_date IS NULL OR pm.plan_date = '') ASC, pm.plan_date ASC, pm.id ASC
  `).all(project.id)).map((p) => {
    const planned = Number(p.amount) || 0;
    const settled = Number(p.settled_amount) || 0;
    p.remain = Math.round((planned - settled) * 100) / 100;
    p.is_settled = planned > 0 && settled >= planned;
    p.is_overdue = !p.is_settled && !!p.plan_date && p.plan_date < today();
    return p;
  });

  /* 实收流水 */
  project.receipts = plainAll(db.prepare(`
    SELECT pm.*, pl.plan_date AS linked_plan_date
    FROM payments pm
    LEFT JOIN payments pl ON pl.id = pm.plan_id
    WHERE pm.project_id = ? AND pm.type = '实收'
    ORDER BY (pm.actual_date IS NULL OR pm.actual_date = '') ASC, pm.actual_date DESC, pm.id DESC
  `).all(project.id));

  /* 待办 */
  project.tasks = plainAll(db.prepare(
    `SELECT id, title, due_at, priority, status, source, done_at FROM tasks
     WHERE project_id = ? AND deleted_at IS NULL
     ORDER BY (status = '已完成') ASC, (due_at IS NULL) ASC, due_at ASC LIMIT 100`
  ).all(project.id));

  /* 跟进记录（关联到本项目的） */
  project.followups = plainAll(db.prepare(
    `SELECT f.*, c.name AS customer_name FROM followups f
     LEFT JOIN customers c ON c.id = f.customer_id
     WHERE f.project_id = ? AND f.deleted_at IS NULL
     ORDER BY f.followed_at DESC, f.id DESC LIMIT 100`
  ).all(project.id));

  /* 变更记录 */
  project.logs = plainAll(db.prepare(
    `SELECT id, action, summary, created_at FROM activity_logs
     WHERE entity_type = 'project' AND entity_id = ? ORDER BY id DESC LIMIT 100`
  ).all(project.id));

  /* 汇总 */
  const contract = Number(project.contract_amount) || 0;
  const received = project.receipts.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const planned = project.plans.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const settled = project.plans.reduce((s, p) => s + (Number(p.settled_amount) || 0), 0);
  project.received_amount = Math.round(received * 100) / 100;
  project.debt_amount = Math.round((contract - received) * 100) / 100;
  project.payment_rate = contract > 0 ? Math.round((received / contract) * 1000) / 10 : 0;
  project.payment_status = contract <= 0 ? '未签约'
    : (received <= 0 ? '未开始' : (received >= contract ? '已结清' : '部分回款'));
  project.summary = {
    contract_amount: contract,
    received_amount: project.received_amount,
    debt_amount: project.debt_amount,
    payment_rate: project.payment_rate,
    planned_amount: Math.round(planned * 100) / 100,
    settled_amount: Math.round(settled * 100) / 100,
    unsettled_amount: Math.round((planned - settled) * 100) / 100,
    overdue_count: project.plans.filter((p) => p.is_overdue).length,
    plan_count: project.plans.length,
    receipt_count: project.receipts.length,
    task_count: project.tasks.filter((t) => t.status === '待办').length
  };

  return project;
}

/* ------------------------------------------------------------------ */
/* 项目：保存                                                          */
/* ------------------------------------------------------------------ */

/** 同步客户累计成交额（只统计已成交阶段的项目） */
function syncCustomerDealAmount(db, customerId, ts) {
  if (!customerId) return;
  const marks = WON_STAGES.map(() => '?').join(', ');
  const row = db.prepare(
    `SELECT COALESCE(SUM(contract_amount), 0) AS total, MAX(signed_at) AS last_signed
     FROM projects WHERE customer_id = ? AND deleted_at IS NULL AND stage IN (${marks})`
  ).get(customerId, ...WON_STAGES);
  db.prepare('UPDATE customers SET deal_amount = ?, last_order_at = ?, updated_at = ? WHERE id = ?')
    .run(Math.round((row.total || 0) * 100) / 100, row.last_signed || null, ts || now(), customerId);
}

function saveProject(db, payload) {
  const data = pick(payload, PROJECT_FIELDS);
  const id = payload.id ? Number(payload.id) : null;
  const ts = now();

  db.exec('BEGIN');
  try {
    if (id) {
      const before = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!before) throw notFound('项目不存在或已删除');

      if (Object.prototype.hasOwnProperty.call(data, 'name') && !(data.name || '').trim()) {
        throw badRequest('项目名称为必填项', 'NAME_REQUIRED');
      }
      if (Object.prototype.hasOwnProperty.call(data, 'progress')) {
        data.progress = Math.max(0, Math.min(100, Number(data.progress) || 0));
      }

      const keys = Object.keys(data);
      if (keys.length) {
        db.prepare(
          `UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
        ).run(...keys.map((k) => data[k]), ts, id);
      }

      const LABEL = {
        name: '项目名称', stage: '阶段', progress: '进度', contract_amount: '合同金额',
        signed_at: '签约日期', bid_date: '投标日期', bid_result: '投标结果',
        delivery_date: '交货期', end_date: '预计结束', owner: '负责人',
        valve_needs: '阀门需求', quantity: '数量', end_user: '最终用户',
        design_institute: '设计院', win_rate_note: '中标/失标原因', remark: '备注'
      };
      const changed = [];
      for (const k of keys) {
        const a = before[k] === null || before[k] === undefined ? '' : String(before[k]);
        const b = data[k] === null || data[k] === undefined ? '' : String(data[k]);
        if (a !== b) changed.push({ field: k, from: a, to: b });
      }
      if (changed.length) {
        const summary = changed.slice(0, 3)
          .map((c) => `${LABEL[c.field] || c.field}：${c.from || '空'} → ${c.to || '空'}`).join('；');
        logActivity(db, 'project', id, 'update',
          `修改 ${changed.length} 项 —— ${summary}${changed.length > 3 ? ' 等' : ''}`, changed);
      }

      syncCustomerDealAmount(db, before.customer_id, ts);
      if (data.customer_id && data.customer_id !== before.customer_id) {
        syncCustomerDealAmount(db, data.customer_id, ts);
      }

      db.exec('COMMIT');
      return { id, created: false, changed: changed.map((c) => c.field) };
    }

    /* 新增 */
    if (!(data.name || '').trim()) throw badRequest('项目名称为必填项', 'NAME_REQUIRED');
    const customerId = Number(data.customer_id || payload.customer_id);
    if (!Number.isInteger(customerId) || customerId <= 0) throw badRequest('必须选择所属客户', 'CUSTOMER_REQUIRED');
    const cust = db.prepare('SELECT id, name FROM customers WHERE id = ? AND deleted_at IS NULL').get(customerId);
    if (!cust) throw badRequest('所属客户不存在或已删除');
    data.customer_id = customerId;
    if (!data.stage) data.stage = '信息收集';
    data.progress = Math.max(0, Math.min(100, Number(data.progress) || 0));

    data.created_at = ts;
    data.updated_at = ts;
    const keys = Object.keys(data);
    const info = db.prepare(
      `INSERT INTO projects (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    ).run(...keys.map((k) => data[k]));

    const newId = Number(info.lastInsertRowid);
    logActivity(db, 'project', newId, 'create',
      `新建项目：${data.name}（客户：${cust.name}）`, null);
    syncCustomerDealAmount(db, customerId, ts);

    db.exec('COMMIT');
    return { id: newId, created: true, changed: [] };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

function deleteProjects(db, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (!list.length) throw badRequest('未指定要删除的项目');
  const ts = now();

  db.exec('BEGIN');
  try {
    const get = db.prepare('SELECT id, name, customer_id FROM projects WHERE id = ? AND deleted_at IS NULL');
    const upd = db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?');
    const names = [];
    const customers = new Set();
    for (const id of list) {
      const p = get.get(id);
      if (!p) continue;
      upd.run(ts, ts, id);
      logActivity(db, 'project', id, 'delete', `删除项目：${p.name}（可在回收站还原）`, null);
      names.push(p.name);
      customers.add(p.customer_id);
    }
    for (const cid of customers) syncCustomerDealAmount(db, cid, ts);
    db.exec('COMMIT');
    return { count: names.length, names };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

function restoreProjects(db, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (!list.length) throw badRequest('未指定要还原的项目');
  const ts = now();

  db.exec('BEGIN');
  try {
    const get = db.prepare('SELECT id, name, customer_id FROM projects WHERE id = ?');
    const upd = db.prepare('UPDATE projects SET deleted_at = NULL, updated_at = ? WHERE id = ?');
    let count = 0;
    const customers = new Set();
    for (const id of list) {
      const p = get.get(id);
      if (!p) continue;
      upd.run(ts, id);
      logActivity(db, 'project', id, 'restore', `还原项目：${p.name}`, null);
      count++;
      customers.add(p.customer_id);
    }
    for (const cid of customers) syncCustomerDealAmount(db, cid, ts);
    db.exec('COMMIT');
    return { count };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 看板拖动改阶段 */
function moveStage(db, id, stage) {
  const pid = Number(id);
  if (!STAGE_ORDER.includes(stage)) throw badRequest('无效的项目阶段：' + stage);
  const p = db.prepare('SELECT id, name, stage, customer_id FROM projects WHERE id = ? AND deleted_at IS NULL').get(pid);
  if (!p) throw notFound('项目不存在或已删除');
  if (p.stage === stage) return { id: pid, stage, changed: false };

  const ts = now();
  db.exec('BEGIN');
  try {
    /* 进入已签约阶段时，若进度为 0 则给一个合理默认值 */
    const patch = { stage };
    if (WON_STAGES.includes(stage)) {
      const cur = db.prepare('SELECT progress, signed_at FROM projects WHERE id = ?').get(pid);
      if (!cur.signed_at && stage === '已中标/已签约') patch.signed_at = today();
      if (!cur.progress && stage !== '已中标/已签约') patch.progress = 10;
    }
    const keys = Object.keys(patch);
    db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => patch[k]), ts, pid);

    logActivity(db, 'project', pid, 'update', `阶段调整：${p.stage} → ${stage}`, null);
    syncCustomerDealAmount(db, p.customer_id, ts);
    db.exec('COMMIT');
    return { id: pid, stage, from: p.stage, changed: true };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 回款：计划与实收                                                    */
/* ------------------------------------------------------------------ */

/** 重算项目的已回款与回款状态（冗余缓存，便于列表快速查询） */
function syncProjectPayment(db, projectId) {
  const pid = Number(projectId);
  const proj = db.prepare('SELECT id, contract_amount, customer_id FROM projects WHERE id = ?').get(pid);
  if (!proj) return null;

  const received = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE project_id = ? AND type = '实收'`
  ).get(pid).s;
  const contract = Number(proj.contract_amount) || 0;
  const status = contract <= 0 ? '未开始' : (received <= 0 ? '未开始' : (received >= contract ? '已结清' : '部分回款'));

  db.prepare('UPDATE projects SET received_amount = ?, payment_status = ?, updated_at = ? WHERE id = ?')
    .run(Math.round(received * 100) / 100, status, now(), pid);

  syncCustomerDealAmount(db, proj.customer_id, now());
  return { received: Math.round(received * 100) / 100, contract, status };
}

/**
 * 保存回款（计划或实收）
 * @returns {{id:number, created:boolean, taskCreated?:boolean, warning?:string}}
 */
function savePayment(db, payload) {
  const data = pick(payload, PAYMENT_FIELDS);
  const id = payload.id ? Number(payload.id) : null;
  const type = data.type === '实收' ? '实收' : '计划';
  data.type = type;

  const projectId = Number(data.project_id || payload.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) throw badRequest('必须选择所属项目', 'PROJECT_REQUIRED');
  data.project_id = projectId;

  const proj = db.prepare('SELECT id, name, customer_id, contract_amount FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId);
  if (!proj) throw badRequest('所属项目不存在或已删除');
  data.customer_id = proj.customer_id;

  const amount = Number(data.amount) || 0;
  if (amount <= 0) throw badRequest('金额必须大于 0', 'AMOUNT_REQUIRED');

  const ts = now();
  let taskCreated = false;
  let warning = '';

  /* 校验：计划必须有计划日期；实收必须有实收日期 */
  if (type === '计划' && !data.plan_date) throw badRequest('计划收款日期为必填项', 'PLAN_DATE_REQUIRED');
  if (type === '实收' && !data.actual_date) data.actual_date = today();

  /* 超收提醒：实收累计超过合同额时给出警告（允许，但提示） */
  if (type === '实收') {
    const contract = Number(proj.contract_amount) || 0;
    const already = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE project_id = ? AND type = '实收' ${id ? 'AND id <> ?' : ''}`
    ).get(...(id ? [projectId, id] : [projectId])).s;
    if (contract > 0 && already + amount > contract) {
      const over = Math.round((already + amount - contract) * 100) / 100;
      warning = `本次收款后累计实收将超过合同金额 ${over} 元，请确认是否填错`;
    }
  }

  let newId = null;
  let oldPlanDate = null;

  db.exec('BEGIN');
  try {
    if (id) {
      const before = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
      if (!before) throw notFound('回款记录不存在');
      if (before.type !== type) throw badRequest('回款类型不可修改；如需变更请删除后重建');
      oldPlanDate = before.plan_date;

      const keys = Object.keys(data);
      db.prepare(`UPDATE payments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => data[k]), ts, id);
      newId = id;

      logActivity(db, 'project', projectId, 'payment',
        `${type === '计划' ? '修改回款计划' : '修改实收记录'}：${amount} 元`, null);
    } else {
      data.created_at = ts;
      data.updated_at = ts;
      const keys = Object.keys(data);
      const info = db.prepare(
        `INSERT INTO payments (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
      ).run(...keys.map((k) => data[k]));
      newId = Number(info.lastInsertRowid);

      logActivity(db, 'project', projectId, 'payment',
        type === '计划'
          ? `新增回款计划：${amount} 元，计划日期 ${data.plan_date}`
          : `登记实收：${amount} 元，收款日期 ${data.actual_date}`,
        { amount, type, plan_date: data.plan_date || null, actual_date: data.actual_date || null });
    }

    /* 计划 → 按提醒天数自动生成待办 */
    if (type === '计划') {
      const remindDays = Number(
        db.prepare("SELECT value FROM settings WHERE key = 'payment_remind_days'").get().value || 7
      );
      const dueAt = addDays(data.plan_date, -remindDays) + ' 09:00:00';
      const title = `回款提醒：${proj.name} 应收 ${amount} 元（计划 ${data.plan_date}）`;
      const dup = db.prepare(
        `SELECT id FROM tasks WHERE project_id = ? AND source = '回款计划' AND title = ? AND deleted_at IS NULL`
      ).get(projectId, title);
      if (!dup) {
        db.prepare(
          `INSERT INTO tasks (title, customer_id, project_id, due_at, priority, status, source, remark, created_at, updated_at)
           VALUES (?, ?, ?, ?, '高', '待办', '回款计划', ?, ?, ?)`
        ).run(title, proj.customer_id, projectId, dueAt, `回款计划 #${newId}`, ts, ts);
        taskCreated = true;
      } else {
        db.prepare('UPDATE tasks SET due_at = ?, updated_at = ? WHERE id = ?').run(dueAt, ts, dup.id);
      }
    }

    syncProjectPayment(db, projectId);
    db.exec('COMMIT');

    return { id: newId, created: !id, taskCreated, warning, planDate: data.plan_date || oldPlanDate };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

function deletePayment(db, id) {
  const pid = Number(id);
  const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(pid);
  if (!pay) throw notFound('回款记录不存在');

  const ts = now();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM payments WHERE id = ?').run(pid);

    /* 删除计划时，解除实收对它的核销关联（实收记录本身保留） */
    if (pay.type === '计划') {
      db.prepare('UPDATE payments SET plan_id = NULL, updated_at = ? WHERE plan_id = ?').run(ts, pid);
    }

    logActivity(db, 'project', pay.project_id, 'payment',
      `删除${pay.type === '计划' ? '回款计划' : '实收记录'}：${pay.amount} 元（${pay.plan_date || pay.actual_date || ''}）`, null);

    syncProjectPayment(db, pay.project_id);
    db.exec('COMMIT');
    return { count: 1, type: pay.type };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 回款总览：逾期计划、近期计划 */
function paymentOverview(db, days) {
  const horizon = addDays(today(), Number(days) || 30);

  const overdue = plainAll(db.prepare(`
    SELECT pm.id, pm.project_id, pm.amount, pm.plan_date, p.name AS project_name,
           c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short,
           COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
             WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0) AS settled_amount,
           CAST(julianday(date('now','localtime')) - julianday(pm.plan_date) AS INTEGER) AS overdue_days
    FROM payments pm
    JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
    LEFT JOIN customers c ON c.id = pm.customer_id
    WHERE pm.type = '计划' AND pm.plan_date IS NOT NULL AND pm.plan_date <> ''
      AND pm.plan_date < date('now','localtime')
      AND pm.amount > COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
        WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0)
    ORDER BY pm.plan_date ASC
    LIMIT 100
  `).all()).map((r) => {
    r.remain = Math.round(((Number(r.amount) || 0) - (Number(r.settled_amount) || 0)) * 100) / 100;
    return r;
  });

  const upcoming = plainAll(db.prepare(`
    SELECT pm.id, pm.project_id, pm.amount, pm.plan_date, p.name AS project_name,
           c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short,
           COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
             WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0) AS settled_amount
    FROM payments pm
    JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
    LEFT JOIN customers c ON c.id = pm.customer_id
    WHERE pm.type = '计划' AND pm.plan_date IS NOT NULL AND pm.plan_date <> ''
      AND pm.plan_date >= date('now','localtime') AND pm.plan_date <= ?
      AND pm.amount > COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
        WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0)
    ORDER BY pm.plan_date ASC
    LIMIT 100
  `).all(horizon)).map((r) => {
    r.remain = Math.round(((Number(r.amount) || 0) - (Number(r.settled_amount) || 0)) * 100) / 100;
    return r;
  });

  return {
    overdue,
    upcoming,
    overdue_amount: Math.round(overdue.reduce((s, r) => s + r.remain, 0) * 100) / 100,
    upcoming_amount: Math.round(upcoming.reduce((s, r) => s + r.remain, 0) * 100) / 100,
    horizon
  };
}

/* ------------------------------------------------------------------ */
/* 待办中心                                                            */
/* ------------------------------------------------------------------ */

function listTasks(db, q) {
  const where = ['t.deleted_at IS NULL'];
  const params = [];

  const view = q.view || 'today';
  if (view === 'today') {
    where.push(`t.status = '待办' AND t.due_at IS NOT NULL AND date(t.due_at) <= date('now','localtime')`);
  } else if (view === 'week') {
    where.push(`t.status = '待办' AND t.due_at IS NOT NULL
      AND date(t.due_at) > date('now','localtime')
      AND date(t.due_at) <= date('now','localtime','+7 days')`);
  } else if (view === 'overdue') {
    where.push(`t.status = '待办' AND t.due_at IS NOT NULL AND date(t.due_at) < date('now','localtime')`);
  } else if (view === 'done') {
    where.push(`t.status = '已完成'`);
  } else if (view === 'all') {
    /* 全部待办 */
    where.push(`t.status = '待办'`);
  } else if (view === 'nodate') {
    where.push(`t.status = '待办' AND (t.due_at IS NULL OR t.due_at = '')`);
  }

  if (q.priority) { where.push('t.priority = ?'); params.push(q.priority); }
  if (q.source) { where.push('t.source = ?'); params.push(q.source); }
  if (q.customer_id) { where.push('t.customer_id = ?'); params.push(Number(q.customer_id)); }
  if (q.project_id) { where.push('t.project_id = ?'); params.push(Number(q.project_id)); }
  if (q.q) {
    const kw = `%${String(q.q).trim()}%`;
    where.push('(t.title LIKE ? OR t.remark LIKE ?)');
    params.push(kw, kw);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = plainAll(db.prepare(`
    SELECT t.*, c.name AS customer_name, c.short_name AS customer_short,
           p.name AS project_name,
           CASE WHEN t.due_at IS NULL OR t.due_at = '' THEN 0
                WHEN date(t.due_at) < date('now','localtime') THEN 1 ELSE 0 END AS is_overdue,
           CASE WHEN t.due_at IS NULL OR t.due_at = '' THEN NULL
                ELSE CAST(julianday(date(t.due_at)) - julianday(date('now','localtime')) AS INTEGER) END AS days_left
    FROM tasks t
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN projects p ON p.id = t.project_id
    ${whereSql}
    ORDER BY
      CASE t.priority WHEN '高' THEN 1 WHEN '中' THEN 2 WHEN '低' THEN 3 ELSE 4 END ASC,
      (t.due_at IS NULL OR t.due_at = '') ASC,
      t.due_at ASC,
      t.id DESC
    LIMIT 500
  `).all(...params));

  /* 计数（用于标签页角标） */
  const countOf = (v) => {
    if (v === 'today') return db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE t.deleted_at IS NULL AND t.status='待办' AND t.due_at IS NOT NULL AND date(t.due_at) <= date('now','localtime')`).get().n;
    if (v === 'week') return db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE t.deleted_at IS NULL AND t.status='待办' AND t.due_at IS NOT NULL AND date(t.due_at) > date('now','localtime') AND date(t.due_at) <= date('now','localtime','+7 days')`).get().n;
    if (v === 'overdue') return db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE t.deleted_at IS NULL AND t.status='待办' AND t.due_at IS NOT NULL AND date(t.due_at) < date('now','localtime')`).get().n;
    if (v === 'done') return db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE t.deleted_at IS NULL AND t.status='已完成'`).get().n;
    return db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE t.deleted_at IS NULL AND t.status='待办'`).get().n;
  };

  return {
    view,
    list: rows,
    counts: {
      today: countOf('today'),
      week: countOf('week'),
      overdue: countOf('overdue'),
      done: countOf('done'),
      all: countOf('all')
    }
  };
}

function saveTask(db, payload) {
  const data = pick(payload, TASK_FIELDS);
  const id = payload.id ? Number(payload.id) : null;
  const ts = now();

  /* 待办可以不关联客户/项目，用 NULL 表示"未关联"。
     表单清空选择时会传来 0 或空串，若原样入库，按 customer_id IS NULL 查询就找不到这些待办，
     统计也会出现"孤儿"数据，因此统一归一化为 NULL。 */
  for (const k of ['customer_id', 'project_id']) {
    if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
    const v = data[k];
    if (v === null || v === undefined || v === '' || Number(v) === 0 || Number.isNaN(Number(v))) {
      data[k] = null;
    } else {
      data[k] = Number(v);
    }
  }

  if (Object.prototype.hasOwnProperty.call(data, 'title') && !(data.title || '').trim()) {
    throw badRequest('待办标题不能为空', 'TITLE_REQUIRED');
  }

  db.exec('BEGIN');
  try {
    if (id) {
      const before = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!before) throw notFound('待办不存在或已删除');
      const keys = Object.keys(data);
      if (keys.length) {
        db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...keys.map((k) => data[k]), ts, id);
      }
      db.exec('COMMIT');
      return { id, created: false };
    }

    if (!(data.title || '').trim()) throw badRequest('待办标题不能为空', 'TITLE_REQUIRED');
    if (!data.source) data.source = '手动';
    if (!data.status) data.status = '待办';
    if (!data.priority) data.priority = '中';

    /* 关联项目时自动带上客户 */
    if (data.project_id && !data.customer_id) {
      const p = db.prepare('SELECT customer_id FROM projects WHERE id = ?').get(Number(data.project_id));
      if (p) data.customer_id = p.customer_id;
    }

    data.created_at = ts;
    data.updated_at = ts;
    const keys = Object.keys(data);
    const info = db.prepare(
      `INSERT INTO tasks (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    ).run(...keys.map((k) => data[k]));

    const newId = Number(info.lastInsertRowid);
    logActivity(db, 'task', newId, 'create', `新增待办：${data.title}`, null);
    db.exec('COMMIT');
    return { id: newId, created: true };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/**
 * 一次性纠正历史数据：把早期版本可能写入的 tasks.customer_id / project_id = 0
 * 归一化为 NULL（0 不是合法主键，会让"未关联"查询与统计漏掉这些待办）。
 */
function normalizeTaskLinks(db) {
  const a = db.prepare('UPDATE tasks SET customer_id = NULL WHERE customer_id = 0').run().changes;
  const b = db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = 0').run().changes;
  return { customer_id: Number(a || 0), project_id: Number(b || 0) };
}

/** 完成 / 取消完成 */
function toggleTask(db, id, done) {
  const tid = Number(id);
  const t = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(tid);
  if (!t) throw notFound('待办不存在或已删除');

  const ts = now();
  const isDone = done === undefined ? t.status !== '已完成' : !!done;
  const status = isDone ? '已完成' : '待办';
  const doneAt = isDone ? ts : null;

  db.prepare('UPDATE tasks SET status = ?, done_at = ?, updated_at = ? WHERE id = ?')
    .run(status, doneAt, ts, tid);
  logActivity(db, 'task', tid, 'update', `${isDone ? '完成' : '重新打开'}待办：${t.title}`, null);

  return { id: tid, status, done_at: doneAt };
}

function deleteTasks(db, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (!list.length) throw badRequest('未指定要删除的待办');
  const ts = now();

  db.exec('BEGIN');
  try {
    const get = db.prepare('SELECT id, title FROM tasks WHERE id = ? AND deleted_at IS NULL');
    const upd = db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?');
    let count = 0;
    for (const id of list) {
      const t = get.get(id);
      if (!t) continue;
      upd.run(ts, ts, id);
      logActivity(db, 'task', id, 'delete', `删除待办：${t.title}`, null);
      count++;
    }
    db.exec('COMMIT');
    return { count };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 清理已完成待办（保留最近 N 天的） */
function purgeDoneTasks(db, keepDays) {
  const days = Number(keepDays);
  const n = Number.isFinite(days) ? days : 30;
  const info = db.prepare(
    `DELETE FROM tasks WHERE status = '已完成' AND done_at IS NOT NULL AND done_at < datetime('now','localtime',?)`
  ).run(`-${n} days`);
  return { removed: Number(info.changes || 0), keepDays: n };
}

module.exports = {
  STAGE_ORDER,
  ACTIVE_STAGES,
  WON_STAGES,
  PROJECT_FIELDS,
  PAYMENT_FIELDS,
  TASK_FIELDS,
  listProjects,
  boardProjects,
  getProject,
  saveProject,
  deleteProjects,
  restoreProjects,
  moveStage,
  syncProjectPayment,
  syncCustomerDealAmount,
  savePayment,
  deletePayment,
  paymentOverview,
  listTasks,
  saveTask,
  normalizeTaskLinks,
  toggleTask,
  deleteTasks,
  purgeDoneTasks
};
