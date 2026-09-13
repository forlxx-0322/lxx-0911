/**
 * 招标信息采集接口路由
 *
 * 路径（全部挂在 /api/collect 下）：
 *   GET    /api/collect/summary              采集总览（来源数/待审核/已入库/下次采集时间）
 *   GET    /api/collect/sources              来源列表（凭据只回显"是否已配置"）
 *   POST   /api/collect/sources              新增来源
 *   PUT    /api/collect/sources/:id          修改来源（pass 留空表示不改凭据）
 *   DELETE /api/collect/sources/:id          删除来源
 *   POST   /api/collect/sources/:id/test     测试连接（只连邮箱读一次，不写库）
 *   POST   /api/collect/run                  立即采集（仍受 24 小时节流约束）
 *   GET    /api/collect/staging              暂存区列表（待审核）
 *   GET    /api/collect/staging/:id          暂存详情
 *   POST   /api/collect/staging/:id/review   审核：approve 入正式库 / reject 忽略
 *   POST   /api/collect/staging/reject-batch 批量忽略
 *   GET    /api/collect/logs                 采集审计日志
 *   GET    /api/collect/providers            常用邮箱服务商预设（含授权码获取提示）
 *
 * 合规说明：采集是唯一会联网的模块，默认关闭；全部来源初始 enabled=0。
 */

'use strict';

const collect = require('../collect/service.js');
const { PROVIDERS } = require('../collect/imap.js');

function tailId(segments, offset) {
  const v = segments[offset];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function seg(segments, offset) {
  return segments[offset] || '';
}

module.exports = async function collectRoutes(ctx) {
  const { db, method, pathname, query, body } = ctx;
  const segments = pathname.split('/').filter(Boolean);   // ['api','collect','sources','3']
  if (seg(segments, 0) !== 'api' || seg(segments, 1) !== 'collect') return null;

  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  const action = seg(segments, 2);
  const id = tailId(segments, 3);
  const sub = seg(segments, 4);

  /* ---------------- 总览 ---------------- */
  if ((action === 'summary' || !action) && method === 'GET') {
    return ok(collect.collectSummary(db));
  }

  /* ---------------- 服务商预设 ---------------- */
  if (action === 'providers' && method === 'GET') {
    return ok(Object.entries(PROVIDERS).map(([key, v]) => ({
      key, label: v.label, host: v.host, port: v.port, hint: v.hint
    })));
  }

  /* ---------------- 来源管理 ---------------- */
  if (action === 'sources') {
    if (!id && method === 'GET') {
      return ok(collect.listSources(db));
    }
    if (!id && method === 'POST') {
      return ok(collect.saveSource(db, body || {}));
    }
    if (id && (method === 'PUT' || method === 'PATCH')) {
      return ok(collect.saveSource(db, Object.assign({}, body, { id })));
    }
    if (id && method === 'DELETE') {
      return ok(collect.deleteSource(db, id));
    }
    /* 测试连接：只读，不写暂存区 */
    if (id && sub === 'test' && method === 'POST') {
      const r = await collect.runCollect(db, { sourceId: id, force: true, dryRun: true, timeout: 20000 });
      const res = (r.results || [])[0] || {};
      if (res.status === 'ok') {
        return ok({
          connected: true,
          message: res.message || '连接成功',
          mails: res.mails || 0,
          mailbox: (collect.readSourceFull(db, id) || {}).cfg
            ? collect.readSourceFull(db, id).cfg.mailbox : ''
        });
      }
      /* 测试连接失败不抛错，而是回一个明确结果，便于界面展示原因 */
      return fail(400, 'CONNECT_FAILED', res.message || '连接失败');
    }
    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ---------------- 立即采集 ---------------- */
  if (action === 'run' && method === 'POST') {
    const p = body || {};
    /* 界面上的「立即采集」仍受 24 小时节流约束（附录 A.7）；
       只有本机显式传 ignoreInterval 才允许强制，避免被脚本无节制触发。 */
    const ip = (ctx.req && ctx.req.socket && ctx.req.socket.remoteAddress) || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const r = await collect.runCollect(db, {
      sourceId: p.source_id ? Number(p.source_id) : null,
      force: p.ignoreInterval === true && isLocal,
      timeout: Number(p.timeout) || 40000
    });
    return ok(r);
  }

  /* ---------------- 暂存区 ---------------- */
  if (action === 'staging') {
    if (!id && method === 'GET') {
      return ok(collect.listStaging(db, query));
    }
    if (id && method === 'GET') {
      return ok(collect.getStaging(db, id));
    }
    if (id && sub === 'review' && method === 'POST') {
      return ok(collect.reviewStaging(db, Object.assign({}, body, { id })));
    }
    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* 批量忽略：/api/collect/staging-reject */
  if (action === 'staging-reject' && method === 'POST') {
    const p = body || {};
    return ok(collect.rejectStaging(db, p.ids, p.reason));
  }

  /* ---------------- 审计日志 ---------------- */
  if (action === 'logs' && method === 'GET') {
    return ok(collect.listLogs(db, query));
  }

  return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
};
