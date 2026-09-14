/**
 * 报价单服务
 *
 * 设计要点：
 *   1. **金额一律服务端计算**：小计 = 数量 × 单价 × (1 − 折扣)，合计 = 各行小计之和。
 *      前端只做即时预览，保存时以服务端结果为准，避免两边算不一致。
 *   2. **报价阶段不动项目合同额**：报价合计 ≠ 合同额（中标后才是）。
 *      只有显式调用 applyToProject 才会回填，且由接口调用方（界面）负责二次确认。
 *   3. **报单号在事务内取号**，避免同一天多张单重号。
 *   4. 软删除（进回收站），与其它实体一致。
 */
'use strict';

const plain = (r) => (r === undefined || r === null ? r : Object.assign({}, r));
const plainAll = (rows) => (rows || []).map(plain);

/** 允许写入的报价单字段（白名单，避免任意列写入） */
const QUOTATION_FIELDS = [
  'project_id', 'customer_id', 'quote_no', 'version', 'parent_id',
  'quote_date', 'valid_until', 'currency', 'status', 'tax_note',
  'delivery_note', 'payment_note', 'competitor', 'competitor_price',
  'lose_reason', 'remark'
];

/** 允许写入的明细行字段 */
const ITEM_FIELDS = [
  'item_name', 'valve_type', 'size_range', 'pressure_rating', 'body_material',
  'connection_type', 'quantity', 'unit', 'unit_price', 'discount',
  'delivery_days', 'remark'
];

/** 状态白名单：与字典 quotation_status 一致 */
const STATUSES = ['草稿', '已报出', '已中标', '已落标', '已过期'];
const TERMINAL = ['已中标', '已落标', '已过期'];

function now() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function pick(src, fields) {
  const out = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(src || {}, f)) out[f] = src[f];
  }
  return out;
}

/** 金额归一：非有限数一律按 0（避免 NaN 落库） */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

/** 保留两位小数（避免浮点误差累积成 0.30000000000000004） */
function money(v) {
  return Math.round(num(v) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* 明细与合计计算                                                      */
/* ------------------------------------------------------------------ */

/**
 * 归一化一行明细并计算小计。
 * 折扣按百分比理解更符合销售习惯（填 10 = 让 10%），但库里存的是小数比例，
 * 这里兼容两种输入：> 1 视为百分比，≤ 1 视为比例。
 */
function normalizeItem(raw, seq) {
  const d = pick(raw, ITEM_FIELDS);
  const quantity = num(d.quantity, 0);
  const unitPrice = num(d.unit_price, 0);
  let discount = num(d.discount, 0);
  if (discount > 1) discount = discount / 100;          // 填 10 → 0.1
  if (discount < 0) discount = 0;
  if (discount > 1) discount = 1;                        // 折扣超过 100% 视为全免

  const subtotal = money(quantity * unitPrice * (1 - discount));
  return {
    seq,
    item_name: String(d.item_name === undefined || d.item_name === null ? '' : d.item_name).trim(),
    valve_type: String(d.valve_type || '').trim(),
    size_range: String(d.size_range || '').trim(),
    pressure_rating: String(d.pressure_rating || '').trim(),
    body_material: String(d.body_material || '').trim(),
    connection_type: String(d.connection_type || '').trim(),
    quantity,
    unit: String(d.unit || '台').trim() || '台',
    unit_price: unitPrice,
    discount: Math.round(discount * 10000) / 10000,
    subtotal,
    delivery_days: Math.round(num(d.delivery_days, 0)),
    remark: String(d.remark || '').trim()
  };
}

/** 明细行是否算"空行"（整行没填实质内容就丢弃，避免存一堆空行） */
function isBlankItem(it) {
  return !it.item_name && !it.valve_type && !it.size_range && !it.pressure_rating
    && !it.body_material && !it.connection_type
    && !it.quantity && !it.unit_price && !it.remark;
}

function sumItems(items) {
  return money(items.reduce((s, it) => s + num(it.subtotal, 0), 0));
}

/* ------------------------------------------------------------------ */
/* 报单号                                                              */
/* ------------------------------------------------------------------ */

/**
 * 生成报价单号：前缀-年月日-当日序号，例如 BJ-20260914-003。
 * 取号在调用方的事务内执行；这里用"当天已有最大序号 + 1"，
 * 并对已存在的号码做一次递增探测，避免手工改号造成的冲突。
 */
function nextQuoteNo(db, dateStr, prefix) {
  const pre = String(prefix || 'BJ').trim() || 'BJ';
  const day = String(dateStr || now().slice(0, 10)).slice(0, 10).replace(/-/g, '');
  const head = `${pre}-${day}-`;
  const row = db.prepare(
    `SELECT quote_no FROM quotations WHERE quote_no LIKE ? ORDER BY quote_no DESC LIMIT 1`
  ).get(head + '%');
  let seq = 1;
  if (row && row.quote_no) {
    const m = String(row.quote_no).match(/-(\d+)$/);
    if (m) seq = Number(m[1]) + 1;
  }
  let candidate = head + String(seq).padStart(3, '0');
  /* 极端情况：号码被人手工占用，向后探测 */
  let guard = 0;
  while (db.prepare('SELECT id FROM quotations WHERE quote_no = ?').get(candidate) && guard < 999) {
    seq++; guard++;
    candidate = head + String(seq).padStart(3, '0');
  }
  return candidate;
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

function listByProject(db, projectId) {
  const rows = plainAll(db.prepare(`
    SELECT q.*,
           (SELECT COUNT(*) FROM quotation_items i WHERE i.quotation_id = q.id) AS item_count,
           p.name AS project_name,
           c.name AS customer_name, c.short_name AS customer_short
    FROM quotations q
    LEFT JOIN projects p ON p.id = q.project_id
    LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.deleted_at IS NULL AND q.project_id = ?
    ORDER BY q.version DESC, q.id DESC
  `).all(Number(projectId)));
  return { list: rows, total: rows.length };
}

function listByCustomer(db, customerId) {
  const rows = plainAll(db.prepare(`
    SELECT q.*,
           (SELECT COUNT(*) FROM quotation_items i WHERE i.quotation_id = q.id) AS item_count,
           p.name AS project_name
    FROM quotations q
    LEFT JOIN projects p ON p.id = q.project_id
    WHERE q.deleted_at IS NULL AND q.customer_id = ?
    ORDER BY q.quote_date DESC, q.id DESC
  `).all(Number(customerId)));
  return { list: rows, total: rows.length };
}

function getOne(db, id) {
  const q = db.prepare(`
    SELECT q.*,
           p.name AS project_name, p.stage AS project_stage, p.contract_amount AS project_contract_amount,
           c.name AS customer_name, c.short_name AS customer_short, c.phone AS customer_phone
    FROM quotations q
    LEFT JOIN projects p ON p.id = q.project_id
    LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.id = ? AND q.deleted_at IS NULL
  `).get(Number(id));
  if (!q) return null;
  const items = plainAll(db.prepare(
    'SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY seq ASC, id ASC'
  ).all(Number(id)));

  /* 版本链：同一 parent 链上的所有版本（便于对比） */
  const versions = plainAll(db.prepare(`
    SELECT id, version, status, total_amount, quote_date
    FROM quotations
    WHERE deleted_at IS NULL
      AND project_id = ?
      AND (id = ? OR parent_id = ? OR id = ?)
    ORDER BY version ASC
  `).all(q.project_id, q.id, q.id, q.parent_id || 0));

  return Object.assign(plain(q), { items, versions });
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

/**
 * 新增或更新报价单（含明细整体覆盖）。
 * @returns {{id:number, created:boolean, total_amount:number}}
 */
function saveQuotation(db, payload, settings) {
  const p = payload || {};
  const id = p.id ? Number(p.id) : null;
  const ts = now();

  if (!p.project_id) {
    const e = new Error('请先选择所属项目'); e.status = 400; e.code = 'PROJECT_REQUIRED'; throw e;
  }
  const project = db.prepare('SELECT id, customer_id FROM projects WHERE id = ? AND deleted_at IS NULL')
    .get(Number(p.project_id));
  if (!project) {
    const e = new Error('项目不存在或已删除'); e.status = 404; e.code = 'PROJECT_NOT_FOUND'; throw e;
  }

  /* 明细先归一化（含丢弃空行） */
  const rawItems = Array.isArray(p.items) ? p.items : [];
  const items = rawItems.map((r, i) => normalizeItem(r, i + 1)).filter((it) => !isBlankItem(it));
  items.forEach((it, i) => { it.seq = i + 1; });
  const total = sumItems(items);

  const data = pick(p, QUOTATION_FIELDS);
  /* 客户跟随项目，避免手工填错导致"报价挂在 A 项目、客户是 B" */
  data.customer_id = project.customer_id || null;
  data.total_amount = total;
  if (data.status && !STATUSES.includes(data.status)) {
    const e = new Error('报价单状态不合法：' + data.status); e.status = 400; e.code = 'BAD_STATUS'; throw e;
  }

  db.exec('BEGIN');
  try {
    let qid = id;
    let created = false;

    if (id) {
      const before = db.prepare('SELECT id, project_id FROM quotations WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!before) { const e = new Error('报价单不存在或已删除'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
      const keys = Object.keys(data);
      if (keys.length) {
        db.prepare(`UPDATE quotations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...keys.map((k) => data[k]), ts, id);
      }
    } else {
      /* 新建：自动取号（未提供时）、版本号从 1 起 */
      if (!data.quote_no) {
        data.quote_no = nextQuoteNo(db, data.quote_date || ts.slice(0, 10), (settings && settings.quote_no_prefix) || 'BJ');
      }
      if (!data.version) data.version = 1;
      if (!data.quote_date) data.quote_date = ts.slice(0, 10);
      const cols = Object.keys(data);
      const r = db.prepare(
        `INSERT INTO quotations (${cols.join(', ')}, created_at, updated_at)
         VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`
      ).run(...cols.map((k) => data[k]), ts, ts);
      qid = Number(r.lastInsertRowid);
      created = true;
    }

    /* 明细整体覆盖：删旧插新（报价单明细没有独立生命周期，覆盖最简单也最不易错） */
    db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(qid);
    const insItem = db.prepare(`INSERT INTO quotation_items
      (quotation_id, seq, item_name, valve_type, size_range, pressure_rating, body_material,
       connection_type, quantity, unit, unit_price, discount, subtotal, delivery_days, remark, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const it of items) {
      insItem.run(qid, it.seq, it.item_name, it.valve_type, it.size_range, it.pressure_rating,
        it.body_material, it.connection_type, it.quantity, it.unit, it.unit_price, it.discount,
        it.subtotal, it.delivery_days, it.remark, ts);
    }

    /* 操作日志 */
    db.prepare(`INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
                VALUES ('quotation', ?, ?, ?, ?, ?)`)
      .run(qid, created ? 'create' : 'update',
        `${created ? '新建' : '修改'}报价单：${data.quote_no || ''}（${items.length} 行，合计 ${total} 元）`,
        JSON.stringify({ project_id: data.project_id, total_amount: total, item_count: items.length }), ts);

    db.exec('COMMIT');
    return { id: qid, created, total_amount: total, item_count: items.length };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/**
 * 复制为新版本：版本号 +1，原单保留可对比。
 */
function copyAsNewVersion(db, id) {
  const src = getOne(db, id);
  if (!src) { const e = new Error('报价单不存在'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  const ts = now();

  db.exec('BEGIN');
  try {
    const maxV = db.prepare(
      'SELECT MAX(version) AS v FROM quotations WHERE project_id = ? AND deleted_at IS NULL'
    ).get(src.project_id).v || 0;
    const version = Math.max(maxV, src.version) + 1;
    const quoteNo = nextQuoteNo(db, ts.slice(0, 10), (src.quote_no || '').split('-')[0] || 'BJ');

    const r = db.prepare(`INSERT INTO quotations
      (project_id, customer_id, quote_no, version, parent_id, quote_date, valid_until, currency,
       status, total_amount, tax_note, delivery_note, payment_note, remark, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '草稿', ?, ?, ?, ?, ?, ?, ?)`)
      .run(src.project_id, src.customer_id, quoteNo, version, src.id,
        ts.slice(0, 10), src.valid_until, src.currency, src.total_amount,
        src.tax_note, src.delivery_note, src.payment_note, src.remark, ts, ts);
    const newId = Number(r.lastInsertRowid);

    const insItem = db.prepare(`INSERT INTO quotation_items
      (quotation_id, seq, item_name, valve_type, size_range, pressure_rating, body_material,
       connection_type, quantity, unit, unit_price, discount, subtotal, delivery_days, remark, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const it of src.items) {
      insItem.run(newId, it.seq, it.item_name, it.valve_type, it.size_range, it.pressure_rating,
        it.body_material, it.connection_type, it.quantity, it.unit, it.unit_price, it.discount,
        it.subtotal, it.delivery_days, it.remark, ts);
    }

    db.prepare(`INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
                VALUES ('quotation', ?, 'copy', ?, ?, ?)`)
      .run(newId, `报价单复制为新版本 V${version}：${quoteNo}`,
        JSON.stringify({ from_id: src.id, from_version: src.version, version }), ts);

    db.exec('COMMIT');
    return { id: newId, version, quote_no: quoteNo, from_id: src.id };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/**
 * 改状态。终态（中标/落标/过期）时返回"是否可同步项目"的提示信息，
 * 由界面决定是否再调用 applyToProject —— 不在本函数里静默改项目。
 */
function setStatus(db, id, status, extra) {
  if (!STATUSES.includes(status)) {
    const e = new Error('报价单状态不合法：' + status); e.status = 400; e.code = 'BAD_STATUS'; throw e;
  }
  const q = db.prepare('SELECT * FROM quotations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!q) { const e = new Error('报价单不存在或已删除'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }

  const e2 = extra || {};
  const ts = now();
  const sets = ['status = ?', 'updated_at = ?'];
  const params = [status, ts];
  /* 落标时记录竞对与原因（这就是后续"落标分析"的数据来源） */
  if (status === '已落标') {
    if (e2.competitor !== undefined) { sets.push('competitor = ?'); params.push(String(e2.competitor || '')); }
    if (e2.competitor_price !== undefined) { sets.push('competitor_price = ?'); params.push(money(e2.competitor_price)); }
    if (e2.lose_reason !== undefined) { sets.push('lose_reason = ?'); params.push(String(e2.lose_reason || '')); }
  }
  params.push(Number(id));
  db.prepare(`UPDATE quotations SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  db.prepare(`INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
              VALUES ('quotation', ?, 'status', ?, ?, ?)`)
    .run(Number(id), `报价单 ${q.quote_no} 状态：${q.status} → ${status}`,
      JSON.stringify({ from: q.status, to: status }), ts);

  const project = db.prepare('SELECT id, name, stage, bid_result, contract_amount FROM projects WHERE id = ?')
    .get(q.project_id);

  return {
    id: Number(id),
    status,
    terminal: TERMINAL.includes(status),
    /* 给界面用的提示：中标时可回填合同额，其它终态只提示同步阶段 */
    can_apply: status === '已中标' && !!project,
    quote_total: money(q.total_amount),
    project: project ? {
      id: project.id, name: project.name, stage: project.stage,
      bid_result: project.bid_result, contract_amount: money(project.contract_amount)
    } : null
  };
}

/**
 * 中标回填：把报价合计写入项目合同额，并把阶段/投标结果置为中标。
 *
 * 之所以单独成一个函数、且必须由界面显式确认后调用：
 * 这个动作会改动项目金额，静默修改风险太大。
 */
function applyToProject(db, id) {
  const q = db.prepare('SELECT * FROM quotations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!q) { const e = new Error('报价单不存在或已删除'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  if (q.status !== '已中标') {
    const e = new Error('只有「已中标」的报价单才能回填项目合同额'); e.status = 400; e.code = 'NOT_WON'; throw e;
  }
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(q.project_id);
  if (!project) { const e = new Error('项目不存在或已删除'); e.status = 404; e.code = 'PROJECT_NOT_FOUND'; throw e; }

  const ts = now();
  const changes = [];
  const beforeAmount = money(project.contract_amount);
  const newAmount = money(q.total_amount);
  if (beforeAmount !== newAmount) changes.push({ field: 'contract_amount', label: '合同额', from: beforeAmount, to: newAmount });
  if (project.stage !== '已中标/已签约') changes.push({ field: 'stage', label: '阶段', from: project.stage || '', to: '已中标/已签约' });
  if (project.bid_result !== '已中标') changes.push({ field: 'bid_result', label: '投标结果', from: project.bid_result || '', to: '已中标' });

  if (!changes.length) {
    return { applied: false, message: '项目已是中标状态且合同额一致，无需修改', changes: [] };
  }

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE projects SET contract_amount = ?, stage = '已中标/已签约', bid_result = '已中标', updated_at = ?
                WHERE id = ?`).run(newAmount, ts, project.id);
    /* 客户累计成交额需同步（与 pm.js 的口径一致） */
    try {
      db.prepare(`UPDATE customers SET deal_amount = (
                    SELECT COALESCE(SUM(p.contract_amount), 0) FROM projects p
                    WHERE p.customer_id = customers.id AND p.deleted_at IS NULL)
                  WHERE id = ?`).run(project.customer_id);
    } catch (_) { /* 客户不存在时忽略 */ }

    db.prepare(`INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
                VALUES ('project', ?, 'apply_quote', ?, ?, ?)`)
      .run(project.id, `按报价单 ${q.quote_no} 回填中标信息：合同额 ${beforeAmount} → ${newAmount}`,
        JSON.stringify({ quotation_id: q.id, changes }), ts);

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }

  return { applied: true, changes, quote_no: q.quote_no, project_id: project.id };
}

function removeQuotation(db, id) {
  const q = db.prepare('SELECT id, quote_no FROM quotations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!q) { const e = new Error('报价单不存在或已删除'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  const ts = now();
  db.prepare('UPDATE quotations SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, Number(id));
  db.prepare(`INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
              VALUES ('quotation', ?, 'delete', ?, ?, ?)`)
    .run(Number(id), `删除报价单 ${q.quote_no}`, '{}', ts);
  return { id: Number(id) };
}

/**
 * 报价单导出用的数据结构（由前端 SheetJS 生成 xlsx 单据）。
 * 服务端只提供数据；排版在浏览器里做，与既有导入导出架构一致。
 */
function exportData(db, id, settings) {
  const q = getOne(db, id);
  if (!q) return null;
  const s = settings || {};
  return {
    company: s.quote_company || s.company_name || '',
    contact: s.quote_contact || '',
    phone: s.customer_phone || '',
    quote_no: q.quote_no,
    version: q.version,
    quote_date: q.quote_date,
    valid_until: q.valid_until,
    currency: q.currency || '人民币',
    status: q.status,
    tax_note: q.tax_note || '',
    delivery_note: q.delivery_note || '',
    payment_note: q.payment_note || '',
    remark: q.remark || '',
    customer_name: q.customer_name || '',
    customer_short: q.customer_short || '',
    project_name: q.project_name || '',
    total_amount: money(q.total_amount),
    items: q.items.map((it) => ({
      seq: it.seq,
      item_name: it.item_name,
      spec: [it.valve_type, it.size_range, it.pressure_rating, it.body_material, it.connection_type]
        .filter(Boolean).join(' '),
      valve_type: it.valve_type,
      size_range: it.size_range,
      pressure_rating: it.pressure_rating,
      body_material: it.body_material,
      connection_type: it.connection_type,
      quantity: it.quantity,
      unit: it.unit,
      unit_price: money(it.unit_price),
      discount: it.discount,
      subtotal: money(it.subtotal),
      delivery_days: it.delivery_days,
      remark: it.remark
    }))
  };
}

module.exports = {
  QUOTATION_FIELDS,
  ITEM_FIELDS,
  STATUSES,
  TERMINAL,
  listByProject,
  listByCustomer,
  getOne,
  saveQuotation,
  copyAsNewVersion,
  setStatus,
  applyToProject,
  removeQuotation,
  exportData,
  nextQuoteNo,
  normalizeItem,
  isBlankItem,
  sumItems,
  money
};
