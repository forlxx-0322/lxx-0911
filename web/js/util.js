/**
 * 通用工具函数
 * 全局命名空间：window.CRM
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  /** 日期格式化：支持 Date / 时间戳 / 'YYYY-MM-DD...' 字符串 */
  function fmtDate(value, withTime) {
    if (value === null || value === undefined || value === '') return '';
    let d;
    if (value instanceof Date) d = value;
    else if (typeof value === 'number') d = new Date(value);
    else d = new Date(String(value).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(value);

    const p = (n) => String(n).padStart(2, '0');
    const ymd = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    if (!withTime) return ymd;
    return `${ymd} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 相对时间：如「3 分钟前」「2 天前」 */
  function fromNow(value) {
    const d = value instanceof Date ? value : new Date(String(value).replace(' ', 'T'));
    if (isNaN(d.getTime())) return '';
    const diff = Date.now() - d.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时前`;
    const day = Math.floor(hour / 24);
    if (day < 30) return `${day} 天前`;
    return fmtDate(d);
  }

  /** 金额格式化：千分位 + 两位小数（整数则不显示小数） */
  function fmtMoney(value, unit) {
    const n = Number(value);
    if (!isFinite(n)) return '0';
    const fixed = Math.abs(n % 1) < 1e-9 ? n.toFixed(0) : n.toFixed(2);
    const s = fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return unit ? `${s} ${unit}` : s;
  }

  /** 金额简写：12.5万 / 1.2亿 */
  function fmtMoneyShort(value) {
    const n = Number(value) || 0;
    const abs = Math.abs(n);
    if (abs >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + ' 亿';
    if (abs >= 1e4) return (n / 1e4).toFixed(2).replace(/\.?0+$/, '') + ' 万';
    return fmtMoney(n);
  }

  /** 文件体积 */
  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  /** 时长：秒 → 1小时23分 */
  function fmtDuration(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分 ${s % 60} 秒`;
    const h = Math.floor(m / 60);
    return `${h} 小时 ${m % 60} 分`;
  }

  /** 按字典取显示名 */
  function dictLabel(category, value) {
    return (CRM.DICT_LABEL && CRM.DICT_LABEL[category]) || value || '';
  }

  /** 简易防抖 */
  function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait || 300);
    };
  }

  /** 文本为空时显示占位符 */
  function orDash(v) {
    const s = (v === null || v === undefined) ? '' : String(v).trim();
    return s === '' ? '—' : s;
  }

  CRM.util = {
    fmtDate, fromNow, fmtMoney, fmtMoneyShort, fmtSize, fmtDuration,
    dictLabel, debounce, orDash
  };

})(window.CRM);
