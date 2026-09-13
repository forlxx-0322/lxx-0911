/**
 * MIME 邮件解析（零依赖）
 *
 * 为什么自己写：Node 内置模块没有邮件解析能力，而本项目坚持零依赖
 * （不引第三方包，保证断网可装可用）。邮件格式是稳定标准（RFC 5322 / 2045-2047），
 * 自己实现完全可控，也便于按"招标邮件"这一窄场景做取舍。
 *
 * 处理范围（均为招标订阅邮件的真实形态）：
 *   - 头字段折行（RFC 5322 folding）与 RFC 2047 编码字（=?UTF-8?B?…?= / =?GBK?B?…?=）
 *   - multipart/alternative 与 multipart/mixed 递归
 *   - Content-Transfer-Encoding: base64 / quoted-printable / 7bit / 8bit / binary
 *   - 字符集：utf-8 / gbk / gb2312 / gb18030 / big5 / latin1（Node 内置 TextDecoder 支持）
 *   - HTML 正文转纯文本（去标签、还原实体、保留换行语义）
 *
 * 边界：全程按「字节」处理，头部按 latin1 保留原始字节，只在需要时按 charset 解码，
 *       避免 UTF-8 强解导致中文乱码（邮件里 charset 声明不可信，需要按声明解）。
 */
'use strict';

/* ------------------------------------------------------------------ */
/* 字节与字符串工具                                                     */
/* ------------------------------------------------------------------ */

/** Buffer → 字符串（按 charset） */
function decodeBuffer(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/["']/g, '').trim();
  const map = {
    'utf8': 'utf-8', 'utf-8': 'utf-8',
    'gbk': 'gbk', 'gb2312': 'gbk', 'gb18030': 'gbk', 'cp936': 'gbk',
    'big5': 'big5', 'big-5': 'big5',
    'latin1': 'latin1', 'iso-8859-1': 'latin1', 'us-ascii': 'utf-8', 'ascii': 'utf-8',
    'unicode': 'utf-16le', 'utf-16': 'utf-16le', 'utf-16le': 'utf-16le'
  };
  const target = map[cs] || 'utf-8';

  /* utf-8 用 Buffer 原生更稳；其余交给 TextDecoder */
  if (target === 'utf-8') {
    const s = buf.toString('utf8');
    /* 声明 utf-8 但实际是 GBK 的情况很常见：出现大量替换字符时按 GBK 重试 */
    if ((s.match(/\uFFFD/g) || []).length > 3) {
      try { return new TextDecoder('gbk').decode(buf); } catch (_) { return s; }
    }
    return s;
  }
  try { return new TextDecoder(target).decode(buf); } catch (_) { return buf.toString('utf8'); }
}

/** quoted-printable 解码（Buffer → Buffer） */
function decodeQP(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b !== 0x3D) { out.push(b); continue; }          // '='
    /* 软换行 = CRLF 或 = LF */
    if (buf[i + 1] === 0x0D && buf[i + 2] === 0x0A) { i += 2; continue; }
    if (buf[i + 1] === 0x0A) { i += 1; continue; }
    const hex = String.fromCharCode(buf[i + 1] || 0, buf[i + 2] || 0);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      out.push(b);
    }
  }
  return Buffer.from(out);
}

/* ------------------------------------------------------------------ */
/* RFC 2047 编码字                                                      */
/* ------------------------------------------------------------------ */

/**
 * 解码形如 =?UTF-8?B?xxxx?= 或 =?GBK?Q?xxx?= 的编码字。
 * 相邻编码字之间按 RFC 规定忽略空白。
 */
function decodeEncodedWords(input) {
  if (!input || input.indexOf('=?') < 0) return input;
  const re = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(input))) {
    let gap = input.slice(last, m.index);
    /* 编码字之间只允许空白，其余文本原样保留 */
    if (!/^\s*$/.test(gap)) out += gap;
    else if (out && !/\s$/.test(out) && !/^[\x00-\x7F]*$/.test(out)) out += '';  // 中文之间不加空格
    else if (gap) out += gap;

    const charset = m[1];
    const enc = m[2].toUpperCase();
    const data = m[3];
    try {
      if (enc === 'B') {
        out += decodeBuffer(Buffer.from(data, 'base64'), charset);
      } else {
        /* Q 编码：下划线代表空格 */
        out += decodeBuffer(decodeQP(Buffer.from(data.replace(/_/g, ' '), 'latin1')), charset);
      }
    } catch (_) {
      out += data;
    }
    last = re.lastIndex;
  }
  out += input.slice(last);
  return out;
}

/* ------------------------------------------------------------------ */
/* 头部解析                                                            */
/* ------------------------------------------------------------------ */

/** 拆分头与体；同时做折行合并 */
function splitMessage(buf) {
  /* 找第一个空行：CRLF CRLF 或 LF LF */
  let sep = buf.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (sep < 0) { sep = buf.indexOf('\n\n'); sepLen = 2; }
  if (sep < 0) return { headerBuf: buf, bodyBuf: Buffer.alloc(0) };
  return { headerBuf: buf.slice(0, sep), bodyBuf: buf.slice(sep + sepLen) };
}

/** 解析头字段为 { name: value }（名小写，值已解折行，未解编码字） */
function parseHeaders(headerBuf) {
  const raw = headerBuf.toString('latin1');
  const lines = raw.split(/\r?\n/);
  const out = {};
  const order = [];
  let cur = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) {
      out[cur] += ' ' + line.trim();
      continue;
    }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (out[name] === undefined) { out[name] = value; order.push(name); }
    else out[name] += ', ' + value;
    cur = name;
  }
  out.__order = order;
  return out;
}

/** 解析 Content-Type，返回 { type, params } */
function parseContentType(value) {
  const s = String(value || 'text/plain');
  const parts = s.split(';');
  const type = parts.shift().trim().toLowerCase();
  const params = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const k = p.slice(0, i).trim().toLowerCase();
    let v = p.slice(i + 1).trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    params[k] = v;
  }
  return { type, params };
}

/* ------------------------------------------------------------------ */
/* HTML → 纯文本                                                       */
/* ------------------------------------------------------------------ */

function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    /* 块级标签与换行标签转换为换行，保留原本的行结构 */
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table|section|article)\s*>/gi, '\n')
    .replace(/<\s*(p|div|tr|li|h[1-6]|table|section|article)[^>]*>/gi, '\n')
    /* 单元格之间用制表符分隔，便于"标签：值"成对抽取 */
    .replace(/<\s*\/\s*(td|th)\s*>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 正文抽取                                                            */
/* ------------------------------------------------------------------ */

/** 抽取所有正文部分：返回 [{ type, charset, text, filename }] */
function collectBodies(headerBuf, bodyBuf, depth) {
  const d = depth || 0;
  if (d > 8) return [];
  /* 空邮件（既无头也无正文）直接返回，避免造出一个空的 text/plain 部分 */
  if (!headerBuf.length && !bodyBuf.length) return [];
  const headers = parseHeaders(headerBuf);
  const ct = parseContentType(headers['content-type']);
  const cte = String(headers['content-transfer-encoding'] || '').toLowerCase().trim();

  /* 解码传输编码 → 原始字节 */
  let raw = bodyBuf;
  if (cte === 'base64') {
    raw = Buffer.from(bodyBuf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  } else if (cte === 'quoted-printable') {
    raw = decodeQP(bodyBuf);
  }

  /* multipart：按 boundary 切分递归 */
  if (ct.type.startsWith('multipart/') && ct.params.boundary) {
    const boundary = Buffer.from('--' + ct.params.boundary, 'latin1');
    const parts = [];
    let idx = raw.indexOf(boundary);
    while (idx >= 0) {
      const start = idx + boundary.length;
      /* 结束标记 --boundary-- */
      if (raw.slice(start, start + 2).toString('latin1') === '--') break;
      /* 跳过 boundary 后的换行 */
      let s = start;
      if (raw[s] === 0x0D && raw[s + 1] === 0x0A) s += 2;
      else if (raw[s] === 0x0A) s += 1;
      const next = raw.indexOf(boundary, s);
      const end = next < 0 ? raw.length : next;
      let chunk = raw.slice(s, end);
      /* 去掉分隔前的换行 */
      if (chunk.length >= 2 && chunk[chunk.length - 2] === 0x0D && chunk[chunk.length - 1] === 0x0A) {
        chunk = chunk.slice(0, chunk.length - 2);
      } else if (chunk.length >= 1 && chunk[chunk.length - 1] === 0x0A) {
        chunk = chunk.slice(0, chunk.length - 1);
      }
      parts.push(chunk);
      idx = next;
    }
    const out = [];
    for (const p of parts) {
      const sp = splitMessage(p);
      out.push(...collectBodies(sp.headerBuf, sp.bodyBuf, d + 1));
    }
    return out;
  }

  /* 文本部分 */
  if (ct.type === 'text/plain' || ct.type === 'text/html' || ct.type === '') {
    const charset = ct.params.charset || 'utf-8';
    const decoded = decodeBuffer(raw, charset);
    const isHtml = ct.type === 'text/html';
    return [{
      type: ct.type || 'text/plain',
      charset,
      text: isHtml ? htmlToText(decoded) : decoded,
      /* 保留原始 HTML，供链接抽取使用（转文本会丢掉 href） */
      rawHtml: isHtml ? decoded : '',
      filename: ct.params.name || ''
    }];
  }

  /* 其他类型（附件等）：仅记录元信息，不解析 */
  return [{ type: ct.type, charset: ct.params.charset || '', text: '', filename: ct.params.name || '' }];
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析一封完整邮件。
 * @param {Buffer|string} input 原始字节（推荐 Buffer）
 * @returns {{subject,from,to,date,messageId,headers,bodies,text,html}}
 *          text 为正文合并文本（优先 text/plain，其次 html 转换结果）
 */
function parseMail(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'binary');
  const { headerBuf, bodyBuf } = splitMessage(buf);
  const headers = parseHeaders(headerBuf);

  const bodies = collectBodies(headerBuf, bodyBuf, 0);

  /* 正文优先级：text/plain 全部拼接；没有则用 html 转换结果 */
  const plains = bodies.filter((b) => b.type === 'text/plain' && b.text.trim());
  const htmls = bodies.filter((b) => b.type === 'text/html' && b.text.trim());
  let text = '';
  if (plains.length) text = plains.map((b) => b.text).join('\n');
  else if (htmls.length) text = htmls.map((b) => b.text).join('\n');

  const dec = (v) => decodeEncodedWords(String(v || ''));

  return {
    subject: dec(headers.subject),
    from: dec(headers.from),
    to: dec(headers.to),
    date: headers.date || '',
    messageId: String(headers['message-id'] || '').replace(/[<>]/g, ''),
    headers,
    bodies,
    text: text.replace(/\r\n/g, '\n').trim(),
    html: htmls.length ? htmls.map((b) => b.text).join('\n') : '',
    /* 正文里出现的链接（招标邮件的原文地址通常在这里） */
    links: extractLinks(bodies)
  };
}

/** 从正文中提取 http(s) 链接
 *  注意：htmlToText 会把 <a href="..."> 变成锚文本，链接本身会丢，
 *  因此必须同时扫原始 HTML 源和纯文本。只发 HTML 版的平台全靠这一步。 */
function extractLinks(bodies) {
  const out = [];
  const seen = new Set();
  const push = (url) => {
    const u = String(url).replace(/[.,;:)\]}]+$/, '');
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  };
  for (const b of bodies) {
    /* 原始 HTML（未经 htmlToText 处理的那份） */
    if (b.rawHtml) {
      const re = /(?:href|src)\s*=\s*["']?(https?:\/\/[^\s"'<>）)，。；;]+)/gi;
      let m;
      while ((m = re.exec(b.rawHtml))) push(m[1]);
    }
    /* 纯文本 / 已转换的正文 */
    const src = b.text || '';
    const re = /https?:\/\/[^\s"'<>）)，。；;、]+/gi;
    let m;
    while ((m = re.exec(src))) push(m[0]);
  }
  return out;
}

/**
 * 从 raw From 头里取邮箱地址。
 * 例："新疆公共资源交易网" <noreply@ggzy.xinjiang.gov.cn> → noreply@ggzy.xinjiang.gov.cn
 */
function parseAddress(fromValue) {
  const s = decodeEncodedWords(String(fromValue || ''));
  const m = s.match(/<([^>]+)>/);
  if (m) return m[1].trim().toLowerCase();
  const m2 = s.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  return m2 ? m2[0].toLowerCase() : '';
}

module.exports = {
  parseMail,
  decodeEncodedWords,
  decodeBuffer,
  decodeQP,
  parseHeaders,
  parseContentType,
  htmlToText,
  extractLinks,
  parseAddress
};
