/**
 * 第三方库本地化脚本
 *
 * 目的：让软件**完全离线可用**——运行时不允许出现任何外部请求（验收标准第 10 条）。
 * 因此 vue / echarts / xlsx 三个库全部下载到 web/vendor/ 后由本地服务器提供。
 *
 * 用法：node tools/fetch-vendor.js
 * 说明：仅在开发期联网执行一次；打包/分发后无需再运行。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'web', 'vendor');
const TMP = path.join(ROOT, '.tmp-vendor');

/** 直接下载的静态资源 */
const DOWNLOADS = [
  {
    name: 'echarts.min.js',
    url: 'https://registry.npmmirror.com/echarts/5.5.1/files/dist/echarts.min.js',
    desc: 'ECharts 5.5.1（图表与地图渲染）'
  },
  {
    name: 'xlsx.full.min.js',
    url: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
    desc: 'SheetJS 0.20.3（Excel 导入导出）'
  }
];

/** 需要从 npm 包中提取的文件 */
const NPM_EXTRACTS = [
  {
    pkg: 'vue@3.5.13',
    inner: 'package/dist/vue.global.prod.js',
    name: 'vue.global.prod.js',
    desc: 'Vue 3.5.13 全局构建版（生产版，不含开发警告）'
  }
];

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error(`响应过小（${buf.length} 字节），可能不是有效文件`);
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/** 从 npm 包中解出指定内部路径的文件 */
function extractFromNpm(spec, innerPath) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const env = Object.assign({}, process.env, { npm_config_cache: path.join(ROOT, '.npm-cache') });
  const out = execFileSync('npm', ['pack', spec, '--silent'], {
    cwd: TMP, env, encoding: 'utf8', shell: true
  }).trim().split(/\r?\n/).pop().trim();

  const tgz = path.join(TMP, out);
  if (!fs.existsSync(tgz)) throw new Error(`未找到 npm pack 产物：${out}`);

  // Windows 10+ 自带 bsdtar
  execFileSync('tar', ['-xzf', out, '-C', '.'], { cwd: TMP, stdio: 'inherit' });

  const src = path.join(TMP, ...innerPath.split('/'));
  if (!fs.existsSync(src)) throw new Error(`包内未找到：${innerPath}`);
  return src;
}

async function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  const results = [];

  for (const item of DOWNLOADS) {
    process.stdout.write(`下载 ${item.name} … `);
    try {
      const size = await download(item.url, path.join(VENDOR, item.name));
      console.log(`完成 ${humanSize(size)}`);
      results.push({ name: item.name, size, ok: true, desc: item.desc });
    } catch (e) {
      console.log(`失败：${e.message}`);
      results.push({ name: item.name, ok: false, desc: item.desc, error: e.message });
    }
  }

  for (const item of NPM_EXTRACTS) {
    process.stdout.write(`提取 ${item.name} … `);
    try {
      const src = extractFromNpm(item.pkg, item.inner);
      const dest = path.join(VENDOR, item.name);
      fs.copyFileSync(src, dest);
      const size = fs.statSync(dest).size;
      console.log(`完成 ${humanSize(size)}`);
      results.push({ name: item.name, size, ok: true, desc: item.desc });
    } catch (e) {
      console.log(`失败：${e.message}`);
      results.push({ name: item.name, ok: false, desc: item.desc, error: e.message });
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('\n--- 本地化结果 ---');
  let total = 0;
  for (const r of results) {
    if (r.ok) total += r.size;
    console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(22)} ${r.ok ? humanSize(r.size).padStart(9) : '失败'}  ${r.desc}`);
  }
  console.log(`\n合计 ${humanSize(total)}，存放于 web/vendor/`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\n注意：有文件下载失败。软件仍可运行，但相关功能会不可用。');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('执行失败：', e && e.stack ? e.stack : e);
  process.exit(1);
});
