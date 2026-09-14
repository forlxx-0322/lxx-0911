/**
 * 模拟 IMAP 服务器（仅用于测试）
 *
 * 为什么需要它：IMAP 客户端的正确性必须验证，但不能把真实邮箱凭据放进测试。
 * 这里用 Node 内置 tls/net 起一个最小 IMAP 服务端，按 RFC 3501 的响应格式应答，
 * 让客户端走完整的「连接 → 登录 → 列文件夹 → 打开 → 检索 → 取信 → 登出」流程。
 *
 * 支持：CAPABILITY / LOGIN / AUTHENTICATE PLAIN / LIST / EXAMINE / SELECT /
 *       UID SEARCH / UID FETCH (BODY.PEEK[]) / LOGOUT / NOOP
 *
 * 用法（测试脚本内）：
 *   const { startMockImap } = require('../.fixtures/mock-imap');
 *   const srv = await startMockImap({ user:'u', pass:'p', mailboxes:[...] });
 *   ... srv.port, srv.requests, srv.close()
 */
'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const CRLF = '\r\n';

/** UTF-8 → IMAP modified UTF-7（与 server/collect/imap.js 的实现保持一致） */
function encodeMUTF7(str) {
  return String(str).replace(/[^\x20-\x7E]|&/g, (ch) => {
    if (ch === '&') return '&-';
    const code = ch.charCodeAt(0);
    const buf = Buffer.from([code >> 8, code & 0xFF]);
    return '&' + buf.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
  });
}

/** Date → IMAP INTERNALDATE 格式："02-Mar-2026 09:15:33 +0800" */
function toInternalDate(d) {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  const date = d || new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  return `${p(date.getUTCDate())}-${MON[date.getUTCMonth()]}-${date.getUTCFullYear()} `
    + `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} +0000`;
}

/**
 * @param {object} opt
 *   user, pass              允许的凭据
 *   mailboxes: [{ name, messages: [{ uid, raw:Buffer|string, flags?, date? }] }]
 *   requireAuthPlain: 是否在 CAPABILITY 里通告 AUTH=PLAIN
 *   onCommand: (line) => void   记录收到的命令（用于断言日志脱敏等）
 */
function startMockImap(opt) {
  const o = Object.assign({ user: 'u', pass: 'p', mailboxes: [], requireAuthPlain: true }, opt || {});
  const requests = [];
  let authed = false;
  let selected = null;

  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let awaitingLiteral = 0;     // 等待 SASL 字面量的字节数
    let saslTag = null;

    socket.write('* OK [CAPABILITY IMAP4rev1' + (o.requireAuthPlain ? ' AUTH=PLAIN' : '') + '] mock ready' + CRLF);

    const send = (s) => { try { socket.write(s + CRLF); } catch (_) { /* 忽略 */ } };

    const findBox = (name) => o.mailboxes.find((b) => b.name === name
      || b.name.toLowerCase() === String(name).toLowerCase());

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      /* 正在等 SASL 字面量 */
      if (awaitingLiteral) {
        if (buf.length < awaitingLiteral) return;
        const payload = buf.slice(0, awaitingLiteral).toString('utf8');
        buf = buf.slice(awaitingLiteral);
        awaitingLiteral = 0;
        /* 跳过可能的 CRLF */
        if (buf.slice(0, 2).toString() === CRLF) buf = buf.slice(2);
        const [u, p] = payload.split('\u0000').slice(1);
        if (u === o.user && p === o.pass) { authed = true; send(`${saslTag} OK AUTHENTICATE completed`); }
        else send(`${saslTag} NO [AUTHENTICATIONFAILED] invalid credentials`);
        saslTag = null;
        return;
      }

      for (;;) {
        const eol = buf.indexOf(0x0A);
        if (eol < 0) return;
        let end = eol;
        if (end > 0 && buf[end - 1] === 0x0D) end--;
        const line = buf.slice(0, end).toString('utf8');
        buf = buf.slice(eol + 1);
        if (!line.trim()) continue;
        requests.push(line);
        handle(line);
      }
    });

    socket.on('error', () => { /* 测试期忽略 */ });

    function unquote(s) {
      const t = String(s || '').trim();
      if (/^".*"$/.test(t)) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      return t;
    }

    function handle(line) {
      const sp = line.indexOf(' ');
      const tag = sp < 0 ? line : line.slice(0, sp);
      const rest = sp < 0 ? '' : line.slice(sp + 1);
      const upper = rest.toUpperCase();

      /* CAPABILITY */
      if (/^CAPABILITY/i.test(upper)) {
        send(`* CAPABILITY IMAP4rev1${o.requireAuthPlain ? ' AUTH=PLAIN' : ''}`);
        send(`${tag} OK CAPABILITY completed`);
        return;
      }

      /* LOGOUT */
      if (/^LOGOUT/i.test(upper)) {
        send('* BYE logging out');
        send(`${tag} OK LOGOUT completed`);
        socket.end();
        return;
      }

      /* NOOP */
      if (/^NOOP/i.test(upper)) { send(`${tag} OK NOOP completed`); return; }

      /* AUTHENTICATE PLAIN */
      if (/^AUTHENTICATE\s+PLAIN/i.test(upper)) {
        saslTag = tag;
        awaitingLiteral = 0;
        send('+ ');
        /* 客户端随后会发一行 base64；当作普通行处理 */
        const onceData = (chunk2) => {
          buf = Buffer.concat([buf, chunk2]);
          const e2 = buf.indexOf(0x0A);
          if (e2 < 0) { socket.once('data', onceData); return; }
          let en = e2; if (en > 0 && buf[en - 1] === 0x0D) en--;
          const b64 = buf.slice(0, en).toString('utf8');
          buf = buf.slice(e2 + 1);
          let payload = '';
          try { payload = Buffer.from(b64, 'base64').toString('utf8'); } catch (_) { /* 忽略 */ }
          const [u, p] = payload.split('\u0000').slice(1);
          if (u === o.user && p === o.pass) { authed = true; send(`${tag} OK AUTHENTICATE completed`); }
          else send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
        };
        socket.once('data', onceData);
        return;
      }

      /* LOGIN */
      if (/^LOGIN/i.test(upper)) {
        const m = rest.match(/^LOGIN\s+(\S+|"(?:[^"\\]|\\.)*")\s+(\S+|"(?:[^"\\]|\\.)*")/i);
        const u = m ? unquote(m[1]) : '';
        const p = m ? unquote(m[2]) : '';
        if (u === o.user && p === o.pass) { authed = true; send(`${tag} OK LOGIN completed`); }
        else send(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
        return;
      }

      if (!authed) { send(`${tag} NO not authenticated`); return; }

      /* LIST "" "*" */
      if (/^LIST/i.test(upper)) {
        for (const b of o.mailboxes) {
          const flags = b.flags || ['\\HasNoChildren'];
          /* 文件夹名按 RFC 3501 要求用 modified UTF-7 编码（中文名必需） */
          send(`* LIST (${flags.join(' ')}) "/" "${encodeMUTF7(b.name)}"`);
        }
        send(`${tag} OK LIST completed`);
        return;
      }

      /* EXAMINE / SELECT */
      let m = rest.match(/^(EXAMINE|SELECT)\s+(.+)$/i);
      if (m) {
        const box = findBox(unquote(m[2]));
        if (!box) { send(`${tag} NO [NONEXISTENT] mailbox not found`); return; }
        selected = box;
        send(`* ${box.messages.length} EXISTS`);
        send('* 0 RECENT');
        send('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
        send('* OK [UIDVALIDITY 1234567890] UIDs valid');
        send(`* OK [UIDNEXT ${1000 + box.messages.length}] Predicted next UID`);
        send(`${tag} OK [READ-ONLY] ${m[1].toUpperCase()} completed`);
        return;
      }

      /* UID SEARCH <criteria> */
      m = rest.match(/^UID\s+SEARCH\s*(.*)$/i);
      if (m) {
        if (!selected) { send(`${tag} NO no mailbox selected`); return; }
        const crit = m[1].trim().toUpperCase();
        let list = selected.messages.slice();
        if (/\bUNSEEN\b/.test(crit)) list = list.filter((x) => !(x.flags || []).includes('\\Seen'));
        if (/\bSEEN\b/.test(crit) && !/UNSEEN/.test(crit)) list = list.filter((x) => (x.flags || []).includes('\\Seen'));
        const uidRange = crit.match(/UID\s+(\d+|\*):(\d+|\*)/);
        if (uidRange) {
          const lo = uidRange[1] === '*' ? -Infinity : Number(uidRange[1]);
          const hi = uidRange[2] === '*' ? Infinity : Number(uidRange[2]);
          list = list.filter((x) => x.uid >= lo && x.uid <= hi);
        }
        const since = crit.match(/\bSINCE\s+(\d{1,2}-[A-Z]{3}-\d{4})/);
        if (since) {
          const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
          const p = since[1].split('-');
          const t = Date.UTC(Number(p[2]), MON[p[1]], Number(p[0]));
          list = list.filter((x) => (x.date ? x.date.getTime() : 0) >= t);
        }
        send('* SEARCH' + (list.length ? ' ' + list.map((x) => x.uid).join(' ') : ''));
        send(`${tag} OK UID SEARCH completed`);
        return;
      }

      /* UID FETCH <set> (...) */
      m = rest.match(/^UID\s+FETCH\s+([\d,:*]+)\s+\(([^)]*)\)/i);
      if (m) {
        if (!selected) { send(`${tag} NO no mailbox selected`); return; }
        const set = m[1];
        const want = new Set();
        for (const part of set.split(',')) {
          const r = part.split(':');
          if (r.length === 2) {
            const lo = r[0] === '*' ? -Infinity : Number(r[0]);
            const hi = r[1] === '*' ? Infinity : Number(r[1]);
            for (const msg of selected.messages) if (msg.uid >= lo && msg.uid <= hi) want.add(msg.uid);
          } else want.add(Number(part));
        }
        for (const msg of selected.messages) {
          if (!want.has(msg.uid)) continue;
          const raw = Buffer.isBuffer(msg.raw) ? msg.raw : Buffer.from(String(msg.raw), 'utf8');
          const seq = selected.messages.indexOf(msg) + 1;
          const flags = (msg.flags || []).join(' ');
          const idate = msg.internalDate || toInternalDate(msg.date);
          send(`* ${seq} FETCH (UID ${msg.uid} FLAGS (${flags}) INTERNALDATE "${idate}" RFC822.SIZE ${raw.length} BODY[] {${raw.length}}`);
          socket.write(raw);
          socket.write(CRLF);
        }
        send(`${tag} OK UID FETCH completed`);
        return;
      }

      send(`${tag} BAD unknown command`);
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        server,
        close() { return new Promise((r) => server.close(() => r())); }
      });
    });
  });
}

/** 从 .fixtures/mail/*.eml 读邮件并组装成邮箱数据 */
function loadMailFixtures(mailboxName) {
  const dir = path.resolve(__dirname, 'mail');
  if (!fs.existsSync(dir)) return { name: mailboxName || 'INBOX', messages: [] };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.eml')).sort();
  const messages = files.map((f, i) => {
    const raw = fs.readFileSync(path.join(dir, f));
    /* 从 Date 头取时间，供 SEARCH SINCE 使用 */
    const head = raw.slice(0, 2000).toString('latin1');
    const dm = head.match(/^Date:\s*(.+)$/im);
    const d = dm ? new Date(dm[1].trim()) : null;
    const valid = d && !isNaN(d) ? d : null;
    return { uid: 101 + i, raw, date: valid, internalDate: toInternalDate(valid), file: f };
  });
  return { name: mailboxName || 'INBOX', messages };
}

module.exports = { startMockImap, loadMailFixtures };
