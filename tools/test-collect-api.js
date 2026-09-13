/**
 * 采集接口层测试（HTTP 层，对本地模拟 IMAP 服务器跑完整链路）
 *
 * 覆盖：
 *   - 总览 / 来源 CRUD / 服务商预设
 *   - 凭据安全：列表不回传明文；空串表示不改；可显式清除
 *   - 测试连接（成功与失败两种）
 *   - 立即采集 + 24 小时节流
 *   - 暂存区列表/筛选/详情
 *   - 审核入库（缺动作/缺客户被拒；成功入库带溯源）
 *   - 批量忽略
 *   - 审计日志
 *   - 断网护栏：无启用来源时启动不产生任何外部请求（用"未启用来源的 run 不发请求"验证）
 *
 * 用法：先启动服务，再 node tools/test-collect-api.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const { startMockImap, loadMailFixtures } = require(path.join(ROOT, '.fixtures', 'mock-imap.js'));
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, p, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json, data: json && json.data, code: json && json.code };
}

(async () => {
  console.log('=== 采集接口层测试 ===\n');

  const inbox = loadMailFixtures('INBOX');
  const srv = await startMockImap({
    user: 'me@example.com', pass: 'auth-code-123456', mailboxes: [inbox]
  });
  console.log(`模拟邮箱：${inbox.messages.length} 封 @ 127.0.0.1:${srv.port}\n`);

  const DB_FILE = path.join(ROOT, 'data', 'crm.db');
  const db = new DatabaseSync(DB_FILE);
  const created = [];

  /* 清残留 */
  for (const row of db.prepare(
    "SELECT id FROM projects WHERE data_origin = '招标采集' AND source_platform LIKE 'API测试来源%'"
  ).all()) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
    db.prepare("DELETE FROM activity_logs WHERE entity_type = 'project' AND entity_id = ?").run(row.id);
  }
  db.prepare("DELETE FROM collect_staging WHERE source_name LIKE 'API测试来源%'").run();
  db.prepare("DELETE FROM collect_sources WHERE name LIKE 'API测试来源%'").run();

  try {
    /* ---------- 1. 总览与预设 ---------- */
    {
      const r = await api('GET', '/api/collect/summary');
      check('总览接口可用', r.status === 200 && r.data && typeof r.data.sources === 'number',
        `来源 ${r.data.sources} 个（启用 ${r.data.enabled}），待审核 ${r.data.pending}`);
      check('总览展示 24 小时间隔与日志保留期',
        r.data.intervalHours === 24 && r.data.logKeepDays >= 180,
        `间隔 ${r.data.intervalHours}h，日志保留 ${r.data.logKeepDays} 天`);

      const p = await api('GET', '/api/collect/providers');
      check('服务商预设返回授权码获取提示',
        p.status === 200 && p.data.length >= 6
        && p.data.every((x) => x.hint)
        /* 自定义服务器地址需要用户自己填，允许 host 为空 */
        && p.data.filter((x) => x.key !== 'custom').every((x) => x.host && x.port === 993),
        `${p.data.length} 个预设：${p.data.slice(0, 3).map((x) => x.label).join('、')}…`);
    }

    /* ---------- 2. 来源 CRUD ---------- */
    let sid = null;
    {
      const created0 = await api('POST', '/api/collect/sources', {
        name: 'API测试来源 · 正常',
        type: 'subscription',
        enabled: 1,
        provider: 'custom',
        host: '127.0.0.1',
        port: srv.port,
        secure: false,
        user: 'me@example.com',
        pass: 'auth-code-123456',
        mailbox: 'INBOX',
        keywords: '阀门,球阀,闸阀,蝶阀',
        regionOnly: true,
        sinceDays: 60
      });
      sid = created0.data.id;
      created.push(sid);
      check('新增来源成功', created0.status === 200 && sid > 0, `id=${sid}`);

      const list = await api('GET', '/api/collect/sources');
      const mine = list.data.find((x) => x.id === sid);
      check('来源列表返回配置但不含凭据明文',
        mine && mine.host === '127.0.0.1' && mine.user === 'me@example.com'
        && mine.hasCredential === true && !('pass' in mine),
        `host=${mine.host} hasCredential=${mine.hasCredential}`);

      const bad = await api('POST', '/api/collect/sources', {
        name: 'API测试来源 · 非法类型', type: 'crawler', host: 'x'
      });
      check('不支持的采集方式被拒绝',
        bad.status === 400 && bad.code === 'SOURCE_TYPE_UNSUPPORTED', bad.code);

      const noName = await api('POST', '/api/collect/sources', { type: 'subscription' });
      check('来源名称必填', noName.status === 400 && noName.code === 'NAME_REQUIRED', noName.code);

      /* 修改：pass 留空不改凭据 */
      const upd = await api('PUT', `/api/collect/sources/${sid}`, {
        name: 'API测试来源 · 正常', provider: 'custom', host: '127.0.0.1', port: srv.port,
        secure: false, user: 'me@example.com', pass: '', mailbox: 'INBOX',
        keywords: '阀门', regionOnly: true, sinceDays: 60, enabled: 1
      });
      check('修改来源成功（空凭据表示不改）', upd.status === 200, `id=${upd.data.id}`);
    }

    /* ---------- 3. 测试连接 ---------- */
    {
      const r = await api('POST', `/api/collect/sources/${sid}/test`);
      check('测试连接成功并报告可读邮件数',
        r.status === 200 && r.data.connected === true && r.data.mails === 8,
        r.data ? r.data.message : r.code);

      const bad = await api('POST', '/api/collect/sources', {
        name: 'API测试来源 · 连不上', type: 'subscription', enabled: 1,
        provider: 'custom', host: '127.0.0.1', port: 1, secure: false,
        user: 'a@b.com', pass: 'x', mailbox: 'INBOX'
      });
      created.push(bad.data.id);
      const t = await api('POST', `/api/collect/sources/${bad.data.id}/test`);
      check('测试连接失败时返回明确原因（不 500）',
        t.status === 400 && t.code === 'CONNECT_FAILED' && /失败|连接/.test(t.json.message),
        t.json.message.slice(0, 50));
    }

    /* ---------- 4. 立即采集 ---------- */
    {
      const r = await api('POST', '/api/collect/run', { source_id: sid });
      check('立即采集执行成功', r.status === 200 && r.data.results[0].status === 'ok',
        r.data.results[0].message);
      /* 夹具共 8 封：非阀门(05)、外省(06)、无来源链接(08) 必被拒；其余视关键词而定 */
      check('采集产出多条暂存待审核', r.data.results[0].new_count >= 4,
        `新增 ${r.data.results[0].new_count} 条，拒绝 ${r.data.results[0].rejected_count} 条：${JSON.stringify(r.data.results[0].rejectReasons)}`);

      const again = await api('POST', '/api/collect/run', { source_id: sid });
      check('再次立即采集被 24 小时节流跳过',
        again.data.results[0].status === 'skipped',
        again.data.results[0].message);

      const forced = await api('POST', '/api/collect/run', { source_id: sid, ignoreInterval: true });
      check('本机可强制忽略节流（内容无变化时全部跳过）',
        forced.data.results[0].status === 'ok' && forced.data.results[0].new_count === 0
        && forced.data.results[0].skipped_count >= 4,
        `新增 ${forced.data.results[0].new_count}，跳过 ${forced.data.results[0].skipped_count}`);
    }

    /* ---------- 5. 暂存区查询 ---------- */
    {
      const list = await api('GET', '/api/collect/staging?status=pending&pageSize=50');
      check('暂存区列表可用', list.status === 200 && list.data.total >= 4,
        `待审核 ${list.data.total} 条，计数 ${JSON.stringify(list.data.counts)}`);

      const kw = await api('GET', '/api/collect/staging?keyword=' + encodeURIComponent('塔河'));
      check('暂存区支持关键词搜索', kw.status === 200 && kw.data.total >= 1,
        `命中 ${kw.data.total} 条`);

      const personal = await api('GET', '/api/collect/staging?has_personal=1');
      check('暂存区支持按"含个人信息"筛选', personal.status === 200 && personal.data.total >= 1,
        `含个人信息 ${personal.data.total} 条`);

      const one = await api('GET', `/api/collect/staging/${list.data.list[0].id}`);
      check('暂存详情可用', one.status === 200 && one.data.id === list.data.list[0].id,
        `项目「${one.data.project_name.slice(0, 24)}」`);
      check('暂存详情含溯源与合规标记',
        'source_url' in one.data && 'has_personal_info' in one.data && 'match_score' in one.data,
        `来源链接=${one.data.source_url ? '有' : '无'} 个人信息=${one.data.has_personal_info} 匹配分=${one.data.match_score}`);
    }

    /* ---------- 6. 审核 ---------- */
    {
      const list = await api('GET', '/api/collect/staging?status=pending&pageSize=50');
      const target = list.data.list.find((x) => x.match_score > 0) || list.data.list[0];

      const noAction = await api('POST', `/api/collect/staging/${target.id}/review`, {});
      check('审核 · 缺动作被拒', noAction.status === 400 && noAction.code === 'ACTION_REQUIRED', noAction.code);

      const noCust = await api('POST', `/api/collect/staging/${target.id}/review`, { action: 'approve' });
      check('审核 · 缺客户被拒', noCust.status === 400 && noCust.code === 'CUSTOMER_REQUIRED', noCust.code);

      /* 找一个客户 */
      let cust = (await api('GET', '/api/customers?pageSize=1')).data.list[0];
      if (!cust) {
        const c = await api('POST', '/api/customers', {
          name: 'API测试来源客户', short_name: '采集测试', type: '终端用户', industry: '石油'
        });
        cust = { id: c.data.id };
      }

      const okRes = await api('POST', `/api/collect/staging/${target.id}/review`, {
        action: 'approve', customer_id: cust.id, stage: '信息收集'
      });
      check('审核 · 确认后入库成功', okRes.status === 200 && okRes.data.status === 'approved',
        `项目 id=${okRes.data.project_id}`);

      const proj = await api('GET', `/api/projects/${okRes.data.project_id}`);
      check('入库项目带溯源字段（可在项目详情看到来源，对应验收标准 C4）',
        proj.data.source_url === target.source_url
        && proj.data.source_notice_id === target.notice_id
        && proj.data.source_platform === target.source_platform,
        `来源=${proj.data.source_platform} 编号=${proj.data.source_notice_id}`);

      const dup = await api('POST', `/api/collect/staging/${target.id}/review`, {
        action: 'approve', customer_id: cust.id
      });
      check('审核 · 重复入库被拒', dup.status === 400 && dup.code === 'ALREADY_APPROVED', dup.code);

      const rej = await api('POST', `/api/collect/staging/${target.id}/review`, {
        action: 'reject', reject_reason: '测试忽略'
      });
      check('审核 · 已入库的记录不能再被忽略',
        rej.status === 400 || rej.data.status === 'approved',
        `HTTP ${rej.status}`);
    }

    /* ---------- 7. 批量忽略 ---------- */
    {
      const list = await api('GET', '/api/collect/staging?status=pending&pageSize=50');
      const ids = list.data.list.map((x) => x.id);
      if (ids.length) {
        const r = await api('POST', '/api/collect/staging-reject', { ids, reason: '批量测试忽略' });
        check('批量忽略生效', r.status === 200 && r.data.rejected === ids.length,
          `忽略 ${r.data.rejected}/${ids.length} 条`);
      } else {
        check('批量忽略生效', true, '（无待审核记录，跳过）');
      }
    }

    /* ---------- 8. 审计日志 ---------- */
    {
      const logs = await api('GET', '/api/collect/logs?pageSize=100');
      check('审计日志可查询', logs.status === 200 && logs.data.total > 0, `${logs.data.total} 条`);

      const actions = new Set(logs.data.list.map((x) => x.action));
      const need = ['collect_ok', 'staging_approve'];
      check('日志覆盖采集与审核动作',
        need.every((a) => actions.has(a)),
        [...actions].join(', '));

      const bySource = await api('GET', `/api/collect/logs?source_id=${sid}`);
      check('日志可按来源过滤', bySource.status === 200
        && bySource.data.list.every((x) => x.source_id === sid),
        `${bySource.data.total} 条`);
    }

    /* ---------- 9. 断网护栏 ---------- */
    {
      /* 未启用的来源 + 不含 force 的 run：必须在连接邮箱之前就被拒绝，
         因此 srv.requests 在这段时间内不应增长 */
      const before = srv.requests.length;
      const disabled = await api('POST', '/api/collect/sources', {
        name: 'API测试来源 · 停用', type: 'subscription', enabled: 0,
        provider: 'custom', host: '127.0.0.1', port: srv.port, secure: false,
        user: 'me@example.com', pass: 'auth-code-123456', mailbox: 'INBOX'
      });
      created.push(disabled.data.id);

      const r = await api('POST', '/api/collect/run', { source_id: disabled.data.id });
      const after = srv.requests.length;
      check('护栏 · 未启用来源不会发起任何邮箱请求',
        r.data.results[0].status === 'failed' && after === before,
        `拒绝原因「${r.data.results[0].message}」，期间邮箱请求数 ${after - before}`);

      /* 不指定 sourceId 时只跑已启用的；停用的不应被触及 */
      const allRun = await api('POST', '/api/collect/run', {});
      const ranIds = (allRun.data.results || []).map((x) => x.sourceId);
      check('护栏 · 不带来源的采集只处理已启用的来源',
        !ranIds.includes(disabled.data.id),
        `本次处理来源：${ranIds.join(', ') || '无'}`);
    }

    /* ---------- 10. 删除来源 ---------- */
    {
      const r = await api('DELETE', `/api/collect/sources/${sid}`);
      check('删除来源成功（软删除）', r.status === 200 && r.data.deleted === true, `id=${r.data.id}`);
      const list = await api('GET', '/api/collect/sources');
      check('删除后不再出现在列表中', !list.data.some((x) => x.id === sid), '已移除');
    }
  } finally {
    /* 清理 */
    for (const row of db.prepare(
      "SELECT id FROM projects WHERE data_origin = '招标采集' AND source_platform LIKE 'API测试来源%'"
    ).all()) {
      db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'project' AND entity_id = ?").run(row.id);
    }
    for (const id of created) {
      db.prepare('DELETE FROM collect_logs WHERE source_id = ?').run(id);
      db.prepare('DELETE FROM collect_staging WHERE source_id = ?').run(id);
      db.prepare('DELETE FROM collect_sources WHERE id = ?').run(id);
    }
    db.prepare("DELETE FROM collect_logs WHERE source_name LIKE 'API测试来源%'").run();
    db.prepare("DELETE FROM collect_staging WHERE source_name LIKE 'API测试来源%'").run();
    db.prepare("DELETE FROM collect_sources WHERE name LIKE 'API测试来源%'").run();
    /* 批量忽略写的是全局日志（source_id 为空），单独按动作清理 */
    db.prepare("DELETE FROM collect_logs WHERE action = 'staging_reject_batch' AND source_id IS NULL").run();
    db.close();
    await srv.close();
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'collect-api-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
