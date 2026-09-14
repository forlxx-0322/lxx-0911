/**
 * 报价自定义列路由
 *
 * 提供：
 *   - 列清单（含类型、单位、候选值、排序、启用状态）
 *   - 新增 / 修改 / 排序 / 删除
 *
 * 这些列会同时出现在**报价单明细**与**报价模板明细**里；
 * 列删掉后历史数据仍在明细的 extra 字段里，只是不再显示。
 */
'use strict';

const fieldsvc = require('../services/quotation-field');

module.exports = async function quotationFieldRoutes(ctx) {
  const { db, method, pathname, query, body } = ctx;
  const segments = pathname.split('/').filter(Boolean);
  if (segments[1] !== 'quotation-fields') return null;

  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  const sub = segments[2] || '';

  /* 列表 */
  if (!sub && method === 'GET') {
    return ok(fieldsvc.listFields(db, { enabledOnly: query.enabled === '1' }));
  }

  /* 新增 */
  if (!sub && method === 'POST') {
    try {
      return ok(fieldsvc.saveField(db, body || {}));
    } catch (e) {
      return fail(e.status || 400, e.code || 'SAVE_FAILED', e.message);
    }
  }

  const id = sub ? Number(sub) : null;
  if (sub && !Number.isFinite(id)) return fail(400, 'BAD_ID', '列 ID 无效');
  const action = segments[3] || '';

  /* 修改 */
  if (id && !action && (method === 'PUT' || method === 'POST')) {
    try {
      return ok(fieldsvc.saveField(db, Object.assign({}, body || {}, { id })));
    } catch (e) {
      return fail(e.status || 400, e.code || 'SAVE_FAILED', e.message);
    }
  }

  /* 删除（软删除；返回 used_in 便于界面提示"已有 N 张报价单填过这一列"） */
  if (id && !action && method === 'DELETE') {
    try {
      return ok(fieldsvc.removeField(db, id));
    } catch (e) {
      return fail(e.status || 400, e.code || 'DELETE_FAILED', e.message);
    }
  }

  /* 排序 */
  if (id && action === 'move' && method === 'POST') {
    const dir = (body && body.dir) === 'up' ? 'up' : 'down';
    try {
      return ok(fieldsvc.moveField(db, id, dir));
    } catch (e) {
      return fail(e.status || 400, e.code || 'MOVE_FAILED', e.message);
    }
  }

  return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
};
