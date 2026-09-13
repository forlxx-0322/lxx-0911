/**
 * IMAP 客户端（零依赖，基于 Node 内置 tls）
 *
 * 为什么手写：Node 没有内置 IMAP；本项目坚持零依赖（不引 npm 包），
 * 而招标采集只需要读一个文件夹里的邮件，用不到完整 IMAP 特性，
 * 自己实现一个小而可控的子集即可。
 *
 * 实现的命令子集（覆盖"读订阅邮件"所需的全部能力）：
 *   CAPABILITY / LOGIN / AUTHENTICATE PLAIN
 *   LIST "" *            → 列出文件夹（用于自动识别订阅文件夹）
 *   SELECT / EXAMINE     → 打开文件夹（EXAMINE 只读，绝不改邮箱状态）
 *   UID SEARCH           → 按条件检索（UNSEEN / SINCE / UID 区间）
 *   UID FETCH            → 取 BODY.PEEK[]（PEEK 不会把邮件标记为已读）
 *   LOGOUT / NOOP
 *
 * 安全与克制原则（对应附录 A 四不原则）：
 *   - 只读：一律用 EXAMINE + BODY.PEEK，绝不 STORE/EXPUNGE，不改动用户邮箱任何状态
 *   - 只取需要的：按 UID 区间与时间过滤，不整箱拉取
 *   - 单连接串行：不做并发，天然限频
 *   - 超时与失败即断开，不重试轰炸
 */
'use strict';

const tls = require('node:tls');

const DEFAULT_TIMEOUT = 30000;

/** 把字符串转成 IMAP 引号字符串 */
function q(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** 解析 IMAP 的 INTERNALDATE："02-Mar-2026 09:15:33 +0800" → Date */
function parseInternalDate(s) {
  const m = String(s || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/);
  if (!m) return null;
  const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const mon = MON[m[2]];
  if (mon === undefined) return null;
  const off = m[7];
  const sign = off[0] === '-' ? -1 : 1;
  const offMin = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5)));
  const utc = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  return new Date(utc - offMin * 60000);
}

/** 把 Date 转成 IMAP SEARCH 用的日期（DD-Mon-YYYY） */
function imapDate(d) {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${MON[d.getMonth()]}-${d.getFullYear()}`;
}

class ImapError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ImapError';
    this.code = code || 'IMAP_ERROR';
  }
}

class ImapClient {
  /**
   * @param {object} opt
   *   host, port, secure(true/false), user, pass,
   *   timeout(ms), logger(fn)
   */
  constructor(opt) {
    this.opt = Object.assign({ port: 993, secure: true, timeout: DEFAULT_TIMEOUT }, opt || {});
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.tagSeq = 0;
    this.pending = null;      // 当前等待响应的命令
    this.onLog = typeof this.opt.logger === 'function' ? this.opt.logger : () => {};
    this.capabilities = [];
    this.closed = false;
  }

  /* ---------------- 底层：连接与命令收发 ---------------- */

  connect() {
    return new Promise((resolve, reject) => {
      const opts = {
        host: this.opt.host,
        port: this.opt.port,
        /* RFC 6066 不允许把 IP 作为 SNI，本机/内网地址直接不传，避免告警 */
        servername: /^\d{1,3}(\.\d{1,3}){3}$/.test(this.opt.host) ? undefined : this.opt.host,
        rejectUnauthorized: this.opt.secure !== false
      };
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };

      this.socket = this.opt.secure === false
        ? require('node:net').connect({ host: opts.host, port: opts.port }, onConnect)
        : tls.connect(opts, onConnect);

      const self = this;
      function onConnect() {
        try { self.socket.setTimeout(self.opt.timeout); } catch (_) { /* 忽略 */ }
      }

      this.socket.once('error', (e) => {
        done(new ImapError(`连接 ${opts.host}:${opts.port} 失败：${e.message}`, 'CONNECT_FAILED'));
      });
      this.socket.once('timeout', () => {
        this.destroy();
        done(new ImapError(`连接 ${opts.host}:${opts.port} 超时`, 'TIMEOUT'));
      });
      this.socket.on('data', (chunk) => self._onData(chunk));
      this.socket.once('close', () => {
        this.closed = true;
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          clearTimeout(p.timer);
          p.reject(new ImapError('连接被服务器关闭', 'CLOSED'));
        }
      });
      /* TLS 需要握手；明文连接直接算连上 */
      if (this.opt.secure === false) {
        this.socket.once('connect', () => done());
      } else {
        this.socket.once('secureConnect', () => done());
      }
    });
  }

  destroy() {
    this.closed = true;
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) { /* 忽略 */ }
      this.socket = null;
    }
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    /* 循环尝试完成当前命令：只有拿到 tagged 结果行才算完成 */
    for (;;) {
      if (!this.pending) {
        /* 无命令在等：丢弃未标记的问候之外的数据，防止无限堆积 */
        if (this.buffer.length > 1 << 20) this.buffer = Buffer.alloc(0);
        return;
      }
      const consumed = this._tryComplete();
      if (!consumed) return;
    }
  }

  /**
   * 尝试从缓冲区里解析出当前命令的完整响应。
   * IMAP 行以 CRLF 结束，遇到 {n} 字面量需要再读 n 字节。
   * @returns {boolean} 是否已完成（或已推进）
   */
  _tryComplete() {
    const p = this.pending;
    const buf = this.buffer;
    let pos = 0;
    let lineStart = 0;
    let newData = false;

    while (pos < buf.length) {
      /* 找一行 */
      let eol = buf.indexOf(0x0A, pos);
      if (eol < 0) break;                       // 行不完整，等更多数据
      let lineEnd = eol;
      if (lineEnd > pos && buf[lineEnd - 1] === 0x0D) lineEnd--;
      const line = buf.slice(pos, lineEnd).toString('binary');
      let next = eol + 1;

      /* 该行是否以 {n} 结尾 → 后面跟 n 字节字面量 */
      const lit = line.match(/\{(\d+)\}$/);
      if (lit) {
        const n = Number(lit[1]);
        if (buf.length < next + n) break;        // 字面量还没到齐
        /* 字面量作为一行内容存入（标记为字面量类型，避免被当文本处理） */
        p.lines.push({ text: line, literal: buf.slice(next, next + n) });
        next += n;
        pos = next;
        newData = true;
        continue;
      }

      p.lines.push({ text: line, literal: null });
      pos = next;
      newData = true;

      /* tagged 结果行：形如 "A3 OK ..." */
      if (line.startsWith(p.tag + ' ')) {
        this.buffer = buf.slice(pos);
        this.pending = null;
        clearTimeout(p.timer);
        const rest = line.slice(p.tag.length + 1).trim();
        if (/^OK\b/i.test(rest)) p.resolve(p.lines);
        else p.reject(new ImapError(rest || 'IMAP 命令失败', /^NO\b/i.test(rest) ? 'NO' : 'BAD'));
        return true;
      }
    }

    /* 推进缓冲区，避免重复解析 */
    if (newData && pos > 0) this.buffer = buf.slice(pos);
    void lineStart;
    return false;
  }

  /** 发送一条命令并等待 tagged 响应 */
  send(command) {
    if (this.closed || !this.socket) {
      return Promise.reject(new ImapError('连接已关闭', 'CLOSED'));
    }
    const tag = 'A' + (++this.tagSeq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.tag === tag) {
          this.pending = null;
          reject(new ImapError(`命令超时：${command.split(' ')[0]}`, 'TIMEOUT'));
        }
      }, this.opt.timeout);
      this.pending = { tag, lines: [], resolve, reject, timer };
      this.onLog(`→ ${tag} ${command}`);
      try {
        this.socket.write(tag + ' ' + command + '\r\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending = null;
        reject(new ImapError('发送失败：' + e.message, 'WRITE_FAILED'));
      }
    });
  }

  /* ---------------- 高层：登录与读取 ---------------- */

  async capability() {
    const lines = await this.send('CAPABILITY');
    const caps = [];
    for (const l of lines) {
      const m = l.text.match(/^\* CAPABILITY (.+)$/i);
      if (m) caps.push(...m[1].split(/\s+/));
    }
    this.capabilities = caps;
    return caps;
  }

  /** 登录：优先 AUTHENTICATE PLAIN（不把口令写进命令日志），退化为 LOGIN */
  async login() {
    const caps = this.capabilities.length ? this.capabilities : await this.capability();
    const user = this.opt.user;
    const pass = this.opt.pass;
    if (!user || !pass) throw new ImapError('缺少邮箱账号或授权码', 'NO_CREDENTIAL');

    if (caps.some((c) => /^AUTH=PLAIN$/i.test(c))) {
      /* SASL PLAIN: \0user\0pass，用字面量发送，避免出现在日志里 */
      const payload = Buffer.from('\u0000' + user + '\u0000' + pass, 'utf8');
      const tag = 'A' + (++this.tagSeq);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending && this.pending.tag === tag) {
            this.pending = null;
            reject(new ImapError('登录超时', 'TIMEOUT'));
          }
        }, this.opt.timeout);
        this.pending = {
          tag,
          lines: [],
          timer,
          resolve: (lines) => resolve(lines),
          reject
        };
        this.onLog(`→ ${tag} AUTHENTICATE PLAIN (凭据已隐藏)`);
        this.socket.write(`${tag} AUTHENTICATE PLAIN\r\n`);
        /* 服务器回 "+" 后发送 base64 凭据；这里直接写入，IMAP 允许不等 + */
        setTimeout(() => {
          try { this.socket.write(payload.toString('base64') + '\r\n'); } catch (_) { /* 忽略 */ }
        }, 30);
      });
    }

    /* LOGIN 分支：口令会出现在命令里，日志必须脱敏 */
    const tag = 'A' + (++this.tagSeq);
    const cmd = `${tag} LOGIN ${q(user)} ${q(pass)}`;
    return this._sendRaw(cmd, `${tag} LOGIN ${q(user)} "***"`);
  }

  /** 发送原始命令（日志用替代文本），供 LOGIN 脱敏用 */
  _sendRaw(command, logText) {
    if (this.closed || !this.socket) return Promise.reject(new ImapError('连接已关闭', 'CLOSED'));
    const tag = command.split(' ')[0];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.tag === tag) {
          this.pending = null;
          reject(new ImapError('命令超时', 'TIMEOUT'));
        }
      }, this.opt.timeout);
      this.pending = { tag, lines: [], resolve, reject, timer };
      this.onLog(`→ ${logText}`);
      try { this.socket.write(command + '\r\n'); } catch (e) {
        clearTimeout(timer);
        this.pending = null;
        reject(new ImapError('发送失败：' + e.message, 'WRITE_FAILED'));
      }
    });
  }

  /** 列出文件夹：返回 [{ name, delimiter, flags }] */
  async listMailboxes() {
    const lines = await this.send('LIST "" "*"');
    const out = [];
    for (const l of lines) {
      const m = l.text.match(/^\* LIST \(([^)]*)\) ("([^"]*)"|NIL) (.+)$/i);
      if (!m) continue;
      const flags = m[1].split(/\s+/).filter(Boolean);
      const delim = m[3] === undefined ? '/' : m[3];
      let name = m[4].trim();
      if (/^".*"$/.test(name)) name = name.slice(1, -1).replace(/\\"/g, '"');
      /* 修正 modified UTF-7 的名称（如 &XfJT0ZAB-），这里做最小可用解码 */
      out.push({ name: decodeMUTF7(name), rawName: name, delimiter: delim, flags });
    }
    return out;
  }

  /**
   * 打开文件夹。readOnly=true 时用 EXAMINE，绝不改变"已读"等状态。
   * @returns {{exists:number, uidValidity:string, uidNext:string}}
   */
  async select(mailbox, readOnly) {
    const name = encodeMUTF7(mailbox);
    const lines = await this.send(`${readOnly === false ? 'SELECT' : 'EXAMINE'} ${q(name)}`);
    const info = { exists: 0, uidValidity: '', uidNext: '' };
    for (const l of lines) {
      let m = l.text.match(/^\* (\d+) EXISTS/i);
      if (m) info.exists = Number(m[1]);
      m = l.text.match(/^\* OK \[UIDVALIDITY (\d+)\]/i);
      if (m) info.uidValidity = m[1];
      m = l.text.match(/^\* OK \[UIDNEXT (\d+)\]/i);
      if (m) info.uidNext = m[1];
    }
    return info;
  }

  /**
   * UID SEARCH
   * @param {string[]} criteria 例如 ['UNSEEN'] 或 ['SINCE','02-Mar-2026'] 或 ['UID','100:*']
   * @returns {number[]}
   */
  async uidSearch(criteria) {
    const lines = await this.send('UID SEARCH ' + (criteria || ['ALL']).join(' '));
    const out = [];
    for (const l of lines) {
      const m = l.text.match(/^\* SEARCH(.*)$/i);
      if (m) {
        for (const tok of m[1].trim().split(/\s+/)) {
          if (/^\d+$/.test(tok)) out.push(Number(tok));
        }
      }
    }
    return out;
  }

  /**
   * UID FETCH 邮件原文。
   * 用 BODY.PEEK[] 避免把邮件标记为已读（不干扰用户邮箱）。
   *
   * 响应可能跨多行（字面量前后各占一行），因此按状态机解析而不是单行正则：
   *   * 12 FETCH (UID 12 FLAGS (\Seen) INTERNALDATE "..." RFC822.SIZE 4707 BODY[] {4707}
   *   <4707 字节字面量>
   *   )
   * @param {number[]} uidList
   * @returns {Array<{uid:number, size:number, internalDate:Date|null, raw:Buffer, flags:string[]}>}
   */
  async uidFetch(uidList) {
    if (!uidList.length) return [];
    const set = uidList.join(',');
    const lines = await this.send(`UID FETCH ${set} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])`);
    const out = [];
    let cur = null;

    for (const l of lines) {
      const text = l.text;

      /* 遇到字面量：这一行同时承载了 FETCH 属性与 {n} 标记，
         所以必须先在本行解析元信息，再挂上原文。 */
      if (l.literal) {
        const h = text.match(/^\*\s+(\d+)\s+FETCH\s+\(([\s\S]*)$/i);
        if (h) {
          if (cur && cur.raw) out.push(cur);
          cur = this._newFetchEntry(Number(h[1]));
          this._fillFetchMeta(cur, h[2]);
        }
        if (cur) {
          cur.raw = l.literal;
          out.push(cur);
          cur = null;
        }
        continue;
      }

      /* FETCH 起始行（无字面量，例如只取元信息） */
      const start = text.match(/^\*\s+(\d+)\s+FETCH\s+\(([\s\S]*)$/i);
      if (start) {
        if (cur && cur.raw) out.push(cur);
        cur = this._newFetchEntry(Number(start[1]));
        this._fillFetchMeta(cur, start[2]);
        continue;
      }

      /* 续行（字面量之后的那一行，通常是 ")" 或更多属性） */
      if (cur && !cur.raw) this._fillFetchMeta(cur, text);
    }

    /* 收尾：只有元信息没有原文的也返回，交由上层判断 */
    if (cur && cur.uid) out.push(cur);
    return out;
  }

  _newFetchEntry(seq) {
    return { seq, uid: 0, size: 0, internalDate: null, flags: [], raw: null };
  }

  /** 从 FETCH 响应片段里抽取 UID / FLAGS / INTERNALDATE / RFC822.SIZE */
  _fillFetchMeta(target, text) {
    const uid = text.match(/\bUID\s+(\d+)/i);
    if (uid && !target.uid) target.uid = Number(uid[1]);

    const size = text.match(/\bRFC822\.SIZE\s+(\d+)/i);
    if (size) target.size = Number(size[1]);

    const idate = text.match(/\bINTERNALDATE\s+"([^"]+)"/i);
    if (idate) target.internalDate = parseInternalDate(idate[1]);

    const flags = text.match(/\bFLAGS\s+\(([^)]*)\)/i);
    if (flags) target.flags = flags[1].split(/\s+/).filter(Boolean);
  }

  async logout() {
    try { await this.send('LOGOUT'); } catch (_) { /* 忽略 */ }
    this.destroy();
  }
}

/* ------------------------------------------------------------------ */
/* modified UTF-7（IMAP 文件夹名编码）                                  */
/* ------------------------------------------------------------------ */

/** 解码 IMAP modified UTF-7 → UTF-8。中文邮箱文件夹名必需。 */
function decodeMUTF7(str) {
  if (!/[&]/.test(str)) return str;
  return str.replace(/&([^-]*)-/g, (_, b64) => {
    if (!b64) return '&';
    try {
      const buf = Buffer.from(b64.replace(/,/g, '/'), 'base64');
      /* 转成 UTF-16BE 再解码 */
      const chars = [];
      for (let i = 0; i + 1 < buf.length; i += 2) {
        chars.push(String.fromCharCode((buf[i] << 8) | buf[i + 1]));
      }
      return chars.join('');
    } catch (_) { return '&' + b64 + '-'; }
  });
}

/** 编码 UTF-8 → IMAP modified UTF-7 */
function encodeMUTF7(str) {
  return String(str).replace(/[^\x20-\x7E]|&/g, (ch) => {
    if (ch === '&') return '&-';
    const code = ch.charCodeAt(0);
    const buf = Buffer.from([code >> 8, code & 0xFF]);
    return '&' + buf.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
  });
}

/**
 * 常用邮箱的 IMAP 服务器预设（用户只需填账号与授权码）
 * 授权码获取路径在界面上给出提示，避免用户拿登录密码去试。
 */
const PROVIDERS = {
  qq: { label: 'QQ 邮箱', host: 'imap.qq.com', port: 993, hint: '设置 → 账户 → 开启 IMAP/SMTP 服务，生成 16 位授权码' },
  '163': { label: '网易 163 邮箱', host: 'imap.163.com', port: 993, hint: '设置 → POP3/SMTP/IMAP → 开启 IMAP，获取授权码' },
  '126': { label: '网易 126 邮箱', host: 'imap.126.com', port: 993, hint: '同上，获取授权码' },
  outlook: { label: 'Outlook / Hotmail', host: 'outlook.office365.com', port: 993, hint: '需使用应用密码（账户 → 安全性 → 高级选项）' },
  '189': { label: '天翼 189 邮箱', host: 'imap.189.cn', port: 993, hint: '设置中开启 IMAP 并获取授权码' },
  exmail: { label: '腾讯企业邮箱', host: 'imap.exmail.qq.com', port: 993, hint: '使用邮箱登录密码或客户端专用密码' },
  custom: { label: '自定义服务器', host: '', port: 993, hint: '填写服务商提供的 IMAP 服务器地址与端口' }
};

module.exports = {
  ImapClient,
  ImapError,
  PROVIDERS,
  parseInternalDate,
  imapDate,
  decodeMUTF7,
  encodeMUTF7
};
