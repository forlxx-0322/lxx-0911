/**
 * 采集引擎测试（对本地模拟 IMAP 服务器跑完整流程，不联网、不接触真实邮箱）
 *
 * 覆盖：
 *   - 24 小时调度：首次执行 / 未到时间跳过 / force 强制
 *   - 增量判定：新增 → 重复跳过 → 内容变化只更新变化字段
 *   - 过滤：非阀门、非新疆、缺来源链接被拒并计入原因统计
 *   - 红线：个人信息命中标记，但**绝不写入任何字段值**
 *   - 暂存区：未经审核不入正式库；审核入库带溯源字段；批量忽略
 *   - 审计：日志写入、级别、保留期清理
 *   - 铁律：未启用来源拒绝执行；不支持的来源类型拒绝执行
 *   - 失败处理：连续 3 次失败自动暂停来源
 *
 * 用法：先启动服务（本测试直接读写数据库，不走 HTTP）
 *   node tools/test-collect-engine.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const { startMockImap, loadMailFixtures } = require(path.join(ROOT, '.fixtures', 'mock-imap.js'));
const svc = require(path.join(ROOT, 'server', 'collect', 'service.js'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

const DB_FILE = path.join(ROOT, 'data', 'crm.db');

/** 造一个可用的来源（指向本地模拟服务器） */
function makeSource(db, srv, extra) {
  return svc.saveSource(db, Object.assign({
    name: '测试来源 · 本地模拟',
    type: 'subscription',
    enabled: 1,
    provider: 'custom',
    host: '127.0.0.1',
    port: srv.port,
    secure: false,                       // 本地模拟服务器是明文连接
    user: 'me@example.com',
    pass: 'auth-code-123456',
    mailbox: 'INBOX',
    keywords: '阀门,球阀,闸阀,蝶阀',
    regionOnly: true,
    sinceDays: 60
  }, extra || {}));
}

(async () => {
  console.log('=== 采集引擎测试 ===\n');

  const inbox = loadMailFixtures('INBOX');
  const srv = await startMockImap({
    user: 'me@example.com', pass: 'auth-code-123456', mailboxes: [inbox]
  });
  console.log(`模拟邮箱：${inbox.messages.length} 封邮件 @ 127.0.0.1:${srv.port}\n`);

  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA foreign_keys = ON');
  const createdSources = [];
  const createdStaging = [];
  const createdProjects = [];

  /* 清理上一次测试的残留（含上次异常中断留下的项目，否则同编号项目会干扰断言） */
  for (const row of db.prepare(
    "SELECT id FROM projects WHERE data_origin = '招标采集' AND source_platform LIKE '测试来源%'"
  ).all()) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
    db.prepare("DELETE FROM activity_logs WHERE entity_type = 'project' AND entity_id = ?").run(row.id);
  }
  db.prepare("DELETE FROM collect_staging WHERE source_name LIKE '测试来源%'").run();
  db.prepare("DELETE FROM collect_sources WHERE name LIKE '测试来源%'").run();

  try {
    /* ---------- 1. 铁律：未启用来源拒绝执行 ---------- */
    {
      const s = makeSource(db, srv, { name: '测试来源 · 未启用', enabled: 0 });
      createdSources.push(s.id);
      const r = await svc.runCollect(db, { sourceId: s.id });
      const res = r.results[0];
      check('铁律 · 未启用的来源拒绝执行', res.status === 'failed' && /未启用/.test(res.message),
        res.message);
    }

    /* ---------- 2. 铁律：不支持的采集方式拒绝执行 ---------- */
    {
      const s = makeSource(db, srv, { name: '测试来源 · 类型不支持' });
      createdSources.push(s.id);
      /* 直接改库绕过 saveSource 的白名单校验，模拟手工写入非法类型 */
      db.prepare("UPDATE collect_sources SET type = 'whitelist_crawl' WHERE id = ?").run(s.id);
      const r = await svc.runCollect(db, { sourceId: s.id, force: true });
      check('铁律 · 不支持的采集方式（非邮件订阅）拒绝执行',
        r.results[0].status === 'failed' && /不支持/.test(r.results[0].message),
        r.results[0].message);
    }

    /* ---------- 3. 正常采集：首次执行 ---------- */
    let goodSourceId = null;
    {
      const s = makeSource(db, srv, { name: '测试来源 · 正常' });
      goodSourceId = s.id;
      createdSources.push(s.id);

      const r = await svc.runCollect(db, { sourceId: s.id });
      const res = r.results[0];
      check('首次采集执行成功', res.status === 'ok', res.message);
      check('首次采集读到 8 封邮件', res.mails === 8, `读取 ${res.mails} 封`);
      /* 夹具中符合条件的是 5 条：
         01 新疆阀门(txt+html)、02 新疆政采、03 昌吉摘要、04 化工园区(含个人信息)、07 独山子石化 */
      check('符合条件的新增 5 条', res.new_count === 5, `新增 ${res.new_count} 条`);
      check('不符合条件的被拒并统计原因',
        res.rejected_count === 3 && Object.keys(res.rejectReasons || {}).length >= 2,
        `拒绝 ${res.rejected_count} 条：${JSON.stringify(res.rejectReasons)}`);

      const rows = db.prepare(
        "SELECT * FROM collect_staging WHERE source_id = ? AND deleted_at IS NULL ORDER BY id"
      ).all(s.id);
      rows.forEach((x) => createdStaging.push(x.id));
      check('暂存区写入 5 条且状态为 pending',
        rows.length === 5 && rows.every((x) => x.status === 'pending'),
        `${rows.length} 条：${rows.map((x) => x.status).join(', ')}`);
      check('拒绝原因包含"未命中关键词"与"非新疆"',
        /关键词/.test(JSON.stringify(res.rejectReasons)) && /新疆/.test(JSON.stringify(res.rejectReasons)),
        JSON.stringify(res.rejectReasons));
    }

    /* ---------- 4. 红线：个人信息不落字段 ---------- */
    {
      const personalMail = db.prepare(
        "SELECT project_name, tenderee, raw_excerpt, has_personal_info, personal_fields FROM collect_staging WHERE source_id = ? AND has_personal_info = 1"
      ).get(goodSourceId);
      check('含个人信息的公告被标记', !!personalMail, personalMail ? personalMail.personal_fields : '未命中');
      const all = db.prepare(
        'SELECT * FROM collect_staging WHERE source_id = ?'
      ).all(goodSourceId);
      const dump = JSON.stringify(all);
      /* 夹具里的手机号与姓名绝不能出现在库里任何字段 */
      check('红线 · 个人手机号未写入数据库任何字段（对应验收标准 C3）',
        !/13909971234/.test(dump) && !/13899887766/.test(dump) && !/13612345678/.test(dump),
        '未发现手机号');
      check('红线 · 个人姓名未写入数据库任何字段',
        !/张建军/.test(dump) && !/李国强/.test(dump) && !/王小梅/.test(dump) && !/阿依古丽/.test(dump),
        '未发现个人姓名');
    }

    /* ---------- 5. 24 小时调度 ---------- */
    {
      const r2 = await svc.runCollect(db, { sourceId: goodSourceId });
      check('未到 24 小时自动跳过（有则更新无则不更，对应验收标准 C5）',
        r2.results[0].status === 'skipped' && /不足 24 小时/.test(r2.results[0].message),
        r2.results[0].message);
      check('跳过后暂存区没有被重写',
        db.prepare('SELECT COUNT(*) AS n FROM collect_staging WHERE source_id = ?').get(goodSourceId).n === 5,
        '仍是 5 条');

      const src = svc.readSourceFull(db, goodSourceId);
      check('来源状态记录了上次采集结果',
        src.last_status === 'ok' && src.last_new_count === 5,
        `status=${src.last_status} new=${src.last_new_count}`);
      check('可计算下次采集时间', !!svc.nextRunAt(src), svc.nextRunAt(src));
    }

    /* ---------- 6. 增量：内容一致则整条跳过 ---------- */
    {
      const before = db.prepare(
        'SELECT id, content_hash, updated_at, amount FROM collect_staging WHERE source_id = ? ORDER BY id'
      ).all(goodSourceId);
      const r = await svc.runCollect(db, { sourceId: goodSourceId, force: true });
      const res = r.results[0];
      check('强制重跑：内容无变化时全部跳过（不重写）',
        res.new_count === 0 && res.updated_count === 0 && res.skipped_count === 5,
        `新增 ${res.new_count}，更新 ${res.updated_count}，跳过 ${res.skipped_count}`);

      const after = db.prepare(
        'SELECT id, content_hash, updated_at FROM collect_staging WHERE source_id = ? ORDER BY id'
      ).all(goodSourceId);
      const unchanged = before.every((b, i) => b.content_hash === after[i].content_hash
        && b.updated_at === after[i].updated_at);
      check('内容一致的记录：指纹与更新时间均未变（符合 A.7）',
        unchanged, `比对 ${before.length} 条`);
    }

    /* ---------- 7. 增量：字段变化只更新变化项 ---------- */
    {
      /* 取一条暂存记录，模拟公告金额发生变化（改库后跑采集，应识别为"内容有变"） */
      const row = db.prepare(
        'SELECT * FROM collect_staging WHERE source_id = ? ORDER BY id LIMIT 1'
      ).get(goodSourceId);
      /* 人为把库里的指纹改掉，模拟"上次抓到的内容与本次不同" */
      db.prepare("UPDATE collect_staging SET content_hash = 'stale-hash', amount = 1 WHERE id = ?").run(row.id);

      const r = await svc.runCollect(db, { sourceId: goodSourceId, force: true });
      const res = r.results[0];
      check('内容有变时被识别为更新', res.updated_count >= 1, `更新 ${res.updated_count} 条`);

      const after = db.prepare('SELECT amount, content_hash FROM collect_staging WHERE id = ?').get(row.id);
      check('只更新变化的字段，金额被改回公告值',
        after.amount === row.amount && after.content_hash !== 'stale-hash',
        `金额 ${after.amount}（原公告值 ${row.amount}）`);

      const updLog = db.prepare(
        "SELECT * FROM collect_logs WHERE action = 'staging_update' ORDER BY id DESC LIMIT 1"
      ).get();
      check('更新动作写入审计日志且记录了改了什么',
        !!updLog && /变化/.test(updLog.message) && updLog.detail.length > 0,
        updLog ? `变更字段：${updLog.detail}` : '无日志');
    }

    /* ---------- 8. 审核：未经确认不入正式库 ---------- */
    {
      const staging = db.prepare(
        "SELECT * FROM collect_staging WHERE source_id = ? AND status = 'pending' ORDER BY match_score DESC LIMIT 1"
      ).get(goodSourceId);

      if (!staging) {
        /* 上游采集失败时给出明确失败而不是崩溃 */
        for (const n of ['审核 · 未指定动作被拒绝', '审核 · 未选择归属客户被拒绝',
          '审核 · 此时仍未写入正式项目库', '审核 · 确认后写入正式项目库',
          '入库项目带完整溯源字段', '入库项目金额来自公告金额',
          '暂存记录状态变为 approved 并回填 project_id',
          '入库写入操作日志（与手动录入一致地留痕）', '审核 · 已入库的记录不会重复入库']) {
          check(n, false, '没有 pending 记录可测（上游采集未产出数据）');
        }
      } else {
        const projBefore = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;

        /* 8.1 缺少审核动作 → 报错 */
        let err = null;
        try { svc.reviewStaging(db, { id: staging.id }); } catch (e) { err = e; }
        check('审核 · 未指定动作被拒绝', !!err && err.code === 'ACTION_REQUIRED', err ? err.code : '未报错');

        /* 8.2 未选客户 → 报错 */
        err = null;
        try { svc.reviewStaging(db, { id: staging.id, action: 'approve' }); } catch (e) { err = e; }
        check('审核 · 未选择归属客户被拒绝', !!err && err.code === 'CUSTOMER_REQUIRED', err ? err.code : '未报错');

        check('审核 · 此时仍未写入正式项目库',
          db.prepare('SELECT COUNT(*) AS n FROM projects').get().n === projBefore,
          `项目数仍为 ${projBefore}`);

        /* 8.3 正常入库 */
        const cust = await ensureCustomer(db, createdStaging);
        const ok = svc.reviewStaging(db, {
          id: staging.id, action: 'approve', customer_id: cust.id, stage: '信息收集'
        });
        createdProjects.push(ok.project_id);
        check('审核 · 确认后写入正式项目库（对应验收标准 C6）', ok.status === 'approved' && ok.project_id > 0,
          `项目 id=${ok.project_id}`);

        const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(ok.project_id);
        check('入库项目带完整溯源字段',
          proj.source_url === staging.source_url
          && proj.source_platform === staging.source_platform
          && proj.source_notice_id === staging.notice_id
          && proj.confidence === staging.match_score
          && proj.data_origin === '招标采集',
          `来源=${proj.source_platform} 编号=${proj.source_notice_id} 置信=${proj.confidence} origin=${proj.data_origin}`);
        check('入库项目金额来自公告金额',
          Number(proj.contract_amount) === Number(staging.amount),
          `${proj.contract_amount} vs ${staging.amount}`);

      const st2 = db.prepare('SELECT status, project_id FROM collect_staging WHERE id = ?').get(staging.id);
      check('暂存记录状态变为 approved 并回填 project_id',
        st2.status === 'approved' && st2.project_id === ok.project_id,
        `status=${st2.status} project_id=${st2.project_id}`);

      const log = db.prepare(
        "SELECT * FROM activity_logs WHERE entity_type = 'project' AND entity_id = ? ORDER BY id DESC LIMIT 1"
      ).get(ok.project_id);
      check('入库写入操作日志（与手动录入一致地留痕）',
        !!log && /招标采集/.test(log.summary), log ? log.summary : '无日志');

        /* 8.4 已入库的记录不能重复入库 */
        let err2 = null;
        try { svc.reviewStaging(db, { id: staging.id, action: 'approve', customer_id: cust.id }); } catch (e) { err2 = e; }
        check('审核 · 已入库的记录不会重复入库',
          db.prepare('SELECT COUNT(*) AS n FROM projects WHERE source_notice_id = ?').get(staging.notice_id).n === 1,
          `同编号项目数 ${db.prepare('SELECT COUNT(*) AS n FROM projects WHERE source_notice_id = ?').get(staging.notice_id).n}`);
        void err2;
      }
    }

    /* ---------- 9. 审核：忽略 ---------- */
    {
      const staging = db.prepare(
        "SELECT * FROM collect_staging WHERE source_id = ? AND status = 'pending' ORDER BY id LIMIT 1"
      ).get(goodSourceId);
      if (staging) {
        const r = svc.reviewStaging(db, { id: staging.id, action: 'reject', reject_reason: '与阀门无关' });
        check('审核 · 忽略后状态为 rejected', r.status === 'rejected', `status=${r.status}`);
        const row = db.prepare('SELECT status, reject_reason FROM collect_staging WHERE id = ?').get(staging.id);
        check('审核 · 忽略原因被记录', row.reject_reason === '与阀门无关', row.reject_reason);
      } else {
        check('审核 · 忽略后状态为 rejected', false, '没有 pending 记录可测');
        check('审核 · 忽略原因被记录', false, '跳过');
      }

      /* 批量忽略 */
      const pend = db.prepare(
        "SELECT id FROM collect_staging WHERE source_id = ? AND status = 'pending'"
      ).all(goodSourceId).map((x) => x.id);
      const b = svc.rejectStaging(db, pend, '批量测试忽略');
      check('审核 · 批量忽略生效', b.rejected === pend.length,
        `忽略 ${b.rejected}/${pend.length} 条`);
    }

    /* ---------- 10. 失败处理：连续失败自动暂停 ---------- */
    {
      const s = svc.saveSource(db, {
        name: '测试来源 · 连不上', type: 'subscription', enabled: 1,
        provider: 'custom', host: '127.0.0.1', port: 1,
        user: 'a@b.com', pass: 'x', mailbox: 'INBOX', keywords: '阀门', sinceDays: 30
      });
      createdSources.push(s.id);

      let last = null;
      for (let i = 1; i <= 3; i++) {
        const r = await svc.runCollect(db, { sourceId: s.id, force: true, timeout: 4000 });
        last = r.results[0];
        if (i === 1) {
          check(`失败处理 · 第 1 次失败记录原因并计数`,
            last.status === 'failed' && last.failStreak === 1,
            `streak=${last.failStreak}，${last.message.slice(0, 40)}`);
        }
      }
      check('失败处理 · 连续 3 次失败自动暂停该来源（对应验收标准 C8）',
        last.paused === true && last.failStreak === 3,
        `streak=${last.failStreak} paused=${last.paused}`);
      const row = db.prepare('SELECT enabled, fail_streak FROM collect_sources WHERE id = ?').get(s.id);
      check('失败处理 · 来源已在库中被停用',
        row.enabled === 0 && row.fail_streak === 3,
        `enabled=${row.enabled} streak=${row.fail_streak}`);
      const errLog = db.prepare(
        "SELECT * FROM collect_logs WHERE source_id = ? AND level = 'error' ORDER BY id DESC LIMIT 1"
      ).get(s.id);
      check('失败处理 · 失败写入 error 级审计日志', !!errLog, errLog ? errLog.message.slice(0, 50) : '无');
    }

    /* ---------- 11. 审计日志与保留期 ---------- */
    {
      const logs = svc.listLogs(db, { source_id: goodSourceId, pageSize: 100 });
      check('审计日志可查询且按来源过滤', logs.total > 0 && logs.list.every((l) => l.source_id === goodSourceId),
        `${logs.total} 条`);

      /* 插一条 300 天前的日志，验证会被清理（保留 200 天） */
      db.prepare(
        `INSERT INTO collect_logs (source_name, level, action, message, created_at)
         VALUES ('测试来源 · 正常', 'info', 'old', '很旧的日志', datetime('now','localtime','-300 days'))`
      ).run();
      const pruned = svc.pruneLogs(db, 200);
      check('审计日志 · 超过保留期的被清理（保留 200 天 ≥ 附录要求的 180 天）',
        pruned >= 1 && !db.prepare("SELECT id FROM collect_logs WHERE action = 'old'").get(),
        `清理 ${pruned} 条`);
    }

    /* ---------- 12. 统计汇总 ---------- */
    {
      const sum = svc.collectSummary(db);
      check('统计 · 待审核数量正确', sum.pending === 0, `pending=${sum.pending}（前面已全部审核完）`);
      check('统计 · 已入库数量正确', sum.approved >= 1, `approved=${sum.approved}`);
      check('统计 · 来自采集的项目数正确', sum.fromCollect >= 1, `fromCollect=${sum.fromCollect}`);
      check('统计 · 展示采集间隔与日志保留期',
        sum.intervalHours === 24 && sum.logKeepDays >= 180,
        `间隔 ${sum.intervalHours} 小时，日志保留 ${sum.logKeepDays} 天`);
      check('统计 · 个人信息命中数被统计（供界面提示）',
        typeof sum.personalInfo === 'number', `命中 ${sum.personalInfo} 条`);
    }

    /* ---------- 13. 来源配置读写安全 ---------- */
    {
      const s = makeSource(db, srv, { name: '测试来源 · 凭据' });
      createdSources.push(s.id);

      const listed = svc.listSources(db).find((x) => x.id === s.id);
      check('来源列表不回传凭据明文',
        listed && listed.hasCredential === true && !('pass' in listed),
        `hasCredential=${listed && listed.hasCredential}`);

      /* 空字符串表示"不改凭据" */
      svc.saveSource(db, { id: s.id, name: '测试来源 · 凭据', provider: 'custom', host: '127.0.0.1', port: srv.port, user: 'me@example.com', pass: '' });
      const after = svc.readSourceFull(db, s.id);
      check('保存时空凭据不会清掉已有授权码', after.cfg.pass === 'auth-code-123456',
        after.cfg.pass ? '仍保留' : '被清空（异常）');

      /* 显式清除 */
      svc.saveSource(db, { id: s.id, name: '测试来源 · 凭据', provider: 'custom', host: '127.0.0.1', port: srv.port, user: 'me@example.com', clearCredential: true });
      const cleared = svc.readSourceFull(db, s.id);
      check('显式清除凭据生效', !cleared.cfg.pass, cleared.cfg.pass ? '未清除' : '已清除');
    }

    /* ---------- 14. 只读性复核 ---------- */
    {
      const mutating = srv.requests.filter((r) => /\b(STORE|EXPUNGE|APPEND|COPY|MOVE)\b/i.test(r));
      check('整个测试过程未发送任何改动邮箱状态的命令',
        mutating.length === 0,
        mutating.length ? mutating.slice(0, 2).join(' | ') : `已检查 ${srv.requests.length} 条命令`);
    }
  } finally {
    /* ---------- 清理测试数据 ---------- */
    for (const id of createdProjects) {
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'project' AND entity_id = ?").run(id);
    }
    for (const id of createdSources) {
      db.prepare('DELETE FROM collect_logs WHERE source_id = ?').run(id);
      db.prepare('DELETE FROM collect_staging WHERE source_id = ?').run(id);
      db.prepare('DELETE FROM collect_sources WHERE id = ?').run(id);
    }
    db.prepare("DELETE FROM collect_logs WHERE source_name LIKE '测试来源%'").run();
    db.prepare("DELETE FROM collect_staging WHERE source_name LIKE '测试来源%'").run();
    db.prepare("DELETE FROM collect_sources WHERE name LIKE '测试来源%'").run();
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
    path.join(ROOT, '.fixtures', 'collect-engine-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});

/** 找一个可用客户（没有就建一个测试客户） */
async function ensureCustomer(db, createdStaging) {
  let c = db.prepare('SELECT id, name FROM customers WHERE deleted_at IS NULL ORDER BY id LIMIT 1').get();
  if (c) return c;
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const info = db.prepare(
    `INSERT INTO customers (name, short_name, type, industry, status, created_at, updated_at)
     VALUES ('采集测试客户', '采集测试', '终端用户', '石油', '潜在', ?, ?)`
  ).run(ts, ts);
  void createdStaging;
  return { id: Number(info.lastInsertRowid), name: '采集测试客户' };
}
