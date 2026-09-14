/**
 * 邮件提醒测试
 *
 * 覆盖：
 *   1. SMTP 客户端：与本地模拟服务器完成完整投递（EHLO→AUTH→MAIL→RCPT→DATA→QUIT）
 *   2. 认证失败（535）给出可操作的提示，且错误信息里**不泄漏授权码**
 *   3. 超时与连接被关闭的处理
 *   4. 报文格式：中文主题 RFC 2047 编码、正文 base64、多部分结构
 *   5. 配置校验：缺项时明确列出缺什么
 *   6. 未启用邮件时**零外部网络连接**（离线承诺）
 *   7. 无待提醒项时不发空邮件
 *   8. 连续失败 3 次自动降级为关闭
 *
 * 用法（不需要真实邮箱，全部走本地模拟服务器）：
 *   node tools/test-notify-email.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const { startMockSmtp } = require('./.fixtures/mock-smtp');
const smtp = require(path.join(ROOT, 'server', 'notify', 'smtp.js'));
const reminders = require(path.join(ROOT, 'server', 'services', 'reminders.js'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

/** 造一个独立的临时库，避免碰真实数据 */
function makeDb() {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'notify-'));
  const dbFile = path.join(tmp, 'crm.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);
  db.exec(`CREATE TABLE customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, short_name TEXT, level TEXT, status TEXT, owner TEXT,
    phone TEXT, city TEXT, next_follow_at TEXT, last_follow_at TEXT, follow_count INTEGER DEFAULT 0,
    deleted_at TEXT)`);
  db.exec(`CREATE TABLE contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, name TEXT, mobile TEXT,
    is_primary INTEGER DEFAULT 0, deleted_at TEXT)`);
  const ts = '2026-09-14 08:00:00';
  const setS = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of [
    ['follow_remind_days', '3'], ['follow_remind_time', '09:00'], ['follow_remind_quiet', '18:00'],
    ['follow_remind_on_start', '1'], ['remind_email_on', '0'], ['remind_email_time', '08:30'],
    ['remind_email_to', ''], ['smtp_provider', 'custom'], ['smtp_host', ''], ['smtp_port', '465'],
    ['smtp_user', ''], ['smtp_pass', ''], ['company_name', '测试公司']
  ]) setS.run(k, v, ts);
  return { db, tmp, dbFile };
}

/* notify 模块从 settings 表读取，但需要 getSettings 形状的对象 */
function settingsOf(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return m;
}

(async () => {
  console.log('=== 邮件提醒测试 ===\n');

  /* ---------- 启动模拟 SMTP ---------- */
  const mock = await startMockSmtp({ user: 'me@example.com', pass: 'auth-code-123456' });
  console.log(`模拟 SMTP 已启动：127.0.0.1:${mock.port}\n`);

  /* ---------- 1. 完整投递 ---------- */
  try {
    const r = await smtp.sendMail({
      host: '127.0.0.1',
      port: mock.port,
      user: 'me@example.com',
      pass: 'auth-code-123456',
      from: 'me@example.com',
      fromName: '客户管理系统',
      to: 'me@example.com',
      subject: '客户跟进提醒 2026-09-14（2 位）',
      text: '纯文本正文：张三、李四',
      html: '<div>HTML 正文：<b>张三</b>、李四</div>'
    });
    check('SMTP 完整投递成功', r.ok === true, `耗时 ${r.ms} ms`);
    const rec = mock.records[0];
    check('服务端收到发件人与收件人', rec && rec.from === 'me@example.com' && rec.to[0] === 'me@example.com',
      rec ? `from=${rec.from} to=${rec.to.join(',')}` : '未收到');
    check('认证账号正确传递', rec && rec.authUser === 'me@example.com', rec ? rec.authUser : '-');
  } catch (e) {
    check('SMTP 完整投递成功', false, e.message);
  }

  /* ---------- 2. 报文格式 ---------- */
  const raw = (mock.records[0] || {}).raw || '';
  check('报文含 MIME 版本与多部分结构',
    /MIME-Version: 1\.0/i.test(raw) && /multipart\/alternative/.test(raw),
    raw ? `${raw.length} 字节` : '无报文');
  check('中文主题用 RFC 2047 编码（不乱码）',
    /Subject: =\?UTF-8\?B\?/.test(raw),
    (raw.match(/Subject: .*/) || ['未找到'])[0].slice(0, 80));
  check('正文用 base64 传输，且含 text 与 html 两部分',
    /Content-Transfer-Encoding: base64/.test(raw)
    && /Content-Type: text\/plain; charset=utf-8/.test(raw)
    && /Content-Type: text\/html; charset=utf-8/.test(raw),
    '两个 part');
  /* 解码验证内容可还原。
     注意：base64 正文按 76 字符折行，必须先去掉换行再解码；
     并要按 MIME 结构逐段取 body（头部与 body 之间以空行分隔）。 */
  function decodeMimeParts(rawMail) {
    const out = [];
    for (const seg of String(rawMail).split(/--crm_[A-Za-z0-9]+/)) {
      const i = seg.indexOf('\r\n\r\n');
      if (i < 0) continue;
      const headers = seg.slice(0, i);
      if (!/Content-Transfer-Encoding:\s*base64/i.test(headers)) continue;
      const b64 = seg.slice(i + 4).replace(/[\r\n]/g, '').trim();
      if (b64) out.push(Buffer.from(b64, 'base64').toString('utf8'));
    }
    return out.join('\n');
  }
  const decoded = decodeMimeParts(raw);
  /* 正文只应含正文本身（主题在头部，不在正文里） */
  check('正文内容可正确解码还原（中文完整）',
    decoded.includes('张三') && decoded.includes('李四') && !decoded.includes('Subject:'),
    `解码 ${decoded.length} 字，含「张三」=${decoded.includes('张三')}，含「李四」=${decoded.includes('李四')}`);

  /* 主题走 RFC 2047 编码字，应能解码回中文（验证不乱码的关键） */
  function decodeRfc2047(s) {
    return String(s).replace(/=\?UTF-8\?B\?([^?]+)\?=/gi,
      (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));
  }
  const subjectLine = (raw.match(/^Subject: (.*)$/m) || [])[1] || '';
  const subjectDecoded = decodeRfc2047(subjectLine);
  check('邮件主题经 RFC 2047 编码后可正确还原中文',
    subjectDecoded.includes('客户跟进提醒 2026-09-14（2 位）'),
    `主题还原为「${subjectDecoded}」`);
  check('长 base64 行已折行（每行 ≤76 字符，符合 RFC 5322）',
    raw.split('\r\n').filter((l) => /^[A-Za-z0-9+/=]{60,}$/.test(l)).every((l) => l.length <= 76),
    '已折行');

  /* ---------- 3. 认证失败 ---------- */
  const badMock = await startMockSmtp({ user: 'me@example.com', pass: 'right-code', failAuth: true });
  try {
    await smtp.sendMail({
      host: '127.0.0.1', port: badMock.port,
      user: 'me@example.com', pass: 'wrong-code-abcdef',
      from: 'me@example.com', to: 'me@example.com',
      subject: 't', text: 't', html: 't'
    });
    check('认证失败应报错', false, '未报错');
  } catch (e) {
    check('认证失败给出可操作提示', /535|认证失败/.test(e.message) && /授权码/.test(e.message),
      e.message.slice(0, 90));
    check('错误信息不泄漏授权码', !e.message.includes('wrong-code-abcdef') && !e.message.includes('right-code'),
      e.message.slice(0, 60));
  }
  await badMock.close();

  /* ---------- 4. 连接被关闭 ---------- */
  const closeMock = await startMockSmtp({ closeOnData: true });
  try {
    await smtp.sendMail({
      host: '127.0.0.1', port: closeMock.port,
      user: 'me@example.com', pass: 'auth-code-123456',
      from: 'me@example.com', to: 'me@example.com',
      subject: 't', text: 't', html: 't'
    });
    check('DATA 阶段被断开应报错', false, '未报错');
  } catch (e) {
    check('连接被关闭时给出明确错误', /关闭|错误|超时/.test(e.message), e.message.slice(0, 80));
  }
  await closeMock.close();

  /* ---------- 5. 超时 ---------- */
  const slowMock = await startMockSmtp({ greetingDelay: 3000 });
  try {
    await smtp.sendMail({
      host: '127.0.0.1', port: slowMock.port, timeout: 800,
      user: 'me@example.com', pass: 'auth-code-123456',
      from: 'me@example.com', to: 'me@example.com',
      subject: 't', text: 't', html: 't'
    });
    check('超时应报错', false, '未报错');
  } catch (e) {
    check('超时给出明确错误', /超时/.test(e.message), e.message.slice(0, 60));
  }
  await slowMock.close();

  /* ---------- 6. 配置校验 ---------- */
  const v1 = smtp.validateConfig({ host: '', port: '465', user: '', pass: '', to: '' });
  check('配置校验列出全部缺失项', v1.ok === false && v1.missing.length === 4, v1.missing.join('、'));
  const v2 = smtp.validateConfig({ host: 'x', port: '465', user: 'a@b.c', pass: 'p', to: 'a@b.c' });
  check('配置完整时校验通过', v2.ok === true, 'ok');
  check('服务商预设包含常见国内邮箱',
    ['qq', '163', '126', 'exmail', '189', 'custom'].every((k) => smtp.PROVIDERS[k]),
    Object.values(smtp.PROVIDERS).map((p) => p.label).join('、'));

  /* ---------- 7. 未启用邮件时零网络连接 ---------- */
  {
    const { db, tmp } = makeDb();
    const notify = require(path.join(ROOT, 'server', 'notify', 'index.js'));
    /* 记录所有 socket 连接尝试 */
    const tls = require('node:tls');
    const net = require('node:net');
    const origTls = tls.connect;
    const origNet = net.connect;
    let attempts = 0;
    tls.connect = function () { attempts++; return origTls.apply(this, arguments); };
    net.connect = function () { attempts++; return origNet.apply(this, arguments); };

    const before = JSON.parse(await (async () => {
      const t = await notify.tick(db, settingsOf(db));
      return JSON.stringify(t);
    })());
    const r1 = await notify.sendDailyReminder(db, settingsOf(db)).catch((e) => ({ message: e.message }));
    tls.connect = origTls;
    net.connect = origNet;

    check('未启用邮件时 tick 直接跳过', before.skipped === 'disabled', JSON.stringify(before));
    check('未启用邮件时发起发送被拒绝且不联网',
      r1.ok === false && r1.code === 'EMAIL_DISABLED' && attempts === 0,
      `${r1.message}；网络连接尝试 ${attempts} 次`);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ---------- 8. 无待提醒项时不发空邮件 ---------- */
  {
    const { db, tmp } = makeDb();
    const notify = require(path.join(ROOT, 'server', 'notify', 'index.js'));
    const ts = '2026-09-14 08:00:00';
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('remind_email_on', '1', ts);
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('smtp_host', '127.0.0.1', ts);
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('smtp_port', String(mock.port), ts);
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('smtp_user', 'me@example.com', ts);
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('smtp_pass', 'auth-code-123456', ts);

    const countBefore = mock.records.length;
    const r = await notify.sendDailyReminder(db, settingsOf(db));
    check('当天无待跟进客户时不发送邮件',
      r.ok === true && r.data.sent === false && mock.records.length === countBefore,
      r.data ? r.data.message : JSON.stringify(r));
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ---------- 9. 有待办时真实发送（走模拟服务器） ---------- */
  {
    const { db, tmp } = makeDb();
    const notify = require(path.join(ROOT, 'server', 'notify', 'index.js'));
    const ts = '2026-09-14 08:00:00';
    const setS = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
    setS.run('remind_email_on', '1', ts);
    setS.run('smtp_host', '127.0.0.1', ts);
    setS.run('smtp_port', String(mock.port), ts);
    setS.run('smtp_user', 'me@example.com', ts);
    setS.run('smtp_pass', 'auth-code-123456', ts);

    /* 造 3 位客户：1 逾期、1 今天、1 三天后；再加 1 位已成交（不应出现） */
    const today = reminders.ymd();
    const ins = db.prepare(`INSERT INTO customers (name, short_name, level, status, next_follow_at, deleted_at, follow_count)
                            VALUES (?, ?, ?, ?, ?, NULL, ?)`);
    ins.run('某某石化有限公司', '某某石化', 'A 重点客户', '跟进中',
      reminders.ymd(reminders.addDays(new Date(), -5)) + ' 10:00:00', 3);
    ins.run('某某设计院', '某某设计院', 'B 一般客户', '跟进中', today + ' 09:00:00', 1);
    ins.run('某某工程公司', '某某工程', '', '潜在', reminders.ymd(reminders.addDays(new Date(), 2)) + ' 14:00:00', 0);
    ins.run('已成交客户', '已成交', '', '已成交', reminders.ymd(reminders.addDays(new Date(), -1)), 0);
    const cid = db.prepare('SELECT id FROM customers WHERE short_name = ?').get('某某石化').id;
    db.prepare('INSERT INTO contacts (customer_id, name, mobile, is_primary, deleted_at) VALUES (?, ?, ?, 1, NULL)')
      .run(cid, '王经理', '13900000000');

    const countBefore = mock.records.length;
    const r = await notify.sendDailyReminder(db, settingsOf(db));
    check('有待跟进客户时成功发送',
      r.ok === true && r.data.sent === true && mock.records.length === countBefore + 1,
      r.data ? `发送 ${r.data.count} 位 → ${r.data.to}；主题「${r.data.subject}」` : JSON.stringify(r));
    check('已成交客户不进入提醒', r.data && r.data.count === 3, `计数 ${r.data ? r.data.count : '?'}（应为 3）`);

    const last = mock.records[mock.records.length - 1];
    /* 用同一个 MIME 解码函数，避免各写一份又写错 */
    const body = decodeMimeParts(last.raw);
    check('邮件正文含逾期与今天的分组标题',
      body.includes('已逾期') && body.includes('今天要跟进') && body.includes('临近跟进'),
      `三个分组：已逾期=${body.includes('已逾期')}、今天要跟进=${body.includes('今天要跟进')}、临近跟进=${body.includes('临近跟进')}`);
    check('邮件正文含客户与联系人信息',
      body.includes('某某石化') && body.includes('王经理') && body.includes('13900000000'),
      `客户名=${body.includes('某某石化')}、联系人=${body.includes('王经理')}、手机号=${body.includes('13900000000')}`);
    check('邮件正文不含已成交客户', !body.includes('已成交客户'), '已过滤');

    /* 同日重复发送应被拒绝 */
    const r2 = await notify.sendDailyReminder(db, settingsOf(db));
    check('同一天重复发送被拒绝',
      r2.ok === false && r2.code === 'EMAIL_SENT_TODAY', r2.message);
    /* force 可强制再发 */
    const r3 = await notify.sendDailyReminder(db, settingsOf(db), { force: true });
    check('force 可强制重发', r3.ok === true && r3.data.sent === true, `再发 ${r3.data.count} 位`);

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ---------- 10. 连续失败自动降级 ---------- */
  {
    const { db, tmp } = makeDb();
    const notify = require(path.join(ROOT, 'server', 'notify', 'index.js'));
    const ts = '2026-09-14 08:00:00';
    const setS = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
    /* 指向一个必定失败的端口 */
    setS.run('remind_email_on', '1', ts);
    setS.run('smtp_host', '127.0.0.1', ts);
    setS.run('smtp_port', '1', ts);              // 1 端口不可用
    setS.run('smtp_user', 'me@example.com', ts);
    setS.run('smtp_pass', 'auth-code-123456', ts);

    const today = reminders.ymd();
    db.prepare(`INSERT INTO customers (name, short_name, status, next_follow_at, deleted_at, follow_count)
                VALUES ('失败测试客户', '失败测试', '跟进中', ?, NULL, 0)`).run(today + ' 09:00:00');

    let degradedAt = 0;
    for (let i = 1; i <= 3; i++) {
      const r = await notify.sendDailyReminder(db, settingsOf(db), { force: true, timeout: 1500 });
      if (r.message && r.message.includes('自动关闭')) degradedAt = i;
    }
    const status = notify.emailStatus(db);
    check('连续失败 3 次后自动关闭邮件提醒',
      degradedAt === 3 && status.enabled === false,
      `第 ${degradedAt} 次触发降级；当前 enabled=${status.enabled}`);
    check('失败次数已清零（避免一直触发）', status.failStreak === 0, `failStreak=${status.failStreak}`);
    check('界面能看到失败原因', status.lastMsg.length > 0, status.lastMsg.slice(0, 70));

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  await mock.close();

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'notify-email-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
