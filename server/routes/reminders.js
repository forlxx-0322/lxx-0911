/**
 * 提醒路由
 *
 * 提供：
 *   - 待跟进提醒清单（软件内提醒的数据源）
 *   - 提醒设置读取 / 保存
 *   - 邮件通道状态、测试发送、立即发送
 *
 * 安全约束：
 *   - 授权码（smtp_pass）只返回"是否已配置"，绝不回传明文
 *   - 邮件相关接口在未启用邮件时不会发起任何网络连接
 */
'use strict';

const reminders = require('../services/reminders');
const notify = require('../notify');

module.exports = async function remindersRoutes(ctx) {
  const { db, method, pathname, body, getSettings } = ctx;
  const segments = pathname.split('/').filter(Boolean);
  if (segments[1] !== 'reminders') return null;

  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  const sub = segments[2] || '';
  const settings = getSettings();

  /* ---------- 待跟进提醒清单 ---------- */
  if (sub === 'due' && method === 'GET') {
    try {
      return ok(reminders.dueFollowups(db, settings));
    } catch (e) {
      return fail(500, 'REMIND_FAILED', '计算提醒失败：' + e.message);
    }
  }

  /* ---------- 提醒相关设置（读取） ---------- */
  if (sub === 'settings' && method === 'GET') {
    return ok(notify.readRemindSettings(db));
  }

  /* ---------- 提醒相关设置（保存） ---------- */
  if (sub === 'settings' && (method === 'PUT' || method === 'POST')) {
    const payload = body || {};
    try {
      return ok(notify.saveRemindSettings(db, payload));
    } catch (e) {
      return fail(400, 'BAD_SETTINGS', e.message);
    }
  }

  /* ---------- 邮件通道状态 ---------- */
  if (sub === 'email-status' && method === 'GET') {
    return ok(notify.emailStatus(db));
  }

  /* ---------- 测试发送 ---------- */
  if (sub === 'test-email' && method === 'POST') {
    const r = await notify.sendTestEmail(db, getSettings());
    if (!r.ok) return fail(r.status || 400, r.code || 'EMAIL_FAILED', r.message);
    return ok(r.data);
  }

  /* ---------- 立即发送当日提醒 ---------- */
  if (sub === 'send-now' && method === 'POST') {
    const r = await notify.sendDailyReminder(db, getSettings(), { force: true });
    if (!r.ok) return fail(r.status || 400, r.code || 'EMAIL_FAILED', r.message);
    return ok(r.data);
  }

  return null;
};
