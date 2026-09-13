/**
 * 项目管理 / 回款 / 待办 接口路由
 *
 * 命名空间：
 *   /api/projects       项目
 *   /api/payments       回款（计划与实收）
 *   /api/tasks          待办
 *   /api/payment-overview  回款总览（逾期与近期）
 */

'use strict';

const pm = require('../services/pm');

function seg(segments, offset) { return segments[offset] || ''; }

function tailId(segments, offset) {
  const v = segments[offset];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = async function pmRoutes(ctx) {
  const { db, method, pathname, query, body } = ctx;
  const segments = pathname.split('/').filter(Boolean);
  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  const root = seg(segments, 1);

  /* ================= 回款总览 ================= */
  if (root === 'payment-overview') {
    if (method === 'GET') return ok(pm.paymentOverview(db, query.days));
    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ================= 回款 ================= */
  if (root === 'payments') {
    if (method === 'GET') return ok(pm.paymentOverview(db, query.days));
    if (method === 'POST') return ok(pm.savePayment(db, body || {}));
    const id = tailId(segments, 2);
    if (id && method === 'DELETE') return ok(pm.deletePayment(db, id));
    if (id && (method === 'PUT' || method === 'PATCH')) {
      return ok(pm.savePayment(db, Object.assign({}, body, { id })));
    }
    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ================= 待办 ================= */
  if (root === 'tasks') {
    const action = seg(segments, 2);

    if (!action && method === 'GET') return ok(pm.listTasks(db, query));
    if (!action && method === 'POST') return ok(pm.saveTask(db, body || {}));

    if (action === 'batch-delete' && method === 'POST') {
      return ok(pm.deleteTasks(db, (body || {}).ids));
    }
    if (action === 'purge-done' && method === 'POST') {
      return ok(pm.purgeDoneTasks(db, (body || {}).keepDays));
    }

    const id = tailId(segments, 2);
    if (id) {
      if (method === 'PUT' || method === 'PATCH') {
        return ok(pm.saveTask(db, Object.assign({}, body, { id })));
      }
      if (method === 'DELETE') return ok(pm.deleteTasks(db, [id]));
      /* 完成 / 取消完成 */
      if (seg(segments, 3) === 'toggle' && method === 'POST') {
        return ok(pm.toggleTask(db, id, (body || {}).done));
      }
    }
    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ================= 项目 ================= */
  if (root === 'projects') {
    const action = seg(segments, 2);

    if (action === 'board' && method === 'GET') {
      return ok(pm.boardProjects(db, query));
    }
    if (action === 'stages' && method === 'GET') {
      return ok({ stages: pm.STAGE_ORDER, active: pm.ACTIVE_STAGES, won: pm.WON_STAGES });
    }
    if (action === 'batch-delete' && method === 'POST') {
      return ok(pm.deleteProjects(db, (body || {}).ids));
    }

    if (!action && method === 'GET') return ok(pm.listProjects(db, query));
    if (!action && method === 'POST') return ok(pm.saveProject(db, body || {}));

    const id = tailId(segments, 2);
    if (id) {
      const sub = seg(segments, 3);

      if (sub === 'move-stage' && method === 'POST') {
        return ok(pm.moveStage(db, id, (body || {}).stage));
      }
      if (sub === 'payments' && method === 'POST') {
        return ok(pm.savePayment(db, Object.assign({}, body, { project_id: id })));
      }
      if (sub === 'tasks' && method === 'POST') {
        return ok(pm.saveTask(db, Object.assign({}, body, { project_id: id })));
      }

      if (!sub && method === 'GET') return ok(pm.getProject(db, id));
      if (!sub && (method === 'PUT' || method === 'PATCH')) {
        return ok(pm.saveProject(db, Object.assign({}, body, { id })));
      }
      if (!sub && method === 'DELETE') return ok(pm.deleteProjects(db, [id]));
    }

    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  return null;
};
