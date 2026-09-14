/**
 * 报价自定义列服务
 *
 * 用途：让报价明细的列**由使用者自己定**——介质、设计压力、设计温度、操作压力、
 * 操作温度、环境温度、泄露等级、阀门标准、执行器型号、定位器、电磁阀、限位开关、
 * 过滤减压阀、气控阀……以及将来任何想加的列，列数不封顶，不需要改代码、不需要迁移。
 *
 * 模型（为什么这么设计）：
 *   - `quotation_fields`     存**列定义**（名称、类型、单位、候选值、排序、是否启用）
 *   - `quotation_items.extra` 存**值**（JSON，键 = 列 id）
 *
 *   两个关键取舍：
 *   1. **不动态加列**。若每个新列都 ALTER TABLE，一是要不停迁移，
 *      二是列名会随用户改名失控；JSON 值 + 列定义表可以任意增删改。
 *   2. **键用列 id，不用列名**。改名（「泄露等级」→「泄漏等级」）后，
 *      历史报价单里的值照样跟着显示，不会变成孤儿数据。
 *
 *   kind（text/number/select）只决定**录入控件与导出对齐方式**，
 *   不做数值强转 —— 免得把「≤80」「PN16」这类合法规格挡在门外。
 */
'use strict';

const plain = (r) => (r === undefined || r === null ? r : Object.assign({}, r));
const plainAll = (rows) => (rows || []).map(plain);

/** 列定义可写字段白名单 */
const FIELD_FIELDS = ['name', 'kind', 'options', 'unit', 'sort', 'enabled', 'remark'];

const KINDS = ['text', 'number', 'select'];

const LIMITS = {
  maxFields: 60,     // 单库最多自定义列数（前端横向滚动也有个上限）
  nameMax: 20,       // 列名长度
  unitMax: 10,       // 单位长度
  valueMax: 200,     // 单元格值长度
  optionsMax: 60     // 下拉候选值个数
};

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

function bad(message, code, status) {
  const e = new Error(message);
  e.status = status || 400;
  e.code = code || 'BAD_FIELD';
  return e;
}

/** 归一化列名：去空白、压缩连续空格 */
function cleanName(v) {
  return String(v === undefined || v === null ? '' : v).trim().replace(/\s+/g, ' ');
}

/** 候选值：兼容中英文逗号、分号、换行；去重保序 */
function normalizeOptions(v) {
  const raw = Array.isArray(v) ? v : String(v === undefined || v === null ? '' : v).split(/[,，;；\n\r]+/);
  const out = [];
  for (const x of raw) {
    const s = String(x || '').trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= LIMITS.optionsMax) break;
  }
  return out.join(',');
}

function optionsArray(row) {
  return String((row && row.options) || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

/**
 * 列清单。
 * @param {object} opts { enabledOnly: 只返回启用的列 }
 */
function listFields(db, opts) {
  const o = opts || {};
  if (!hasFieldTable(db)) {
    return { list: [], total: 0, enabled_count: 0, kinds: KINDS, limits: LIMITS };
  }
  const where = ['deleted_at IS NULL'];
  if (o.enabledOnly) where.push('enabled = 1');

  const rows = plainAll(db.prepare(
    `SELECT * FROM quotation_fields WHERE ${where.join(' AND ')} ORDER BY sort ASC, id ASC`
  ).all()).map((r) => Object.assign(r, { options_list: optionsArray(r) }));

  const all = plainAll(db.prepare(
    'SELECT enabled FROM quotation_fields WHERE deleted_at IS NULL'
  ).all());

  return {
    list: rows,
    total: rows.length,
    enabled_count: all.filter((r) => r.enabled).length,
    kinds: KINDS,
    limits: LIMITS
  };
}

function getField(db, id) {
  const r = db.prepare('SELECT * FROM quotation_fields WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!r) return null;
  return Object.assign(plain(r), { options_list: optionsArray(r) });
}

/**
 * 表是否已存在。
 *
 * 为什么需要：报价单/模板的服务层测试用的是**自己搭的最小库**（只建它用到的那几张表），
 * 那里没有 quotation_fields。缺表时按"没有自定义列"处理，
 * 而不是抛 no such table —— 既让服务层可独立测试，也让极端情况
 * （比如迁移中途被中断）下报价单功能仍然可用。
 */
function hasFieldTable(db) {
  try {
    return !!db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='quotation_fields'"
    ).get();
  } catch (_) {
    return false;
  }
}

/**
 * 未删除列 id 集合（含已停用的）。
 *
 * 停用的列**仍然接受已有值**：停用只是"界面先不显示这一列"，
 * 不该把历史报价单里的值抹掉。
 */
function liveFieldIds(db) {
  const set = new Set();
  if (!hasFieldTable(db)) return set;
  for (const r of db.prepare('SELECT id FROM quotation_fields WHERE deleted_at IS NULL').all()) {
    set.add(String(r.id));
  }
  return set;
}

/** id → 列定义（导出、跨库比对时用） */
function fieldMap(db) {
  const map = new Map();
  if (!hasFieldTable(db)) return map;
  for (const r of db.prepare('SELECT * FROM quotation_fields WHERE deleted_at IS NULL').all()) {
    map.set(String(r.id), plain(r));
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* extra 值的归一化与解析                                              */
/* ------------------------------------------------------------------ */

/**
 * 把前端传来的 extra 归一化成可入库的 JSON 字符串。
 *
 * 规则：
 *   - 只保留**确实存在的列**（列被彻底删除后，其残留值会在下一次保存时自然清掉）
 *   - 值统一转成字符串并去空白；空值直接不存（保持 JSON 干净）
 *   - 单值长度上限 valueMax，超长截断而不是报错（录入场景下截断比丢掉整行好）
 *
 * @param {object}  db
 * @param {object|string|null} raw   对象 / JSON 字符串 / 空
 * @param {Set<string>} [idSet]      预取的列 id 集合（批量保存时避免每行查一次库）
 */
function normalizeExtra(db, raw, idSet) {
  let obj = raw;
  if (typeof obj === 'string') {
    const s = obj.trim();
    if (!s) return '{}';
    try { obj = JSON.parse(s); } catch (_) { return '{}'; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '{}';

  const ids = idSet || liveFieldIds(db);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k);
    if (!ids.has(key)) continue;
    if (v === undefined || v === null) continue;
    let s = String(v).trim();
    if (!s) continue;
    if (s.length > LIMITS.valueMax) s = s.slice(0, LIMITS.valueMax);
    out[key] = s;
  }
  return JSON.stringify(out);
}

/** 解析库里的 extra（容错：脏数据一律当空对象，不让一行坏数据拖垮整张报价单） */
function parseExtra(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const o = JSON.parse(String(raw));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (_) {
    return {};
  }
}

/** 行内是否还有实质内容（自定义列有值也算有内容，避免被判成空行丢掉） */
function extraHasValue(raw) {
  const o = parseExtra(raw);
  return Object.keys(o).some((k) => String(o[k] || '').trim() !== '');
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

/**
 * 新增或修改一列。
 * @returns {{id:number, created:boolean}}
 */
function saveField(db, payload) {
  const p = payload || {};
  const id = p.id ? Number(p.id) : null;
  const ts = now();

  const data = pick(p, FIELD_FIELDS);

  if (data.name !== undefined || !id) {
    const name = cleanName(data.name);
    if (!name) throw bad('列名不能为空', 'NAME_REQUIRED');
    if (name.length > LIMITS.nameMax) {
      throw bad(`列名最长 ${LIMITS.nameMax} 个字`, 'NAME_TOO_LONG');
    }
    /* 重名检查：同一列改自己的名字要放行，所以排除自身 */
    const dup = db.prepare(
      'SELECT id FROM quotation_fields WHERE deleted_at IS NULL AND lower(name) = lower(?) AND id <> ?'
    ).get(name, id || 0);
    if (dup) throw bad(`已经有一列叫「${name}」了`, 'NAME_DUPLICATED');
    data.name = name;
  }

  if (data.kind !== undefined) {
    const kind = String(data.kind || 'text').trim();
    if (!KINDS.includes(kind)) throw bad('列类型只能是 文本 / 数字 / 下拉', 'BAD_KIND');
    data.kind = kind;
  }
  if (data.options !== undefined) data.options = normalizeOptions(data.options);
  if (data.unit !== undefined) {
    const unit = String(data.unit || '').trim();
    if (unit.length > LIMITS.unitMax) throw bad(`单位最长 ${LIMITS.unitMax} 个字`, 'UNIT_TOO_LONG');
    data.unit = unit;
  }
  if (data.remark !== undefined) data.remark = String(data.remark || '').trim().slice(0, 200);
  if (data.enabled !== undefined) data.enabled = Number(data.enabled) ? 1 : 0;
  if (data.sort !== undefined) data.sort = Number(data.sort) || 0;

  db.exec('BEGIN');
  try {
    let fid = id;
    let created = false;

    if (id) {
      const before = db.prepare('SELECT id, name FROM quotation_fields WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!before) throw bad('这一列不存在或已删除', 'NOT_FOUND', 404);
      const keys = Object.keys(data);
      if (keys.length) {
        db.prepare(`UPDATE quotation_fields SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...keys.map((k) => data[k]), ts, id);
      }
    } else {
      const used = db.prepare('SELECT COUNT(*) AS n FROM quotation_fields WHERE deleted_at IS NULL').get().n;
      if (used >= LIMITS.maxFields) {
        throw bad(`自定义列最多 ${LIMITS.maxFields} 个（当前 ${used} 个）`, 'TOO_MANY_FIELDS');
      }
      if (data.kind === undefined) data.kind = 'text';
      if (data.enabled === undefined) data.enabled = 1;
      /* 新列排到末尾，保证已有列的位置不跳 */
      if (data.sort === undefined || !data.sort) {
        data.sort = (db.prepare(
          'SELECT COALESCE(MAX(sort), 0) AS s FROM quotation_fields WHERE deleted_at IS NULL'
        ).get().s || 0) + 10;
      }
      const cols = Object.keys(data);
      const r = db.prepare(
        `INSERT INTO quotation_fields (${cols.join(', ')}, created_at, updated_at)
         VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`
      ).run(...cols.map((k) => data[k]), ts, ts);
      fid = Number(r.lastInsertRowid);
      created = true;
    }

    db.prepare(`INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
                VALUES ('quotation_field', ?, ?, ?, ?, ?)`)
      .run(fid, created ? 'create' : 'update',
        `${created ? '新增' : '修改'}报价自定义列：${data.name || ''}`,
        JSON.stringify({ name: data.name, kind: data.kind }), ts);

    db.exec('COMMIT');
    return { id: fid, created, name: data.name };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 调整列顺序（与报价模板同一套上下交换逻辑） */
function moveField(db, id, dir) {
  const cur = db.prepare(
    'SELECT id, sort FROM quotation_fields WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(id));
  if (!cur) throw bad('这一列不存在或已删除', 'NOT_FOUND', 404);

  const target = dir === 'up'
    ? db.prepare(`SELECT id, sort FROM quotation_fields
                  WHERE deleted_at IS NULL AND (sort < ? OR (sort = ? AND id < ?))
                  ORDER BY sort DESC, id DESC LIMIT 1`).get(cur.sort, cur.sort, cur.id)
    : db.prepare(`SELECT id, sort FROM quotation_fields
                  WHERE deleted_at IS NULL AND (sort > ? OR (sort = ? AND id > ?))
                  ORDER BY sort ASC, id ASC LIMIT 1`).get(cur.sort, cur.sort, cur.id);
  if (!target) return { moved: false, message: dir === 'up' ? '已经在最前面' : '已经在最后面' };

  const ts = now();
  db.exec('BEGIN');
  try {
    const a = cur.sort;
    const b = target.sort;
    if (a === b) {
      db.prepare('UPDATE quotation_fields SET sort = ?, updated_at = ? WHERE id = ?')
        .run(a + (dir === 'up' ? -1 : 1), ts, cur.id);
    } else {
      db.prepare('UPDATE quotation_fields SET sort = ?, updated_at = ? WHERE id = ?').run(b, ts, cur.id);
      db.prepare('UPDATE quotation_fields SET sort = ?, updated_at = ? WHERE id = ?').run(a, ts, target.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
  return { moved: true, message: dir === 'up' ? '已上移' : '已下移' };
}

/**
 * 删除一列（软删除）。
 *
 * 说明：已经填过的值**保留在明细的 extra 里不动**（列被删只是不再显示），
 * 万一删错了，把同名列加回来是拿不回值的（键是 id）—— 所以这里返回
 * used_in 让界面能提示"已有 N 张报价单填过这一列"。
 */
function removeField(db, id) {
  const f = db.prepare('SELECT id, name FROM quotation_fields WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!f) throw bad('这一列不存在或已删除', 'NOT_FOUND', 404);

  const like = `%"${f.id}":%`;
  const inQuotations = db.prepare(
    'SELECT COUNT(DISTINCT quotation_id) AS n FROM quotation_items WHERE extra LIKE ?'
  ).get(like).n;
  const inTemplates = db.prepare(
    'SELECT COUNT(DISTINCT template_id) AS n FROM quotation_template_items WHERE extra LIKE ?'
  ).get(like).n;

  const ts = now();
  db.prepare('UPDATE quotation_fields SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, Number(id));
  db.prepare(`INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
              VALUES ('quotation_field', ?, 'delete', ?, ?, ?)`)
    .run(Number(id), `删除报价自定义列：${f.name}`,
      JSON.stringify({ quotation_count: inQuotations, template_count: inTemplates }), ts);

  return { id: Number(id), name: f.name, used_in: inQuotations, used_in_templates: inTemplates };
}

module.exports = {
  FIELD_FIELDS,
  KINDS,
  LIMITS,
  listFields,
  getField,
  fieldMap,
  liveFieldIds,
  normalizeExtra,
  parseExtra,
  extraHasValue,
  saveField,
  moveField,
  removeField,
  cleanName,
  normalizeOptions
};
