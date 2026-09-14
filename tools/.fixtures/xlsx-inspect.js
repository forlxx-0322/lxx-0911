/**
 * xlsx 内容校验（零依赖，手工解压）：确认列宽/行高/样式是否真的写入。
 *
 * 背景：xlsx 是 zip 压缩的，**不能用"在二进制里搜字符串"的方式判断内容**，
 * 必须解压后看 sheet1.xml。本工具就是干这个的（测试里也用它做断言）。
 *
 * 用法：
 *   const { readXlsxParts } = require('./.fixtures/xlsx-inspect');
 *   const p = readXlsxParts(buf);   // { names, sheetXml, stylesXml, hasCols, colWidths, ... }
 */
'use strict';

const zlib = require('node:zlib');

/** 列出 zip 中央目录中的条目名 */
function listEntries(b) {
  const names = [];
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 66000; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return names;
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    names.push(b.slice(off + 46, off + 46 + nameLen).toString('utf8'));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** 从 zip 中取某个条目的内容（支持 deflate 与 stored） */
function readEntry(b, target) {
  for (let i = 0; i < b.length - 30; i++) {
    if (b.readUInt32LE(i) !== 0x04034b50) continue;
    const nameLen = b.readUInt16LE(i + 26);
    const extraLen = b.readUInt16LE(i + 28);
    const name = b.slice(i + 30, i + 30 + nameLen).toString('utf8');
    if (name !== target) continue;
    const method = b.readUInt16LE(i + 8);
    const compSize = b.readUInt32LE(i + 18);
    const dataStart = i + 30 + nameLen + extraLen;
    const comp = b.slice(dataStart, dataStart + compSize);
    try {
      return (method === 8 ? zlib.inflateRawSync(comp) : comp).toString('utf8');
    } catch (_) {
      return '';
    }
  }
  return '';
}

/**
 * 解析 xlsx 内部结构。
 * @param {Buffer} buf
 * @returns {{names:string[], sheetXml:string, stylesXml:string,
 *            hasCols:boolean, colWidths:number[], hasRowHeights:boolean,
 *            hasCellStyles:boolean, hasMerges:boolean, mergeCount:number}}
 */
function readXlsxParts(bufIn) {
  /* XLSX.write({ type:'buffer' }) 可能返回 ArrayBuffer，统一成 Node Buffer */
  const buf = Buffer.isBuffer(bufIn) ? bufIn : Buffer.from(bufIn);
  const names = listEntries(buf);
  const sheetXml = readEntry(buf, 'xl/worksheets/sheet1.xml');
  const stylesXml = readEntry(buf, 'xl/styles.xml');

  /* 列宽：<col min="1" max="1" width="6.83" customWidth="1"/> */
  const colWidths = [];
  const colRe = /<col\b[^>]*\bwidth="([\d.]+)"[^>]*\/?>/g;
  let m;
  while ((m = colRe.exec(sheetXml)) !== null) colWidths.push(Number(m[1]));

  /* 行高：<row r="1" ht="26" customHeight="1"> */
  const hasRowHeights = /<row\b[^>]*\bht="[\d.]+"/.test(sheetXml);

  /* 单元格样式引用：<c r="A1" s="1" ...> */
  const hasCellStyles = /<c\b[^>]*\bs="\d+"/.test(sheetXml);

  /* 合并单元格：<mergeCells count="4"> */
  const mergeMatch = sheetXml.match(/<mergeCells\b[^>]*count="(\d+)"/);
  const mergeCount = mergeMatch ? Number(mergeMatch[1]) : 0;

  return {
    names,
    sheetXml,
    stylesXml,
    hasCols: /<cols\b/.test(sheetXml),
    colWidths,
    hasRowHeights,
    hasCellStyles,
    hasMerges: mergeCount > 0,
    mergeCount,
    hasStyles: names.includes('xl/styles.xml')
  };
}

module.exports = { readXlsxParts, listEntries, readEntry };
