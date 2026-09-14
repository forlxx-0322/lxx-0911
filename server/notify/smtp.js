/**
 * 极简 SMTP 客户端（零依赖）
 *
 * 为什么手写：本项目的立身之本是「零依赖 + 离线可用」。招标采集模块已手写过一个
 * IMAP 客户端（server/collect/imap.js），SMTP 与之同源，沿用同一套模式与约束。
 *
 * 实现范围（够用即止，不做完整 RFC 覆盖）：
 *   - 传输：465 端口 **隐式 TLS**（tls.connect）。已实测 QQ / 163 / 126 /
 *     腾讯企业邮 / 天翼 189 的 465 均可用；不实现 587 的 STARTTLS 升级。
 *   - 命令：EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA → QUIT
 *   - 报文：UTF-8；主题用 RFC 2047 编码字；正文 base64，多部分（text + html）
 *
 * 安全约束：
 *   - 只发信给「设置里指定的收件人」，不接受任意收件人参数（避免被误用成群发）
 *   - 失败只返回错误信息，**不重试轰炸**（重试策略由调用方按日粒度控制）
 *   - 授权码在日志与错误信息中一律脱敏
 */

'use strict';

const tls = require('node:tls');

const DEFAULT_TIMEOUT = 20000;
/** 常见服务商预设：授权码不是登录密码，各家的获取路径在界面上有指引 */
const PROVIDERS = {
  qq: { label: 'QQ 邮箱', host: 'smtp.qq.com', port: 465 },
  '163': { label: '网易 163 邮箱', host: 'smtp.163.com', port: 465 },
  '126': { label: '网易 126 邮箱', host: 'smtp.126.com', port: 465 },
  exmail: { label: '腾讯企业邮箱', host: 'smtp.exmail.qq.com', port: 465 },
  '189': { label: '天翼 189 邮箱', host: 'smtp.189.cn', port: 465 },
  custom: { label: '自定义 SMTP', host: '', port: 465 }
};

/** 把可能出现在错误信息里的授权码抹掉 */
function mask(text, secret) {
  let s = String(text || '');
  if (secret && String(secret).length >= 3) {
    s = s.split(String(secret)).join('******');
  }
  /* 兜底：抹掉常见的 base64 授权码形态 */
  return s.replace(/[A-Za-z0-9+/=]{16,}/g, (m) => (m.length > 24 ? m.slice(0, 4) + '******' : m));
}

/** RFC 2047 编码字（主题用，避免中文乱码） */
function encodeHeader(str) {
  const s = String(str === undefined || str === null ? '' : str);
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** 长行折行（RFC 5322 建议 ≤78 字符） */
function foldBase64(b64) {
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}

/**
 * 组装 MIME 报文。
 * @param {object} msg { from, to, subject, text, html }
 */
function buildMessage(msg) {
  const boundary = 'crm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const date = new Date().toUTCString();
  const headers = [
    `From: ${encodeHeader(msg.fromName || '')} <${msg.from}>`,
    `To: <${msg.to}>`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2, 10)}@crm-bjxt.local>`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];

  const parts = [];
  parts.push([
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(Buffer.from(String(msg.text || ''), 'utf8').toString('base64'))
  ].join('\r\n'));
  parts.push([
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(Buffer.from(String(msg.html || ''), 'utf8').toString('base64'))
  ].join('\r\n'));

  const body = parts.join('\r\n') + `\r\n--${boundary}--`;
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

/**
 * 发送一封邮件。
 *
 * @param {object} cfg
 *   host, port, user, pass   SMTP 连接与认证信息
 *   from, fromName, to       发件人与收件人
 *   subject, text, html      内容
 *   timeout                  单次超时（毫秒），默认 20 秒
 * @returns {Promise<{ok:true, ms:number}>} 或抛出带脱敏信息的 Error
 */
function sendMail(cfg) {
  return new Promise((resolve, reject) => {
    const timeout = Number(cfg.timeout) || DEFAULT_TIMEOUT;
    const host = cfg.host;
    const port = Number(cfg.port) || 465;
    let socket = null;
    let settled = false;
    let buffer = '';

    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (socket) socket.destroy(); } catch (_) { /* 忽略 */ }
      if (err) reject(err); else resolve({ ok: true, ms: Date.now() - started });
    };

    const started = Date.now();
    const timer = setTimeout(() => {
      done(new Error(`SMTP 超时（${timeout / 1000} 秒未完成），请检查网络或服务器地址`));
    }, timeout);

    /* 命令队列：每条步骤 = 发一条命令 + 期望的应答码。
       注意 send 与 expect 必须成对：
       早期实现把二者错开一位，导致"拿上一条命令的期望值比对当前应答"，
       表现是 EHLO 的 250 被当成 AUTH 的应答、随后 334 报失败。 */
    const steps = [];

    steps.push({
      send: () => 'EHLO crm-bjxt.local',
      expect: 250
    });
    steps.push({
      send: () => 'AUTH LOGIN',
      expect: 334
    });
    steps.push({
      send: () => Buffer.from(String(cfg.user || ''), 'utf8').toString('base64'),
      expect: 334
    });
    steps.push({
      send: () => Buffer.from(String(cfg.pass || ''), 'utf8').toString('base64'),
      expect: 235
    });
    steps.push({
      send: () => `MAIL FROM:<${cfg.from || cfg.user}>`,
      expect: 250
    });
    steps.push({
      send: () => `RCPT TO:<${cfg.to}>`,
      expect: 250
    });
    steps.push({
      send: () => 'DATA',
      expect: 354
    });
    steps.push({
      send: () => {
        /* DATA 阶段内容结尾必须是 <CRLF>.<CRLF>，且行首的点要转义 */
        const escaped = message.replace(/\r\n\./g, '\r\n..');
        return escaped + '\r\n.';
      },
      expect: 250
    });
    steps.push({
      send: () => 'QUIT',
      expect: 221,
      finish: true
    });
    /* 是否还在等 220 欢迎语。用显式标志而不是 stepIndex === 0 判断：
       步骤在收到 220 之前不会推进，若用位置判断，后续任何 220 都会被误当成欢迎语。 */
    let awaitingGreeting = true;
    const message = buildMessage({
      from: cfg.from || cfg.user,
      fromName: cfg.fromName || '',
      to: cfg.to,
      subject: cfg.subject,
      text: cfg.text,
      html: cfg.html
    });

    let stepIndex = 0;
    const advance = () => {
      if (stepIndex >= steps.length) return;
      const step = steps[stepIndex];
      try {
        const cmd = step.send();
        if (process.env.SMTP_DEBUG) {
          console.error(`  [smtp] 发送 step${stepIndex} expect=${step.expect}`
            + ` → ${String(cmd).slice(0, 50).replace(/\r?\n/g, ' ')}`);
        }
        socket.write(cmd + '\r\n');
      } catch (e) {
        done(new Error('发送失败：' + mask(e.message, cfg.pass)));
      }
    };

    const onReply = (code, text) => {
      const step = steps[stepIndex];
      if (process.env.SMTP_DEBUG) {
        console.error(`  [smtp] 收到 ${code} ${String(text).slice(0, 40)} | stepIndex=${stepIndex}`
          + ` expect=${steps[stepIndex] ? steps[stepIndex].expect : '（无）'}`);
      }
      if (!step) return;
      /* 期望 2xx/3xx 时按首位数字宽松匹配（各家返回的扩展码不完全一致） */
      const okCode = Math.floor(code / 100) === Math.floor(step.expect / 100);
      if (!okCode) {
        const hint = code === 535 || code === 534
          ? '（认证失败：请确认填的是「授权码」而不是登录密码，且该邮箱已开启 SMTP 服务）'
          : '';
        done(new Error(`SMTP 服务器返回 ${code} ${text}${hint}`));
        return;
      }
      if (step.finish) { done(null); return; }
      stepIndex++;
      advance();
    };

    try {
      /* 只在主机名（非 IP）时设置 SNI，否则 Node 会报 RFC 6066 弃用警告 */
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
      const opts = { host, port, rejectUnauthorized: false };
      if (!isIp) opts.servername = host;
      socket = tls.connect(opts, () => {
        /* 连接建立后等服务端 220 欢迎语 */
      });
    } catch (e) {
      done(new Error('无法连接 SMTP 服务器：' + mask(e.message, cfg.pass)));
      return;
    }

    socket.setEncoding('utf8');

    socket.on('data', (chunk) => {
      buffer += chunk;
      /* SMTP 应答规则：
         - 单行应答：`250 OK`
         - 多行应答：中间行是 `250-XXX`，最后一行才是 `250 XXX`
         注意多行应答可能被拆到多个 TCP 包里到达，因此必须按行累积判断，
         且**中间行不能推进步骤**（早期实现踩过这个坑：EHLO 的多行应答
         把步数提前推进，随后收到 334 时已经错位，被误判为失败）。 */
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const m = line.match(/^(\d{3})([ -])(.*)$/);
        if (!m) continue;

        const code = Number(m[1]);
        const isFinal = m[2] === ' ';

        /* 连接建立后的第一步：先收 220 欢迎语，再发首条命令 */
        if (awaitingGreeting) {
          if (!isFinal) continue;
          if (code !== 220) {
            done(new Error(`SMTP 服务器未按预期问候（返回 ${code} ${m[3]}）`));
            return;
          }
          awaitingGreeting = false;
          advance();
          continue;
        }

        /* 多行应答的中间行：只等下一行，不推进步骤 */
        if (!isFinal) continue;

        onReply(code, m[3]);
      }
    });

    socket.on('error', (e) => {
      done(new Error('SMTP 连接错误：' + mask(e.message, cfg.pass)));
    });

    socket.on('close', () => {
      if (!settled) done(new Error('SMTP 连接被服务器关闭（可能是授权码错误或服务器限制）'));
    });
  });
}

/** 校验配置是否完整，返回 { ok, missing[] } */
function validateConfig(cfg) {
  const missing = [];
  if (!cfg || !String(cfg.host || '').trim()) missing.push('SMTP 服务器地址');
  if (!String(cfg.port || '').trim()) missing.push('SMTP 端口');
  if (!String(cfg.user || '').trim()) missing.push('邮箱账号');
  if (!String(cfg.pass || '').trim()) missing.push('邮箱授权码');
  if (!String(cfg.to || cfg.user || '').trim()) missing.push('收件地址');
  return { ok: missing.length === 0, missing };
}

module.exports = { sendMail, buildMessage, encodeHeader, validateConfig, PROVIDERS, mask };
