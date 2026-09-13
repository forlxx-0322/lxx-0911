/**
 * 主题（浅色 / 深色）
 *
 * 设计要点：
 * - 颜色全部由 CSS 令牌驱动，切换主题只改 <html data-theme>，不重写任何组件样式；
 * - 图表里的颜色是写在 ECharts option 里的，无法用 CSS 控制，
 *   因此这里同时提供 colors() 给各页面拼 option 用；
 * - theme.state 是响应式的，页面 computed 里读它即可在切换时自动重绘图表。
 *
 * 选择持久化在 localStorage（无需登录，纯本机偏好）。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {
  const KEY = 'crm_theme';
  const { reactive, watch } = Vue;

  function systemPrefersDark() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (_) { return false; }
  }

  function readSaved() {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'dark' || v === 'light' ? v : '';
    } catch (_) { return ''; }
  }

  const saved = readSaved();
  const state = reactive({
    /* 'light' | 'dark'；首次访问跟随系统偏好 */
    mode: saved || (systemPrefersDark() ? 'dark' : 'light')
  });

  function apply(mode) {
    const el = document.documentElement;
    if (mode === 'dark') el.setAttribute('data-theme', 'dark');
    else el.removeAttribute('data-theme');
    /* 让原生控件（滚动条、日期选择器）也跟着换 */
    el.style.colorScheme = mode;
  }

  /* --- 图表配色：与 CSS 令牌保持一致 --- */
  const LIGHT = {
    palette: ['#2f6fed', '#12925a', '#c97a0c', '#8e5bd9', '#0b87b8', '#d92d3f',
      '#6b7a8f', '#e0679a', '#4aa564', '#c7811f'],
    axisLine: '#dfe5ee',
    axisLabel: '#7b8798',
    splitLine: '#eef1f6',
    tooltipBg: 'rgba(26,33,48,.94)',
    tooltipText: '#ffffff',
    /* 地图：无客户的地州填充 */
    mapEmpty: '#eef2f8',
    mapBorder: '#ffffff',
    mapLabel: '#59647a',
    seriesLabel: '#1a2130'
  };
  const DARK = {
    palette: ['#5b8ef5', '#35b377', '#e0a24a', '#a97ce8', '#3aa9d6', '#e8607a',
      '#8b97a8', '#e58bb4', '#5fbb84', '#d9a24a'],
    axisLine: '#39414f',
    axisLabel: '#8a95a8',
    splitLine: '#2c333e',
    tooltipBg: 'rgba(14,18,25,.96)',
    tooltipText: '#e6eaf0',
    mapEmpty: '#252b35',
    mapBorder: '#1a1f27',
    mapLabel: '#a8b2c1',
    seriesLabel: '#e6eaf0'
  };

  /* 首屏尽早应用，避免浅色闪一下再变深色 */
  apply(state.mode);

  watch(() => state.mode, (m) => {
    apply(m);
    try { localStorage.setItem(KEY, m); } catch (_) { /* 忽略 */ }
  });

  CRM.theme = {
    state,
    /** 当前是否深色 */
    isDark() { return state.mode === 'dark'; },
    /** 切换主题 */
    toggle() {
      state.mode = state.mode === 'dark' ? 'light' : 'dark';
      return state.mode;
    },
    /** 显式设置 */
    set(mode) {
      state.mode = mode === 'dark' ? 'dark' : 'light';
    },
    /** 图表配色（页面拼 ECharts option 时使用；读 state.mode 保证响应式） */
    colors() {
      return state.mode === 'dark' ? DARK : LIGHT;
    }
  };
})(window.CRM);
