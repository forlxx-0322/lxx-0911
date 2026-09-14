/**
 * 报价模板服务
 *
 * 用途：把"常用规格组合"沉淀成模板，报价时一键带出明细行，
 * 避免每次报价都从零敲一遍阀种/口径/压力/材质。
 *
 * 设计取舍：
 *   1. **模板不含价格**。单价随项目、行情、客户议价能力变化，
 *      把价格存进模板反而容易报错价；模板只沉淀规格与数量，套用后由使用者填价。
 *   2. 模板与报价单明细**结构对齐但表独立**：模板不随报价单变化，
 *      报价单也不会因为改了模板而被影响。
 *   3. 提供「从报价单存为模板」——实际报价里好用的组合可直接沉淀，不用重敲。
 *   4. 软删除，与其它实体一致。
 */
'use strict';

const fieldsvc = require('./quotation-field');

const plain = (r) => (r === undefined || r === null ? r : Object.assign({}, r));
const plainAll = (rows) => (rows || []).map(plain);

/** 模板可写字段白名单 */
const TEMPLATE_FIELDS = ['name', 'category', 'description', 'unit', 'sort', 'enabled'];

/** 模板明细行可写字段白名单（注意：**不含单价/折扣/小计**） */
const ITEM_FIELDS = [
  'item_name', 'valve_type', 'size_range', 'pressure_rating', 'body_material',
  'connection_type', 'quantity', 'unit', 'delivery_days', 'remark', 'extra'
];

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

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

/** 归一化模板明细行（extra 与报价明细共用同一套自定义列） */
function normalizeItem(raw, seq, db, extraIds) {
  const d = pick(raw, ITEM_FIELDS);
  const str = (k, dflt) => String(d[k] === undefined || d[k] === null ? (dflt || '') : d[k]).trim();
  return {
    seq,
    item_name: str('item_name'),
    valve_type: str('valve_type'),
    size_range: str('size_range'),
    pressure_rating: str('pressure_rating'),
    body_material: str('body_material'),
    connection_type: str('connection_type'),
    quantity: num(d.quantity, 1),
    unit: str('unit', '台') || '台',
    delivery_days: Math.round(num(d.delivery_days, 0)),
    remark: str('remark'),
    extra: db
      ? fieldsvc.normalizeExtra(db, d.extra, extraIds)
      : (d.extra === undefined ? '{}' : JSON.stringify(fieldsvc.parseExtra(d.extra)))
  };
}

/** 整行没实质内容即视为空行（丢弃，避免模板里存一堆空行） */
function isBlankItem(it) {
  return !it.item_name && !it.valve_type && !it.size_range && !it.pressure_rating
    && !it.body_material && !it.connection_type && !it.remark
    && !fieldsvc.extraHasValue(it.extra);
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

/** 模板列表（含行数；可按类别与关键词过滤） */
function listTemplates(db, opts) {
  const o = opts || {};
  const where = ['t.deleted_at IS NULL'];
  const params = [];
  if (o.category) { where.push('t.category = ?'); params.push(String(o.category)); }
  if (o.keyword) {
    where.push('(t.name LIKE ? OR t.description LIKE ?)');
    params.push(`%${o.keyword}%`, `%${o.keyword}%`);
  }
  if (o.enabledOnly) where.push('t.enabled = 1');

  const rows = plainAll(db.prepare(`
    SELECT t.*,
           (SELECT COUNT(*) FROM quotation_template_items i WHERE i.template_id = t.id) AS item_count
    FROM quotation_templates t
    WHERE ${where.join(' AND ')}
    ORDER BY t.sort ASC, t.id ASC
  `).all(...params));

  const categories = plainAll(db.prepare(
    `SELECT DISTINCT category FROM quotation_templates
     WHERE deleted_at IS NULL AND category <> '' ORDER BY category`
  ).all()).map((r) => r.category);

  return { list: rows, total: rows.length, categories };
}

/** 模板详情（含明细行） */
function getTemplate(db, id) {
  const t = db.prepare('SELECT * FROM quotation_templates WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!t) return null;
  const items = plainAll(db.prepare(
    'SELECT * FROM quotation_template_items WHERE template_id = ? ORDER BY seq ASC, id ASC'
  ).all(Number(id))).map((it) => Object.assign(it, { extra: fieldsvc.parseExtra(it.extra) }));
  return Object.assign(plain(t), { items });
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

/**
 * 新增或更新模板（含明细整体覆盖）。
 * @returns {{id:number, created:boolean, item_count:number}}
 */
function saveTemplate(db, payload) {
  const p = payload || {};
  const id = p.id ? Number(p.id) : null;
  const ts = now();

  const data = pick(p, TEMPLATE_FIELDS);
  if (!String(data.name || '').trim()) {
    const e = new Error('模板名称不能为空'); e.status = 400; e.code = 'NAME_REQUIRED'; throw e;
  }
  data.name = String(data.name).trim();
  if (data.category !== undefined) data.category = String(data.category || '').trim();
  if (data.description !== undefined) data.description = String(data.description || '').trim();
  if (data.unit !== undefined) data.unit = String(data.unit || '台').trim() || '台';
  if (data.enabled !== undefined) data.enabled = num(data.enabled, 1) ? 1 : 0;

  const rawItems = Array.isArray(p.items) ? p.items : [];
  const extraIds = fieldsvc.liveFieldIds(db);
  const items = rawItems.map((r, i) => normalizeItem(r, i + 1, db, extraIds)).filter((it) => !isBlankItem(it));
  items.forEach((it, i) => { it.seq = i + 1; });

  if (!items.length) {
    const e = new Error('模板至少要有一行明细'); e.status = 400; e.code = 'ITEMS_REQUIRED'; throw e;
  }

  db.exec('BEGIN');
  try {
    let tid = id;
    let created = false;

    if (id) {
      const before = db.prepare('SELECT id FROM quotation_templates WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!before) { const e = new Error('模板不存在或已删除'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
      const keys = Object.keys(data);
      if (keys.length) {
        db.prepare(`UPDATE quotation_templates SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...keys.map((k) => data[k]), ts, id);
      }
    } else {
      /* 新模板的排序值排到末尾，保证列表顺序稳定 */
      if (data.sort === undefined) {
        data.sort = (db.prepare(
          'SELECT COALESCE(MAX(sort), 0) AS s FROM quotation_templates WHERE deleted_at IS NULL'
        ).get().s || 0) + 10;
      }
      const cols = Object.keys(data);
      const r = db.prepare(
        `INSERT INTO quotation_templates (${cols.join(', ')}, created_at, updated_at)
         VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`
      ).run(...cols.map((k) => data[k]), ts, ts);
      tid = Number(r.lastInsertRowid);
      created = true;
    }

    /* 明细整体覆盖：模板明细没有独立生命周期，覆盖最简单也最不易错 */
    db.prepare('DELETE FROM quotation_template_items WHERE template_id = ?').run(tid);
    const ins = db.prepare(`INSERT INTO quotation_template_items
      (template_id, seq, item_name, valve_type, size_range, pressure_rating, body_material,
       connection_type, quantity, unit, delivery_days, remark, extra, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const it of items) {
      ins.run(tid, it.seq, it.item_name, it.valve_type, it.size_range, it.pressure_rating,
        it.body_material, it.connection_type, it.quantity, it.unit, it.delivery_days, it.remark,
        it.extra, ts);
    }

    db.prepare(`INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
                VALUES ('quotation_template', ?, ?, ?, ?, ?)`)
      .run(tid, created ? 'create' : 'update',
        `${created ? '新建' : '修改'}报价模板：${data.name}（${items.length} 行）`,
        JSON.stringify({ item_count: items.length }), ts);

    db.exec('COMMIT');
    return { id: tid, created, item_count: items.length };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 从报价单沉淀为模板（复用真实报价里的规格组合） */
function saveFromQuotation(db, quotationId, payload) {
  const p = payload || {};
  const qid = Number(quotationId);
  const q = db.prepare('SELECT * FROM quotations WHERE id = ? AND deleted_at IS NULL').get(qid);
  if (!q) { const e = new Error('报价单不存在或已删除'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }

  const items = plainAll(db.prepare(
    'SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY seq ASC, id ASC'
  ).all(qid)).map((it) => Object.assign(it, { extra: fieldsvc.parseExtra(it.extra) }));
  if (!items.length) {
    const e = new Error('该报价单没有明细行，无法沉淀为模板'); e.status = 400; e.code = 'NO_ITEMS'; throw e;
  }

  const name = String(p.name || '').trim()
    || `来自报价单 ${q.quote_no || qid}（${items.length} 行）`;

  /* 只带规格与数量，**不带价格**（价格随项目与行情变，存进模板易报错价）；
     自定义列的值属于"规格"，一并沉淀 */
  return saveTemplate(db, {
    name,
    category: p.category || '',
    description: p.description || `由报价单 ${q.quote_no || ''} 沉淀`,
    items: items.map((it) => ({
      item_name: it.item_name,
      valve_type: it.valve_type,
      size_range: it.size_range,
      pressure_rating: it.pressure_rating,
      body_material: it.body_material,
      connection_type: it.connection_type,
      quantity: it.quantity,
      unit: it.unit,
      delivery_days: it.delivery_days,
      remark: it.remark,
      extra: it.extra
    }))
  });
}

/**
 * 套用模板：返回可直接插入报价单的明细行（**不含价格**，price 留给使用者填）。
 *
 * 只返回数据、不写库 —— 由前端填进抽屉后统一保存，
 * 这样"套用后反悔"不会留下垃圾数据。
 */
function applyTemplate(db, id) {
  const t = getTemplate(db, id);
  if (!t) { const e = new Error('模板不存在或已删除'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  if (!t.enabled) { const e = new Error(`模板「${t.name}」已停用`); e.status = 400; e.code = 'DISABLED'; throw e; }

  const ts = now();
  /* 记录使用次数与时间，便于把常用模板排前面 */
  db.prepare('UPDATE quotation_templates SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    .run(ts, Number(id));

  return {
    template: { id: t.id, name: t.name, category: t.category, unit: t.unit },
    items: t.items.map((it) => ({
      item_name: it.item_name,
      valve_type: it.valve_type,
      size_range: it.size_range,
      pressure_rating: it.pressure_rating,
      body_material: it.body_material,
      connection_type: it.connection_type,
      quantity: it.quantity,
      unit: it.unit || t.unit || '台',
      delivery_days: it.delivery_days,
      remark: it.remark,
      /* 自定义列的值随模板带出（属于规格，不属于价格） */
      extra: it.extra || {},
      /* 价格留空由使用者填写 */
      unit_price: '',
      discount: 0
    }))
  };
}

/** 调整排序（上移/下移时与相邻模板交换 sort） */
function moveTemplate(db, id, dir) {
  const cur = db.prepare(
    'SELECT id, sort FROM quotation_templates WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(id));
  if (!cur) { const e = new Error('模板不存在或已删除'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }

  const target = dir === 'up'
    ? db.prepare(`SELECT id, sort FROM quotation_templates
                  WHERE deleted_at IS NULL AND (sort < ? OR (sort = ? AND id < ?))
                  ORDER BY sort DESC, id DESC LIMIT 1`).get(cur.sort, cur.sort, cur.id)
    : db.prepare(`SELECT id, sort FROM quotation_templates
                  WHERE deleted_at IS NULL AND (sort > ? OR (sort = ? AND id > ?))
                  ORDER BY sort ASC, id ASC LIMIT 1`).get(cur.sort, cur.sort, cur.id);
  if (!target) return { moved: false, message: dir === 'up' ? '已经在最前面' : '已经在最后面' };

  const ts = now();
  db.exec('BEGIN');
  try {
    /* sort 相同时交换 id 顺序无法表达，统一改写为显式的两个值 */
    const a = cur.sort;
    const b = target.sort;
    if (a === b) {
      db.prepare('UPDATE quotation_templates SET sort = ?, updated_at = ? WHERE id = ?').run(a + (dir === 'up' ? -1 : 1), ts, cur.id);
    } else {
      db.prepare('UPDATE quotation_templates SET sort = ?, updated_at = ? WHERE id = ?').run(b, ts, cur.id);
      db.prepare('UPDATE quotation_templates SET sort = ?, updated_at = ? WHERE id = ?').run(a, ts, target.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
  return { moved: true, message: dir === 'up' ? '已上移' : '已下移' };
}

function removeTemplate(db, id) {
  const t = db.prepare('SELECT id, name FROM quotation_templates WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!t) { const e = new Error('模板不存在或已删除'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  const ts = now();
  db.prepare('UPDATE quotation_templates SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, Number(id));
  db.prepare(`INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
              VALUES ('quotation_template', ?, 'delete', ?, ?, ?)`)
    .run(Number(id), `删除报价模板：${t.name}`, '{}', ts);
  return { id: Number(id) };
}

module.exports = {
  TEMPLATE_FIELDS,
  ITEM_FIELDS,
  listTemplates,
  getTemplate,
  saveTemplate,
  saveFromQuotation,
  applyTemplate,
  moveTemplate,
  removeTemplate,
  normalizeItem,
  isBlankItem
};
