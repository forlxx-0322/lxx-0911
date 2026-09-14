/**
 * 提醒服务 —— 客户跟进提醒
 *
 * 职责：
 *   1. 计算"该提醒谁"（纯查询，无副作用）
 *   2. 生成提醒邮件正文（HTML，内联样式，不引用任何外部资源）
 *
 * 设计要点：
 *   - 只读：本模块不写任何业务数据，可随时调用
 *   - 分级：逾期 / 今天 / 临近，便于界面按紧急度排序与折叠
 *   - 软件内提醒是主路径，邮件是可选增强（默认关闭，见 notify/ 目录）
 *
 * 关于"哪些客户需要跟进"的口径：
 *   next_follow_at 有值，且日期 ≤ 今天 + follow_remind_days（默认 3 天），
 *   且客户未删除、状态不是终态（已成交 / 已流失）。
 */
'use strict';

const plain = (r) => (r === undefined || r === null ? r : Object.assign({}, r));
const plainAll = (rows) => (rows || []).map(plain);

/** 视为"无需再催跟进"的终态客户状态 */
const CLOSED_STATUS = ['已成交', '已流失', '已放弃'];

/**
 * 计算某天的日期字符串（本地时区，YYYY-MM-DD）
 * 不用 toISOString()，避免被 UTC 偏移带偏一天。
 */
function ymd(date) {
  const d = date || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 在给定日期上加天数 */
function addDays(base, days) {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/** 两个 YYYY-MM-DD 之间相差几天（b - a） */
function diffDays(a, b) {
  const pa = parseYmd(a);
  const pb = parseYmd(b);
  if (!pa || !pb) return null;
  return Math.round((pb.getTime() - pa.getTime()) / 86400000);
}

/** 解析 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss */
function parseYmd(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * 当前时间点是否处于"允许弹提醒"的时段内。
 * 用于：过了安静时间就不再弹新提醒（但角标仍显示条数）。
 */
function inRemindWindow(settings, now) {
  const d = now || new Date();
  const cur = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const start = String(settings.follow_remind_time || '09:00');
  const quiet = String(settings.follow_remind_quiet || '18:00');
  if (!start || !quiet) return true;
  return cur >= start && cur <= quiet;
}

/**
 * 待跟进提醒清单。
 *
 * @param {object} db
 * @param {object} settings  来自 getSettings()
 * @param {object} [opts]    { now: Date, ignoreWindow: boolean }
 * @returns {{ items:Array, counts:object, window:object, generated_at:string }}
 */
function dueFollowups(db, settings, opts) {
  const o = opts || {};
  const now = o.now instanceof Date ? o.now : new Date();
  const today = ymd(now);
  const days = Number(settings.follow_remind_days);
  const lead = Number.isFinite(days) && days >= 0 ? days : 3;
  const until = ymd(addDays(now, lead));

  const rows = plainAll(db.prepare(`
    SELECT c.id, c.name, c.short_name, c.level, c.status, c.owner,
           c.next_follow_at, c.last_follow_at, c.follow_count,
           c.phone, c.city,
           (SELECT ct.name FROM contacts ct
              WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL
              ORDER BY ct.is_primary DESC, ct.id ASC LIMIT 1) AS primary_contact,
           (SELECT ct.mobile FROM contacts ct
              WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL
              ORDER BY ct.is_primary DESC, ct.id ASC LIMIT 1) AS primary_mobile
    FROM customers c
    WHERE c.deleted_at IS NULL
      AND c.next_follow_at IS NOT NULL
      AND trim(c.next_follow_at) <> ''
      AND date(c.next_follow_at) <= date(?)
    ORDER BY date(c.next_follow_at) ASC, c.id ASC
  `).all(until));

  const items = [];
  for (const r of rows) {
    /* 终态客户不再催跟进 */
    if (CLOSED_STATUS.includes(String(r.status || '').trim())) continue;

    const daysLeft = diffDays(today, r.next_follow_at);
    if (daysLeft === null) continue;

    /* 分级：逾期红 / 今天橙 / 临近灰 */
    let level = 'soon';
    if (daysLeft < 0) level = 'overdue';
    else if (daysLeft === 0) level = 'today';

    items.push({
      type: 'follow',
      customer_id: r.id,
      name: r.name,
      short_name: r.short_name || r.name,
      level,
      customer_level: r.level || '',
      status: r.status || '',
      owner: r.owner || '',
      next_follow_at: String(r.next_follow_at).slice(0, 16),
      last_follow_at: r.last_follow_at || '',
      follow_count: r.follow_count || 0,
      days_left: daysLeft,
      days_text: daysLeft < 0 ? `逾期 ${Math.abs(daysLeft)} 天`
        : (daysLeft === 0 ? '今天' : `${daysLeft} 天后`),
      contact: r.primary_contact || '',
      mobile: r.primary_mobile || r.phone || '',
      city: r.city || ''
    });
  }

  /* 排序：逾期最久的在前，其次今天，再次临近 */
  items.sort((a, b) => {
    const rank = { overdue: 0, today: 1, soon: 2 };
    if (rank[a.level] !== rank[b.level]) return rank[a.level] - rank[b.level];
    return a.days_left - b.days_left;
  });

  const counts = {
    total: items.length,
    overdue: items.filter((i) => i.level === 'overdue').length,
    today: items.filter((i) => i.level === 'today').length,
    soon: items.filter((i) => i.level === 'soon').length
  };

  return {
    items,
    counts,
    window: {
      lead_days: lead,
      remind_time: settings.follow_remind_time || '09:00',
      quiet_time: settings.follow_remind_quiet || '18:00',
      on_start: String(settings.follow_remind_on_start) !== '0',
      in_window: inRemindWindow(settings, now),
      allow_popup: o.ignoreWindow === true ? true : inRemindWindow(settings, now)
    },
    today,
    generated_at: new Date().toISOString()
  };
}

/**
 * 生成提醒邮件的 HTML 正文。
 *
 * 约束：
 *   - 全部内联样式，不引用任何外部图片/样式表（与软件本身一样不依赖外部资源）
 *   - 不包含任何非本系统数据；客户名与联系方式来自用户自己的库
 *   - 无待提醒项时返回 null，调用方据此决定"不发信"
 */
function buildEmail(data, settings) {
  const items = (data && data.items) || [];
  if (!items.length) return null;

  const esc = (s) => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const company = settings.company_name || '客户管理系统';
  const GROUP = [
    { level: 'overdue', title: '已逾期', color: '#dc2626', bg: '#fef2f2' },
    { level: 'today', title: '今天要跟进', color: '#ea580c', bg: '#fff7ed' },
    { level: 'soon', title: '临近跟进', color: '#64748b', bg: '#f8fafc' }
  ];

  let body = '';
  for (const g of GROUP) {
    const list = items.filter((i) => i.level === g.level);
    if (!list.length) continue;
    body += `<h3 style="margin:18px 0 8px;font-size:15px;color:${g.color}">`
      + `${esc(g.title)}（${list.length}）</h3>`;
    body += `<table cellpadding="0" cellspacing="0" border="0" `
      + `style="width:100%;border-collapse:collapse;font-size:14px">`;
    for (const it of list) {
      body += `<tr>`
        + `<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;background:${g.bg}">`
        + `<div style="font-weight:600;color:#0f172a">${esc(it.short_name)}</div>`
        + `<div style="color:#64748b;font-size:12px;margin-top:2px">`
        + `${esc(it.name)}</div>`
        + (it.contact || it.mobile
          ? `<div style="color:#64748b;font-size:12px;margin-top:2px">`
            + `${esc(it.contact)}${it.contact && it.mobile ? ' · ' : ''}${esc(it.mobile)}</div>`
          : '')
        + `</td>`
        + `<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;background:${g.bg};`
        + `text-align:right;white-space:nowrap">`
        + `<span style="color:${g.color};font-weight:600">${esc(it.days_text)}</span>`
        + `<div style="color:#94a3b8;font-size:12px;margin-top:2px">计划 ${esc(it.next_follow_at)}</div>`
        + (it.follow_count ? `<div style="color:#94a3b8;font-size:12px">已跟进 ${it.follow_count} 次</div>` : '')
        + `</td></tr>`;
    }
    body += `</table>`;
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>客户跟进提醒</title></head>
<body style="margin:0;padding:0;background:#f1f5f9">
<div style="max-width:640px;margin:0 auto;padding:20px">
  <div style="background:#ffffff;border-radius:10px;padding:22px 24px;
              font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#0f172a">
    <h2 style="margin:0 0 4px;font-size:18px">客户跟进提醒</h2>
    <div style="color:#64748b;font-size:13px">
      ${esc(data.today)} · 共 ${data.counts.total} 位客户待跟进
      （逾期 ${data.counts.overdue}、今天 ${data.counts.today}、临近 ${data.counts.soon}）
    </div>
    ${body}
    <div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;
                color:#94a3b8;font-size:12px;line-height:1.7">
      本邮件由「${esc(company)}」本地软件发出，数据未离开你的电脑。<br>
      如需关闭，请打开软件 →「功能设置 → 提醒与偏好」关闭邮件提醒。
    </div>
  </div>
</div>
</body></html>`;

  const text = [
    `客户跟进提醒（${data.today}）`,
    `共 ${data.counts.total} 位：逾期 ${data.counts.overdue}、今天 ${data.counts.today}、临近 ${data.counts.soon}`,
    '',
    ...items.map((it) => `· [${it.days_text}] ${it.name}${it.mobile ? ' ' + it.mobile : ''}`),
    '',
    '由本地软件发出，数据未离开你的电脑。'
  ].join('\n');

  return {
    subject: `客户跟进提醒 ${data.today}（${data.counts.total} 位）`,
    html,
    text,
    count: data.counts.total
  };
}

module.exports = {
  dueFollowups,
  buildEmail,
  inRemindWindow,
  ymd,
  addDays,
  diffDays,
  CLOSED_STATUS
};
