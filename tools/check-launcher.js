/**
 * 验证启动器里的两个子过程逻辑与 bat 中一致：
 *   1) 用 curl 探测健康接口并识别签名（替代原 PowerShell 方案）
 *   2) 找出第一个空闲端口
 *
 * 不启动新服务、不停现有服务，只验证判断逻辑与 bat 写法等价。
 *
 * 用法：node tools/check-launcher.js
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8899;
const MAXPORT = 8910;

console.log('=== 启动器逻辑验证 ===\n');

/* ---------- 1. bat 里用的 curl 探测，等价写法 ---------- */
console.log('1) 健康探测（curl + findstr 签名判定）');
let alive = 0;
let foundPort = '';
for (let p = PORT; p <= MAXPORT; p++) {
  let out = '';
  try {
    out = execFileSync('curl.exe', ['-s', '--max-time', '2', `http://127.0.0.1:${p}/api/health`],
      { encoding: 'utf8', timeout: 5000 });
  } catch (_) { out = ''; }
  if (out.includes('crm-bjxt')) { alive = 1; foundPort = p; break; }
}
console.log(`   探测结果：RUNNING=${alive}  FOUNDPORT=${foundPort || '(空)'}`);
console.log(`   ${alive === 1 ? '✓ 能识别出正在运行的本软件服务' : '⚠ 未探测到服务（若服务未运行则属正常）'}`);
console.log('');

/* ---------- 2. 第一个空闲端口 ---------- */
console.log('2) 空闲端口查找（netstat LISTENING 判定）');
let netstat = '';
try {
  netstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 10000 });
} catch (e) { netstat = ''; }
const listening = new Set();
for (const line of netstat.split(/\r?\n/)) {
  if (!/LISTENING/.test(line)) continue;
  const m = line.match(/:(\d+)\s/);
  if (m) listening.add(Number(m[1]));
}
let freePort = '';
for (let p = PORT; p <= MAXPORT; p++) {
  if (!listening.has(p)) { freePort = p; break; }
}
console.log(`   监听中的端口数：${listening.size}`);
console.log(`   8899 是否被占用：${listening.has(8899)}`);
console.log(`   第一个空闲端口：${freePort || '(无)'}`);
console.log(`   ${freePort ? '✓ 能选出可用端口' : '✗ 8899~8910 全被占用'}`);
console.log('');

/* ---------- 3. bat 文件静态检查 ---------- */
console.log('3) bat 文件静态检查');
for (const name of ['启动.bat', '停止.bat', '打开数据目录.bat']) {
  const buf = fs.readFileSync(path.join(ROOT, name));
  const text = buf.toString('utf8');
  const lines = text.split(/\r\n/);
  const problems = [];

  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) problems.push('含 UTF-8 BOM（cmd 会把 BOM 当命令）');
  const lfOnly = (text.match(/(?<!\r)\n/g) || []).length;
  if (lfOnly > 0) problems.push(`有 ${lfOnly} 处 LF-only 换行（应为 CRLF）`);

  /* rem 行必须全是 ASCII，否则代码页不匹配时可能被解析成命令 */
  const cnRem = lines
    .map((l, i) => ({ l, n: i + 1 }))
    .filter((x) => /^\s*rem\s/i.test(x.l) && /[^\x00-\x7F]/.test(x.l));
  if (cnRem.length) problems.push(`有 ${cnRem.length} 行 rem 含非 ASCII 字符（第 ${cnRem.map((x) => x.n).join(',')} 行）`);

  /* 是否残留旧的 PowerShell 探测 */
  const hasPsProbe = lines.some((l) => /Invoke-WebRequest -Uri \('http:\/\/127\.0\.0\.1:%1\/api\/health'\)/.test(l));
  if (hasPsProbe) problems.push('仍使用旧 PowerShell 探测（应已换成 curl）');

  console.log(`   ${name}  ${buf.length} 字节`);
  if (problems.length) {
    for (const p of problems) console.log(`     ⚠ ${p}`);
  } else {
    console.log('     ✓ 无 BOM、全 CRLF、rem 全 ASCII');
  }
}
console.log('');

/* ---------- 4. 结论 ---------- */
const ok = alive === 1 && !!freePort;
console.log(ok ? '结论：启动器逻辑正常' : '结论：存在问题，见上');
process.exit(ok ? 0 : 1);
