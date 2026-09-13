/**
 * 阶段二 前端数据契约测试
 *
 * 目的：页面模板依赖的每个字段，后端必须真的返回。
 * 这类问题在浏览器里表现为「表格空白」「undefined」，很难排查，
 * 所以用脚本按模板实际取用的字段逐项断言。
 *
 * 用法：node tools/test-phase2-ui-contract.js
 */

'use strict';

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, path, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json, data: json && json.data };
}

/** 断言对象含有一组键 */
function hasKeys(obj, keys) {
  if (!obj) return { ok: false, missing: keys };
  const missing = keys.filter((k) => !(k in obj));
  return { ok: missing.length === 0, missing };
}

(async () => {
  console.log('=== 阶段二 前端数据契约测试 ===\n');

  /* ---------- 1. 字典结构：模板用 options[category] 渲染下拉 ---------- */
  const dict = await api('GET', '/api/dict');
  const d = dict.data || {};
  const needCats = [
    'customer_type', 'industry', 'customer_level', 'customer_status', 'customer_source',
    'enterprise_nature', 'purchase_mode', 'valve_type', 'drive_mode', 'body_material',
    'pressure_rating', 'size_range', 'design_standard', 'connection_type', 'cert_required',
    'account_period', 'follow_method', 'follow_result', 'payment_method',
    'contact_position', 'contact_influence'
  ];
  const missCat = needCats.filter((c) => !Array.isArray(d.options && d.options[c]));
  check('字典 options 覆盖表单全部下拉分类',
    missCat.length === 0,
    missCat.length ? '缺少：' + missCat.join(', ') : `${needCats.length} 类齐备`);

  const arrOk = needCats.every((c) => (d.options[c] || []).every((v) => typeof v === 'string'));
  check('字典 options 的内容是字符串数组（可直接 v-for 渲染）', arrOk,
    arrOk ? '全部为字符串' : '存在非字符串项');

  const itemKeys = hasKeys((d.items.industry || [])[0], ['id', 'category', 'value', 'color', 'sort', 'is_system']);
  check('字典 items 含 id/color/is_system（设置页与管理功能需要）', itemKeys.ok,
    itemKeys.ok ? '字段完整' : '缺少：' + itemKeys.missing.join(', '));

  /* ---------- 2. 客户列表行字段：列表页 10 列 + 模板绑定 ---------- */
  const c = await api('POST', '/api/customers', {
    name: '契约测试客户', short_name: '契约测试', type: '终端用户', industry: '石油',
    level: 'A 重点客户', status: '跟进中', phone: '0991-1234567', province: '新疆维吾尔自治区',
    city: '乌鲁木齐市', design_institute: '测试设计院', annual_demand: 300,
    next_follow_at: '2026-03-01 10:00:00'
  });
  const cid = c.data.id;

  await api('POST', '/api/contacts', {
    customer_id: cid, name: '契约联系人', mobile: '13900001111', is_primary: 1, is_decision: 1,
    position: '采购经理', department: '采购部', influence: '关键决策'
  });
  await api('POST', '/api/followups', {
    customer_id: cid, method: '电话', content: '契约测试跟进', result: '有意向',
    next_plan: '报价', next_at: '2026-03-05 10:00:00'
  });

  const list = await api('GET', '/api/customers?q=' + encodeURIComponent('契约测试'));
  const row = (list.data.list || [])[0];
  const rowKeys = [
    'id', 'name', 'short_name', 'type', 'industry', 'level', 'status', 'phone',
    'next_follow_at', 'annual_demand', 'project_count', 'overdue',
    'primary_contact', 'primary_mobile'
  ];
  const rk = hasKeys(row, rowKeys);
  check('客户列表行含列表页模板用到的全部字段', rk.ok,
    rk.ok ? `${rowKeys.length} 个字段齐备` : '缺少：' + rk.missing.join(', '));

  check('列表行 primary_contact / primary_mobile 已聚合主联系人',
    row && row.primary_contact === '契约联系人' && row.primary_mobile === '13900001111',
    `主联系人=${row && row.primary_contact}，手机=${row && row.primary_mobile}`);

  check('列表行 overdue 布尔标记可用（列表标红依赖它）',
    row && typeof row.overdue === 'boolean',
    `overdue=${row && row.overdue} (${typeof (row && row.overdue)})`);

  /* ---------- 3. 客户详情：5 个标签页依赖的字段 ---------- */
  const detail = await api('GET', `/api/customers/${cid}`);
  const cd = detail.data || {};

  const detailKeys = [
    'id', 'name', 'short_name', 'type', 'industry', 'level', 'status', 'supplier_code',
    'contacts', 'tags', 'followups', 'projects', 'tasks', 'logs', 'summary',
    'last_follow_at', 'next_follow_at', 'follow_count', 'remark'
  ];
  const dk = hasKeys(cd, detailKeys);
  check('客户详情含 5 个标签页依赖的全部字段', dk.ok,
    dk.ok ? `${detailKeys.length} 个字段齐备` : '缺少：' + dk.missing.join(', '));

  const sumKeys = hasKeys(cd.summary, [
    'contact_count', 'project_count', 'contract_total', 'received_total',
    'debt_total', 'follow_count', 'task_count'
  ]);
  check('summary 汇总对象字段完整（详情页顶部数字依赖）', sumKeys.ok,
    sumKeys.ok ? JSON.stringify(cd.summary) : '缺少：' + sumKeys.missing.join(', '));

  const ct = (cd.contacts || [])[0] || {};
  const ctKeys = hasKeys(ct, [
    'id', 'name', 'position', 'department', 'mobile', 'phone', 'wechat', 'email',
    'is_decision', 'is_primary', 'influence', 'birthday'
  ]);
  check('联系人卡片字段完整', ctKeys.ok,
    ctKeys.ok ? '字段齐备' : '缺少：' + ctKeys.missing.join(', '));

  const f = (cd.followups || [])[0] || {};
  const fKeys = hasKeys(f, ['id', 'method', 'result', 'content', 'next_plan', 'next_at', 'followed_at', 'project_name']);
  check('跟进时间轴字段完整（含 project_name 关联展示）', fKeys.ok,
    fKeys.ok ? '字段齐备' : '缺少：' + fKeys.missing.join(', '));

  check('跟进记录写入后已回填客户统计',
    cd.follow_count === 1 && !!cd.last_follow_at && String(cd.next_follow_at).startsWith('2026-03-05'),
    `次数=${cd.follow_count} 最近=${cd.last_follow_at} 下次=${cd.next_follow_at}`);

  const log = (cd.logs || [])[0] || {};
  const logKeys = hasKeys(log, ['id', 'action', 'summary', 'created_at']);
  check('变更记录字段完整（详情页时间轴依赖）', logKeys.ok,
    logKeys.ok ? `共 ${cd.logs.length} 条` : '缺少：' + logKeys.missing.join(', '));

  const tagOk = (cd.tags || []).every((t) => 'id' in t && 'name' in t && 'color' in t);
  check('客户标签字段完整', tagOk, `${(cd.tags || []).length} 个标签`);

  /* ---------- 4. 表单可写字段：编辑抽屉提交后必须完整回读 ---------- */
  const FORM_FIELDS = [
    'name', 'short_name', 'type', 'industry', 'source', 'level', 'status', 'owner',
    'phone', 'fax', 'website', 'email', 'wechat', 'credit_code',
    'province', 'city', 'district', 'address', 'zip_code',
    'enterprise_nature', 'parent_group', 'scale', 'founded_at',
    'employees', 'legal_person', 'is_listed',
    'purchase_mode', 'end_user', 'design_institute', 'epc_contractor', 'valve_types',
    'drive_mode', 'body_material', 'pressure_rating', 'size_range', 'design_standard',
    'connection_type', 'cert_required',
    'annual_demand', 'purchase_cycle', 'account_period', 'warranty_ratio',
    'warranty_months', 'payer', 'tender_platform',
    'qualification', 'has_ts_license', 'has_explosion_proof', 'quality_grade',
    'supplier_code', 'credit_rating',
    'introducer', 'competitor', 'longitude', 'latitude', 'customer_since',
    'next_follow_at', 'remark'
  ];
  const fk = hasKeys(cd, FORM_FIELDS);
  check(`详情返回表单全部 ${FORM_FIELDS.length} 个可写字段（编辑抽屉回填依赖）`, fk.ok,
    fk.ok ? `${FORM_FIELDS.length} 个字段齐备` : '缺少：' + fk.missing.join(', '));

  /* 已删除的字段不应再出现在接口返回中 */
  check('已删除的 reg_capital 字段不再返回',
    !('reg_capital' in cd),
    'reg_capital' in cd ? '仍存在（迁移未生效？）' : '已彻底移除');

  /* ---------- 5. 标签接口：TagPicker 与批量打标签依赖 ---------- */
  const tags = await api('GET', '/api/tags');
  const t0 = (tags.data || [])[0] || {};
  const tk = hasKeys(t0, ['id', 'name', 'color', 'sort', 'customer_count']);
  check('标签接口字段完整（含 customer_count 统计）', tags.data.length === 0 || tk.ok,
    tags.data.length ? `${tags.data.length} 个标签，${JSON.stringify(t0)}` : '暂无标签');

  /* ---------- 6. 回收站接口：字段与页面展示一致 ---------- */
  await api('DELETE', `/api/customers/${cid}`);
  const trash = await api('GET', '/api/trash?type=customer');
  const tr = (trash.data || []).find((x) => x.id === cid) || {};
  const trk = hasKeys(tr, ['id', 'title', 'sub', 'deleted_at']);
  check('回收站条目字段完整（title/sub/deleted_at）', trk.ok,
    trk.ok ? `title=${tr.title}，sub=${tr.sub}` : '缺少：' + trk.missing.join(', '));
  await api('POST', '/api/trash/restore', { ids: [cid] });

  /* ---------- 7. 错误响应结构：前端 toast 依赖 message ---------- */
  const err404 = await api('GET', '/api/customers/99999999');
  check('错误响应含 code 与 message（前端 toast 展示依赖）',
    err404.json && err404.json.ok === false && !!err404.json.code && !!err404.json.message,
    `code=${err404.json && err404.json.code}, message=${err404.json && err404.json.message}`);

  const err400 = await api('POST', '/api/customers', { name: '' });
  check('校验错误可读（展示给用户的中文提示）',
    err400.status === 400 && /中文|必填|名称/.test(err400.json.message),
    `HTTP ${err400.status} message=${err400.json.message}`);

  /* ---------- 清理 ---------- */
  await api('POST', '/api/customers/batch-delete', { ids: [cid] });

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
