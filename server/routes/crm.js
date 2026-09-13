/**
 * CRM 接口路由
 *
 * 设计：单一入口函数，内部按「精确路径 + 方法」分发。
 * 约定：所有响应经 ctx.ok / ctx.fail 包装，成功为 { ok:true, data }，
 *       失败为 { ok:false, code, message }，错误码取自 Error.code。
 */

'use strict';

const crm = require('../services/crm');
const pm = require('../services/pm');

/** 读取路径中的数字 ID 段：/api/customers/12 → 12 */
function tailId(segments, offset) {
  const v = segments[offset];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function seg(segments, offset) {
  return segments[offset] || '';
}

module.exports = async function crmRoutes(ctx) {
  const { db, method, pathname, query, body } = ctx;
  const segments = pathname.split('/').filter(Boolean); // ['api','customers','12']
  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });

  /* ================= 字典 ================= */
  if (seg(segments, 1) === 'dict') {
    const action = seg(segments, 2);

    if (!action && method === 'GET') {
      /* 管理页需要看到已停用项（用于重新启用），表单下拉只认启用中的项 */
      const rawAll = crm.readDict(db, true);
      const rawEnabled = crm.readDict(db, false);
      const enabledSet = {};
      for (const [cat, arr] of Object.entries(rawEnabled)) enabledSet[cat] = arr.map((x) => x.value);
      const options = {};   // 分类 → 启用中的选项文本数组（表单下拉直接用）
      const items = {};     // 分类 → 全部选项（含 enabled 标记，字典管理页用）
      for (const [cat, arr] of Object.entries(rawAll)) {
        options[cat] = enabledSet[cat] || [];
        items[cat] = arr;
      }
      return ok({ options, items, categories: Object.keys(rawAll) });
    }

    if (!action && method === 'POST') {
      const { category, value, color } = body || {};
      return ok(crm.quickAddDict(db, category, value, { color, forceNew: true }));
    }

    if (action === 'quick-add' && method === 'POST') {
      const { category, value, color } = body || {};
      return ok(crm.quickAddDict(db, category, value, { color }));
    }

    if (action === 'usage' && method === 'GET') {
      return ok({ count: crm.countDictUsage(db, query.category, query.value) });
    }

    const did = tailId(segments, 2);
    if (did) {
      if (method === 'PUT' || method === 'PATCH') return ok(crm.updateDict(db, did, body || {}));
      if (method === 'DELETE') return ok(crm.deleteDict(db, did));
    }

    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ================= 标签 ================= */
  if (seg(segments, 1) === 'tags') {
    if (method === 'GET') return ok(crm.listTags(db));
    if (method === 'POST') return ok(crm.saveTag(db, body || {}));
    if (method === 'DELETE') {
      const id = tailId(segments, 2) || Number((body || {}).id);
      if (!id) return fail(400, 'BAD_REQUEST', '缺少标签 ID');
      return ok(crm.deleteTag(db, id));
    }
    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ================= 联系人 ================= */
  if (seg(segments, 1) === 'contacts') {
    if (method === 'POST') return ok(crm.saveContact(db, body || {}));
    if (method === 'DELETE') {
      const id = tailId(segments, 2) || Number((body || {}).id);
      if (!id) return fail(400, 'BAD_REQUEST', '缺少联系人 ID');
      return ok(crm.deleteContact(db, id));
    }
    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ================= 跟进记录 ================= */
  if (seg(segments, 1) === 'followups') {
    if (method === 'POST') return ok(crm.saveFollowup(db, body || {}));
    if (method === 'DELETE') {
      const id = tailId(segments, 2) || Number((body || {}).id);
      if (!id) return fail(400, 'BAD_REQUEST', '缺少跟进记录 ID');
      return ok(crm.deleteFollowup(db, id));
    }
    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ================= 回收站 ================= */
  if (seg(segments, 1) === 'trash') {
    if (method === 'GET') return ok(crm.listTrash(db, query.type));
    if (method === 'POST' && seg(segments, 2) === 'restore') {
      const ids = (body || {}).ids;
      const type = (body || {}).type || query.type || 'customer';
      if (!ids || !ids.length) return fail(400, 'BAD_REQUEST', '未选中要还原的记录');
      if (type === 'project') return ok(pm.restoreProjects(db, ids));
      return ok(crm.restoreCustomers(db, ids));
    }
    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ================= 客户 ================= */
  if (seg(segments, 1) === 'customers') {
    const action = seg(segments, 2);

    /* 查重 */
    if (action === 'check-duplicate' && method === 'GET') {
      return ok(crm.findDuplicates(db, query.name || '', query.phone || '',
        query.excludeId ? Number(query.excludeId) : null));
    }

    /* 批量操作 */
    if (action === 'bulk' && method === 'POST') {
      const { ids, type, value, tag_id } = body || {};
      return ok(crm.bulkUpdate(db, ids, { type, value, tag_id }));
    }

    /* 批量删除 */
    if (action === 'batch-delete' && method === 'POST') {
      return ok(crm.deleteCustomers(db, (body || {}).ids));
    }

    /* 列表 */
    if (!action && method === 'GET') {
      return ok(crm.listCustomers(db, query));
    }

    /* 新增 */
    if (!action && method === 'POST') {
      return ok(crm.saveCustomer(db, body || {}));
    }

    /* 单条操作 */
    const id = tailId(segments, 2);
    if (id) {
      if (method === 'GET') return ok(crm.getCustomer(db, id));
      if (method === 'PUT' || method === 'PATCH') {
        return ok(crm.saveCustomer(db, Object.assign({}, body, { id })));
      }
      if (method === 'DELETE') return ok(crm.deleteCustomers(db, [id]));

      /* 子资源 */
      if (seg(segments, 3) === 'followups' && method === 'POST') {
        return ok(crm.saveFollowup(db, Object.assign({}, body, { customer_id: id })));
      }
      if (seg(segments, 3) === 'contacts' && method === 'POST') {
        return ok(crm.saveContact(db, Object.assign({}, body, { customer_id: id })));
      }
    }

    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  return null; // 未命中，交回主路由
};
