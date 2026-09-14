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

/**
 * 内置列 —— 结构固定、不可改名或删除，但**位置可以移动**（见「列顺序」一节）。
 *
 * scope：both = 报价单与模板都有；quotation = 只有报价单有（模板不带价格）；
 * template = 只有模板有（目前没有这种列，保留扩展位）。
 */
const BUILTIN_COLUMNS = [
  { key: 'item_name', label: '名称 / 阀种', scope: 'both', kind: 'text' },
  { key: 'size_range', label: '口径', scope: 'both', kind: 'text' },
  { key: 'pressure_rating', label: '压力', scope: 'both', kind: 'text' },
  { key: 'body_material', label: '阀体材质', scope: 'both', kind: 'text' },
  { key: 'connection_type', label: '连接', scope: 'both', kind: 'text' },
  { key: 'quantity', label: '数量', scope: 'both', kind: 'number' },
  { key: 'unit', label: '单位', scope: 'both', kind: 'text' },
  { key: 'unit_price', label: '单价(元)', scope: 'quotation', kind: 'number' },
  { key: 'discount', label: '折扣%', scope: 'quotation', kind: 'number' },
  { key: 'subtotal', label: '小计(元)', scope: 'quotation', kind: 'computed' },
  { key: 'delivery_days', label: '交期(天)', scope: 'both', kind: 'number' },
  { key: 'remark', label: '备注', scope: 'both', kind: 'text' }
];

/** 默认列序（与 1.15 之前的固定表头一致；自定义列默认落在「连接」之后） */
const DEFAULT_ORDER = BUILTIN_COLUMNS.map((c) => c.key);

/** 自定义列的默认落位：接在「连接」后面（这也是 1.15 之前的观感） */
const CUSTOM_ANCHOR = 'connection_type';

/** 列序存放的设置项 key（存的是 JSON 数组，元素为内置列 key 或 `f:<列id>`） */
const ORDER_SETTING = 'quotation_column_order';

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
    return {
      list: [], total: 0, enabled_count: 0, kinds: KINDS, limits: LIMITS,
      builtins: BUILTIN_COLUMNS, order: resolveOrder(db), columns: columnsFor(db, null, { enabledOnly: false })
    };
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
    limits: LIMITS,
    /* 内置列定义 + 全局列顺序（界面表头、列管理、导出排版都用它） */
    builtins: BUILTIN_COLUMNS,
    order: resolveOrder(db),
    columns: columnsFor(db, null, { enabledOnly: false })
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
/* 列顺序（全局一套）                                                  */
/*                                                                     */
/* 为什么放设置项而不是给表加字段：顺序是"界面偏好"，不是业务数据；     */
/* 存成 settings 里的一条 JSON 数组即可，**不需要迁移**，              */
/* 报价模板、报价单明细、导出单据三处共用同一套顺序。                   */
/* ------------------------------------------------------------------ */

/** 自定义列在顺序数组里的键（内置列直接用列 key，自定义列用 f:<id>） */
const customKey = (id) => `f:${id}`;

function readStoredOrder(db) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(ORDER_SETTING);
    if (!r || !r.value) return [];
    const arr = JSON.parse(r.value);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch (_) {
    return [];
  }
}

function persistOrder(db, arr) {
  db.prepare(`INSERT INTO settings (key, value, remark, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(ORDER_SETTING, JSON.stringify(arr), '报价明细列顺序（内部使用）', now());
}

/** 现存自定义列的键，按 sort 排（新列排在后面） */
function liveCustomKeys(db) {
  if (!hasFieldTable(db)) return [];
  return db.prepare(
    'SELECT id FROM quotation_fields WHERE deleted_at IS NULL ORDER BY sort ASC, id ASC'
  ).all().map((r) => customKey(r.id));
}

/**
 * 解析出完整的列顺序。
 *
 * 容错三件事（都要做，否则用户会看到"列凭空消失"）：
 *   1. 顺序数组里已不存在的键（列被删了）→ 丢掉
 *   2. 顺序数组里**没有**的列（新加的列 / 本次升级后才有的内置列）→ 按默认位置补进去
 *   3. 顺序数组本身为空（从没排过）→ 用默认顺序
 *
 * @param {Array} [base] 可选的起点（保存时传用户传来的顺序）
 */
function resolveOrder(db, base) {
  const builtinKeys = DEFAULT_ORDER;
  const customKeys = liveCustomKeys(db);
  const known = new Set([...builtinKeys, ...customKeys]);

  const stored = Array.isArray(base) ? base : readStoredOrder(db);
  const seen = new Set();
  const out = [];
  for (const raw of stored) {
    const key = String(raw);
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }

  /**
   * 缺失的内置列：**优先插到"默认顺序里它前一个已存在的列"之后**，
   * 找不到前驱才退而插到后一个已存在列之前。
   *
   * 为什么前驱优先：用户只保存了部分列时（例如只把「备注」拖到最前、
   * 只显式给出 ['remark','item_name']），其余列应当补在各自的常规位置附近，
   * 而不是统统挤到「备注」前面去。
   */
  const insertBuiltin = (key, idx) => {
    for (let j = idx - 1; j >= 0; j--) {
      const at = out.indexOf(builtinKeys[j]);
      if (at >= 0) { out.splice(at + 1, 0, key); return; }
    }
    for (let j = idx + 1; j < builtinKeys.length; j++) {
      const at = out.indexOf(builtinKeys[j]);
      if (at >= 0) { out.splice(at, 0, key); return; }
    }
    out.push(key);
  };
  builtinKeys.forEach((key, i) => { if (!out.includes(key)) insertBuiltin(key, i); });

  /** 缺失的自定义列：接在最后一个自定义列之后，没有就接在「连接」之后 */
  for (const key of customKeys) {
    if (out.includes(key)) continue;
    const customs = out.filter((k) => k.startsWith('f:'));
    const anchor = customs.length ? customs[customs.length - 1] : CUSTOM_ANCHOR;
    const at = out.indexOf(anchor);
    if (at >= 0) out.splice(at + 1, 0, key); else out.push(key);
  }

  return out.filter((k) => known.has(k));
}

/** 保存列顺序（缺的列自动补齐，不会因为前端少传就丢列） */
function saveOrder(db, order) {
  const merged = resolveOrder(db, order);
  persistOrder(db, merged);
  return merged;
}

/**
 * 移动一列（左右/上下都走这里）。
 * @param {string} key 内置列 key 或 `f:<列id>`
 */
function moveColumn(db, key, dir) {
  const order = resolveOrder(db);
  const at = order.indexOf(String(key));
  if (at < 0) throw bad('这一列不存在或已删除', 'NOT_FOUND', 404);

  const back = dir === 'up' || dir === 'left';
  const to = back ? at - 1 : at + 1;
  if (to < 0) return { moved: false, message: '已经在最前面', order };
  if (to >= order.length) return { moved: false, message: '已经在最后面', order };

  const next = order.slice();
  next[at] = order[to];
  next[to] = order[at];
  persistOrder(db, next);
  return { moved: true, message: back ? '已前移' : '已后移', key: String(key), order: next };
}

/**
 * 表格要显示的列（按全局列顺序）。
 *
 * @param {string} [scope] 'quotation' | 'template' | 空（空 = 全部列，列管理用）
 * @param {object} [opts]  { enabledOnly: 只返回启用的自定义列（表格用） }
 */
function columnsFor(db, scope, opts) {
  const o = opts || {};
  const order = resolveOrder(db);
  const fmap = fieldMap(db);

  const allowed = scope
    ? new Set(BUILTIN_COLUMNS.filter((c) => c.scope === 'both' || c.scope === scope).map((c) => c.key))
    : null;

  const out = [];
  for (const key of order) {
    if (key.startsWith('f:')) {
      const f = fmap.get(key.slice(2));
      if (!f) continue;
      if (o.enabledOnly && !f.enabled) continue;
      out.push({
        key, type: 'custom', id: f.id, label: f.name, unit: f.unit || '',
        kind: f.kind, enabled: !!f.enabled, options_list: optionsArray(f)
      });
    } else {
      const b = BUILTIN_COLUMNS.find((c) => c.key === key);
      if (!b) continue;
      if (allowed && !allowed.has(key)) continue;
      out.push({ key, type: 'builtin', label: b.label, unit: '', kind: b.kind, scope: b.scope });
    }
  }
  return out;
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

      /* 新列落位：接在已有自定义列之后（没有自定义列就接在「连接」之后），
         之后可以用表头上的 ◀ ▶ 挪到任意位置 */
      const order = resolveOrder(db);
      const customs = order.filter((k) => k.startsWith('f:'));
      const anchor = customs.length ? customs[customs.length - 1] : CUSTOM_ANCHOR;
      const at = order.indexOf(anchor);
      order.splice(at >= 0 ? at + 1 : order.length, 0, customKey(fid));
      persistOrder(db, order);
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

/** 调整列顺序（列管理里的 ↑↓ 与表头上的 ◀ ▶ 都走这里，同一套全局列序） */
function moveField(db, id, dir) {
  const f = db.prepare('SELECT id FROM quotation_fields WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!f) throw bad('这一列不存在或已删除', 'NOT_FOUND', 404);
  return moveColumn(db, customKey(f.id), dir);
}

/** 兼容旧接口名：移动任意列（内置列也支持） */
function moveAnyColumn(db, key, dir) {
  return moveColumn(db, key, dir);
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
  /* 顺手把这一列从列顺序里摘掉（resolveOrder 本来也会过滤，但存着干净） */
  persistOrder(db, resolveOrder(db));
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
  BUILTIN_COLUMNS,
  DEFAULT_ORDER,
  ORDER_SETTING,
  customKey,
  listFields,
  getField,
  fieldMap,
  liveFieldIds,
  resolveOrder,
  saveOrder,
  moveColumn,
  moveAnyColumn,
  columnsFor,
  normalizeExtra,
  parseExtra,
  extraHasValue,
  saveField,
  moveField,
  removeField,
  cleanName,
  normalizeOptions
};
