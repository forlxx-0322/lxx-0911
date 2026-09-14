/**
 * 报价模板路由
 *
 * 提供：
 *   - 模板列表（含行数、类别清单）
 *   - 模板详情（含明细行）
 *   - 新建 / 修改 / 排序 / 删除
 *   - 从报价单沉淀为模板
 *   - 套用模板（返回可直接插入报价单的明细行，**不写库**）
 *
 * 模板**不含价格**：单价随项目与行情变，套用后由使用者填写。
 */
'use strict';

const tpl = require('../services/quotation-template');

module.exports = async function quotationTemplateRoutes(ctx) {
  const { db, method, pathname, query, body } = ctx;
  const segments = pathname.split('/').filter(Boolean);
  if (segments[1] !== 'quotation-templates') return null;

  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  const sub = segments[2] || '';

  /* 从报价单沉淀为模板：/api/quotation-templates/from-quotation/:qid */
  if (sub === 'from-quotation' && method === 'POST') {
    const qid = Number(segments[3]);
    if (!Number.isFinite(qid)) return fail(400, 'BAD_ID', '报价单 ID 无效');
    try {
      return ok(tpl.saveFromQuotation(db, qid, body || {}));
    } catch (e) {
      return fail(e.status || 400, e.code || 'SAVE_FAILED', e.message);
    }
  }

  /* 列表 */
  if (!sub && method === 'GET') {
    return ok(tpl.listTemplates(db, {
      category: query.category,
      keyword: query.q,
      enabledOnly: query.enabledOnly === '1'
    }));
  }

  /* 新建 */
  if (!sub && method === 'POST') {
    try {
      return ok(tpl.saveTemplate(db, body || {}));
    } catch (e) {
      return fail(e.status || 400, e.code || 'SAVE_FAILED', e.message);
    }
  }

  const id = sub ? Number(sub) : null;
  if (sub && !Number.isFinite(id)) return fail(400, 'BAD_ID', '模板 ID 无效');
  const action = segments[3] || '';

  /* 详情 */
  if (id && !action && method === 'GET') {
    const r = tpl.getTemplate(db, id);
    return r ? ok(r) : fail(404, 'NOT_FOUND', '模板不存在或已删除');
  }

  /* 修改 */
  if (id && !action && (method === 'PUT' || method === 'POST')) {
    try {
      return ok(tpl.saveTemplate(db, Object.assign({}, body || {}, { id })));
    } catch (e) {
      return fail(e.status || 400, e.code || 'SAVE_FAILED', e.message);
    }
  }

  /* 删除 */
  if (id && !action && method === 'DELETE') {
    try {
      return ok(tpl.removeTemplate(db, id));
    } catch (e) {
      return fail(e.status || 400, e.code || 'DELETE_FAILED', e.message);
    }
  }

  /* 排序 */
  if (id && action === 'move' && method === 'POST') {
    const dir = (body && body.dir) === 'up' ? 'up' : 'down';
    try {
      return ok(tpl.moveTemplate(db, id, dir));
    } catch (e) {
      return fail(e.status || 400, e.code || 'MOVE_FAILED', e.message);
    }
  }

  /* 套用（返回明细行，不写库） */
  if (id && action === 'apply' && method === 'POST') {
    try {
      return ok(tpl.applyTemplate(db, id));
    } catch (e) {
      return fail(e.status || 400, e.code || 'APPLY_FAILED', e.message);
    }
  }

  return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
};
