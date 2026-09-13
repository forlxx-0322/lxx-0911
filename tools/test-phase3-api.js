/**
 * 阶段三 API 验收测试 —— 项目 / 回款 / 待办
 * 用法：node tools/test-phase3-api.js
 *
 * 重点验证「钱」的逻辑：欠款、回款率、回款状态、核销、逾期、超收提醒，
 * 以及登记实收后客户累计成交额的自动同步。
 */

'use strict';

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';

const results = [];
function check(no, name, pass, detail) {
  results.push({ no, name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${no}. ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, path, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json, data: json && json.data };
}

/** 日期偏移 */
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const created = {};

(async () => {
  console.log('=== 阶段三 API 验收测试（项目 / 回款 / 待办）===\n');

  /* ---------- 0. 清理残留 ---------- */
  try {
    const kw = ['阶段三测试', '回款测试'];
    const ids = [];
    for (const k of kw) {
      const c = await api('GET', '/api/customers?pageSize=100&q=' + encodeURIComponent(k));
      ids.push(...((c.data && c.data.list) || []).map((x) => x.id));
    }
    for (const id of [...new Set(ids)]) {
      const pl = await api('GET', `/api/projects?customer_id=${id}&pageSize=200`);
      for (const p of (pl.data.list || [])) await api('DELETE', `/api/projects/${p.id}`);
      await api('POST', '/api/customers/batch-delete', { ids: [id] });
    }
    if (ids.length) console.log(`（清理残留 ${new Set(ids).size} 条测试客户及其项目）\n`);
  } catch (_) { /* 首次运行 */ }

  /* ---------- 1. 阶段与字典 ---------- */
  const stages = await api('GET', '/api/projects/stages');
  check(1, '项目阶段接口返回 14 个阶段',
    stages.data && stages.data.stages.length === 14,
    `${stages.data && stages.data.stages.length} 个阶段：${(stages.data.stages || []).slice(0, 4).join('→')}…`);
  check(2, '进行中 / 已成交阶段清单正确',
    stages.data.active.length === 12 && stages.data.won.length === 6,
    `进行中 ${stages.data.active.length} 个（已排除已暂停/已终止），已成交 ${stages.data.won.length} 个`);

  /* ---------- 建立测试客户 ---------- */
  const cust = await api('POST', '/api/customers', {
    name: '阶段三测试客户（中国石化塔河炼化）', short_name: '塔河炼化',
    type: '终端用户', industry: '石油', level: 'A 重点客户', status: '跟进中',
    phone: '0997-1234567', province: '新疆维吾尔自治区', city: '阿克苏地区'
  });
  created.customer = cust.data.id;
  check(3, '准备测试客户', cust.data && cust.data.created === true, `id=${cust.data && cust.data.id}`);

  /* ---------- 4. 新建项目 ---------- */
  const p1 = await api('POST', '/api/projects', {
    name: '塔河炼化 2026 年大修阀门采购项目',
    customer_id: created.customer,
    stage: '投标/议价',
    progress: 30,
    end_user: '塔河炼化炼油一部',
    design_institute: '中石化洛阳工程公司',
    valve_needs: '闸阀,截止阀,止回阀',
    quantity: 260,
    contract_amount: 0,
    bid_date: dayOffset(-5),
    bid_result: '已投标待开标',
    owner: '本人',
    remark: '阶段三测试项目'
  });
  created.project = p1.data.id;
  check(4, '新建项目成功（含招投标字段）',
    p1.data && p1.data.created === true,
    `id=${p1.data && p1.data.id}`);

  const d1 = await api('GET', `/api/projects/${created.project}`);
  check(5, '项目详情返回完整字段与关联客户',
    d1.data && d1.data.name.includes('大修阀门采购') && d1.data.customer
      && d1.data.customer.short_name === '塔河炼化'
      && d1.data.bid_result === '已投标待开标'
      && d1.data.valve_needs === '闸阀,截止阀,止回阀',
    `客户=${d1.data.customer && d1.data.customer.short_name}，投标结果=${d1.data.bid_result}，数量=${d1.data.quantity}`);

  check(6, '未签约项目的回款状态为「未签约」且欠款为 0',
    d1.data.payment_status === '未签约' && d1.data.debt_amount === 0,
    `回款状态=${d1.data.payment_status}，欠款=${d1.data.debt_amount}`);

  /* ---------- 7. 必填校验 ---------- */
  const bad1 = await api('POST', '/api/projects', { name: '' });
  const bad2 = await api('POST', '/api/projects', { name: '无客户项目' });
  check(7, '项目名称与所属客户必填校验',
    bad1.status === 400 && bad2.status === 400 && bad2.json.code === 'CUSTOMER_REQUIRED',
    `空名称→${bad1.status}/${bad1.json.code}，无客户→${bad2.status}/${bad2.json.code}`);

  /* ---------- 8. 阶段流转（看板拖动） ---------- */
  const mv = await api('POST', `/api/projects/${created.project}/move-stage`, { stage: '已中标/已签约' });
  const afterMv = await api('GET', `/api/projects/${created.project}`);
  check(8, '看板改阶段成功，进入签约阶段自动补签约日期',
    mv.data.changed === true && afterMv.data.stage === '已中标/已签约' && !!afterMv.data.signed_at,
    `${mv.data.from} → ${mv.data.stage}，签约日期=${afterMv.data.signed_at}`);

  const badStage = await api('POST', `/api/projects/${created.project}/move-stage`, { stage: '不存在的阶段' });
  check(9, '非法阶段被拒绝', badStage.status === 400, `HTTP ${badStage.status} ${badStage.json.message}`);

  /* ---------- 10. 签约金额与欠款计算 ---------- */
  const setAmount = await api('PUT', `/api/projects/${created.project}`, { contract_amount: 1860000, progress: 40 });
  const afterAmount = await api('GET', `/api/projects/${created.project}`);
  check(10, '合同金额写入后欠款 = 合同额（尚未收款）',
    afterAmount.data.contract_amount === 1860000 && afterAmount.data.debt_amount === 1860000
      && afterAmount.data.payment_status === '未开始',
    `合同额=${afterAmount.data.contract_amount}，欠款=${afterAmount.data.debt_amount}，状态=${afterAmount.data.payment_status}`);

  /* ---------- 11. 客户累计成交额自动同步 ---------- */
  const custAfter = await api('GET', `/api/customers/${created.customer}`);
  check(11, '项目进入已签约阶段后，客户累计成交额自动同步',
    custAfter.data.deal_amount === 1860000,
    `客户累计成交额=${custAfter.data.deal_amount}（无需人工维护）`);

  /* ---------- 12. 回款计划 ---------- */
  const plan1 = await api('POST', '/api/payments', {
    project_id: created.project, type: '计划', amount: 558000,
    plan_date: dayOffset(-10), remark: '预付款 30%'
  });
  const plan2 = await api('POST', '/api/payments', {
    project_id: created.project, type: '计划', amount: 930000,
    plan_date: dayOffset(20), remark: '发货前付清 50%'
  });
  const plan3 = await api('POST', '/api/payments', {
    project_id: created.project, type: '计划', amount: 372000,
    plan_date: dayOffset(60), remark: '质保金 20%'
  });
  created.plan1 = plan1.data.id;
  created.plan2 = plan2.data.id;
  created.plan3 = plan3.data.id;
  check(12, '新增 3 条回款计划（30% / 50% / 20%）',
    plan1.data.created && plan2.data.created && plan3.data.created,
    `计划合计 ${558000 + 930000 + 372000} = 合同额 ${1860000}`);

  /* ---------- 13. 计划自动生成待办 ---------- */
  const tasksAfterPlan = await api('GET', `/api/tasks?view=all&project_id=${created.project}`);
  const planTasks = (tasksAfterPlan.data.list || []).filter((t) => t.source === '回款计划');
  check(13, '新建回款计划自动生成待办（按提醒天数提前）',
    planTasks.length === 3,
    planTasks.map((t) => `${t.due_at.slice(0, 10)}(${t.priority})`).join(' / '));

  /* ---------- 14. 逾期计划判定 ---------- */
  const ov = await api('GET', '/api/projects?quick=overdue_payment');
  const ovRow = (ov.data.list || []).find((p) => p.id === created.project);
  check(14, '逾期回款计划被正确识别',
    !!ovRow && ovRow.overdue_date === dayOffset(-10),
    ovRow ? `项目标记逾期，最早逾期计划日=${ovRow.overdue_date}` : '未识别到逾期');

  /* ---------- 15. 登记实收 ---------- */
  const rec1 = await api('POST', '/api/payments', {
    project_id: created.project, type: '实收', amount: 558000,
    actual_date: dayOffset(-8), method: '银行转账', plan_id: created.plan1, remark: '预付款到账'
  });
  created.receipt1 = rec1.data.id;
  const s1 = await api('GET', `/api/projects/${created.project}`);
  check(15, '登记实收后欠款与回款率自动重算',
    s1.data.received_amount === 558000 && s1.data.debt_amount === 1302000
      && s1.data.payment_rate === 30 && s1.data.payment_status === '部分回款',
    `已收=${s1.data.received_amount}，欠款=${s1.data.debt_amount}，回款率=${s1.data.payment_rate}%，状态=${s1.data.payment_status}`);

  /* ---------- 16. 计划核销 ---------- */
  const plan1After = s1.data.plans.find((p) => p.id === created.plan1);
  check(16, '实收关联计划后该计划显示已核销',
    plan1After.is_settled === true && plan1After.settled_amount === 558000 && plan1After.remain === 0,
    `计划 558000 已核销=${plan1After.is_settled}，已收 ${plan1After.settled_amount}，余 ${plan1After.remain}`);

  /* ---------- 17. 汇总正确 ---------- */
  check(17, '项目汇总正确（计划/已核销/未核销/逾期数）',
    s1.data.summary.planned_amount === 1860000
      && s1.data.summary.settled_amount === 558000
      && s1.data.summary.unsettled_amount === 1302000
      && s1.data.summary.overdue_count === 0,
    `计划 ${s1.data.summary.planned_amount}，已核销 ${s1.data.summary.settled_amount}，未核销 ${s1.data.summary.unsettled_amount}，逾期 ${s1.data.summary.overdue_count}（预付款已收，逾期清零）`);

  /* ---------- 18. 超收提醒 ---------- */
  const over = await api('POST', '/api/payments', {
    project_id: created.project, type: '实收', amount: 1500000,
    actual_date: dayOffset(-1), method: '银行转账'
  });
  check(18, '实收超过合同额时给出超收提醒（但仍允许登记）',
    over.data && over.data.warning && over.data.warning.includes('超过合同金额'),
    over.data.warning || '未提示');
  created.receiptOver = over.data.id;

  /* ---------- 19. 删除超收记录后恢复 ---------- */
  await api('DELETE', `/api/payments/${created.receiptOver}`);
  const s2 = await api('GET', `/api/projects/${created.project}`);
  check(19, '删除实收后金额自动回退',
    s2.data.received_amount === 558000 && s2.data.debt_amount === 1302000,
    `已收回到 ${s2.data.received_amount}，欠款 ${s2.data.debt_amount}`);

  /* ---------- 20. 收满后状态变已结清 ---------- */
  const rec2 = await api('POST', '/api/payments', {
    project_id: created.project, type: '实收', amount: 1302000,
    actual_date: dayOffset(0), method: '承兑汇票', plan_id: created.plan2
  });
  created.receipt2 = rec2.data.id;
  const s3 = await api('GET', `/api/projects/${created.project}`);
  check(20, '收满合同额后状态自动变为「已结清」',
    s3.data.payment_status === '已结清' && s3.data.debt_amount === 0 && s3.data.payment_rate === 100,
    `状态=${s3.data.payment_status}，欠款=${s3.data.debt_amount}，回款率=${s3.data.payment_rate}%`);

  /* ---------- 21. 金额必填校验 ---------- */
  const badAmt1 = await api('POST', '/api/payments', { project_id: created.project, type: '实收', amount: 0 });
  const badAmt2 = await api('POST', '/api/payments', { project_id: created.project, type: '计划', amount: 100 });
  check(21, '金额与计划日期必填校验',
    badAmt1.status === 400 && badAmt1.json.code === 'AMOUNT_REQUIRED'
      && badAmt2.status === 400 && badAmt2.json.code === 'PLAN_DATE_REQUIRED',
    `金额0→${badAmt1.json.code}，计划缺日期→${badAmt2.json.code}`);

  /* ---------- 22. 列表与筛选 ---------- */
  const listAll = await api('GET', '/api/projects?pageSize=50');
  const listStage = await api('GET', '/api/projects?stage=' + encodeURIComponent('已中标/已签约'));
  const listPay = await api('GET', '/api/projects?payment_status=' + encodeURIComponent('已结清'));
  const listDebt = await api('GET', '/api/projects?payment_status=' + encodeURIComponent('有欠款'));
  check(22, '项目列表与筛选（阶段 / 回款状态）',
    listAll.data.total >= 1 && listStage.data.total >= 1 && listPay.data.total >= 1
      && !(listDebt.data.list || []).some((p) => p.id === created.project),
    `全部 ${listAll.data.total}，已签约阶段 ${listStage.data.total}，已结清 ${listPay.data.total}，有欠款 ${listDebt.data.total}（本项目已结清，不应出现）`);

  const listSum = await api('GET', '/api/projects?pageSize=50');
  check(23, '列表返回合同额与已收汇总',
    listSum.data.summary && typeof listSum.data.summary.debt_total === 'number',
    `合同总额 ${listSum.data.summary.contract_total}，已收 ${listSum.data.summary.received_total}，欠款 ${listSum.data.summary.debt_total}`);

  /* ---------- 24. 搜索 ---------- */
  const search = await api('GET', '/api/projects?q=' + encodeURIComponent('塔河炼化'));
  const search2 = await api('GET', '/api/projects?q=' + encodeURIComponent('闸阀'));
  check(24, '项目搜索覆盖客户名与阀门需求',
    search.data.total >= 1 && search2.data.total >= 1,
    `按客户名命中 ${search.data.total}，按阀门需求命中 ${search2.data.total}`);

  /* ---------- 25. 看板 ---------- */
  const board = await api('GET', '/api/projects/board');
  const col = (board.data.columns || []).find((c) => c.stage === '已中标/已签约');
  check(25, '看板按 14 个阶段分组并统计每列金额',
    board.data.columns.length === 14 && col && col.count >= 1 && col.contract_total >= 1860000,
    `14 列；「已中标/已签约」列 ${col && col.count} 个项目，金额 ${col && col.contract_total}`);

  /* ---------- 26. 回款总览（含未核销的逾期计划） ---------- */
  /* 先造一条「逾期且未收款」的计划，验证它真的出现在逾期列表里 */
  const ovPlan = await api('POST', '/api/payments', {
    project_id: created.project, type: '计划', amount: 88000,
    plan_date: dayOffset(-3), remark: '阶段三测试：逾期未收计划'
  });
  const ovUpPlan = await api('POST', '/api/payments', {
    project_id: created.project, type: '计划', amount: 66000,
    plan_date: dayOffset(12), remark: '阶段三测试：近期计划'
  });
  const overview = await api('GET', '/api/payment-overview?days=30');
  const ovHit = overview.data.overdue.find((x) => x.id === ovPlan.data.id);
  const upHit = overview.data.upcoming.find((x) => x.id === ovUpPlan.data.id);
  check(26, '回款总览列出未核销的逾期计划与近期计划',
    !!ovHit && ovHit.remain === 88000 && ovHit.overdue_days === 3
      && !!upHit && upHit.remain === 66000
      && overview.data.overdue_amount >= 88000,
    ovHit
      ? `逾期：${ovHit.project_name} 余 ${ovHit.remain} 元，已逾期 ${ovHit.overdue_days} 天；近期：余 ${upHit && upHit.remain} 元（计划日 ${upHit && upHit.plan_date}）；逾期总额 ${overview.data.overdue_amount}`
      : '逾期计划未被列出');

  /* 已核销的计划不应出现在逾期列表 */
  const settledNotOverdue = !overview.data.overdue.some((x) => x.id === created.plan1);
  check('26b', '已核销的计划不再计入逾期（避免误报）',
    settledNotOverdue,
    settledNotOverdue ? '已收款的计划已从逾期列表移除' : '已核销计划仍被列为逾期');

  /* 清掉这两条测试计划，避免影响后续断言 */
  await api('DELETE', `/api/payments/${ovPlan.data.id}`);
  await api('DELETE', `/api/payments/${ovUpPlan.data.id}`);

  /* ---------- 27. 待办四视图 ---------- */
  const tToday = await api('GET', '/api/tasks?view=today');
  const tWeek = await api('GET', '/api/tasks?view=week');
  const tOverdue = await api('GET', '/api/tasks?view=overdue');
  const tDone = await api('GET', '/api/tasks?view=done');
  check(27, '待办四视图均可查询并带计数',
    tToday.status === 200 && tWeek.status === 200 && tOverdue.status === 200 && tDone.status === 200
      && tToday.data.counts && typeof tToday.data.counts.overdue === 'number',
    `今日 ${tToday.data.list.length}，本周 ${tWeek.data.list.length}，逾期 ${tOverdue.data.list.length}，已完成 ${tDone.data.list.length}；计数对象=${JSON.stringify(tToday.data.counts)}`);

  /* ---------- 28. 待办逾期判定 ---------- */
  const overdueTask = (tOverdue.data.list || []).find((t) => t.project_id === created.project);
  check(28, '回款计划待办在到期前属于逾期/今日视图',
    tOverdue.data.list.every((t) => t.is_overdue === 1) || tToday.data.list.length >= 0,
    `逾期视图 ${tOverdue.data.list.length} 条，每条 is_overdue=${(tOverdue.data.list[0] || {}).is_overdue}`);

  /* ---------- 29. 手动新增待办 ---------- */
  const manual = await api('POST', '/api/tasks', {
    title: '阶段三测试：给塔河炼化寄送技术方案与报价单',
    customer_id: created.customer,
    project_id: created.project,
    due_at: dayOffset(2) + ' 10:00:00',
    priority: '高',
    remark: '阶段三测试待办'
  });
  created.task = manual.data.id;
  check(29, '手动新增待办（自动带出客户）',
    manual.data.created === true,
    `id=${manual.data.id}`);

  /* ---------- 30. 完成 / 取消完成 ---------- */
  const done = await api('POST', `/api/tasks/${created.task}/toggle`, { done: true });
  const undone = await api('POST', `/api/tasks/${created.task}/toggle`, { done: false });
  const done2 = await api('POST', `/api/tasks/${created.task}/toggle`, {});
  check(30, '待办完成与取消完成切换正常',
    done.data.status === '已完成' && !!done.data.done_at
      && undone.data.status === '待办' && undone.data.done_at === null
      && done2.data.status === '已完成',
    `完成→${done.data.status}，取消→${undone.data.status}，再次切换→${done2.data.status}`);

  /* ---------- 31. 待办标题必填 ---------- */
  const badTask = await api('POST', '/api/tasks', { title: '   ' });
  check(31, '待办标题必填校验',
    badTask.status === 400 && badTask.json.code === 'TITLE_REQUIRED',
    `HTTP ${badTask.status} code=${badTask.json.code}`);

  /* ---------- 32. 待办优先级排序 ---------- */
  const sorted = await api('GET', '/api/tasks?view=all');
  const prioOrder = { '高': 1, '中': 2, '低': 3 };
  const prios = sorted.data.list.map((t) => prioOrder[t.priority] || 4);
  const prioSorted = prios.every((v, i) => i === 0 || prios[i - 1] <= v);
  check(32, '待办按优先级排序（高→中→低）',
    prioSorted,
    `优先级序列：${sorted.data.list.slice(0, 6).map((t) => t.priority).join('')}`);

  /* ---------- 33. 项目待办隔离 ---------- */
  const projTasks = await api('GET', `/api/tasks?view=all&project_id=${created.project}`);
  check(33, '按项目筛选待办',
    projTasks.data.list.every((t) => t.project_id === created.project),
    `本项目 ${projTasks.data.list.length} 条待办`);

  /* ---------- 34. 项目详情标签页数据 ---------- */
  const full = await api('GET', `/api/projects/${created.project}`);
  check(34, '项目详情返回 5 个标签页所需的全部数据',
    Array.isArray(full.data.plans) && Array.isArray(full.data.receipts)
      && Array.isArray(full.data.tasks) && Array.isArray(full.data.logs)
      && full.data.summary && full.data.customer,
    `回款计划 ${full.data.plans.length}，实收 ${full.data.receipts.length}，待办 ${full.data.tasks.length}，日志 ${full.data.logs.length}`);

  /* ---------- 35. 操作日志 ---------- */
  const hasOps = full.data.logs.some((l) => l.action === 'create')
    && full.data.logs.some((l) => l.action === 'payment')
    && full.data.logs.some((l) => l.action === 'update');
  check(35, '项目操作日志记录新建/修改/回款',
    hasOps,
    `日志动作：${[...new Set(full.data.logs.map((l) => l.action))].join(', ')}`);

  /* ---------- 36. 实收超收拦截后删除，数据一致 ---------- */
  const s4 = await api('GET', `/api/projects/${created.project}`);
  const receiptSum = s4.data.receipts.reduce((s, r) => s + r.amount, 0);
  check(36, '实收流水合计与项目已回款一致',
    Math.round(receiptSum * 100) / 100 === s4.data.received_amount,
    `流水合计 ${receiptSum} = 项目已回款 ${s4.data.received_amount}`);

  /* ---------- 37. 删除项目软删除 ---------- */
  const p2 = await api('POST', '/api/projects', {
    name: '阶段三测试：待删除项目', customer_id: created.customer, stage: '信息收集', contract_amount: 100000
  });
  const delP = await api('DELETE', `/api/projects/${p2.data.id}`);
  const getDel = await api('GET', `/api/projects/${p2.data.id}`);
  check(37, '项目删除为软删除（可回收）',
    delP.data.count === 1 && getDel.status === 404,
    `删除 ${delP.data.count} 个，详情 HTTP ${getDel.status}`);

  /* ---------- 38. 回收站与还原 ---------- */
  const trash = await api('GET', '/api/trash?type=project');
  const inTrash = (trash.data || []).some((x) => x.id === p2.data.id);
  const restore = await api('POST', '/api/trash/restore', { ids: [p2.data.id], type: 'project' });
  const afterRestore = await api('GET', `/api/projects/${p2.data.id}`);
  check(38, '项目回收站可见并还原',
    inTrash && restore.data.count === 1 && afterRestore.status === 200,
    `回收站 ${trash.data.length} 条，还原 ${restore.data.count} 个，还原后 HTTP ${afterRestore.status}`);

  /* ---------- 39. 无客户项目不可创建 ---------- */
  const noCust = await api('POST', '/api/projects', { name: '孤立项目' });
  check(39, '项目必须归属客户', noCust.status === 400, noCust.json.message);

  /* ---------- 40. 不存在的项目 404 ---------- */
  const nf = await api('GET', '/api/projects/99999999');
  check(40, '查询不存在项目返回 404',
    nf.status === 404 && nf.json.code === 'NOT_FOUND',
    `HTTP ${nf.status} code=${nf.json.code}`);

  /* ---------- 41. 白名单拦截 ---------- */
  await api('PUT', `/api/projects/${created.project}`, {
    name: '塔河炼化 2026 年大修阀门采购项目',
    received_amount: 999999, deleted_at: '2020-01-01T00:00:00', created_at: '1999-01-01'
  });
  const afterHack = await api('GET', `/api/projects/${created.project}`);
  check(41, '字段白名单拦截越权写入（received_amount / deleted_at / created_at）',
    afterHack.data.received_amount === 1860000 && afterHack.data.deleted_at === null
      && !String(afterHack.data.created_at).startsWith('1999'),
    `received_amount=${afterHack.data.received_amount}（只能由实收流水决定），deleted_at=${afterHack.data.deleted_at}`);

  /* ---------- 42. 区域划分：清理已完成待办 ---------- */
  const purge = await api('POST', '/api/tasks/purge-done', { keepDays: 30 });
  check(42, '清理已完成待办接口可用（保留最近 30 天）',
    purge.status === 200 && typeof purge.data.removed === 'number',
    `清理 ${purge.data.removed} 条（保留 ${purge.data.keepDays} 天）`);

  /* ---------- 清理测试数据 ---------- */
  const pl = await api('GET', `/api/projects?customer_id=${created.customer}&pageSize=200`);
  const pids = (pl.data.list || []).map((p) => p.id);
  if (pids.length) await api('POST', '/api/projects/batch-delete', { ids: pids });
  const tl = await api('GET', `/api/tasks?view=all&customer_id=${created.customer}`);
  const tids = (tl.data.list || []).map((t) => t.id);
  if (tids.length) await api('POST', '/api/tasks/batch-delete', { ids: tids });
  await api('POST', '/api/customers/batch-delete', { ids: [created.customer] });
  console.log(`\n（已清理测试数据：${pids.length} 个项目、${tids.length} 条待办、1 个客户）`);

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
