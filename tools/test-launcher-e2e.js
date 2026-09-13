/**
 * 端到端验证启动器：停掉服务 → 用 启动.bat 启动 → 验证服务可用 → 收尾。
 *
 * 用法：node tools/test-launcher-e2e.js
 *
 * 说明：会短暂中断本机服务，用于验证"服务未运行时"的完整启动路径。
 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8899;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    const j = await res.json();
    return j && j.data;
  } catch (_) { return null; }
}

(async () => {
  console.log('=== 启动器端到端验证 ===\n');

  /* ---------- 1. 先确认当前状态 ---------- */
  const before = await health(PORT);
  console.log(`1) 当前状态：${before ? `运行中（PID ${before.pid}）` : '未运行'}`);

  /* ---------- 2. 优雅停掉服务 ---------- */
  if (before) {
    console.log('2) 通过接口优雅停机…');
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    } catch (_) { /* 连接可能被主动断开，属正常 */ }
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (!(await health(PORT))) break;
    }
    const still = await health(PORT);
    console.log(`   停机结果：${still ? '⚠ 仍在运行' : '✓ 已停止'}`);
    /* 兜底：按 run.json 记录强杀 */
    if (still) {
      try {
        const rf = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '.run.json'), 'utf8'));
        execFileSync('taskkill', ['/PID', String(rf.pid), '/T', '/F'], { stdio: 'ignore' });
        await sleep(2000);
      } catch (_) { /* 忽略 */ }
    }
  }

  /* ---------- 3. 用启动器启动 ---------- */
  console.log('3) 运行 启动.bat（真实双击等价）…');
  const outFile = path.join(ROOT, '.fixtures', 'launcher-e2e.log');
  const child = spawn('cmd.exe', ['/c', path.join(ROOT, '启动.bat')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fs.openSync(outFile, 'w'), fs.openSync(outFile, 'a')]
  });
  child.unref();

  /* ---------- 4. 等待服务就绪 ---------- */
  let started = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    started = await health(PORT);
    if (started) break;
  }

  console.log('');
  if (!started) {
    console.log('✗ 启动失败。启动器输出：');
    console.log(fs.readFileSync(outFile, 'utf8').split(/\r?\n/).map((l) => '    ' + l).join('\n'));
    process.exit(1);
  }
  console.log(`✓ 服务已启动：版本 ${started.version}，PID ${started.pid}，端口 ${started.port}`);

  /* ---------- 5. 验证启动器输出无报错 ---------- */
  const log = fs.readFileSync(outFile, 'utf8');
  const badLines = log.split(/\r?\n/).filter((l) =>
    /is not recognized|not recognized as an internal|拒绝访问|Access is denied|Cannot find module/i.test(l));
  console.log(`   启动器输出：${badLines.length ? '⚠ 含报错行' : '✓ 无报错'}`);
  for (const l of badLines.slice(0, 5)) console.log('      ' + l.trim());

  /* ---------- 6. 再跑一次启动器（应走"已在运行"分支） ---------- */
  console.log('\n4) 再次运行 启动.bat（服务已在运行，应秒退并打开页面）…');
  const t0 = Date.now();
  let second = '';
  try {
    second = execFileSync('cmd.exe', ['/c', path.join(ROOT, '启动.bat')], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  } catch (e) { second = (e.stdout || '') + (e.stderr || ''); }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const saidRunning = /服务已在运行/.test(second);
  const badLines2 = second.split(/\r?\n/).filter((l) => /is not recognized|Cannot find module/i.test(l));
  console.log(`   耗时 ${elapsed}s，识别为已在运行=${saidRunning}，报错行=${badLines2.length}`);
  if (badLines2.length) for (const l of badLines2.slice(0, 3)) console.log('      ' + l.trim());

  /* ---------- 7. 最终状态 ---------- */
  const final = await health(PORT);
  console.log('');
  console.log('=== 结果 ===');
  console.log(`  启动路径：${started ? '✓ 正常' : '✗ 失败'}`);
  console.log(`  重复启动：${saidRunning && !badLines2.length ? '✓ 正确识别，未起新实例' : '⚠ 需检查'}`);
  console.log(`  报错输出：${badLines.length === 0 && badLines2.length === 0 ? '✓ 无' : '⚠ 有'}`);
  console.log(`  服务状态：${final ? `运行中（PID ${final.pid}，版本 ${final.version}）` : '未运行'}`);

  /* 数据完整性粗查 */
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/customers?pageSize=1`, { signal: AbortSignal.timeout(4000) });
    const j = await res.json();
    console.log(`  客户数据：${j.data.total} 条`);
  } catch (_) { console.log('  客户数据：读取失败'); }

  process.exit(badLines.length === 0 && badLines2.length === 0 && final ? 0 : 1);
})();
