/**
 * IMAP 客户端测试（对着本地模拟 IMAP 服务器跑真实协议）
 *
 * 覆盖：
 *   - AUTHENTICATE PLAIN 登录（凭据不写进日志）
 *   - LOGIN 登录 + 日志脱敏（口令绝不出现在日志里）
 *   - 错误口令被拒绝
 *   - 列文件夹（含中文文件夹名 modified UTF-7）
 *   - EXAMINE 只读打开（不发送任何 STORE/EXPUNGE）
 *   - UID SEARCH：UNSEEN / SINCE / UID 区间
 *   - UID FETCH：BODY.PEEK[] 取回完整原文并与磁盘文件逐字节比对
 *   - 服务器关闭 / 超时的错误处理
 *   - 常用邮箱服务商预设完整性
 *
 * 用法：node tools/test-collect-imap.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { startMockImap, loadMailFixtures } = require(path.join(ROOT, '.fixtures', 'mock-imap.js'));
const imap = require(path.join(ROOT, 'server', 'collect', 'imap.js'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

const MAIL_DIR = path.join(ROOT, '.fixtures', 'mail');

(async () => {
  console.log('=== IMAP 客户端测试（本地模拟服务器）===\n');

  /* ---------- 准备 ---------- */
  const inbox = loadMailFixtures('INBOX');
  const subscribe = loadMailFixtures('招标订阅');
  /* 给第二封打个 \Seen，用于验证 UNSEEN 过滤 */
  if (inbox.messages[1]) inbox.messages[1].flags = ['\\Seen'];

  const srv = await startMockImap({
    user: 'me@example.com',
    pass: 'auth-code-123456',
    requireAuthPlain: true,
    mailboxes: [
      inbox,
      subscribe,
      { name: 'Sent', messages: [], flags: ['\\HasNoChildren', '\\Sent'] }
    ]
  });
  console.log(`模拟服务器已启动：127.0.0.1:${srv.port}，收件箱 ${inbox.messages.length} 封\n`);

  const logs = [];

  /* ---------- 1. AUTHENTICATE PLAIN 登录 ---------- */
  {
    const c = new imap.ImapClient({
      host: '127.0.0.1', port: srv.port, secure: false,
      user: 'me@example.com', pass: 'auth-code-123456',
      logger: (m) => logs.push(m)
    });
    await c.connect();
    const caps = await c.capability();
    check('连接并取得 CAPABILITY', caps.includes('IMAP4rev1'), caps.join(' '));

    await c.login();
    check('AUTHENTICATE PLAIN 登录成功', true, '无异常');

    const leaked = logs.filter((l) => l.includes('auth-code-123456'));
    check('授权码未出现在日志中', leaked.length === 0,
      leaked.length ? `泄漏 ${leaked.length} 条` : `共 ${logs.length} 条日志，均无授权码`);

    await c.logout();
    check('LOGOUT 正常断开', c.closed === true, '连接已关闭');
  }

  /* ---------- 2. LOGIN 分支与脱敏 ---------- */
  {
    const srv2 = await startMockImap({
      user: 'me@example.com', pass: 'pw-with-"quote"',
      requireAuthPlain: false,
      mailboxes: [{ name: 'INBOX', messages: [] }]
    });
    const logs2 = [];
    const c = new imap.ImapClient({
      host: '127.0.0.1', port: srv2.port, secure: false,
      user: 'me@example.com', pass: 'pw-with-"quote"',
      logger: (m) => logs2.push(m)
    });
    await c.connect();
    await c.capability();
    await c.login();
    check('无 AUTH=PLAIN 时退化为 LOGIN 并成功（含引号口令转义）', true, '登录成功');
    const leaked2 = logs2.filter((l) => l.includes('pw-with'));
    check('LOGIN 分支日志已脱敏', leaked2.length === 0,
      leaked2.length ? '日志含口令' : '日志中口令显示为 ***');
    /* 服务器确实收到了真实口令（证明脱敏只作用于日志） */
    const gotLogin = srv2.requests.some((r) => r.includes('LOGIN') && r.includes('pw-with'));
    check('服务器端确实收到正确口令（脱敏仅作用于日志）', gotLogin, '协议内容正确');
    await c.logout();
    await srv2.close();
  }

  /* ---------- 3. 错误口令 ---------- */
  {
    const c = new imap.ImapClient({
      host: '127.0.0.1', port: srv.port, secure: false,
      user: 'me@example.com', pass: 'wrong-pass'
    });
    await c.connect();
    let err = null;
    try { await c.login(); } catch (e) { err = e; }
    check('错误授权码被拒绝并抛出可读错误', !!err && /NO|invalid|AUTHENTICATIONFAILED/i.test(err.message),
      err ? err.message : '未抛错');
    c.destroy();
  }

  /* ---------- 4. 列文件夹（含中文名） ---------- */
  {
    const c = new imap.ImapClient({
      host: '127.0.0.1', port: srv.port, secure: false,
      user: 'me@example.com', pass: 'auth-code-123456'
    });
    await c.connect();
    await c.login();
    const boxes = await c.listMailboxes();
    check('列出全部文件夹', boxes.length === 3, boxes.map((b) => b.name).join(' / '));
    check('中文文件夹名正确解析', boxes.some((b) => b.name === '招标订阅'),
      boxes.find((b) => b.name.includes('招标')) ? '识别到「招标订阅」' : '未识别');

    /* ---------- 5. EXAMINE 只读 ---------- */
    const info = await c.select('INBOX', true);
    check('EXAMINE 打开收件箱并取到邮件数', info.exists === inbox.messages.length,
      `EXISTS=${info.exists}，UIDVALIDITY=${info.uidValidity}`);

    /* ---------- 6. UID SEARCH ---------- */
    const all = await c.uidSearch(['ALL']);
    check('UID SEARCH ALL 返回全部 UID', all.length === inbox.messages.length,
      `${all.length} 封：${all.join(', ')}`);

    const unseen = await c.uidSearch(['UNSEEN']);
    check('UID SEARCH UNSEEN 正确过滤已读邮件',
      unseen.length === inbox.messages.length - 1,
      `未读 ${unseen.length} 封（共 ${inbox.messages.length}，其中 1 封标记已读）`);

    const since = await c.uidSearch(['SINCE', imap.imapDate(new Date(2026, 2, 5))]);
    check('UID SEARCH SINCE 按日期过滤', since.length > 0 && since.length <= all.length,
      `2026-03-05 起 ${since.length} 封`);

    const range = await c.uidSearch(['UID', all[0] + ':' + all[0]]);
    check('UID SEARCH UID 区间过滤', range.length === 1 && range[0] === all[0], `命中 UID ${range[0]}`);

    /* ---------- 7. UID FETCH 原文一致性 ---------- */
    const fetched = await c.uidFetch(all.slice(0, 3));
    check('UID FETCH 取回 3 封', fetched.length === 3, fetched.map((f) => f.uid).join(', '));

    const first = fetched[0];
    const file0 = path.join(MAIL_DIR, inbox.messages.find((m) => m.uid === first.uid).file);
    const disk = fs.readFileSync(file0);
    check('取回的原文与磁盘夹具逐字节一致',
      Buffer.isBuffer(first.raw) && first.raw.length === disk.length && first.raw.equals(disk),
      `${first.raw ? first.raw.length : 0} 字节 vs ${disk.length} 字节`);

    check('FETCH 响应解析出 UID / SIZE / INTERNALDATE / FLAGS',
      first.uid > 0 && first.size > 0 && !!first.internalDate && Array.isArray(first.flags),
      `UID=${first.uid} SIZE=${first.size} DATE=${first.internalDate && first.internalDate.toISOString()} FLAGS=[${first.flags.join(' ')}]`);

    /* 取回的原文可直接交给 MIME 解析器 */
    const mail = require(path.join(ROOT, 'server', 'collect', 'mail.js'));
    const parsed = mail.parseMail(first.raw);
    check('取回原文可直接被 MIME 解析（端到端打通）',
      parsed.subject.length > 0 && parsed.text.length > 20,
      `主题「${parsed.subject.slice(0, 34)}」`);

    /* ---------- 8. 只读性：绝不发送会改状态的命令 ---------- */
    const mutating = srv.requests.filter((r) => /\b(STORE|EXPUNGE|COPY|MOVE|APPEND|DELETE)\b/i.test(r));
    check('全程未发送任何会改动邮箱状态的命令（只读保证，对应验收标准 C2）',
      mutating.length === 0,
      mutating.length ? `发现：${mutating.join(' | ')}` : `已检查 ${srv.requests.length} 条命令，无 STORE/EXPUNGE/APPEND 等`);
    check('取信使用 BODY.PEEK[] 而非 BODY[]（不置已读）',
      srv.requests.some((r) => /BODY\.PEEK\[\]/i.test(r)),
      'FETCH 命令含 BODY.PEEK[]');

    await c.logout();
  }

  /* ---------- 9. 异常处理 ---------- */
  {
    /* 连不上的端口 */
    const c = new imap.ImapClient({
      host: '127.0.0.1', port: 1, secure: false, timeout: 3000,
      user: 'a', pass: 'b'
    });
    let err = null;
    try { await c.connect(); } catch (e) { err = e; }
    check('端口不通时抛出可读错误', !!err && /失败|超时|refused|ECONN/i.test(err.message),
      err ? err.message.slice(0, 60) : '未抛错');
    c.destroy();

    /* 连接后服务器关闭 */
    const srv3 = await startMockImap({ user: 'u', pass: 'p', mailboxes: [] });
    const c3 = new imap.ImapClient({
      host: '127.0.0.1', port: srv3.port, secure: false, user: 'u', pass: 'p', timeout: 3000
    });
    await c3.connect();
    await c3.login();
    await srv3.close();
    await new Promise((s) => setTimeout(s, 200));
    let err3 = null;
    try { await c3.select('INBOX', true); } catch (e) { err3 = e; }
    check('服务器断开后的命令抛出可读错误', !!err3,
      err3 ? err3.message.slice(0, 50) : '未抛错');
    c3.destroy();

    /* 不存在的文件夹 */
    const c4 = new imap.ImapClient({
      host: '127.0.0.1', port: srv.port, secure: false,
      user: 'me@example.com', pass: 'auth-code-123456'
    });
    await c4.connect();
    await c4.login();
    let err4 = null;
    try { await c4.select('不存在的文件夹', true); } catch (e) { err4 = e; }
    check('打开不存在的文件夹时抛出错误', !!err4 && /NONEXISTENT|not found/i.test(err4.message),
      err4 ? err4.message.slice(0, 50) : '未抛错');
    await c4.logout();
  }

  /* ---------- 10. 服务商预设 ---------- */
  {
    const need = ['qq', '163', '126', 'exmail', 'outlook', 'custom'];
    const miss = need.filter((k) => !imap.PROVIDERS[k]);
    check('常用邮箱服务商预设齐全', miss.length === 0,
      miss.length ? `缺少 ${miss.join(', ')}` : Object.values(imap.PROVIDERS).map((p) => p.label).join(' / '));
    const bad = Object.entries(imap.PROVIDERS).filter(([, v]) => !v.hint || v.port !== 993);
    check('每个预设都带授权码获取提示且端口正确', bad.length === 0,
      bad.length ? bad.map(([k]) => k).join(', ') : '6 个预设均完整');
  }

  /* ---------- 11. modified UTF-7 ---------- */
  {
    const enc = imap.encodeMUTF7('招标订阅');
    const dec = imap.decodeMUTF7(enc);
    check('modified UTF-7 编解码可往返', dec === '招标订阅', `${enc} → ${dec}`);
    check('纯 ASCII 名称不被改写', imap.encodeMUTF7('INBOX') === 'INBOX', 'INBOX 原样');
    check('& 字符按规范转义为 &-', imap.encodeMUTF7('A&B') === 'A&-B', imap.encodeMUTF7('A&B'));
  }

  /* ---------- 汇总 ---------- */
  await srv.close();

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'collect-imap-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
