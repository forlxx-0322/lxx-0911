/**
 * 招标信息采集引擎（邮件订阅解析路线）
 *
 * 流程（对应附录 A.8 的七步，按订阅路线落地）：
 *   1. 配置校验      来源必须启用、类型必须是 subscription、凭据齐全
 *   2. 调度判定      每 24 小时一次；当日已跑过则跳过（A.7）
 *   3. 只读拉取      EXAMINE + BODY.PEEK，绝不改动邮箱状态
 *   4. 解析抽取      MIME → 文本 → 结构化字段
 *   5. 个人信息检测  命中则标记，但**绝不把个人信息写入任何字段**
 *   6. 客户匹配打分  与库内客户/设计院/最终用户名称比对
 *   7. 增量写入暂存区 按公告编号去重，内容有变才覆盖，否则整条跳过
 *
 * 之后由人工在界面审核，确认后才写入正式项目库（未经确认绝不入正式库）。
 *
 * 铁律（附录 A.5）在代码级强制：
 *   - 白名单制：只有 type='subscription' 有实现，其余类型一律拒绝执行
 *   - 默认关闭：enabled=0 直接拒绝
 *   - 只读：不使用任何会改动邮箱状态的 IMAP 命令
 */
'use strict';

const mail = require('./mail.js');
const extract = require('./extract.js');
const { ImapClient, PROVIDERS } = require('./imap.js');

/** 允许执行的来源类型白名单（当前只实现邮件订阅） */
const ALLOWED_SOURCE_TYPES = ['subscription'];
/** 调度间隔：24 小时（附录 A.7 已确认） */
const INTERVAL_HOURS = 24;
/** 单次采集最多处理的邮件数（克制原则：不整箱拉取） */
const MAX_MAILS_PER_RUN = 80;
/** 连续失败多少次自动暂停该来源（附录 A.7） */
const MAX_FAIL_STREAK = 3;
/** 审计日志保留天数（附录 A.8：≥180 天） */
const LOG_KEEP_DAYS = 200;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function now() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T`
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function plain(row) { return row ? Object.assign({}, row) : row; }

/** 写审计日志 */
function writeLog(db, entry) {
  db.prepare(
    `INSERT INTO collect_logs (source_id, source_name, level, action, message, detail, item_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.source_id == null ? null : Number(entry.source_id),
    entry.source_name || '',
    entry.level || 'info',
    entry.action || '',
    entry.message || '',
    entry.detail ? (typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail)) : '',
    Number(entry.item_count || 0),
    now()
  );
}

/** 清理过期审计日志 */
function pruneLogs(db, keepDays) {
  const days = Number(keepDays) || LOG_KEEP_DAYS;
  const info = db.prepare(
    `DELETE FROM collect_logs WHERE created_at < datetime('now','localtime','-${days} days')`
  ).run();
  return Number(info.changes || 0);
}

/* ------------------------------------------------------------------ */
/* 来源配置读写                                                        */
/* ------------------------------------------------------------------ */

/** 读取来源（隐藏凭据，供界面展示） */
function listSources(db) {
  const rows = db.prepare(
    'SELECT * FROM collect_sources WHERE deleted_at IS NULL ORDER BY id'
  ).all().map(plain);
  return rows.map((r) => {
    let cfg = {};
    try { cfg = JSON.parse(r.config_json || '{}'); } catch (_) { cfg = {}; }
    const provider = PROVIDERS[cfg.provider] || PROVIDERS.custom;
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      enabled: !!r.enabled,
      provider: cfg.provider || 'custom',
      providerLabel: provider.label,
      host: cfg.host || provider.host || '',
      port: Number(cfg.port || provider.port || 993),
      secure: cfg.secure === undefined ? Number(cfg.port || provider.port || 993) !== 143 : !!cfg.secure,
      user: cfg.user || '',
      /* 凭据只回显"是否已配置"，绝不返回明文 */
      hasCredential: !!(cfg.pass),
      mailbox: cfg.mailbox || 'INBOX',
      keywords: cfg.keywords || '',
      regionOnly: cfg.regionOnly !== false,
      sinceDays: Number(cfg.sinceDays || 30),
      last_run_at: r.last_run_at,
      last_status: r.last_status,
      last_message: r.last_message,
      last_new_count: r.last_new_count,
      last_upd_count: r.last_upd_count,
      fail_streak: r.fail_streak,
      next_run_at: nextRunAt(r),
      providerHint: provider.hint
    };
  });
}

/** 读取来源的完整配置（含凭据，仅内部使用） */
function readSourceFull(db, id) {
  const r = db.prepare('SELECT * FROM collect_sources WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!r) return null;
  const row = plain(r);
  let cfg = {};
  try { cfg = JSON.parse(row.config_json || '{}'); } catch (_) { cfg = {}; }
  const provider = PROVIDERS[cfg.provider] || PROVIDERS.custom;
  row.cfg = cfg;
  row.host = cfg.host || provider.host || '';
  row.port = Number(cfg.port || provider.port || 993);
  return row;
}

/** 计算下次可采集时间（上次采集 + 24 小时） */
function nextRunAt(row) {
  if (!row.last_run_at) return '';
  const t = new Date(String(row.last_run_at).replace(' ', 'T'));
  if (isNaN(t)) return '';
  t.setHours(t.getHours() + INTERVAL_HOURS);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

/**
 * 是否到了可以采集的时间。
 * 规则（A.7）：每 24 小时一次；未开机不累积补跑，下次启动跑一次即可。
 */
function isDue(row, nowDate) {
  if (!row.last_run_at) return true;
  const last = new Date(String(row.last_run_at).replace(' ', 'T'));
  if (isNaN(last)) return true;
  const diff = (nowDate || new Date()).getTime() - last.getTime();
  return diff >= INTERVAL_HOURS * 3600 * 1000;
}

/**
 * 保存来源。pass 为空字符串表示"不改动已有凭据"。
 */
function saveSource(db, payload) {
  const id = payload.id ? Number(payload.id) : null;
  const ts = now();
  const name = String(payload.name || '').trim();
  if (!name) {
    const e = new Error('来源名称不能为空');
    e.status = 400; e.code = 'NAME_REQUIRED';
    throw e;
  }
  const type = String(payload.type || 'subscription');
  if (!ALLOWED_SOURCE_TYPES.includes(type)) {
    const e = new Error(`暂不支持的采集方式：${type}（当前仅支持邮件订阅解析）`);
    e.status = 400; e.code = 'SOURCE_TYPE_UNSUPPORTED';
    throw e;
  }

  const provider = String(payload.provider || 'custom');
  const preset = PROVIDERS[provider] || PROVIDERS.custom;
  const port = Number(payload.port || preset.port || 993);
  const cfg = {
    provider,
    host: String(payload.host || preset.host || '').trim(),
    port,
    /* 993 走隐式 TLS；143 通常配 STARTTLS，本实现不启用 STARTTLS，因此按明文处理并提示用户优先用 993 */
    secure: payload.secure === undefined ? port !== 143 : !!payload.secure,
    user: String(payload.user || '').trim(),
    mailbox: String(payload.mailbox || 'INBOX').trim() || 'INBOX',
    keywords: String(payload.keywords || '').trim(),
    regionOnly: payload.regionOnly !== false,
    sinceDays: Math.min(Math.max(Number(payload.sinceDays) || 30, 1), 365)
  };

  /* 凭据处理：空串=保持不变；有值=更新；显式 clearCredential=清除 */
  let oldCfg = {};
  if (id) {
    const old = readSourceFull(db, id);
    if (!old) {
      const e = new Error('来源不存在');
      e.status = 404; e.code = 'NOT_FOUND';
      throw e;
    }
    oldCfg = old.cfg || {};
  }
  if (payload.clearCredential) cfg.pass = '';
  else if (String(payload.pass || '').length) cfg.pass = String(payload.pass);
  else cfg.pass = oldCfg.pass || '';

  if (id) {
    db.prepare(
      `UPDATE collect_sources SET name = ?, type = ?, enabled = ?, config_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(name, type, payload.enabled ? 1 : 0, JSON.stringify(cfg), ts, id);
    writeLog(db, { source_id: id, source_name: name, action: 'source_update', message: `更新采集来源：${name}` });
    return { id, created: false };
  }

  const info = db.prepare(
    `INSERT INTO collect_sources (name, type, enabled, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(name, type, payload.enabled ? 1 : 0, JSON.stringify(cfg), ts, ts);
  const newId = Number(info.lastInsertRowid);
  writeLog(db, { source_id: newId, source_name: name, action: 'source_create', message: `新增采集来源：${name}` });
  return { id: newId, created: true };
}

function deleteSource(db, id) {
  const sid = Number(id);
  const row = db.prepare('SELECT name FROM collect_sources WHERE id = ?').get(sid);
  if (!row) {
    const e = new Error('来源不存在');
    e.status = 404; e.code = 'NOT_FOUND';
    throw e;
  }
  db.prepare('UPDATE collect_sources SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?')
    .run(now(), now(), sid);
  writeLog(db, { source_id: sid, source_name: row.name, action: 'source_delete', message: `删除采集来源：${row.name}` });
  return { id: sid, deleted: true };
}

/* ------------------------------------------------------------------ */
/* 暂存区写入与增量判定                                                */
/* ------------------------------------------------------------------ */

/**
 * 把一条抽取结果写入暂存区，按 A.7 的增量规则处理：
 *   - 用去重键（公告编号优先，其次来源 URL）找已有记录
 *   - 没有 → 新增
 *   - 有且内容指纹相同 → 整条跳过（不重写、不改 updated_at）
 *   - 有且指纹不同 → 只更新确实变化的字段，并记录改了什么
 * @returns {{action:'new'|'skipped'|'updated', id:number, changed:string[]}}
 */
function upsertStaging(db, info, meta) {
  const key = extract.noticeKey(info);
  const hash = extract.contentHash(info);
  const ts = now();
  const m = meta || {};

  const existing = db.prepare(
    `SELECT * FROM collect_staging
     WHERE deleted_at IS NULL
       AND (notice_id = ? OR (notice_id = '' AND source_url = ?))
     ORDER BY id LIMIT 1`
  ).get(key, info.source_url || '');

  const fields = {
    source_id: m.sourceId == null ? null : Number(m.sourceId),
    source_name: m.sourceName || '',
    notice_id: key,
    title: info.title || '',
    project_name: info.project_name || '',
    project_code: info.project_code || '',
    region_code: info.region_code || '',
    region_name: info.region_name || '',
    location: info.location || '',
    amount: info.amount == null ? null : Number(info.amount),
    industry: info.industry || '',
    tenderee: info.tenderee || '',
    agency: info.agency || '',
    design_institute: info.design_institute || '',
    bid_date: info.bid_date || '',
    notice_type: info.notice_type || '',
    source_url: info.source_url || '',
    source_platform: info.source_platform || '',
    mail_subject: m.subject || '',
    mail_from: m.from || '',
    mail_date: m.mailDate || '',
    mail_uid: m.mailUid == null ? '' : String(m.mailUid),
    raw_excerpt: info.raw_excerpt || '',
    has_personal_info: info.has_personal_info ? 1 : 0,
    personal_fields: (info.personal_fields || []).join('、'),
    keyword_hits: (info.keyword_hits || []).join('、'),
    matched_customer: (info.match && info.match.customer) || '',
    match_score: (info.match && info.match.score) || 0,
    content_hash: hash
  };

  if (!existing) {
    const keys = Object.keys(fields);
    const info2 = db.prepare(
      `INSERT INTO collect_staging (${keys.join(', ')}, status, collected_at, created_at, updated_at)
       VALUES (${keys.map(() => '?').join(', ')}, 'pending', ?, ?, ?)`
    ).run(...keys.map((k) => fields[k]), ts, ts, ts);
    return { action: 'new', id: Number(info2.lastInsertRowid), changed: [] };
  }

  /* 内容完全一致 → 整条跳过（A.7：不重写、不改更新时间） */
  if (existing.content_hash === hash) {
    return { action: 'skipped', id: existing.id, changed: [] };
  }

  /* 只更新确实变化的字段 */
  const CHANGED_LABEL = {
    project_name: '项目名称', project_code: '项目编号', region_name: '所属地州',
    amount: '金额', tenderee: '招标人', agency: '代理机构', design_institute: '设计单位',
    bid_date: '开标时间', notice_type: '公告类型', source_url: '来源链接',
    industry: '行业', location: '建设地点', raw_excerpt: '正文摘要',
    has_personal_info: '个人信息标记', personal_fields: '个人信息类型',
    keyword_hits: '关键词', matched_customer: '匹配客户', match_score: '匹配得分',
    title: '标题', mail_subject: '邮件主题', mail_from: '发件人', mail_date: '邮件时间', mail_uid: '邮件UID'
  };
  const sets = [];
  const params = [];
  const changed = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'source_id' || k === 'source_name') continue;
    const before = existing[k];
    const same = (before === null && v === null)
      || (before !== null && v !== null && String(before) === String(v));
    if (!same) {
      sets.push(`${k} = ?`);
      params.push(v);
      changed.push(CHANGED_LABEL[k] || k);
    }
  }
  if (!sets.length) return { action: 'skipped', id: existing.id, changed: [] };

  sets.push('content_hash = ?'); params.push(hash);
  sets.push('updated_at = ?'); params.push(ts);
  params.push(existing.id);
  db.prepare(`UPDATE collect_staging SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  return { action: 'updated', id: existing.id, changed };
}

/* ------------------------------------------------------------------ */
/* 采集主流程                                                          */
/* ------------------------------------------------------------------ */

/**
 * 执行一次采集。
 * @param {object} db
 * @param {object} opt
 *   sourceId      指定来源 id（不传则跑全部启用的来源）
 *   force         忽略 24 小时节流（界面上"立即采集"仍然受约束，仅测试用）
 *   dryRun        只连邮箱与解析，不写库（用于"测试连接"）
 *   onProgress    进度回调
 *   timeout       单来源总超时
 * @returns {Promise<object>} 汇总结果
 */
async function runCollect(db, opt) {
  const o = opt || {};
  const started = now();

  const sources = o.sourceId
    ? [readSourceFull(db, o.sourceId)].filter(Boolean)
    : db.prepare('SELECT id FROM collect_sources WHERE deleted_at IS NULL AND enabled = 1 ORDER BY id')
      .all().map((r) => readSourceFull(db, r.id)).filter(Boolean);

  if (!sources.length) {
    return { ran: 0, skipped: 0, results: [], message: '没有启用的采集来源' };
  }

  const results = [];
  for (const src of sources) {
    results.push(await runOneSource(db, src, o));
  }

  pruneLogs(db, LOG_KEEP_DAYS);

  const totals = results.reduce((acc, r) => {
    acc.new += r.new_count || 0;
    acc.updated += r.updated_count || 0;
    acc.skipped += r.skipped_count || 0;
    acc.rejected += r.rejected_count || 0;
    acc.mails += r.mails || 0;
    return acc;
  }, { new: 0, updated: 0, skipped: 0, rejected: 0, mails: 0 });

  return {
    ran: results.filter((r) => r.status === 'ok').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    startedAt: started,
    finishedAt: now(),
    totals,
    results
  };
}

/** 单个来源的采集 */
async function runOneSource(db, src, opt) {
  const o = opt || {};
  const name = src.name;
  const cfg = src.cfg || {};
  const context = { source_id: src.id, source_name: name };

  const fail = (message, detail) => {
    const streak = Number(src.fail_streak || 0) + 1;
    const paused = streak >= MAX_FAIL_STREAK;
    db.prepare(
      `UPDATE collect_sources
       SET last_run_at = ?, last_status = ?, last_message = ?, fail_streak = ?,
           enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END, updated_at = ?
       WHERE id = ?`
    ).run(now(), 'failed', message, streak, paused ? 1 : 0, now(), src.id);
    writeLog(db, Object.assign({}, context, {
      level: 'error', action: 'collect_failed',
      message: paused ? `${message}（连续失败 ${streak} 次，已自动暂停该来源）` : message,
      detail: detail || ''
    }));
    return {
      sourceId: src.id, sourceName: name, status: 'failed',
      message: paused ? `${message}（已自动暂停）` : message,
      new_count: 0, updated_count: 0, skipped_count: 0, rejected_count: 0, mails: 0,
      failStreak: streak, paused
    };
  };

  /* 1) 配置校验（铁律一/二：白名单 + 默认关闭） */
  if (!ALLOWED_SOURCE_TYPES.includes(src.type)) {
    return fail(`不支持的采集方式：${src.type}`);
  }
  if (!src.enabled && !o.force) {
    return fail('来源未启用');
  }
  if (!cfg.user || !cfg.pass) {
    return fail('邮箱账号或授权码未配置');
  }
  if (!src.host) {
    return fail('IMAP 服务器地址未配置');
  }

  /* 2) 调度判定（A.7：每 24 小时一次） */
  if (!o.force && !isDue(src)) {
    const next = nextRunAt(src);
    writeLog(db, Object.assign({}, context, {
      action: 'collect_skip_interval',
      message: `未到采集时间，跳过（下次：${next}）`
    }));
    return {
      sourceId: src.id, sourceName: name, status: 'skipped',
      message: `距上次采集不足 24 小时，跳过（下次：${next}）`,
      nextRunAt: next,
      new_count: 0, updated_count: 0, skipped_count: 0, rejected_count: 0, mails: 0
    };
  }

  /* 3) 只读拉取 */
  const client = new ImapClient({
    host: src.host, port: src.port,
    secure: cfg.secure === undefined ? src.port !== 143 : !!cfg.secure,
    user: cfg.user, pass: cfg.pass,
    timeout: o.timeout || 40000,
    logger: () => {}                       // 协议日志不落库，避免噪声与凭据风险
  });

  let mails = [];
  try {
    await client.connect();
    await client.capability();
    await client.login();

    let mailbox = cfg.mailbox || 'INBOX';
    const boxes = await client.listMailboxes();
    if (!boxes.some((b) => b.name === mailbox)) {
      /* 配置的文件夹不存在时退回收件箱，并明确告知 */
      const fallback = boxes.find((b) => /^INBOX$/i.test(b.name)) ? 'INBOX' : (boxes[0] && boxes[0].name);
      if (!fallback) throw new Error(`邮箱里没有可读取的文件夹（配置的是「${mailbox}」）`);
      writeLog(db, Object.assign({}, context, {
        level: 'warn', action: 'mailbox_fallback',
        message: `文件夹「${mailbox}」不存在，改用「${fallback}」`
      }));
      mailbox = fallback;
    }

    await client.select(mailbox, true);     // EXAMINE：只读

    /* 检索条件：优先按时间窗，避免整箱拉取 */
    const sinceDays = Math.min(Math.max(Number(cfg.sinceDays) || 30, 1), 365);
    const since = new Date(Date.now() - sinceDays * 86400000);
    const { imapDate } = require('./imap.js');
    let uids = await client.uidSearch(['SINCE', imapDate(since)]);
    if (!uids.length) uids = await client.uidSearch(['UNSEEN']);
    /* 只取最新的若干封，克制原则 */
    uids = uids.slice(-MAX_MAILS_PER_RUN);

    if (uids.length) {
      mails = await client.uidFetch(uids);
    }
    await client.logout();
  } catch (e) {
    client.destroy();
    return fail('邮箱连接或读取失败：' + (e.message || e), e.code || '');
  }

  if (o.dryRun) {
    return {
      sourceId: src.id, sourceName: name, status: 'ok', dryRun: true,
      message: `连接成功，窗口内可读 ${mails.length} 封邮件`,
      new_count: 0, updated_count: 0, skipped_count: 0, rejected_count: 0, mails: mails.length
    };
  }

  /* 4~7) 解析 → 抽取 → 检测 → 匹配 → 增量写入 */
  const customers = db.prepare(
    `SELECT id, name, short_name, end_user, design_institute, region_code
     FROM customers WHERE deleted_at IS NULL`
  ).all().map(plain);

  const keywords = String(cfg.keywords || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  const stats = { new_count: 0, updated_count: 0, skipped_count: 0, rejected_count: 0, changedTotal: 0 };
  const rejectReasons = {};

  const seen = new Set();
  for (const m of mails) {
    let parsed;
    try { parsed = mail.parseMail(m.raw); } catch (e) {
      stats.rejected_count++;
      rejectReasons['解析失败'] = (rejectReasons['解析失败'] || 0) + 1;
      continue;
    }

    const r = extract.extractFromMail(parsed, {
      sourceName: name,
      customers,
      keywords: keywords.length ? keywords : undefined,
      requireXinjiang: cfg.regionOnly !== false
    });

    if (!r.ok) {
      stats.rejected_count++;
      rejectReasons[r.reason] = (rejectReasons[r.reason] || 0) + 1;
      continue;
    }

    const key = extract.noticeKey(r.info);
    if (seen.has(key)) {          // 同一批邮件里重复（转发/重复推送）
      stats.skipped_count++;
      continue;
    }
    seen.add(key);

    const res = upsertStaging(db, r.info, {
      sourceId: src.id,
      sourceName: name,
      subject: parsed.subject,
      from: mail.parseAddress(parsed.from),
      mailDate: m.internalDate ? m.internalDate.toISOString().slice(0, 19).replace('T', ' ') : parsed.date,
      mailUid: m.uid
    });

    if (res.action === 'new') stats.new_count++;
    else if (res.action === 'updated') {
      stats.updated_count++;
      stats.changedTotal += res.changed.length;
      writeLog(db, Object.assign({}, context, {
        action: 'staging_update',
        message: `公告内容有变化，已更新：${r.info.project_name || r.info.title}`,
        detail: res.changed, item_count: res.changed.length
      }));
    } else stats.skipped_count++;
  }

  /* 更新来源状态 */
  const msg = `读取 ${mails.length} 封，新增 ${stats.new_count} 条，更新 ${stats.updated_count} 条，`
    + `跳过 ${stats.skipped_count} 条，不符合条件 ${stats.rejected_count} 条`;
  db.prepare(
    `UPDATE collect_sources
     SET last_run_at = ?, last_status = 'ok', last_message = ?, last_new_count = ?,
         last_upd_count = ?, fail_streak = 0, updated_at = ?
     WHERE id = ?`
  ).run(now(), msg, stats.new_count, stats.updated_count, now(), src.id);

  writeLog(db, Object.assign({}, context, {
    action: 'collect_ok', message: msg,
    detail: { rejected: rejectReasons, mailbox: cfg.mailbox || 'INBOX' },
    item_count: stats.new_count + stats.updated_count
  }));

  return Object.assign({
    sourceId: src.id, sourceName: name, status: 'ok',
    message: msg, mails: mails.length, rejectReasons, nextRunAt: nextRunAt({ last_run_at: now() })
  }, stats);
}

/* ------------------------------------------------------------------ */
/* 暂存区审核                                                          */
/* ------------------------------------------------------------------ */

/** 暂存区列表 */
function listStaging(db, q) {
  const query = q || {};
  const where = ['s.deleted_at IS NULL'];
  const params = [];
  if (query.status) { where.push('s.status = ?'); params.push(query.status); }
  if (query.source_id) { where.push('s.source_id = ?'); params.push(Number(query.source_id)); }
  if (query.region_code) { where.push('s.region_code = ?'); params.push(query.region_code); }
  if (query.keyword) {
    where.push('(s.project_name LIKE ? OR s.title LIKE ? OR s.tenderee LIKE ? OR s.project_code LIKE ?)');
    const kw = `%${query.keyword}%`;
    params.push(kw, kw, kw, kw);
  }
  if (query.min_score) { where.push('s.match_score >= ?'); params.push(Number(query.min_score)); }
  if (query.has_personal === '1') where.push('s.has_personal_info = 1');

  const whereSql = 'WHERE ' + where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM collect_staging s ${whereSql}`).get(...params).n;

  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 20, 1), 200);
  const list = db.prepare(
    `SELECT s.* FROM collect_staging s ${whereSql}
     ORDER BY s.match_score DESC, s.collected_at DESC, s.id DESC
     LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize).map(plain);

  const counts = {};
  for (const row of db.prepare(
    'SELECT status, COUNT(*) AS n FROM collect_staging WHERE deleted_at IS NULL GROUP BY status'
  ).all()) counts[row.status] = row.n;

  return { list, total, page, pageSize, counts };
}

/** 单条详情 */
function getStaging(db, id) {
  const row = plain(db.prepare('SELECT * FROM collect_staging WHERE id = ? AND deleted_at IS NULL').get(Number(id)));
  if (!row) {
    const e = new Error('暂存记录不存在');
    e.status = 404; e.code = 'NOT_FOUND';
    throw e;
  }
  return row;
}

/**
 * 审核：把暂存记录写入正式项目库。
 * 未经人工确认绝不入正式库 —— 因此这里必须显式传 action='approve'。
 * @param {object} payload { id, action:'approve'|'reject', customer_id, stage, remark, reject_reason }
 */
function reviewStaging(db, payload) {
  const id = Number(payload.id);
  const row = getStaging(db, id);
  const ts = now();

  if (payload.action === 'reject') {
    /* 已入库的记录不能再改成"已忽略"：项目已经在正式库里了，
       若允许多半会出现"项目存在但暂存说已忽略"的矛盾状态。 */
    if (row.status === 'approved' && row.project_id) {
      const e = new Error('该公告已转入项目库，不能再标记为忽略；如需撤销请删除对应项目');
      e.status = 400; e.code = 'ALREADY_APPROVED';
      e.projectId = row.project_id;
      throw e;
    }
    db.prepare(
      `UPDATE collect_staging SET status = 'rejected', reject_reason = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(String(payload.reject_reason || '人工判定不相关'), ts, ts, id);
    writeLog(db, {
      source_id: row.source_id, source_name: row.source_name,
      action: 'staging_reject', message: `已忽略采集公告：${row.project_name || row.title}`
    });
    return { id, status: 'rejected' };
  }

  if (payload.action !== 'approve') {
    const e = new Error('请明确指定审核动作（approve / reject）');
    e.status = 400; e.code = 'ACTION_REQUIRED';
    throw e;
  }

  /* 已入库的记录不能重复入库（否则会出现同编号的重复项目） */
  if (row.status === 'approved' && row.project_id) {
    const e = new Error('该公告已经转入项目库，无需重复入库');
    e.status = 400; e.code = 'ALREADY_APPROVED';
    e.projectId = row.project_id;
    throw e;
  }

  /* 入库前必须确认关联客户（避免产生无主项目） */
  const customerId = Number(payload.customer_id || 0);
  if (!customerId) {
    const e = new Error('请先选择该项目归属的客户');
    e.status = 400; e.code = 'CUSTOMER_REQUIRED';
    throw e;
  }
  const cust = db.prepare('SELECT id, name FROM customers WHERE id = ? AND deleted_at IS NULL').get(customerId);
  if (!cust) {
    const e = new Error('所选客户不存在');
    e.status = 400; e.code = 'CUSTOMER_NOT_FOUND';
    throw e;
  }

  db.exec('BEGIN');
  try {
    /* 1) 写入正式项目库，并带上来源溯源字段 */
    const info = db.prepare(
      `INSERT INTO projects
        (name, customer_id, stage, end_user, design_institute, contract_amount,
         bid_date, bid_result, owner, remark, data_origin,
         source_url, source_platform, collected_at, source_notice_id, confidence,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '招标采集', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      String(payload.name || row.project_name || row.title || '未命名项目'),
      customerId,
      String(payload.stage || '信息收集'),
      row.tenderee || '',
      row.design_institute || '',
      Number(payload.contract_amount || row.amount || 0),
      row.bid_date || '',
      String(payload.bid_result || '未投标'),
      String(payload.owner || ''),
      String(payload.remark || buildRemark(row)),
      row.source_url || '',
      row.source_platform || '',
      row.collected_at || ts,
      row.notice_id || '',
      Number(row.match_score || 0),
      ts, ts
    );
    const projectId = Number(info.lastInsertRowid);

    /* 2) 更新暂存状态并回填 project_id（可溯源） */
    db.prepare(
      `UPDATE collect_staging SET status = 'approved', project_id = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(projectId, ts, ts, id);

    /* 3) 操作日志（与手动录入的项目一致地留痕） */
    db.prepare(
      `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
       VALUES ('project', ?, 'create', ?, ?, ?)`
    ).run(projectId, `由招标采集转入项目：${row.project_name || row.title}`, JSON.stringify({
      from: 'collect', staging_id: id, source_platform: row.source_platform,
      source_url: row.source_url, notice_id: row.notice_id, confidence: row.match_score
    }), ts);

    db.exec('COMMIT');
    writeLog(db, {
      source_id: row.source_id, source_name: row.source_name,
      action: 'staging_approve',
      message: `采集公告已转入项目库：${row.project_name || row.title}`,
      detail: { project_id: projectId, customer_id: customerId }
    });
    return { id, status: 'approved', project_id: projectId, customer_id: customerId };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 审核入库时写入项目备注，保留可追溯信息 */
function buildRemark(row) {
  const parts = [];
  if (row.project_code) parts.push(`公告编号：${row.project_code}`);
  if (row.region_name) parts.push(`所属地区：${row.region_name}`);
  if (row.tenderee) parts.push(`招标人：${row.tenderee}`);
  if (row.agency) parts.push(`代理机构：${row.agency}`);
  if (row.amount) parts.push(`公告金额：${Math.round(row.amount * 100) / 100} 元`);
  if (row.has_personal_info) {
    parts.push(`原公告含${row.personal_fields || '联系人信息'}，已按合规要求不采集，请点击来源链接自行查看`);
  }
  parts.push(`来源：${row.source_platform || '邮件订阅'}`);
  return parts.join('；');
}

/** 批量忽略 */
function rejectStaging(db, ids, reason) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  let n = 0;
  const ts = now();
  for (const id of list) {
    const row = db.prepare('SELECT id, status FROM collect_staging WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!row || row.status === 'approved') continue;
    db.prepare(
      `UPDATE collect_staging SET status = 'rejected', reject_reason = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(String(reason || '人工批量忽略'), ts, ts, id);
    n++;
  }
  if (n) writeLog(db, { action: 'staging_reject_batch', message: `批量忽略 ${n} 条采集公告`, item_count: n });
  return { rejected: n };
}

/** 采集统计（供界面顶部展示） */
function collectSummary(db) {
  const one = (sql, ...p) => db.prepare(sql).get(...p).n;
  const sources = db.prepare('SELECT COUNT(*) AS n FROM collect_sources WHERE deleted_at IS NULL').get().n;
  const enabled = db.prepare('SELECT COUNT(*) AS n FROM collect_sources WHERE deleted_at IS NULL AND enabled = 1').get().n;
  const pending = one("SELECT COUNT(*) AS n FROM collect_staging WHERE deleted_at IS NULL AND status = 'pending'");
  const approved = one("SELECT COUNT(*) AS n FROM collect_staging WHERE deleted_at IS NULL AND status = 'approved'");
  const rejected = one("SELECT COUNT(*) AS n FROM collect_staging WHERE deleted_at IS NULL AND status = 'rejected'");
  const personal = one('SELECT COUNT(*) AS n FROM collect_staging WHERE deleted_at IS NULL AND has_personal_info = 1');
  const lastRun = db.prepare(
    `SELECT name AS source_name, last_run_at, last_status, last_message, last_new_count, last_upd_count
     FROM collect_sources WHERE deleted_at IS NULL AND last_run_at <> '' ORDER BY last_run_at DESC LIMIT 1`
  ).get();

  /* 下次可采集时间：所有启用来源里最早的那个 */
  const enabledRows = db.prepare(
    'SELECT * FROM collect_sources WHERE deleted_at IS NULL AND enabled = 1 ORDER BY id'
  ).all().map(plain);
  let nextRun = '';
  if (enabledRows.length) {
    const times = enabledRows.map((r) => (isDue(r) ? now() : nextRunAt(r))).filter(Boolean).sort();
    nextRun = times[0] || '';
  }

  /* 入库项目里来自采集的数量 */
  const fromCollect = one("SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL AND source_platform <> ''");

  return {
    sources, enabled, pending, approved, rejected, personalInfo: personal,
    fromCollect,
    lastRun: lastRun ? plain(lastRun) : null,
    nextRunAt: nextRun,
    intervalHours: INTERVAL_HOURS,
    logKeepDays: LOG_KEEP_DAYS
  };
}

/** 采集日志列表 */
function listLogs(db, q) {
  const query = q || {};
  const where = [];
  const params = [];
  if (query.source_id) { where.push('source_id = ?'); params.push(Number(query.source_id)); }
  if (query.level) { where.push('level = ?'); params.push(query.level); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM collect_logs ${whereSql}`).get(...params).n;
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 50, 1), 200);
  const list = db.prepare(
    `SELECT * FROM collect_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize).map(plain);
  return { list, total, page, pageSize };
}

module.exports = {
  INTERVAL_HOURS,
  MAX_FAIL_STREAK,
  LOG_KEEP_DAYS,
  ALLOWED_SOURCE_TYPES,
  runCollect,
  runOneSource,
  isDue,
  nextRunAt,
  listSources,
  readSourceFull,
  saveSource,
  deleteSource,
  upsertStaging,
  listStaging,
  getStaging,
  reviewStaging,
  rejectStaging,
  collectSummary,
  listLogs,
  writeLog,
  pruneLogs
};
