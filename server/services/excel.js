/**
 * 数据导入导出服务
 *
 * 架构说明（重要）：
 *   SheetJS 运行在**浏览器**里，因此：
 *     - 导出：后端返回数据 + 列定义，前端生成 xlsx 并触发下载
 *     - 导入：前端解析 xlsx 为 JSON 后提交后端；后端只做校验与落库
 *   好处：后端保持零第三方依赖；前端可即时预览、逐行报错，用户体验更好。
 *
 * 本文件负责：字段定义、模板与示例、行校验、查重、落库、错误报告。
 */

'use strict';

const { now } = require('../db');
const { syncCustomerRegion } = require('./crm');

/* ------------------------------------------------------------------ */
/* 导入字段定义（也是导出与模板的列定义）                                */
/* ------------------------------------------------------------------ */

/** 客户导入字段：key 为数据库字段，label 为 Excel 表头 */
const CUSTOMER_FIELDS = [
  { key: 'name', label: '客户全称', required: true, width: 34, sample: '中国石油天然气股份有限公司独山子石化分公司' },
  { key: 'short_name', label: '客户简称', required: true, width: 16, sample: '独山子石化' },
  /* 主体类型与下游行业与界面表单保持一致（表单里也是必填），
     否则导入进来的客户在界面上是"缺必填项"的状态；列表与筛选也依赖这两列。 */
  { key: 'type', label: '主体类型', dict: 'customer_type', required: true, width: 16, sample: '终端用户' },
  { key: 'industry', label: '下游行业', dict: 'industry', required: true, width: 12, sample: '石油' },
  { key: 'level', label: '客户等级', dict: 'customer_level', width: 12, sample: 'A 重点客户' },
  { key: 'status', label: '客户状态', dict: 'customer_status', width: 12, sample: '跟进中' },
  { key: 'source', label: '客户来源', dict: 'customer_source', width: 14, sample: '设计院推荐' },
  { key: 'owner', label: '归属业务员', width: 12, sample: '本人' },
  { key: 'phone', label: '公司电话', width: 16, sample: '0992-3862000' },
  { key: 'fax', label: '传真', width: 14 },
  { key: 'email', label: '公司邮箱', width: 22 },
  { key: 'website', label: '网址', width: 22 },
  { key: 'wechat', label: '微信', width: 14 },
  { key: 'credit_code', label: '统一社会信用代码', width: 22, sample: '91650200123456789X' },
  { key: 'province', label: '省/自治区', width: 16, sample: '新疆维吾尔自治区' },
  { key: 'city', label: '市/地区', width: 16, sample: '克拉玛依市' },
  { key: 'district', label: '区/县', width: 14, sample: '独山子区' },
  { key: 'address', label: '详细地址', width: 26, sample: '独山子区大庆路 1 号' },
  { key: 'zip_code', label: '邮编', width: 10 },
  { key: 'enterprise_nature', label: '企业性质', dict: 'enterprise_nature', width: 14, sample: '央企' },
  { key: 'parent_group', label: '所属集团', width: 26, sample: '中国石油天然气集团有限公司' },
  { key: 'scale', label: '企业规模', width: 12, sample: '大型' },
  { key: 'founded_at', label: '成立日期', width: 14, sample: '1936-10-01' },
  { key: 'employees', label: '员工人数', width: 14, sample: '1000人以上' },
  { key: 'legal_person', label: '法定代表人', width: 12 },
  { key: 'is_listed', label: '是否上市', type: 'yesno', width: 10, sample: '是' },
  { key: 'purchase_mode', label: '采购模式', dict: 'purchase_mode', width: 16, sample: '框架协议' },
  { key: 'end_user', label: '最终用户', width: 20, sample: '独山子石化炼油厂' },
  { key: 'design_institute', label: '关联设计院', width: 22, sample: '中国石化工程建设有限公司' },
  { key: 'epc_contractor', label: '关联工程公司', width: 20 },
  { key: 'valve_types', label: '常用阀门类型', type: 'multiline', width: 24, sample: '球阀,闸阀,截止阀' },
  { key: 'drive_mode', label: '常用驱动方式', type: 'multiline', width: 16, sample: '气动,电动' },
  { key: 'body_material', label: '常用阀体材质', type: 'multiline', width: 22, sample: '不锈钢 316L,碳钢 WCB' },
  { key: 'pressure_rating', label: '常用压力等级', type: 'multiline', width: 20, sample: 'Class300,Class600' },
  { key: 'size_range', label: '常用口径范围', width: 18, sample: 'DN50~DN600' },
  { key: 'design_standard', label: '常用设计标准', type: 'multiline', width: 18, sample: 'API,ANSI/ASME' },
  { key: 'connection_type', label: '连接方式', type: 'multiline', width: 16, sample: '法兰连接' },
  { key: 'cert_required', label: '认证要求', type: 'multiline', width: 26, sample: '特种设备制造许可证 TS,API 6D' },
  { key: 'annual_demand', label: '年需求量(万元)', type: 'number', width: 16, sample: 800 },
  { key: 'purchase_cycle', label: '采购周期', width: 14, sample: '年度' },
  { key: 'account_period', label: '账期', dict: 'account_period', width: 20, sample: '月结60天' },
  { key: 'warranty_ratio', label: '质保金比例(%)', type: 'number', width: 16, sample: 10 },
  { key: 'warranty_months', label: '质保期(月)', type: 'number', width: 14, sample: 24 },
  { key: 'payer', label: '付款方', width: 16, sample: '集团财务' },
  { key: 'tender_platform', label: '常用招标平台', width: 18, sample: '中石油' },
  { key: 'qualification', label: '客户要求资质', type: 'multiline', width: 24 },
  { key: 'has_ts_license', label: '要求TS许可证', type: 'yesno', width: 14, sample: '是' },
  { key: 'has_explosion_proof', label: '要求防爆认证', type: 'yesno', width: 14, sample: '否' },
  { key: 'quality_grade', label: '客户分级', width: 20, sample: '中石油一级供应商' },
  { key: 'supplier_code', label: '供应商编码', width: 20, sample: 'CNPC-SUP-20240001' },
  { key: 'credit_rating', label: '信用评级', width: 12, sample: '优' },
  { key: 'introducer', label: '介绍人', width: 18, sample: '李工（石化设计院）' },
  { key: 'competitor', label: '主要竞争对手', width: 16, sample: '纽威阀门' },
  { key: 'customer_since', label: '合作起始日期', width: 16, sample: '2020-03-15' },
  { key: 'next_follow_at', label: '下次跟进时间', width: 20, sample: '2026-03-01 10:00' },
  { key: 'longitude', label: '经度', type: 'number', width: 12 },
  { key: 'latitude', label: '纬度', type: 'number', width: 12 },
  { key: 'remark', label: '备注', width: 30 }
];

/** 联系人导入字段 */
const CONTACT_FIELDS = [
  { key: 'customer_name', label: '客户全称', required: true, width: 34, sample: '中国石油天然气股份有限公司独山子石化分公司' },
  { key: 'name', label: '姓名', required: true, width: 12, sample: '王建国' },
  { key: 'position', label: '职位', dict: 'contact_position', width: 16, sample: '采购经理' },
  { key: 'department', label: '所属部门', width: 14, sample: '采购部' },
  { key: 'mobile', label: '手机号', width: 16, sample: '13909920001' },
  { key: 'phone', label: '座机', width: 16 },
  { key: 'wechat', label: '微信', width: 14 },
  { key: 'email', label: '邮箱', width: 22 },
  { key: 'is_primary', label: '主联系人', type: 'yesno', width: 12, sample: '是' },
  { key: 'is_decision', label: '决策人', type: 'yesno', width: 12, sample: '是' },
  { key: 'influence', label: '影响力', dict: 'contact_influence', width: 14, sample: '关键决策' },
  { key: 'birthday', label: '生日', width: 14 },
  { key: 'remark', label: '备注', width: 24 }
];

/** 项目导入字段 */
const PROJECT_FIELDS = [
  { key: 'customer_name', label: '客户全称', required: true, width: 34, sample: '中国石油天然气股份有限公司独山子石化分公司' },
  { key: 'name', label: '项目名称', required: true, width: 34, sample: '塔河炼化 2026 年大修阀门采购项目' },
  { key: 'stage', label: '项目阶段', dict: 'project_stage', width: 14, sample: '投标/议价' },
  { key: 'progress', label: '进度(%)', type: 'number', width: 12, sample: 30 },
  { key: 'end_user', label: '最终用户', width: 20 },
  { key: 'design_institute', label: '设计院', width: 22 },
  { key: 'valve_needs', label: '阀门需求', type: 'multiline', width: 24, sample: '闸阀,截止阀' },
  { key: 'quantity', label: '数量(台/套)', type: 'number', width: 14, sample: 260 },
  { key: 'contract_amount', label: '合同金额(元)', type: 'number', width: 16, sample: 1860000 },
  { key: 'bid_date', label: '投标日期', width: 14, sample: '2026-03-10' },
  { key: 'bid_result', label: '投标结果', width: 16, sample: '已投标待开标' },
  { key: 'win_rate_note', label: '中标/失标原因', width: 18 },
  { key: 'signed_at', label: '签约日期', width: 14 },
  { key: 'delivery_date', label: '合同交货期', width: 14 },
  { key: 'start_date', label: '开始日期', width: 14 },
  { key: 'end_date', label: '预计结束日期', width: 14 },
  { key: 'owner', label: '负责人', width: 12 },
  { key: 'remark', label: '备注', width: 24 }
];

const SCHEMAS = {
  customer: { key: 'customer', label: '客户', fields: CUSTOMER_FIELDS, matchKey: 'name' },
  contact: { key: 'contact', label: '联系人', fields: CONTACT_FIELDS, matchKey: 'name' },
  project: { key: 'project', label: '项目', fields: PROJECT_FIELDS, matchKey: 'name' }
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 把 Excel 单元格值转成字符串 */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).trim();
}

/** 是/否 → 1/0 */
function yesNo(v) {
  const s = cellText(v).toLowerCase();
  if (!s) return 0;
  if (['是', 'y', 'yes', 'true', '1', '√', '有'].includes(s)) return 1;
  return 0;
}

/** 归一化日期：支持 2026/3/1、2026-03-01、20260301 */
function normDate(v) {
  const s = cellText(v);
  if (!s) return '';
  const m = s.match(/^(\d{4})[-/年.]?(\d{1,2})[-/月.]?(\d{1,2})/);
  if (m) {
    const p = (n) => String(n).padStart(2, '0');
    return `${m[1]}-${p(m[2])}-${p(m[3])}`;
  }
  // Excel 序列号
  const n = Number(s);
  if (isFinite(n) && n > 20000 && n < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }
  return s;
}

/** 归一化日期时间 */
function normDateTime(v) {
  const d = normDate(v);
  if (!d) return '';
  const s = cellText(v);
  const tm = s.match(/(\d{1,2}):(\d{2})/);
  return tm ? `${d} ${String(tm[1]).padStart(2, '0')}:${tm[2]}:00` : `${d} 09:00:00`;
}

/** 按字段类型归一值 */
function normValue(field, raw, dictCache) {
  const s = cellText(raw);
  if (field.type === 'yesno') return yesNo(raw);
  if (field.type === 'number') {
    if (!s) return 0;
    const n = Number(s.replace(/[,，\s]/g, ''));
    return isFinite(n) ? n : 0;
  }
  if (field.key === 'founded_at' || field.key === 'customer_since'
    || field.key === 'signed_at' || field.key === 'bid_date' || field.key === 'delivery_date'
    || field.key === 'start_date' || field.key === 'end_date' || field.key === 'birthday') {
    return normDateRaw(s);
  }
  if (field.key === 'next_follow_at') return normDateTime(raw);

  /* 字典字段：校验值是否在字典中，不在则保留原值（允许用户自定义） */
  if (field.dict && s && dictCache && dictCache[field.dict]) {
    const hit = dictCache[field.dict].find((x) => x === s);
    if (!hit) return s;   // 保留原值，由业务层决定是否新增选项
  }
  return s;
}

function normDateRaw(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})[-/年.]?(\d{1,2})[-/月.]?(\d{1,2})/);
  if (m) {
    const p = (n) => String(n).padStart(2, '0');
    return `${m[1]}-${p(m[2])}-${p(m[3])}`;
  }
  return String(s);
}

/** 读取字典（用于校验与提示） */
function readDictMap(db) {
  const rows = db.prepare(
    'SELECT category, value FROM dict WHERE deleted_at IS NULL AND enabled = 1'
  ).all();
  const map = {};
  for (const r of rows) (map[r.category] = map[r.category] || []).push(r.value);
  return map;
}

/* ------------------------------------------------------------------ */
/* 模板与导出列定义                                                     */
/* ------------------------------------------------------------------ */

/**
 * 生成导入模板的列定义。
 * @param {object} db  用于读取字典当前可选值（供模板里生成「可选值参考」页）
 * @param {string} entity customer / contact / project
 */
function getTemplate(db, entity) {
  const schema = SCHEMAS[entity];
  if (!schema) throw Object.assign(new Error('不支持的导入类型：' + entity), { status: 400, code: 'BAD_ENTITY' });
  const dictMap = readDictMap(db);
  return {
    entity: schema.key,
    label: schema.label,
    fields: schema.fields.map((f) => ({
      key: f.key, label: f.label, required: !!f.required,
      type: f.type || 'text', width: f.width || 16,
      /* 带字典的列，把当前可选值一并返回，供模板生成「可选值参考」页 */
      dict: f.dict || '',
      options: f.dict ? (dictMap[f.dict] || []) : []
    })),
    sample: schema.fields.map((f) => (f.sample === undefined ? '' : f.sample))
  };
}

/**
 * 导出数据：返回 { entity, fields, rows }
 * 前端用 SheetJS 生成 xlsx
 */
function exportData(db, entity, options) {
  const schema = SCHEMAS[entity] || SCHEMAS.customer;
  const opts = options || {};
  const fields = schema.fields;
  let rows = [];

  if (entity === 'contact') {
    rows = db.prepare(`
      SELECT c.name AS customer_name, ct.name, ct.position, ct.department, ct.mobile,
             ct.phone, ct.wechat, ct.email, ct.is_primary, ct.is_decision, ct.influence,
             ct.birthday, ct.remark
      FROM contacts ct JOIN customers c ON c.id = ct.customer_id
      WHERE ct.deleted_at IS NULL AND c.deleted_at IS NULL
      ORDER BY c.id, ct.is_primary DESC, ct.id
    `).all();
  } else if (entity === 'project') {
    rows = db.prepare(`
      SELECT c.name AS customer_name, p.name, p.stage, p.progress, p.end_user,
             p.design_institute, p.valve_needs, p.quantity, p.contract_amount,
             p.bid_date, p.bid_result, p.win_rate_note, p.signed_at, p.delivery_date,
             p.start_date, p.end_date, p.owner, p.remark
      FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.deleted_at IS NULL
      ORDER BY p.id DESC
    `).all();
  } else {
    /* 客户：支持按当前筛选条件导出 */
    const where = ['deleted_at IS NULL'];
    const params = [];
    if (opts.ids && opts.ids.length) {
      where.push(`id IN (${opts.ids.map(() => '?').join(', ')})`);
      params.push(...opts.ids.map(Number));
    } else {
      if (opts.industry) { where.push('industry = ?'); params.push(opts.industry); }
      if (opts.status) { where.push('status = ?'); params.push(opts.status); }
      if (opts.type) { where.push('type = ?'); params.push(opts.type); }
      if (opts.level) { where.push('level = ?'); params.push(opts.level); }
    }
    const cols = fields.map((f) => f.key).join(', ');
    rows = db.prepare(
      `SELECT ${cols} FROM customers WHERE ${where.join(' AND ')} ORDER BY id DESC`
    ).all(...params);
  }

  /* 把 1/0 转成 是/否，便于阅读 */
  const out = rows.map((r) => {
    const o = {};
    for (const f of fields) {
      let v = r[f.key];
      if (f.type === 'yesno') v = v ? '是' : '否';
      o[f.key] = v === null || v === undefined ? '' : v;
    }
    return o;
  });

  return {
    entity: schema.key,
    label: schema.label,
    fields: fields.map((f) => ({
      key: f.key, label: f.label, required: !!f.required,
      type: f.type || 'text', width: f.width || 16
    })),
    rows: out,
    count: out.length
  };
}

/* ------------------------------------------------------------------ */
/* 导入：逐行校验                                                       */
/* ------------------------------------------------------------------ */

/**
 * 逐行校验导入数据。
 *
 * 关键区分：**「与库中重名」是"重复"，不是"错误"**。
 * 早期实现把它塞进 errors，导致重复行被算作"校验未通过"、
 * 既不能跳过也不能更新，前端设的"遇到同名客户"选项形同虚设。
 * 现在：
 *   - duplicateMode='skip'   → 该行标记 action='skip'，计入 valid（会被跳过而非失败）
 *   - duplicateMode='update' → 该行标记 action='update'，导入时更新已有记录
 * 只有真正无法导入的问题（必填缺失、文件内重复、找不到所属客户）才算错误。
 *
 * @param {object} db
 * @param {string} entity
 * @param {Array} rawRows
 * @param {object} options { duplicateMode: 'skip' | 'update' }
 */
function validateRows(db, entity, rawRows, options) {
  const opts = options || {};
  const duplicateMode = opts.duplicateMode === 'update' ? 'update' : 'skip';
  const schema = SCHEMAS[entity];
  if (!schema) throw Object.assign(new Error('不支持的导入类型：' + entity), { status: 400, code: 'BAD_ENTITY' });
  if (!Array.isArray(rawRows)) throw Object.assign(new Error('导入数据格式错误'), { status: 400, code: 'BAD_DATA' });
  if (rawRows.length > 5000) throw Object.assign(new Error('单次最多导入 5000 行'), { status: 400, code: 'TOO_MANY' });

  const dictMap = readDictMap(db);
  const results = [];
  const seenKeys = new Map();   // 文件内查重
  let valid = 0;
  let invalid = 0;
  let duplicateCount = 0;

  /* 预取已有客户名与 id，用于查重与更新 */
  const existingCustomers = new Map(
    db.prepare('SELECT id, name FROM customers WHERE deleted_at IS NULL').all().map((r) => [r.name, r.id])
  );
  const existingProjects = new Map(
    db.prepare('SELECT id, name FROM projects WHERE deleted_at IS NULL').all().map((r) => [r.name, r.id])
  );

  rawRows.forEach((raw, i) => {
    const errors = [];
    const data = {};

    for (const f of schema.fields) {
      const v = normValue(f, raw[f.key], dictMap);
      data[f.key] = v;
      if (f.required && (v === '' || v === null || v === undefined)) {
        errors.push(`「${f.label}」为必填项`);
      }
    }

    /* 字典值是否已存在（仅提示，不阻止导入） */
    const dictWarnings = [];
    for (const f of schema.fields) {
      if (!f.dict) continue;
      const v = data[f.key];
      if (!v) continue;
      const list = dictMap[f.dict] || [];
      if (!list.includes(v)) dictWarnings.push(`「${f.label}」的值「${v}」不在字典中，导入后会自动新增该选项`);
    }

    /* 文件内查重 */
    const key = data[schema.matchKey];
    let duplicateInFile = false;
    if (key) {
      if (seenKeys.has(key)) duplicateInFile = true;
      else seenKeys.set(key, i + 1);
    }

    /* 与库中已有数据查重 */
    let duplicateInDb = false;
    let existingId = null;
    if (entity === 'customer' && data.name && existingCustomers.has(data.name)) {
      duplicateInDb = true;
      existingId = existingCustomers.get(data.name);
    }
    if (entity === 'project' && data.name && existingProjects.has(data.name)) {
      duplicateInDb = true;
      existingId = existingProjects.get(data.name);
    }

    /* 联系人需要能匹配到客户 */
    let customerMissing = false;
    if (entity === 'contact' || entity === 'project') {
      if (data.customer_name && !existingCustomers.has(data.customer_name)) customerMissing = true;
    }

    /* 只有真正无法导入的问题才算错误 */
    if (duplicateInFile) errors.push(`文件内第 ${seenKeys.get(key)} 行已存在同名「${key}」`);
    if (customerMissing) errors.push(`找不到客户「${data.customer_name}」，请先导入该客户`);

    /* 重名作为"重复"处理，按所选模式决定跳过还是更新 */
    if (duplicateInDb) {
      duplicateCount++;
      dictWarnings.push(duplicateMode === 'update'
        ? `库中已有同名「${data.name}」，将更新该记录`
        : `库中已有同名「${data.name}」，将跳过该行`);
    }

    const ok = errors.length === 0;
    if (ok) valid++; else invalid++;

    results.push({
      index: i + 1,
      data,
      errors,
      warnings: dictWarnings,
      duplicateInDb,
      existingId,
      action: ok ? (duplicateInDb ? duplicateMode : 'create') : 'error'
    });
  });

  return {
    entity: schema.key,
    label: schema.label,
    total: rawRows.length,
    valid,
    invalid,
    duplicateCount,
    duplicateMode,
    rows: results
  };
}

/* ------------------------------------------------------------------ */
/* 导入：落库                                                          */
/* ------------------------------------------------------------------ */

/**
 * 执行导入
 * @param {object} db
 * @param {string} entity
 * @param {Array} rawRows  前端传来的行（这里会再校验一次）
 * @param {object} options { duplicateMode: 'skip' | 'update' }
 *   skip   → 与库中重名的行跳过，保留库中已有资料
 *   update → 与库中重名的行更新已有记录（只覆盖表格里填了值的列）
 */
function runImport(db, entity, rawRows, options) {
  const opts = options || {};
  const duplicateMode = opts.duplicateMode === 'update' ? 'update' : 'skip';
  const check = validateRows(db, entity, rawRows, { duplicateMode });

  const report = {
    entity: check.entity,
    label: check.label,
    total: check.total,
    valid: check.valid,
    invalid: check.invalid,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    dictAdded: 0,
    regionSynced: 0,
    duplicateMode,
    errors: []
  };

  const insertable = check.rows.filter((r) => r.action !== 'error');
  const ts = now();

  db.exec('BEGIN');
  try {
    /* 1. 先把字典里缺失的选项补上，避免导入后下拉框对不上 */
    for (const r of insertable) {
      for (const f of SCHEMAS[entity].fields) {
        if (!f.dict) continue;
        const v = r.data[f.key];
        if (!v) continue;
        const exists = db.prepare(
          'SELECT id, enabled, deleted_at FROM dict WHERE category = ? AND value = ?'
        ).get(f.dict, v);
        if (exists && !exists.deleted_at) {
          if (!exists.enabled) {
            db.prepare('UPDATE dict SET enabled = 1, updated_at = ? WHERE id = ?').run(ts, exists.id);
          }
          continue;
        }
        if (exists && exists.deleted_at) {
          db.prepare('UPDATE dict SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?')
            .run(ts, exists.id);
          continue;
        }
        const maxSort = db.prepare(
          'SELECT COALESCE(MAX(sort), 0) AS s FROM dict WHERE category = ?'
        ).get(f.dict).s;
        db.prepare(
          `INSERT INTO dict (category, value, color, sort, enabled, is_system, created_at, updated_at)
           VALUES (?, ?, '', ?, 1, 0, ?, ?)`
        ).run(f.dict, v, Number(maxSort) + 10, ts, ts);
        report.dictAdded++;
      }
    }

    /* 2. 逐行落库。三种动作：
          create → 新增；update → 覆盖已有记录里"本次填了值"的列；skip → 跳过
          （记录本次新增/更新的客户 id，供补归属使用） */
    const insertedCustomerIds = [];
    const touchedCustomerIds = [];
    for (const r of insertable) {
      try {
        if (r.action === 'skip') {
          report.skipped++;
          continue;
        }
        if (r.action === 'update' && r.existingId) {
          updateExisting(db, entity, r.existingId, r.data, ts);
          report.updated++;
          if (entity === 'customer') touchedCustomerIds.push(r.existingId);
          continue;
        }
        if (entity === 'customer') {
          const id = insertCustomer(db, r.data, ts);
          insertedCustomerIds.push(id);
          touchedCustomerIds.push(id);
        } else if (entity === 'contact') {
          insertContact(db, r.data, ts);
        } else if (entity === 'project') {
          insertProject(db, r.data, ts);
        }
        report.imported++;
      } catch (e) {
        report.failed++;
        report.errors.push({ index: r.index, message: e.message });
      }
    }

    /* 3. 导入的客户按「市/地区」自动归属地州
         说明：导入走的是直接 INSERT（不是 saveCustomer），不会经过归属逻辑，
         所以这里必须显式补一次，否则批量导入的客户
         在地图分布、按区域筛选中都会缺失。 */
    if (entity === 'customer' && touchedCustomerIds.length) {
      for (const id of touchedCustomerIds) {
        try { syncCustomerRegion(db, id); } catch (_) { /* 单条失败不影响整体导入 */ }
      }
      const marks = touchedCustomerIds.map(() => '?').join(', ');
      report.regionSynced = db.prepare(
        `SELECT COUNT(*) AS n FROM customers WHERE id IN (${marks}) AND region_code <> ''`
      ).get(...touchedCustomerIds).n;
      void insertedCustomerIds;
    }

    /* 4. 记录操作日志 */
    db.prepare(
      `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
       VALUES ('import', NULL, 'import', ?, ?, ?)`
    ).run(
      `Excel 导入${report.label}：新增 ${report.imported} 条，更新 ${report.updated} 条，跳过 ${report.skipped} 条，失败 ${report.failed} 条，校验未通过 ${report.invalid} 条`,
      JSON.stringify({ entity: report.entity, imported: report.imported, invalid: report.invalid }),
      ts
    );

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }

  /* 把校验期的错误一并带上，方便前端展示 */
  report.errors = report.errors.concat(
    check.rows.filter((r) => r.action === 'error')
      .map((r) => ({ index: r.index, message: r.errors.join('；') }))
  );

  return report;
}

/**
 * 更新一条已存在的记录（导入时选择「更新同名记录」的情况）。
 *
 * 只覆盖表格里**实际填了值**的列：表格中留空的列保持库里原值，
 * 避免"只想补一个字段，结果把其它资料清空"。
 * 注意 name 是匹配键，不参与覆盖。
 */
function updateExisting(db, entity, id, d, ts) {
  const schema = SCHEMAS[entity];
  const table = entity === 'customer' ? 'customers' : (entity === 'contact' ? 'contacts' : 'projects');
  const sets = [];
  const params = [];
  for (const f of schema.fields) {
    if (f.key === schema.matchKey) continue;        // 匹配键不覆盖
    const v = d[f.key];
    if (v === '' || v === null || v === undefined) continue;   // 留空则保持原值
    sets.push(`${f.key} = ?`);
    params.push(v);
  }
  if (!sets.length) return false;
  sets.push('updated_at = ?');
  params.push(ts, id);
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return true;
}

function insertCustomer(db, d, ts) {
  const COLS = [
    'name', 'short_name', 'type', 'industry', 'source', 'level', 'status', 'owner',
    'phone', 'fax', 'website', 'email', 'wechat', 'credit_code',
    'province', 'city', 'district', 'address', 'zip_code',
    'enterprise_nature', 'parent_group', 'scale', 'founded_at', 'employees', 'legal_person', 'is_listed',
    'purchase_mode', 'end_user', 'design_institute', 'epc_contractor', 'valve_types', 'drive_mode',
    'body_material', 'pressure_rating', 'size_range', 'design_standard', 'connection_type', 'cert_required',
    'annual_demand', 'purchase_cycle', 'account_period', 'warranty_ratio', 'warranty_months',
    'payer', 'tender_platform',
    'qualification', 'has_ts_license', 'has_explosion_proof', 'quality_grade', 'supplier_code', 'credit_rating',
    'introducer', 'competitor', 'customer_since', 'next_follow_at', 'longitude', 'latitude', 'remark',
    'created_at', 'updated_at'
  ];

  const num = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  };

  const VALUES = [
    d.name, d.short_name || '', d.type || '', d.industry || '', d.source || '',
    d.level || '', d.status || '潜在', d.owner || '',
    d.phone || '', d.fax || '', d.website || '', d.email || '', d.wechat || '', d.credit_code || '',
    d.province || '', d.city || '', d.district || '', d.address || '', d.zip_code || '',
    d.enterprise_nature || '', d.parent_group || '', d.scale || '', d.founded_at || null,
    d.employees || '', d.legal_person || '', Number(d.is_listed) || 0,
    d.purchase_mode || '', d.end_user || '', d.design_institute || '', d.epc_contractor || '',
    d.valve_types || '', d.drive_mode || '', d.body_material || '', d.pressure_rating || '',
    d.size_range || '', d.design_standard || '', d.connection_type || '', d.cert_required || '',
    Number(d.annual_demand) || 0, d.purchase_cycle || '', d.account_period || '',
    Number(d.warranty_ratio) || 0, Number(d.warranty_months) || 0,
    d.payer || '', d.tender_platform || '',
    d.qualification || '', Number(d.has_ts_license) || 0, Number(d.has_explosion_proof) || 0,
    d.quality_grade || '', d.supplier_code || '', d.credit_rating || '',
    d.introducer || '', d.competitor || '', d.customer_since || null, d.next_follow_at || null,
    num(d.longitude), num(d.latitude), d.remark || '',
    ts, ts
  ];

  if (COLS.length !== VALUES.length) {
    throw new Error(`客户导入列数与值数不一致（列 ${COLS.length} / 值 ${VALUES.length}），请反馈此问题`);
  }

  const info = db.prepare(
    `INSERT INTO customers (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`
  ).run(...VALUES);

  const id = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
     VALUES ('customer', ?, 'create', ?, '', ?)`
  ).run(id, `Excel 导入新建客户：${d.name}`, ts);
  return id;
}

function insertContact(db, d, ts) {
  const cust = db.prepare('SELECT id FROM customers WHERE name = ? AND deleted_at IS NULL').get(d.customer_name);
  if (!cust) throw new Error(`找不到客户「${d.customer_name}」`);
  const info = db.prepare(`
    INSERT INTO contacts (customer_id, name, position, department, mobile, phone, wechat, email,
      is_decision, is_primary, influence, birthday, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cust.id, d.name, d.position || '', d.department || '', d.mobile || '', d.phone || '',
    d.wechat || '', d.email || '', Number(d.is_decision) || 0, Number(d.is_primary) || 0,
    d.influence || '', d.birthday || null, d.remark || '', ts, ts
  );
  if (Number(d.is_primary) === 1) {
    db.prepare('UPDATE contacts SET is_primary = 0 WHERE customer_id = ? AND id <> ?')
      .run(cust.id, Number(info.lastInsertRowid));
  }
  return Number(info.lastInsertRowid);
}

function insertProject(db, d, ts) {
  const cust = db.prepare('SELECT id FROM customers WHERE name = ? AND deleted_at IS NULL').get(d.customer_name);
  if (!cust) throw new Error(`找不到客户「${d.customer_name}」`);
  const info = db.prepare(`
    INSERT INTO projects (name, customer_id, stage, progress, end_user, design_institute,
      valve_needs, quantity, contract_amount, signed_at, bid_date, bid_result, win_rate_note,
      start_date, end_date, delivery_date, owner, remark, data_origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Excel 导入', ?, ?)
  `).run(
    d.name, cust.id, d.stage || '信息收集', Number(d.progress) || 0,
    d.end_user || '', d.design_institute || '', d.valve_needs || '', Number(d.quantity) || 0,
    Number(d.contract_amount) || 0, d.signed_at || null, d.bid_date || null,
    d.bid_result || '', d.win_rate_note || '', d.start_date || null, d.end_date || null,
    d.delivery_date || null, d.owner || '', d.remark || '', ts, ts
  );
  const id = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
     VALUES ('project', ?, 'create', ?, '', ?)`
  ).run(id, `Excel 导入新建项目：${d.name}`, ts);
  return id;
}

module.exports = {
  SCHEMAS,
  getTemplate,
  exportData,
  validateRows,
  runImport
};
