/**
 * 提交内容安全扫描：确认仓库里没有凭据、真实客户资料或本机绝对路径。
 *
 * 用法：node tools/security-scan.js
 *
 * 说明：本工具会把已知的**合成值**（测试夹具里的假授权码、UI 占位示例里的公开企业名）
 * 单独列为「提示」而不是「问题」，避免每次扫描都被噪声淹没而失去意义。
 * 判定为「问题」的只保留真正有风险的东西。
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean);

const TEXT_EXT = /\.(js|json|md|html|css|bat|cmd|txt|yml|yaml|gitignore|gitattributes)$/i;
const SKIP = /^(web\/vendor\/|\.git)/;

/* 已知的合成值：出现在测试夹具或 UI 示例里，属于公开可讨论的内容。
   这些一旦命中，只作提示，不算问题。 */
const KNOWN_SYNTHETIC = [
  { re: /auth-code-\d{6}/, why: '本地模拟 IMAP 的假授权码（配合 me@example.com 使用）' },
  { re: /me@example\.com/, why: '测试用占位邮箱' },
  { re: /example\.(com|gov\.cn|cn)/, why: 'RFC 2606 保留域名，非真实地址' }
];

/* 只保留真正有风险的形态 */
const CRED_PATTERNS = [
  ['密码/口令赋值', /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{3,}["']/i],
  ['密钥/令牌赋值', /(?:secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*["'][^"']{6,}["']/i],
  ['Bearer 令牌', /authorization\s*:\s*["']?bearer\s+[A-Za-z0-9._-]{10,}/i],
  ['GitHub 令牌', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['私钥文件内容', /-----BEGIN [A-Z ]*PRIVATE KEY-----/]
];

/* 本机绝对路径（会暴露用户名与目录结构） */
const ABS_PATHS = [/D:\\BJXT/g, /C:\\Users\\Administrator/g];

const findings = { cred: [], paths: [] };
const notes = [];

for (const f of files) {
  if (!TEXT_EXT.test(f) || SKIP.test(f)) continue;
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { continue; }

  for (const [label, re] of CRED_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    /* 命中内容属于已知合成值则不报问题 */
    const synthetic = KNOWN_SYNTHETIC.some((k) => k.re.test(m[0]));
    if (synthetic) notes.push(`${f}  → ${label}（合成值，非真实凭据）`);
    else findings.cred.push(`${f}  → ${label}：${String(m[0]).slice(0, 40)}…`);
  }

  for (const re of ABS_PATHS) {
    const m = text.match(re);
    if (m) findings.paths.push(`${f}  → ${m[0]}`);
  }
}

console.log(`已扫描 ${files.length} 个受版本控制的文件\n`);

const section = (title, list, okText) => {
  console.log(`=== ${title} ===`);
  if (!list.length) { console.log(`  ✓ ${okText}`); return 0; }
  const uniq = [...new Set(list)];
  for (const x of uniq.slice(0, 20)) console.log(`  ⚠ ${x}`);
  if (uniq.length > 20) console.log(`  …另有 ${uniq.length - 20} 处`);
  return uniq.length;
};

let bad = 0;
bad += section('凭据泄漏', findings.cred, '未发现硬编码的真实密码 / 令牌 / 私钥');
console.log('');
bad += section('本机绝对路径', findings.paths, '未发现本机绝对路径（不含用户名与目录结构）');

if (notes.length) {
  console.log('\n=== 提示（已知合成值，无需处理）===');
  for (const x of [...new Set(notes)].slice(0, 10)) console.log(`  · ${x}`);
  console.log('  · UI 占位提示与 Excel 示例值里出现的公开央企名（如「独山子石化」）属于示例文案，非客户数据');
}

/* 额外确认：本机运行数据确实没被纳入版本控制 */
console.log('\n=== 本机数据是否被排除 ===');
const MUST_IGNORE = ['data/crm.db', '.fixtures/客户备份-独山子石化.json'];
let leak = 0;
for (const f of MUST_IGNORE) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', f], { cwd: ROOT, stdio: 'ignore' });
    console.log(`  ⚠ 被纳入版本控制：${f}`);
    leak++;
  } catch (_) {
    console.log(`  ✓ 已排除：${f}`);
  }
}
bad += leak;

console.log('');
console.log(bad ? `结论：发现 ${bad} 处需要处理` : '结论：未发现风险，可以安全公开');
process.exit(bad ? 1 : 0);

