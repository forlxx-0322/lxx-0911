/**
 * 本地模拟 SMTP 服务器（仅用于测试，零依赖）
 *
 * 用 Node 内置 tls + 自签证书提供 465 隐式 TLS 服务，
 * 按 SMTP 协议与客户端对话，便于在无真实邮箱的情况下验证客户端实现。
 *
 * 用法（测试脚本内）：
 *   const { startMockSmtp } = require('./.fixtures/mock-smtp');
 *   const srv = await startMockSmtp({ user: 'me@example.com', pass: 'auth-code-123456' });
 *   ... srv.port, srv.records, srv.close()
 */
'use strict';

const tls = require('node:tls');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 生成一次性自签证书（每个测试进程一份，放临时目录） */
function ensureCert(dir) {
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) return { keyFile, certFile };

  const openssl = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'openssl']
      .find((p) => p === 'openssl' || fs.existsSync(p))
    : 'openssl';

  try {
    execFileSync(openssl, [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyFile, '-out', certFile,
      '-days', '2', '-subj', '/CN=localhost'
    ], { stdio: 'ignore' });
    return { keyFile, certFile };
  } catch (_) {
    /* openssl 不可用时退回 Node 自签（不依赖外部命令） */
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    fs.writeFileSync(certFile, publicKey.export({ type: 'spki', format: 'pem' }));
    return { keyFile, certFile, selfSignedByNode: true };
  }
}

/**
 * 启动模拟 SMTP 服务器。
 * @param {object} opts
 *   user / pass   期望的认证信息（用于校验客户端是否正确发送）
 *   failAuth      true 时始终返回 535（用于测试认证失败路径）
 *   closeOnData   true 时在 DATA 阶段断开（用于测试连接被关闭的路径）
 *   greetingDelay 毫秒，延迟发出 220 欢迎语（用于测试超时）
 * @returns {Promise<{port, records, close, errors}>}
 */
async function startMockSmtp(opts) {
  const o = opts || {};
  const expectUser = o.user || 'me@example.com';
  const expectPass = o.pass || 'auth-code-123456';

  const tmp = path.join(__dirname, 'smtp-cert');
  fs.mkdirSync(tmp, { recursive: true });
  const { keyFile, certFile } = ensureCert(tmp);

  const records = [];
  const errors = [];
  const sockets = new Set();

  const server = tls.createServer({
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile)
  }, (socket) => {
    sockets.add(socket);
    let buf = '';
    let state = 'greeting';     // greeting → ehlo → user → pass → mail → rcpt → data → done
    let authUser = '';
    let envelope = { from: '', to: [], data: '' };

    const say = (line) => { try { socket.write(line + '\r\n'); } catch (_) { /* 忽略 */ } };

    if (o.greetingDelay) setTimeout(() => say('220 mock ESMTP ready'), o.greetingDelay);
    else say('220 mock ESMTP ready');

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        if (state === 'data') {
          if (line === '.') {
            records.push({
              from: envelope.from,
              to: envelope.to.slice(),
              raw: envelope.data,
              authUser,
              receivedAt: new Date().toISOString()
            });
            state = 'done';
            say('250 OK queued');
          } else {
            envelope.data += line + '\r\n';
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          say('250-mock');
          say('250-AUTH LOGIN PLAIN');
          say('250 SIZE 20971520');
          state = 'ehlo';
        } else if (upper === 'AUTH LOGIN') {
          state = 'user';
          say('334 VXNlcm5hbWU6');
        } else if (state === 'user') {
          authUser = Buffer.from(line, 'base64').toString('utf8');
          state = 'pass';
          say('334 UGFzc3dvcmQ6');
        } else if (state === 'pass') {
          const pass = Buffer.from(line, 'base64').toString('utf8');
          if (o.failAuth || authUser !== expectUser || pass !== expectPass) {
            state = 'greeting';
            say('535 5.7.8 Authentication credentials invalid');
          } else {
            state = 'mail';
            say('235 2.7.0 Authentication successful');
          }
        } else if (upper.startsWith('MAIL FROM')) {
          envelope = { from: (line.match(/<([^>]*)>/) || [])[1] || '', to: [], data: '' };
          state = 'rcpt';
          say('250 OK');
        } else if (upper.startsWith('RCPT TO')) {
          envelope.to.push((line.match(/<([^>]*)>/) || [])[1] || '');
          say('250 OK');
        } else if (upper === 'DATA') {
          if (o.closeOnData) { socket.destroy(); return; }
          state = 'data';
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper === 'QUIT') {
          say('221 Bye');
          socket.end();
        } else if (upper === 'RSET') {
          say('250 OK');
        } else {
          say('502 Command not implemented');
        }
      }
    });

    socket.on('error', (e) => errors.push(e.message));
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    host: '127.0.0.1',
    records,
    errors,
    user: expectUser,
    pass: expectPass,
    close() {
      for (const s of sockets) { try { s.destroy(); } catch (_) { /* 忽略 */ } }
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { startMockSmtp };
