/**
 * 报价单路由
 *
 * 提供：
 *   - 按项目 / 按客户查询报价单
 *   - 报价单详情（含明细行与版本链）
 *   - 新建 / 修改 / 复制新版本 / 改状态 / 中标回填 / 删除
 *   - 导出数据结构（前端 SheetJS 生成 Excel 单据）
 *   - 报价单状态字典项
 *
 * 金额一律由服务端计算（见 services/quotation.js）。
 */
'use strict';

const quotation = require('../services/quotation');

module.exports = async function quotationRoutes(ctx) {
  const { db, method, pathname, query, body, getSettings } = ctx;
  const segments = pathname.split('/').filter(Boolean);
  if (segments[1] !== 'quotations') return null;

  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  const settings = getSettings();

  /* /api/quotations/statuses —— 可选状态清单 */
  if (segments[2] === 'statuses' && method === 'GET') {
    return ok({ list: quotation.STATUSES, terminal: quotation.TERMINAL });
  }

  /* /api/quotations/status-counts —— 各状态单数（供列表页筛选标签） */
  if (segments[2] === 'status-counts' && method === 'GET') {
    return ok(quotation.statusCounts(db));
  }

  /* /api/quotations/overview —— 跨项目总列表（供独立「报价单」页） */
  if (segments[2] === 'overview' && method === 'GET') {
    return ok(quotation.listAll(db, {
      status: query.status,
      project_id: query.project_id,
      customer_id: query.customer_id,
      date_from: query.date_from,
      date_to: query.date_to,
      q: query.q,
      sort: query.sort,
      page: query.page,
      pageSize: query.pageSize
    }));
  }

  /* /api/quotations/:id 及其子动作 */
  const id = segments[2] ? Number(segments[2]) : null;
  const action = segments[3] || '';

  if (id && !Number.isFinite(id)) return fail(400, 'BAD_ID', '报价单 ID 无效');

  /* 详情 */
  if (id && !action && method === 'GET') {
    const r = quotation.getOne(db, id);
    return r ? ok(r) : fail(404, 'NOT_FOUND', '报价单不存在或已删除');
  }

  /* 修改 */
  if (id && !action && (method === 'PUT' || method === 'POST')) {
    try {
      return ok(quotation.saveQuotation(db, Object.assign({}, body || {}, { id }), settings));
    } catch (e) {
      return fail(e.status || 400, e.code || 'SAVE_FAILED', e.message);
    }
  }

  /* 删除（软删除，进回收站） */
  if (id && !action && method === 'DELETE') {
    try {
      return ok(quotation.removeQuotation(db, id));
    } catch (e) {
      return fail(e.status || 400, e.code || 'DELETE_FAILED', e.message);
    }
  }

  /* 复制为新版本 */
  if (id && action === 'copy' && method === 'POST') {
    try {
      return ok(quotation.copyAsNewVersion(db, id));
    } catch (e) {
      return fail(e.status || 400, e.code || 'COPY_FAILED', e.message);
    }
  }

  /* 改状态（终态时返回是否可回填项目的提示，不静默改项目） */
  if (id && action === 'status' && method === 'POST') {
    const p = body || {};
    if (!p.status) return fail(400, 'STATUS_REQUIRED', '请提供 status');
    try {
      return ok(quotation.setStatus(db, id, p.status, p));
    } catch (e) {
      return fail(e.status || 400, e.code || 'STATUS_FAILED', e.message);
    }
  }

  /* 中标回填项目（必须由界面二次确认后调用） */
  if (id && action === 'apply-to-project' && method === 'POST') {
    try {
      return ok(quotation.applyToProject(db, id));
    } catch (e) {
      return fail(e.status || 400, e.code || 'APPLY_FAILED', e.message);
    }
  }

  /* 导出数据结构（前端生成 xlsx 单据） */
  if (id && action === 'export' && (method === 'GET' || method === 'POST')) {
    const r = quotation.exportData(db, id, settings);
    return r ? ok(r) : fail(404, 'NOT_FOUND', '报价单不存在或已删除');
  }

  /* 新建 */
  if (!id && method === 'POST') {
    try {
      return ok(quotation.saveQuotation(db, body || {}, settings));
    } catch (e) {
      return fail(e.status || 400, e.code || 'SAVE_FAILED', e.message);
    }
  }

  /* 列表：/api/quotations?project_id=1 或 ?customer_id=1 */
  if (!id && method === 'GET') {
    if (query.project_id) return ok(quotation.listByProject(db, query.project_id));
    if (query.customer_id) return ok(quotation.listByCustomer(db, query.customer_id));
    return fail(400, 'PARAM_REQUIRED', '请提供 project_id 或 customer_id');
  }

  return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
};
