/**
 * 提醒发送模块（邮件）
 *
 * 定位：本项目**第二个会联网的模块**（第一个是招标采集）。三条护栏：
 *   1. 默认关闭（remind_email_on = 0）。未开启时本模块**不建立任何连接**。
 *   2. 只发给自己：收件人固定取设置里的 remind_email_to（留空则发给发件账号本身），
 *      不提供任意收件人参数，避免被误用成群发工具。
 *   3. 失败不重试轰炸：每天只尝试一次；连续失败 3 次自动关闭邮件提醒并提示原因。
 *
 * 调度：由 server.js 定时检查（默认每天 remind_email_time 发一次），
 *       无待提醒项时**不发信**（避免每天收空邮件）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const smtp = require('./smtp');
const reminders = require('../services/reminders');

/** 连续失败达到此值即自动关闭邮件提醒 */
const FAIL_STREAK_LIMIT = 3;

/** 允许保存/读取的设置键（白名单，避免任意键写入） */
const REMIND_SETTING_KEYS = [
  'follow_remind_days', 'follow_remind_time', 'follow_remind_quiet', 'follow_remind_on_start',
  'remind_email_on', 'remind_email_time', 'remind_email_to',
  'smtp_provider', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass',
  'company_name'
];
/** 授权码不回传，只回传"是否已配置" */
const SECRET_KEYS = ['smtp_pass'];

/** 运行时状态（不落库；失败次数落库以便重启后仍能触发降级） */
const runtime = {
  sending: false,
  lastAttemptAt: '',
  lastResult: '',
  lastMessage: ''
};

/* ------------------------------------------------------------------ */
/* 设置读写                                                            */
/* ------------------------------------------------------------------ */

function readRemindSettings(db) {
  const rows = db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${REMIND_SETTING_KEYS.map(() => '?').join(',')})`
  ).all(...REMIND_SETTING_KEYS);
  const map = {};
  for (const r of rows) {
    if (SECRET_KEYS.includes(r.key)) {
      /* 只回传是否已配置，绝不回传明文 */
      map[r.key + '_configured'] = String(r.value || '').length > 0;
    } else {
      map[r.key] = r.value;
    }
  }
  /* 补齐未落库的键，避免前端 undefined */
  for (const k of REMIND_SETTING_KEYS) {
    if (SECRET_KEYS.includes(k)) {
      if (map[k + '_configured'] === undefined) map[k + '_configured'] = false;
    } else if (map[k] === undefined) {
      map[k] = '';
    }
  }
  return Object.assign({}, map, runtime, {
    providers: Object.entries(smtp.PROVIDERS).map(([key, v]) => ({ key, label: v.label, host: v.host, port: v.port }))
  });
}

/**
 * 保存提醒设置。
 * 授权码特殊处理：空字符串表示"不修改"，传 '__CLEAR__' 表示清空。
 */
function saveRemindSettings(db, payload) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  const saved = [];
  db.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(payload || {})) {
      if (!REMIND_SETTING_KEYS.includes(k)) continue;
      let val = v === undefined || v === null ? '' : String(v);
      if (SECRET_KEYS.includes(k)) {
        if (val === '') continue;                    // 空 = 不修改
        if (val === '__CLEAR__') val = '';           // 显式清空
      }
      /* 时间格式（HH:mm）简单校验，避免存进离谱值 */
      if ((k === 'follow_remind_time' || k === 'remind_email_time') && val && !/^\d{1,2}:\d{2}$/.test(val)) {
        throw new Error(`「${k}」的时间格式应为 HH:mm，收到「${val}」`);
      }
      if (k === 'follow_remind_days') {
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0 || n > 60) throw new Error('跟进提醒提前天数应为 0~60 之间的数字');
      }
      if (k === 'smtp_port') {
        const n = Number(val);
        if (val && (!Number.isFinite(n) || n < 1 || n > 65535)) throw new Error('SMTP 端口应为 1~65535');
      }
      upsert.run(k, val, ts);
      saved.push(k);
    }

    /* 换了服务商预设时，同步 host/port（用户手改过则以手改值为准，这里只在 host 为空时补） */
    if (payload && payload.smtp_provider) {
      const preset = smtp.PROVIDERS[payload.smtp_provider];
      if (preset && preset.host) {
        const cur = db.prepare('SELECT value FROM settings WHERE key = ?').get('smtp_host');
        if (!cur || !String(cur.value || '').trim()) {
          upsert.run('smtp_host', preset.host, ts);
          upsert.run('smtp_port', String(preset.port), ts);
          saved.push('smtp_host', 'smtp_port');
        }
      }
    }
    /* 启用邮件时必须配置完整，否则直接报错（避免"以为开了其实没配"） */
    if (payload && String(payload.remind_email_on) === '1') {
      const cfg = loadMailConfig(db);
      const v = smtp.validateConfig(cfg);
      if (!v.ok) throw new Error('启用邮件提醒前请先填写：' + v.missing.join('、'));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { saved: [...new Set(saved)], settings: readRemindSettings(db) };
}

/* ------------------------------------------------------------------ */
/* 配置装配                                                            */
/* ------------------------------------------------------------------ */

/** 从设置表装配发送配置；不回传授权码给前端，但内部使用需要 */
function loadMailConfig(db) {
  const get = (k) => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return r ? String(r.value || '') : '';
  };
  return {
    provider: get('smtp_provider') || 'qq',
    host: get('smtp_host') || '',
    port: get('smtp_port') || '465',
    user: get('smtp_user') || '',
    pass: get('smtp_pass') || '',
    to: get('remind_email_to') || '',
    fromName: get('company_name') || '客户管理系统'
  };
}

/** 是否已启用邮件提醒 */
function emailEnabled(db) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get('remind_email_on');
  return r && String(r.value) === '1';
}

/* ------------------------------------------------------------------ */
/* 发送状态（落库，供界面展示与降级判断）                                */
/* ------------------------------------------------------------------ */

const STATE_FILE_KEYS = {
  streak: 'remind_email_fail_streak',
  lastAt: 'remind_email_last_at',
  lastOk: 'remind_email_last_ok',
  lastMsg: 'remind_email_last_msg',
  lastDay: 'remind_email_last_day'
};

function stateGet(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE_FILE_KEYS[key]);
  return r ? String(r.value || '') : '';
}

function stateSet(db, key, value) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(STATE_FILE_KEYS[key], String(value), ts);
}

/** 邮件通道状态（供界面显示） */
function emailStatus(db) {
  const cfg = loadMailConfig(db);
  const v = smtp.validateConfig(cfg);
  return {
    enabled: emailEnabled(db),
    configured: v.ok,
    missing: v.missing,
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    to: cfg.to || cfg.user,
    provideConfigured: cfg.pass.length > 0,
    failStreak: Number(stateGet(db, 'streak')) || 0,
    failStreakLimit: FAIL_STREAK_LIMIT,
    lastAt: stateGet(db, 'lastAt'),
    lastOk: stateGet(db, 'lastOk') === '1',
    lastMsg: stateGet(db, 'lastMsg'),
    lastDay: stateGet(db, 'lastDay'),
    sending: runtime.sending
  };
}

/* ------------------------------------------------------------------ */
/* 发送                                                                */
/* ------------------------------------------------------------------ */

/** 记录一次发送结果，返回是否已触发自动降级 */
function recordResult(db, ok, message) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  stateSet(db, 'lastAt', ts);
  stateSet(db, 'lastOk', ok ? '1' : '0');
  stateSet(db, 'lastMsg', String(message || '').slice(0, 300));
  runtime.lastAttemptAt = ts;
  runtime.lastResult = ok ? 'ok' : 'fail';
  runtime.lastMessage = String(message || '').slice(0, 300);

  if (ok) {
    stateSet(db, 'streak', '0');
    return false;
  }
  const streak = (Number(stateGet(db, 'streak')) || 0) + 1;
  stateSet(db, 'streak', String(streak));
  if (streak >= FAIL_STREAK_LIMIT) {
    /* 自动降级：关闭邮件提醒，只保留软件内提醒（避免天天失败天天重试） */
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('remind_email_on', '0', ?)
       ON CONFLICT(key) DO UPDATE SET value = '0', updated_at = excluded.updated_at`
    ).run(ts);
    stateSet(db, 'streak', '0');
    return true;
  }
  return false;
}

/** 测试发送：立即发一封，用于验证配置是否正确 */
async function sendTestEmail(db, settings) {
  const cfg = loadMailConfig(db);
  const v = smtp.validateConfig(cfg);
  if (!v.ok) {
    return { ok: false, status: 400, code: 'EMAIL_NOT_CONFIGURED', message: '请先填写：' + v.missing.join('、') };
  }
  const to = cfg.to || cfg.user;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  try {
    const r = await smtp.sendMail({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      pass: cfg.pass,
      from: cfg.user,
      fromName: cfg.fromName,
      to,
      subject: `【测试】客户管理系统邮件提醒配置正常 ${now}`,
      text: `这是一封测试邮件。\n\n如果你收到它，说明邮件提醒配置正确。\n发送时间：${now}\n发件账号：${cfg.user}\n收件地址：${to}\n\n'
        + '正式提醒会在每天设定的时间发送，且当天没有待跟进客户时不会发信。`,
      html: `<div style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#0f172a">
        <h3 style="margin:0 0 10px">邮件提醒配置正常</h3>
        <p style="color:#475569;font-size:14px;line-height:1.8">
          如果你收到这封邮件，说明邮件提醒已配置成功。<br>
          发送时间：${now}<br>
          发件账号：${cfg.user}<br>
          收件地址：${to}
        </p>
        <p style="color:#94a3b8;font-size:12px;line-height:1.7">
          正式提醒会在每天设定的时间发送；当天没有待跟进客户时不会发信。
        </p>
      </div>`
    });
    recordResult(db, true, `测试邮件发送成功（${r.ms} ms）`);
    return { ok: true, data: { ms: r.ms, to, message: `测试邮件已发送到 ${to}，请查收（也看看垃圾箱）` } };
  } catch (e) {
    const degraded = recordResult(db, false, e.message);
    return {
      ok: false,
      status: 400,
      code: 'EMAIL_SEND_FAILED',
      message: e.message + (degraded ? '（连续失败已达上限，邮件提醒已自动关闭）' : '')
    };
  }
}

/**
 * 发送当日提醒。
 * @param {object} db
 * @param {object} settings
 * @param {object} [opts] { force: true 时忽略"今天已发过"的限制 }
 */
async function sendDailyReminder(db, settings, opts) {
  const o = opts || {};
  const today = reminders.ymd();

  if (runtime.sending) {
    return { ok: false, status: 429, code: 'EMAIL_BUSY', message: '正在发送中，请稍候' };
  }
  if (!o.force && !emailEnabled(db)) {
    return { ok: false, status: 400, code: 'EMAIL_DISABLED', message: '邮件提醒未启用' };
  }
  if (!o.force && stateGet(db, 'lastDay') === today) {
    return { ok: false, status: 400, code: 'EMAIL_SENT_TODAY', message: '今天已经发送过了' };
  }

  const data = reminders.dueFollowups(db, settings, { ignoreWindow: true });
  const mail = reminders.buildEmail(data, settings);
  if (!mail) {
    /* 无待提醒项：不发空邮件 */
    stateSet(db, 'lastDay', today);
    recordResult(db, true, '当天无待跟进客户，未发送');
    return { ok: true, data: { sent: false, count: 0, message: '当天没有待跟进客户，未发送邮件' } };
  }

  const cfg = loadMailConfig(db);
  const v = smtp.validateConfig(cfg);
  if (!v.ok) {
    return { ok: false, status: 400, code: 'EMAIL_NOT_CONFIGURED', message: '请先填写：' + v.missing.join('、') };
  }

  runtime.sending = true;
  try {
    const r = await smtp.sendMail({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      pass: cfg.pass,
      from: cfg.user,
      fromName: cfg.fromName,
      to: cfg.to || cfg.user,
      subject: mail.subject,
      text: mail.text,
      html: mail.html
    });
    stateSet(db, 'lastDay', today);
    recordResult(db, true, `已发送 ${mail.count} 位客户的提醒（${r.ms} ms）`);
    return { ok: true, data: { sent: true, count: mail.count, ms: r.ms, to: cfg.to || cfg.user, subject: mail.subject } };
  } catch (e) {
    const degraded = recordResult(db, false, e.message);
    return {
      ok: false,
      status: 400,
      code: 'EMAIL_SEND_FAILED',
      message: e.message + (degraded ? '（连续失败已达上限，邮件提醒已自动关闭）' : '')
    };
  } finally {
    runtime.sending = false;
  }
}

/**
 * 定时检查：到点且今天没发过就发一次。
 * 由 server.js 的定时器调用；未启用邮件时**立即返回，不建立任何连接**。
 */
async function tick(db, settings) {
  try {
    if (!emailEnabled(db)) return { skipped: 'disabled' };
    const want = String(settings.remind_email_time || '08:30');
    const now = new Date();
    const cur = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (cur < want) return { skipped: 'before-time' };
    const today = reminders.ymd();
    if (stateGet(db, 'lastDay') === today) return { skipped: 'already-sent' };
    const r = await sendDailyReminder(db, settings);
    return r;
  } catch (e) {
    return { skipped: 'error', message: e.message };
  }
}

module.exports = {
  readRemindSettings,
  saveRemindSettings,
  loadMailConfig,
  emailEnabled,
  emailStatus,
  sendTestEmail,
  sendDailyReminder,
  tick,
  FAIL_STREAK_LIMIT,
  REMIND_SETTING_KEYS
};
