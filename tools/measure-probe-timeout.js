/**
 * 用毫秒精度测量 curl 探测死端口的真实耗时，找出最小可用超时。
 * 用法：node tools/measure-probe-timeout.js
 */
'use strict';

const { spawnSync } = require('node:child_process');

/** 通过 cmd 运行 curl，用 Date.now() 计时（避免 Node 捕获 stdout 的干扰） */
function timed(label, args) {
  const cmdLine = `curl ${args.join(' ')} >NUL 2>NUL`;
  const t = Date.now();
  spawnSync('cmd.exe', ['/c', cmdLine], { stdio: 'ignore', windowsHide: true });
  const ms = Date.now() - t;
  console.log(`  ${label.padEnd(46)} ${String(ms).padStart(6)} ms`);
  return ms;
}

console.log('=== 死端口 8900 上的探测耗时（毫秒精度）===\n');
timed('curl --max-time 2', ['-s', '--max-time', '2', 'http://127.0.0.1:8900/api/health']);
timed('curl --max-time 1', ['-s', '--max-time', '1', 'http://127.0.0.1:8900/api/health']);
timed('curl --connect-timeout 0.3 --max-time 1', ['-s', '--connect-timeout', '0.3', '--max-time', '1', 'http://127.0.0.1:8900/api/health']);
timed('curl --connect-timeout 0.2 --max-time 1', ['-s', '--connect-timeout', '0.2', '--max-time', '1', 'http://127.0.0.1:8900/api/health']);
timed('curl --connect-timeout 0.1 --max-time 1', ['-s', '--connect-timeout', '0.1', '--max-time', '1', 'http://127.0.0.1:8900/api/health']);
timed('纯 cmd 空转（基准开销）', ['-s', '--version']);

console.log('\n=== 有服务端口 8899 上（必须成功）===\n');
timed('curl --max-time 1', ['-s', '--max-time', '1', 'http://127.0.0.1:8899/api/health']);
timed('curl --connect-timeout 0.1 --max-time 1', ['-s', '--connect-timeout', '0.1', '--max-time', '1', 'http://127.0.0.1:8899/api/health']);

console.log('\n=== 11 端口扫描总耗时（仅 8899 有服务）===\n');
{
  const t = Date.now();
  for (let p = 8899; p <= 8910; p++) {
    spawnSync('cmd.exe', ['/c', `curl -s --max-time 1 http://127.0.0.1:${p}/api/health >NUL 2>NUL`],
      { stdio: 'ignore', windowsHide: true });
  }
  console.log(`  旧写法 max-time 2 预估            ${String((Date.now() - t) / 1000 * 2).padStart(6)} s（按 2s/端口推算）`);
}
{
  const t = Date.now();
  for (let p = 8899; p <= 8910; p++) {
    spawnSync('cmd.exe', ['/c', `curl -s --max-time 1 http://127.0.0.1:${p}/api/health >NUL 2>NUL`],
      { stdio: 'ignore', windowsHide: true });
  }
  console.log(`  新写法 max-time 1（实测）        ${String((Date.now() - t) / 1000).padStart(6)} s`);
}
