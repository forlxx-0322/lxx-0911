/**
 * 逐行转储 启动.bat 的原始字节，用于确认 cmd 实际读到什么。
 * 用法：node tools/dump-bat-bytes.js [文件名]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const name = process.argv[2] || '启动.bat';
const file = path.join(ROOT, name);
const buf = fs.readFileSync(file);

console.log(`文件：${name}`);
console.log(`大小：${buf.length} 字节`);
console.log(`前 3 字节：${[...buf.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
console.log('');

/* 按 CRLF 切行（cmd 的行分隔） */
const text = buf.toString('utf8');
const lines = text.split(/\r\n/);
console.log(`按 CRLF 切分：${lines.length} 行（最后一项${lines[lines.length - 1] === '' ? '为空，说明以 CRLF 结尾' : '非空'}）`);
console.log('');

/* 找出所有非 ASCII 行，并打印其字节，便于判断编码是否一致 */
let nonAscii = 0;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/[^\x00-\x7F]/.test(l)) nonAscii++;
}
console.log(`含非 ASCII 字符的行数：${nonAscii}`);
console.log('');

/* 检查每行的字节在 UTF-8 下是否合法 */
const dec = new TextDecoder('utf-8', { fatal: true });
let bad = 0;
for (let i = 0; i < lines.length; i++) {
  try {
    dec.decode(Buffer.from(lines[i], 'utf8'));
  } catch (_) {
    console.log(`  ⚠ 第 ${i + 1} 行不是合法 UTF-8`);
    bad++;
  }
}
console.log(bad ? `共 ${bad} 行编码异常` : '  ✓ 全部行都是合法 UTF-8');
console.log('');

/* 打印关键行的字节，确认 rem 行与 call 行 */
console.log('=== 关键行（行号 / 内容 / 是否以 rem 开头）===');
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  const n = i + 1;
  const isRem = /^\s*rem[\s]/.test(l);
  const isLabel = /^:[a-zA-Z]/.test(l.trim());
  const isCall = /^\s*call\s/i.test(l);
  if (n >= 81 && n <= 131) {
    const mark = isRem ? '[rem]' : (isLabel ? '[标号]' : (isCall ? '[call]' : '[命令]'));
    console.log(`  ${String(n).padStart(3)} ${mark} ${l}`);
  }
}
console.log('');
console.log('=== 第 98 行原始字节 ===');
const l98 = Buffer.from(lines[97] || '', 'utf8');
console.log(`  长度 ${l98.length} 字节`);
console.log('  ' + [...l98].map((b) => b.toString(16).padStart(2, '0')).join(' '));
console.log(`  解码：${l98.toString('utf8')}`);
console.log(`  以 rem 开头：${/^\s*rem[\s]/.test(lines[97] || '')}`);
console.log(`  含 < > & | ^ 等特殊字符：${/[<>&|^]/.test(lines[97] || '')}`);
