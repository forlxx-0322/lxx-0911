/**
 * 阶段四 API 验收测试 —— 首页总览 / 设置 / 备份恢复 / 导入导出 / 日志
 * 用法：node tools/test-phase4-api.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const DB_FILE = path.resolve(__dirname, '..', 'data', 'crm.db');
const BACKUP_DIR = path.resolve(__dirname, '..', 'data', 'backups');
const MIRROR_DIR = path.join(BACKUP_DIR, 'mirror');

const results = [];
function check(no, name, pass, detail) {
  results.push({ no, name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${no}. ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, path_, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path_, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json, data: json && json.data };
}

function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const created = {};

(async () => {
  console.log('=== 阶段四 API 验收测试 ===\n');

  /* ================= 0. 先清理上次运行残留（否则统计类断言必挂） ================= */
  try {
    const leftovers = [];
    for (const kw of ['阶段四测试', '导入测试', '天业集团']) {
      const r = await api('GET', '/api/customers?pageSize=200&q=' + encodeURIComponent(kw));
      leftovers.push(...((r.data && r.data.list) || []).map((x) => x.id));
    }
    const uniq = [...new Set(leftovers)];
    for (const id of uniq) {
      const pl = await api('GET', `/api/projects?customer_id=${id}&pageSize=200`);
      const pids = (pl.data.list || []).map((p) => p.id);
      if (pids.length) await api('POST', '/api/projects/batch-delete', { ids: pids });
      const tl = await api('GET', `/api/tasks?view=all&customer_id=${id}`);
      const tids = (tl.data.list || []).map((t) => t.id);
      if (tids.length) await api('POST', '/api/tasks/batch-delete', { ids: tids });
    }
    if (uniq.length) {
      await api('POST', '/api/customers/batch-delete', { ids: uniq });
      console.log(`（已清理上次残留 ${uniq.length} 个测试客户及其项目/待办）\n`);
    }
    /* 清掉残留的测试字典项 */
    const dic = await api('GET', '/api/dict');
    for (const cat of ['industry']) {
      const hits = ((dic.data.items && dic.data.items[cat]) || []).filter((x) => x.value === '测试新行业XYZ');
      for (const h of hits) await api('DELETE', '/api/dict/' + h.id);
    }
  } catch (_) { /* 首次运行无残留 */ }

  /* ================= 0. 造一套完整业务数据（供总览与导出测试） ================= */
  const cust = await api('POST', '/api/customers', {
    name: '阶段四测试客户（新疆天业集团）', short_name: '天业集团',
    type: '终端用户', industry: '化工', level: 'A 重点客户', status: '跟进中',
    city: '石河子市', phone: '0993-1234567',
    annual_demand: 500, next_follow_at: dayOffset(-2) + ' 10:00:00',
    supplier_code: 'P4-TEST-001'
  });
  created.customer = cust.data.id;
  await api('POST', '/api/contacts', {
    customer_id: created.customer, name: '阶段四联系人', mobile: '13909930001',
    position: '采购经理', department: '采购部', is_primary: 1, is_decision: 1
  });
  await api('POST', '/api/followups', {
    customer_id: created.customer, method: '电话', content: '阶段四测试跟进', result: '有意向'
  });
  const proj = await api('POST', '/api/projects', {
    name: '阶段四测试项目：天业化工阀门采购', customer_id: created.customer,
    stage: '已中标/已签约', contract_amount: 800000,
    signed_at: dayOffset(-15), bid_date: dayOffset(-20), bid_result: '已中标'
  });
  created.project = proj.data.id;
  const plan = await api('POST', '/api/payments', {
    project_id: created.project, type: '计划', amount: 240000, plan_date: dayOffset(-5)
  });
  created.plan = plan.data.id;
  await api('POST', '/api/payments', {
    project_id: created.project, type: '实收', amount: 100000,
    actual_date: dayOffset(-1), method: '银行转账', plan_id: created.plan
  });
  const task = await api('POST', '/api/tasks', {
    title: '阶段四测试待办', customer_id: created.customer, project_id: created.project,
    due_at: dayOffset(-1) + ' 09:00:00', priority: '高'
  });
  created.task = task.data.id;
  check(0, '准备完整业务数据（客户/联系人/跟进/项目/回款/待办）',
    cust.data.created && proj.data.created,
    `客户 ${created.customer}，项目 ${created.project}`);

  /* ================= 1. 首页总览 ================= */
  const dash = await api('GET', '/api/dashboard');
  const d = dash.data || {};
  check(1, '首页总览接口返回全部数据块',
    dash.status === 200 && d.cards && d.follow_customers && d.payment_overdue
      && d.bid_calendar && d.chart_trend && d.today_tasks && d.recent_logs,
    `数据块：${Object.keys(d).join(', ')}`);

  check(2, '数字卡数据正确',
    d.cards && d.cards.customer_total >= 1 && d.cards.active_projects >= 1
      && d.cards.month_received >= 100000 && d.cards.follow_today >= 1
      && d.cards.follow_overdue >= 1,
    `客户 ${d.cards.customer_total}（本月新增 ${d.cards.customer_new_this_month}），进行中项目 ${d.cards.active_projects}，本月回款 ${d.cards.month_received}，今日待跟进 ${d.cards.follow_today}（逾期 ${d.cards.follow_overdue}）`);

  check(3, '欠款与逾期回款统计正确',
    d.cards.total_debt === 700000 && d.cards.overdue_payment_count >= 1,
    `总欠款 ${d.cards.total_debt}（合同 800000 − 已收 100000），逾期计划 ${d.cards.overdue_payment_count} 笔共 ${d.cards.overdue_payment_amount} 元`);

  const followHit = (d.follow_customers || []).find((x) => x.id === created.customer);
  check(4, '今日/逾期待跟进客户含天数与主联系人',
    !!followHit && followHit.days_left < 0 && followHit.primary_contact === '阶段四联系人',
    followHit ? `逾期 ${Math.abs(followHit.days_left)} 天，主联系人 ${followHit.primary_contact}，手机 ${followHit.primary_mobile}` : '未找到');

  const payHit = (d.payment_overdue || []).find((x) => x.id === created.plan);
  check(5, '逾期回款计划含未收余额',
    !!payHit && payHit.remain === 140000,
    payHit ? `计划 ${payHit.amount}，已收 ${payHit.amount - payHit.remain}，未收 ${payHit.remain}，逾期 ${Math.abs(payHit.days_diff)} 天` : '未找到');

  const bidHit = (d.bid_calendar || []).find((x) => x.id === created.project);
  check(6, '招投标日历含投标日期与预警级别',
    !!bidHit && bidHit.bid_date === dayOffset(-20),
    bidHit ? `投标日 ${bidHit.bid_date}（${bidHit.days_left} 天），结果 ${bidHit.bid_result}` : '未找到');

  check(7, '趋势图返回 6 个月签约与回款',
    d.chart_trend.months.length === 6
      && d.chart_trend.signed.length === 6 && d.chart_trend.received.length === 6
      && d.chart_trend.signed.some((v) => v > 0),
    `月份 ${d.chart_trend.months.join(',')}；签约 ${d.chart_trend.signed.join(',')}；回款 ${d.chart_trend.received.join(',')}`);

  check(8, '项目阶段分布含金额',
    Array.isArray(d.chart_stages) && d.chart_stages.some((x) => x.name === '已中标/已签约'),
    (d.chart_stages || []).map((x) => `${x.name}:${x.value}`).join(' / '));

  check(9, '下游行业成交额占比正确',
    Array.isArray(d.chart_industries) && d.chart_industries.some((x) => x.name === '化工' && x.amount >= 800000),
    (d.chart_industries || []).map((x) => `${x.name}:${x.amount}`).join(' / '));

  check(10, '客户转化漏斗 5 层有序',
    Array.isArray(d.chart_funnel) && d.chart_funnel.length === 5
      && d.chart_funnel[0].value >= d.chart_funnel[4].value,
    d.chart_funnel.map((x) => `${x.name}:${x.value}`).join(' → '));

  check(11, '今日待办与最近动态有数据',
    (d.today_tasks || []).some((t) => t.id === created.task)
      && (d.recent_logs || []).length > 0,
    `今日待办 ${d.today_tasks.length} 条，最近动态 ${d.recent_logs.length} 条`);

  /* ================= 2. 设置项 ================= */
  const st = await api('GET', '/api/settings');
  check(12, '设置接口返回全部键值与说明',
    st.status === 200 && st.data.settings && Object.keys(st.data.settings).length >= 12,
    `共 ${Object.keys(st.data.settings).length} 项：${Object.keys(st.data.settings).slice(0, 6).join(', ')}…`);

  const oldRemind = st.data.settings.payment_remind_days;
  const upd = await api('PUT', '/api/settings', { payment_remind_days: '10', page_size: '50' });
  const st2 = await api('GET', '/api/settings');
  check(13, '设置项可修改并持久化',
    upd.data.updated.length === 2 && st2.data.settings.payment_remind_days === '10'
      && st2.data.settings.page_size === '50',
    `已更新 ${upd.data.updated.join('、')}`);

  const badKey = await api('PUT', '/api/settings', { not_a_real_key: 'x', hacked: '1' });
  const st3 = await api('GET', '/api/settings');
  check(14, '未知设置键被忽略（防写入垃圾数据）',
    badKey.data.updated.length === 0 && st3.data.settings.hacked === undefined,
    '未知键未写入');

  /* 复原设置 */
  await api('PUT', '/api/settings', { payment_remind_days: oldRemind, page_size: '20' });

  /* ================= 3. 备份 ================= */
  const list0 = await api('GET', '/api/backup/list');
  check(15, '备份列表接口可用并返回目录信息',
    list0.status === 200 && Array.isArray(list0.data.backups) && !!list0.data.backupDir,
    `主目录 ${list0.data.backups.length} 份，镜像 ${list0.data.mirror.length} 份，保留策略 ${list0.data.keep}/${list0.data.mirrorKeep}`);

  const bk = await api('POST', '/api/backup/create', { reason: '阶段四测试手动备份' });
  check(16, '手动备份创建成功',
    bk.status === 200 && bk.data.name && bk.data.size > 0,
    `${bk.data.name}（${Math.round(bk.data.size / 1024)} KB）`);

  const bkPath = path.join(BACKUP_DIR, bk.data.name);
  const bkJson = bkPath.replace(/\.db$/, '.json');
  const jsonSize = fs.existsSync(bkJson) ? fs.statSync(bkJson).size : 0;
  check(17, '备份文件真实落盘且为有效数据库（含非空清单）',
    fs.existsSync(bkPath) && fs.statSync(bkPath).size > 0 && jsonSize > 50,
    `数据库 ${fs.existsSync(bkPath) ? Math.round(fs.statSync(bkPath).size / 1024) + ' KB' : '缺失'}，清单 ${jsonSize} 字节`);

  /* 清单必须是可解析的完整 JSON，且含时间/版本/表行数 */
  let bkManifest = null;
  try { bkManifest = JSON.parse(fs.readFileSync(bkJson, 'utf8')); } catch (_) { bkManifest = null; }
  const expectedSchema = require('../server/db').SCHEMA_VERSION;
  check(18, '备份清单是完整可解析的 JSON 且含时间/版本/各表行数',
    !!bkManifest && !!bkManifest.createdAt && bkManifest.schemaVersion === expectedSchema
      && bkManifest.tables && bkManifest.tables.customers >= 1
      && Object.keys(bkManifest.tables).length >= 13,
    bkManifest
      ? `结构版本 v${bkManifest.schemaVersion}（代码当前 v${expectedSchema}），记录 ${Object.keys(bkManifest.tables).length} 张表；客户 ${bkManifest.tables.customers} 条，项目 ${bkManifest.tables.projects} 条`
      : '清单无法解析');

  const mirrorPath = path.join(MIRROR_DIR, bk.data.name);
  check(19, '镜像副本已生成（第二份，防误删）',
    fs.existsSync(mirrorPath),
    fs.existsSync(mirrorPath) ? `镜像 ${Math.round(fs.statSync(mirrorPath).size / 1024)} KB` : '镜像缺失');

  const verify = await api('POST', '/api/backup/verify', { name: bk.data.name });
  check(20, '备份可校验（完整性与内容）',
    verify.data.ok === true && verify.data.customers >= 1 && verify.data.tables >= 13,
    `完整性 ${verify.data.ok}，表 ${verify.data.tables} 张，客户 ${verify.data.customers} 条，版本 v${verify.data.version}`);

  /* 内容抽查：备份里的客户数应与当前库一致 */
  const probe = new DatabaseSync(bkPath, { readOnly: true });
  const bkCustomer = probe.prepare('SELECT name FROM customers WHERE id = ?').get(created.customer);
  const bkProject = probe.prepare('SELECT contract_amount FROM projects WHERE id = ?').get(created.project);
  probe.close();
  check(21, '备份内容与当前数据一致（可抽查到具体记录）',
    bkCustomer && bkCustomer.name.includes('天业集团') && bkProject && bkProject.contract_amount === 800000,
    `备份中客户「${bkCustomer && bkCustomer.name.slice(0, 12)}…」，项目金额 ${bkProject && bkProject.contract_amount}`);

  const badVerify = await api('POST', '/api/backup/verify', { name: 'not-exist.db' });
  const traverse = await api('POST', '/api/backup/verify', { name: '../../crm.db' });
  check(22, '非法备份名与目录穿越被拒绝',
    badVerify.data.ok === false && traverse.status === 400,
    `不存在→${badVerify.data.ok === false ? '校验失败' : '异常'}，目录穿越→HTTP ${traverse.status}`);

  const delLatest = await api('POST', '/api/backup/delete', { name: bk.data.name });
  check(23, '最新一份备份不允许删除（保留唯一保险）',
    delLatest.status === 400 && delLatest.json.code === 'KEEP_LATEST',
    `HTTP ${delLatest.status} ${delLatest.json.message}`);

  /* 恢复：第一步只校验不动数据 */
  const restore1 = await api('POST', '/api/backup/restore', { name: bk.data.name });
  check(24, '恢复第一步只做校验与预览，不改动数据',
    restore1.status === 200 && restore1.data.needConfirm === true
      && restore1.data.verify.ok === true && restore1.data.willReplace,
    `预览：将替换 客户 ${restore1.data.willReplace.customers} / 项目 ${restore1.data.willReplace.projects} / 待办 ${restore1.data.willReplace.tasks}`);

  /* ================= 4. 导入导出 ================= */
  const tpl = await api('GET', '/api/data/template?entity=customer');
  /* 必填列与界面表单一致：客户全称 / 简称 / 主体类型 / 下游行业，共 4 列 */
  const requiredLabels = tpl.data.fields.filter((f) => f.required).map((f) => f.label);
  check(25, '导入模板返回字段定义与示例',
    tpl.data.fields.length >= 55 && tpl.data.sample.length === tpl.data.fields.length
      && requiredLabels.length === 4
      && ['客户全称', '客户简称', '主体类型', '下游行业'].every((l) => requiredLabels.includes(l)),
    `客户模板 ${tpl.data.fields.length} 列（必填 ${requiredLabels.length} 列：${requiredLabels.join('、')}），示例 ${tpl.data.sample.filter(Boolean).length} 个`);

  const exp = await api('GET', '/api/data/export?entity=customer');
  check(26, '导出客户数据（含列定义）',
    exp.data.rows.length >= 1 && exp.data.fields.length >= 55,
    `导出 ${exp.data.count} 条 × ${exp.data.fields.length} 列`);

  const expProj = await api('GET', '/api/data/export?entity=project');
  const expCont = await api('GET', '/api/data/export?entity=contact');
  check(27, '导出项目与联系人数据',
    expProj.data.rows.length >= 1 && expCont.data.rows.length >= 1,
    `项目 ${expProj.data.count} 条，联系人 ${expCont.data.count} 条`);

  /* 导入预校验：构造一批含正确、重复、缺必填、字典外值的行 */
  /* 为"库内重复"这一条专门建一个客户：不依赖前面步骤留下的数据，
     避免那些数据在此处之前被清理掉导致查重测不到（曾经因此误判为功能故障）。 */
  const dupTarget = await api('POST', '/api/customers', {
    name: '阶段四导入查重对照客户', short_name: '查重对照',
    type: '终端用户', industry: '石油'
  });
  const dupTargetId = dupTarget.data.id;

  const importRows = [
    { name: '导入测试客户A', short_name: '导入A', type: '终端用户', industry: '煤化工',
      level: 'A 重点客户', status: '潜在', annual_demand: '1200', is_listed: '是',
      founded_at: '2010/5/20', city: '乌鲁木齐市' },
    { name: '导入测试客户B', short_name: '导入B', type: '贸易商/经销商', industry: '测试新行业XYZ',
      status: '跟进中', annual_demand: 'abc' },
    { name: '', short_name: '缺名称', type: '终端用户' },
    { name: '导入测试客户A', short_name: '重复行', type: '其他' },
    { name: '阶段四导入查重对照客户', short_name: '库里已有', type: '终端用户', industry: '石油' }
  ];
  const prev = await api('POST', '/api/data/preview', { entity: 'customer', rows: importRows });
  /* 注意：与库中重名现在归为"重复"（可跳过/可更新）而不是"错误"，
     因此第 5 行算有效行、action='skip'；仍算错误的是必填缺失与文件内重复。 */
  check(28, '导入预校验：正确识别有效行与错误行',
    prev.data.total === 5 && prev.data.valid === 3 && prev.data.invalid === 2,
    `共 ${prev.data.total} 行：有效 ${prev.data.valid}，无效 ${prev.data.invalid}`);

  const row1 = prev.data.rows[0];
  const row2 = prev.data.rows[1];
  const row3 = prev.data.rows[2];
  const row4 = prev.data.rows[3];
  const row5 = prev.data.rows[4];
  check(29, '校验细节：必填/文件内重复/库内重复/字典外值',
    row1.errors.length === 0
      && row1.data.annual_demand === 1200 && row1.data.is_listed === 1 && row1.data.founded_at === '2010-05-20'
      && row2.warnings.some((w) => w.includes('测试新行业XYZ')) && row2.data.annual_demand === 0
      && row3.errors.some((e) => e.includes('必填'))
      && row4.errors.some((e) => e.includes('文件内'))
      /* 库内重名：不算错误，标记为重复并给出"将跳过/将更新"的提示 */
      && row5.errors.length === 0 && row5.duplicateInDb === true
      && row5.action === 'skip'
      && row5.warnings.some((w) => w.includes('库中已有同名')),
    `A:数字/是/日期归一正确；B:字典外值提示 ${row2.warnings.length} 条且非法数字归 0；C:必填报错；D:文件内重复；E:库内重名标记为 ${row5.action}`);

  const imp = await api('POST', '/api/data/import', { entity: 'customer', rows: importRows });
  /* 新增 2 条、库内重名的 1 条被跳过、必填缺失与文件内重复 2 条校验未通过 */
  check(30, '执行导入：只导入有效行并给出报告',
    imp.data.imported === 2 && imp.data.skipped === 1 && imp.data.invalid === 2 && imp.data.failed === 0,
    `导入 ${imp.data.imported} 条，跳过 ${imp.data.skipped} 条，校验未通过 ${imp.data.invalid} 条，失败 ${imp.data.failed} 条，自动新增字典 ${imp.data.dictAdded} 项`);

  const importedList = await api('GET', '/api/customers?q=' + encodeURIComponent('导入测试客户'));
  check(31, '导入的数据真实入库且字段正确',
    importedList.data.total === 2,
    `查到 ${importedList.data.total} 条：${(importedList.data.list || []).map((x) => x.short_name).join('/')}`);

  const dictAfter = await api('GET', '/api/dict');
  check(32, '导入时字典外值自动补进字典',
    dictAfter.data.options.industry.includes('测试新行业XYZ'),
    `行业选项数 ${dictAfter.data.options.industry.length}，「测试新行业XYZ」已入字典`);

  /* 导入项目与联系人 */
  const projRows = [{
    customer_name: '导入测试客户A', name: '导入测试项目X', stage: '询价报价',
    progress: '20', contract_amount: '350000', bid_date: '2026/4/1', owner: '本人'
  }];
  const impProj = await api('POST', '/api/data/import', { entity: 'project', rows: projRows });
  check(33, '导入项目成功（并校验客户存在）',
    impProj.data.imported === 1,
    `导入 ${impProj.data.imported} 条项目`);

  const badProjRows = [{ customer_name: '不存在的客户XYZ', name: '孤立项目' }];
  const badProj = await api('POST', '/api/data/preview', { entity: 'project', rows: badProjRows });
  check(34, '导入项目时客户不存在会报错',
    badProj.data.invalid === 1 && badProj.data.rows[0].errors.some((e) => e.includes('找不到客户')),
    badProj.data.rows[0].errors.join('；'));

  /* 超量保护 */
  const tooMany = await api('POST', '/api/data/preview', {
    entity: 'customer', rows: new Array(5001).fill({ name: 'x' })
  });
  check(35, '单次导入行数上限保护',
    tooMany.status === 400 && tooMany.json.code === 'TOO_MANY',
    `HTTP ${tooMany.status} ${tooMany.json.message}`);

  /* ================= 5. 操作日志 ================= */
  const logs = await api('GET', '/api/logs?pageSize=20');
  check(36, '操作日志列表带中文标签与统计',
    logs.data.list.length > 0 && logs.data.list[0].entity_label && logs.data.list[0].action_label
      && logs.data.stats.by_entity.length > 0,
    `共 ${logs.data.total} 条；类型统计 ${logs.data.stats.by_entity.map((x) => x.label + ':' + x.n).slice(0, 5).join(' ')}`);

  const logsFiltered = await api('GET', '/api/logs?entity_type=project&pageSize=10');
  check(37, '日志可按对象类型筛选',
    logsFiltered.data.list.length > 0 && logsFiltered.data.list.every((l) => l.entity_type === 'project'),
    `项目日志 ${logsFiltered.data.total} 条`);

  const logsSearch = await api('GET', '/api/logs?q=' + encodeURIComponent('导入'));
  check(38, '日志可关键词搜索',
    logsSearch.data.total >= 1 && logsSearch.data.list.some((l) => l.action === 'import'),
    `含「导入」的日志 ${logsSearch.data.total} 条`);

  /* ================= 6. 回收站（阶段四补齐界面所需接口） ================= */
  const trashCust = await api('GET', '/api/trash?type=customer');
  const trashProj = await api('GET', '/api/trash?type=project');
  const trashTask = await api('GET', '/api/trash?type=task');
  check(39, '回收站支持客户/项目/待办三类',
    Array.isArray(trashCust.data) && Array.isArray(trashProj.data) && Array.isArray(trashTask.data),
    `客户 ${trashCust.data.length}，项目 ${trashProj.data.length}，待办 ${trashTask.data.length}`);

  /* ================= 清理 ================= */
  const cleanupCust = await api('GET', '/api/customers?q=' + encodeURIComponent('导入测试'));
  const ids = (cleanupCust.data.list || []).map((x) => x.id);
  for (const id of ids) {
    const pl = await api('GET', `/api/projects?customer_id=${id}&pageSize=200`);
    const pids = (pl.data.list || []).map((p) => p.id);
    if (pids.length) await api('POST', '/api/projects/batch-delete', { ids: pids });
  }
  if (ids.length) await api('POST', '/api/customers/batch-delete', { ids });

  const pl2 = await api('GET', `/api/projects?customer_id=${created.customer}&pageSize=200`);
  if ((pl2.data.list || []).length) {
    await api('POST', '/api/projects/batch-delete', { ids: pl2.data.list.map((p) => p.id) });
  }
  await api('POST', '/api/tasks/batch-delete', { ids: [created.task] });
  await api('POST', '/api/customers/batch-delete', { ids: [created.customer] });
  /* 查重对照客户也一并清理 */
  await api('POST', '/api/customers/batch-delete', { ids: [dupTargetId] });
  console.log(`\n（已清理测试数据：客户 ${ids.length + 2} 个及其项目、待办）`);

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.no}. ${r.name} —— ${r.detail}`);
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
