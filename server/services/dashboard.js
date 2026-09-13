/**
 * 首页总览聚合服务
 *
 * 一次请求返回首页所需的全部数据，避免前端发十几个请求：
 *   - 4 张数字卡（客户数 / 进行中项目 / 本月回款 / 今日待跟进）
 *   - 今日与逾期待跟进客户
 *   - 临期与逾期回款计划
 *   - 招投标日历
 *   - 图表数据（近 6 个月签约与回款趋势、项目阶段分布、下游行业成交额占比、转化漏斗）
 *   - 今日待办、最近动态
 */

'use strict';

const { plainAll, now } = require('../db');

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function today() { return now().slice(0, 10); }

/** 本月第一天 / 上月第一天 */
function monthStart(offset) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + (offset || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`;
}

/** 生成最近 n 个月的键（YYYY-MM） */
function recentMonths(n) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/* ------------------------------------------------------------------ */
/* 总览                                                                */
/* ------------------------------------------------------------------ */

function dashboard(db) {
  const t = today();
  const data = {};

  /* ---------- 1. 数字卡 ---------- */
  const customerTotal = db.prepare(
    'SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL'
  ).get().n;
  const customerNewThisMonth = db.prepare(
    `SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL AND date(created_at) >= ?`
  ).get(monthStart(0)).n;

  const activeProjects = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(contract_amount), 0) AS amount
    FROM projects WHERE deleted_at IS NULL AND stage NOT IN ('已暂停','已终止')
  `).get();

  const thisMonthReceived = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM payments
    WHERE type = '实收' AND actual_date IS NOT NULL AND actual_date <> ''
      AND date(actual_date) >= ? AND date(actual_date) <= ?
  `).get(monthStart(0), t).s;
  const lastMonthReceived = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM payments
    WHERE type = '实收' AND actual_date IS NOT NULL AND actual_date <> ''
      AND date(actual_date) >= ? AND date(actual_date) < ?
  `).get(monthStart(-1), monthStart(0)).s;

  const followToday = db.prepare(`
    SELECT COUNT(*) AS n FROM customers
    WHERE deleted_at IS NULL AND next_follow_at IS NOT NULL AND next_follow_at <> ''
      AND date(next_follow_at) <= ?
  `).get(t).n;
  const followOverdue = db.prepare(`
    SELECT COUNT(*) AS n FROM customers
    WHERE deleted_at IS NULL AND next_follow_at IS NOT NULL AND next_follow_at <> ''
      AND date(next_follow_at) < ?
  `).get(t).n;

  const overduePay = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(remain), 0) AS amount FROM (
      SELECT pm.amount - COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
               WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0) AS remain
      FROM payments pm
      JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
      WHERE pm.type = '计划' AND pm.plan_date IS NOT NULL AND pm.plan_date <> ''
        AND pm.plan_date < date('now','localtime')
        AND pm.amount > COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
          WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0)
    ) WHERE remain > 0
  `).get();

  const totalDebt = db.prepare(`
    SELECT COALESCE(SUM(contract_amount), 0) - COALESCE((
      SELECT SUM(pm.amount) FROM payments pm
      JOIN projects p2 ON p2.id = pm.project_id AND p2.deleted_at IS NULL
      WHERE pm.type = '实收'
    ), 0) AS d
    FROM projects WHERE deleted_at IS NULL
  `).get().d;

  data.cards = {
    customer_total: customerTotal,
    customer_new_this_month: customerNewThisMonth,
    active_projects: activeProjects.n,
    active_contract_amount: round2(activeProjects.amount),
    month_received: round2(thisMonthReceived),
    month_received_prev: round2(lastMonthReceived),
    month_received_delta: lastMonthReceived > 0
      ? Math.round(((thisMonthReceived - lastMonthReceived) / lastMonthReceived) * 1000) / 10
      : (thisMonthReceived > 0 ? 100 : 0),
    follow_today: followToday,
    follow_overdue: followOverdue,
    overdue_payment_count: overduePay.n,
    overdue_payment_amount: round2(overduePay.amount),
    total_debt: round2(totalDebt)
  };

  /* ---------- 2. 今日与逾期待跟进客户 ---------- */
  data.follow_customers = plainAll(db.prepare(`
    SELECT c.id, c.name, c.short_name, c.type, c.industry, c.level, c.status,
           c.next_follow_at, c.last_follow_at, c.follow_count,
           CAST(julianday(date(c.next_follow_at)) - julianday(date('now','localtime')) AS INTEGER) AS days_left,
           (SELECT ct.name FROM contacts ct WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL
              ORDER BY ct.is_primary DESC, ct.id ASC LIMIT 1) AS primary_contact,
           (SELECT ct.mobile FROM contacts ct WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL
              ORDER BY ct.is_primary DESC, ct.id ASC LIMIT 1) AS primary_mobile
    FROM customers c
    WHERE c.deleted_at IS NULL AND c.next_follow_at IS NOT NULL AND c.next_follow_at <> ''
      AND date(c.next_follow_at) <= date('now','localtime')
    ORDER BY c.next_follow_at ASC
    LIMIT 30
  `).all());

  /* ---------- 3. 临期与逾期回款计划 ---------- */
  const payRows = (whereSql) => plainAll(db.prepare(`
    SELECT pm.id, pm.project_id, pm.amount, pm.plan_date, pm.remark,
           p.name AS project_name, p.id AS project_id,
           c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short,
           pm.amount - COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
             WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0) AS remain,
           CAST(julianday(date('now','localtime')) - julianday(pm.plan_date) AS INTEGER) AS days_diff
    FROM payments pm
    JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
    LEFT JOIN customers c ON c.id = pm.customer_id
    ${whereSql}
    ORDER BY pm.plan_date ASC
    LIMIT 30
  `).all());

  data.payment_overdue = payRows(`
    WHERE pm.type = '计划' AND pm.plan_date IS NOT NULL AND pm.plan_date <> ''
      AND pm.plan_date < date('now','localtime')
      AND pm.amount > COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
        WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0)
  `);
  data.payment_upcoming = payRows(`
    WHERE pm.type = '计划' AND pm.plan_date IS NOT NULL AND pm.plan_date <> ''
      AND pm.plan_date >= date('now','localtime')
      AND pm.plan_date <= date('now','localtime','+30 days')
      AND pm.amount > COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
        WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0)
  `);

  /* ---------- 4. 招投标日历 ---------- */
  data.bid_calendar = plainAll(db.prepare(`
    SELECT p.id, p.name, p.stage, p.bid_date, p.bid_result, p.contract_amount,
           p.delivery_date, c.name AS customer_name, c.short_name AS customer_short,
           CAST(julianday(date(p.bid_date)) - julianday(date('now','localtime')) AS INTEGER) AS days_left,
           CASE
             WHEN p.bid_date < date('now','localtime') AND (p.bid_result IS NULL OR p.bid_result = '' OR p.bid_result = '未投标')
               THEN 2
             WHEN p.bid_date >= date('now','localtime') AND p.bid_date <= date('now','localtime','+7 days')
               THEN 1
             ELSE 0
           END AS alert_level
    FROM projects p
    LEFT JOIN customers c ON c.id = p.customer_id
    WHERE p.deleted_at IS NULL AND p.bid_date IS NOT NULL AND p.bid_date <> ''
      AND p.bid_date >= date('now','localtime','-30 days')
      AND p.bid_date <= date('now','localtime','+60 days')
      AND p.stage NOT IN ('已终止')
    ORDER BY p.bid_date ASC
    LIMIT 30
  `).all());

  /* ---------- 5. 图表 ---------- */

  /* 近 6 个月签约额与回款额 */
  const months = recentMonths(6);
  const signRows = db.prepare(`
    SELECT substr(signed_at, 1, 7) AS m, COALESCE(SUM(contract_amount), 0) AS s
    FROM projects
    WHERE deleted_at IS NULL AND signed_at IS NOT NULL AND signed_at <> ''
      AND substr(signed_at, 1, 7) >= ?
    GROUP BY m
  `).all(months[0]);
  const recvRows = db.prepare(`
    SELECT substr(actual_date, 1, 7) AS m, COALESCE(SUM(amount), 0) AS s
    FROM payments
    WHERE type = '实收' AND actual_date IS NOT NULL AND actual_date <> ''
      AND substr(actual_date, 1, 7) >= ?
    GROUP BY m
  `).all(months[0]);
  const signMap = Object.fromEntries(signRows.map((r) => [r.m, r.s]));
  const recvMap = Object.fromEntries(recvRows.map((r) => [r.m, r.s]));

  data.chart_trend = {
    months,
    signed: months.map((m) => round2(signMap[m] || 0)),
    received: months.map((m) => round2(recvMap[m] || 0))
  };

  /* 项目阶段分布（14 阶段，只返回有数据的） */
  data.chart_stages = plainAll(db.prepare(`
    SELECT p.stage AS name, COUNT(*) AS value, COALESCE(SUM(p.contract_amount), 0) AS amount
    FROM projects p WHERE p.deleted_at IS NULL
    GROUP BY p.stage
  `).all()).map((r) => Object.assign(r, { amount: round2(r.amount) }));

  /* 下游行业成交额占比（按已成交阶段项目） */
  const WON = ['已中标/已签约', '生产执行', '发货交付', '安装调试', '验收结项', '质保期内'];
  const marks = WON.map(() => '?').join(', ');
  data.chart_industries = plainAll(db.prepare(`
    SELECT COALESCE(NULLIF(c.industry, ''), '未分类') AS name,
           COUNT(DISTINCT c.id) AS customers,
           COALESCE(SUM(p.contract_amount), 0) AS amount
    FROM projects p
    JOIN customers c ON c.id = p.customer_id
    WHERE p.deleted_at IS NULL AND p.stage IN (${marks})
    GROUP BY COALESCE(NULLIF(c.industry, ''), '未分类')
    HAVING amount > 0
    ORDER BY amount DESC
    LIMIT 12
  `).all(...WON)).map((r) => Object.assign(r, { amount: round2(r.amount) }));

  /* 客户转化漏斗：分别查，避免在相关子查询里引用外层别名造成歧义 */
  const cnt = (sql, ...p) => db.prepare(sql).get(...p).n;
  const wonMarks = WON.map(() => '?').join(', ');
  data.chart_funnel = [
    { name: '建档客户', value: cnt('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL') },
    { name: '已跟进', value: cnt('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL AND follow_count > 0') },
    { name: '有项目', value: cnt('SELECT COUNT(DISTINCT customer_id) AS n FROM projects WHERE deleted_at IS NULL') },
    { name: '已签约', value: cnt('SELECT COUNT(DISTINCT customer_id) AS n FROM projects WHERE deleted_at IS NULL AND contract_amount > 0') },
    { name: '已成交', value: cnt(`SELECT COUNT(DISTINCT customer_id) AS n FROM projects WHERE deleted_at IS NULL AND stage IN (${wonMarks})`, ...WON) }
  ];

  /* ---------- 6. 今日待办 ---------- */
  data.today_tasks = plainAll(db.prepare(`
    SELECT t.id, t.title, t.due_at, t.priority, t.status, t.source,
           t.customer_id, t.project_id,
           c.short_name AS customer_short, p.name AS project_name
    FROM tasks t
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL AND t.status = '待办'
      AND t.due_at IS NOT NULL AND t.due_at <> ''
      AND date(t.due_at) <= date('now','localtime')
    ORDER BY CASE t.priority WHEN '高' THEN 1 WHEN '中' THEN 2 ELSE 3 END,
             t.due_at ASC
    LIMIT 20
  `).all());

  /* ---------- 7. 最近动态 ---------- */
  data.recent_logs = plainAll(db.prepare(`
    SELECT id, entity_type, entity_id, action, summary, created_at
    FROM activity_logs
    ORDER BY id DESC LIMIT 12
  `).all());

  return data;
}

module.exports = { dashboard };
