/**
 * 公共组件与图标
 * 阶段一提供布局骨架；阶段二在此扩展表格 / 分页 / 抽屉 / 弹窗等。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  /* ---------------- 图标 ---------------- */
  const PATHS = {
    home: 'M12 3 2.5 10.5V21h7v-6h5v6h7V10.5L12 3Z',
    customers: 'M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM22 20v-1.5a4 4 0 0 0-3-3.87',
    projects: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l1.6 2H18.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z',
    tasks: 'M9 4.5h9M9 12h9M9 19.5h9M4 4.5h.01M4 12h.01M4 19.5h.01',
    settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM3 12h1.6M19.4 12H21M12 3v1.6M12 19.4V21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M18.4 5.6l-1.1 1.1M6.7 17.3l-1.1 1.1',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
    folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l1.6 2H18.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z',
    refresh: 'M20 11a8 8 0 1 0-2.3 6.3M20 5.5V11h-5.5',
    database: 'M12 8c4.4 0 8-1.1 8-2.5S16.4 3 12 3 4 4.1 4 5.5 7.6 8 12 8ZM4 5.5v13C4 19.9 7.6 21 12 21s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5',
    check: 'M20 6 9 17l-5-5',
    alert: 'M12 9v4.5M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5.2l3.2 1.9',
    money: 'M12 2v20M17 6.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2.2 2.8 5 3.4 5 1.5 5 3.4-2.2 3.2-5 3.2-5-1.3-5-3.2',
    map: 'M9 3.5 3 6v14.5l6-2.5 6 2.5 6-2.5V3.5L15 6 9 3.5ZM9 3.5V18M15 6v14.5',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    file: 'M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z',
    list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
    plus: 'M12 5v14M5 12h14',
    trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11.5v6M14 11.5v6',
    book: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v14.5H6.5A2.5 2.5 0 0 0 4 20V5.5ZM4 20a2.5 2.5 0 0 1 2.5-2.5H20V21H6.5A2.5 2.5 0 0 1 4 20Z',
    sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z'
  };

  /** 通用图标组件：<c-icon name="home" /> */
  const CIcon = {
    name: 'CIcon',
    props: {
      name: { type: String, required: true },
      size: { type: [Number, String], default: 18 }
    },
    computed: {
      d() { return PATHS[this.name] || PATHS.file; }
    },
    template: `
      <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="1.7" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <path :d="d" />
      </svg>`
  };

  /* ---------------- 侧边栏 ---------------- */
  const Sidebar = {
    name: 'Sidebar',
    props: {
      activeKey: String,
      appName: String,
      version: String
    },
    data() {
      return { online: true };
    },
    computed: {
      groups() {
        const map = new Map();
        for (const item of CRM.router.MENU) {
          if (!map.has(item.group)) map.set(item.group, []);
          map.get(item.group).push(item);
        }
        return [...map.entries()];
      }
    },
    methods: {
      go(path) { CRM.router.navigate(path); }
    },
    mounted() {
      this._on = () => { this.online = navigator.onLine; };
      window.addEventListener('online', this._on);
      window.addEventListener('offline', this._on);
      this.online = navigator.onLine;
    },
    beforeUnmount() {
      window.removeEventListener('online', this._on);
      window.removeEventListener('offline', this._on);
    },
    template: `
      <aside class="sidebar">
        <div class="brand">
          <svg class="brand-logo" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <rect x="1" y="1" width="30" height="30" rx="8" fill="#2f6fed"/>
            <path d="M9 21V11l7-4 7 4v10" stroke="#fff" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="16" cy="16.5" r="3" stroke="#fff" stroke-width="2"/>
          </svg>
          <div class="brand-text">
            <div class="brand-title">{{ appName || '客户管理系统' }}</div>
            <div class="brand-sub">阀门行业版 · {{ version || '' }}</div>
          </div>
        </div>

        <nav class="nav">
          <template v-for="[group, items] in groups" :key="group">
            <div class="nav-group-label">{{ group }}</div>
            <a v-for="item in items" :key="item.key"
               class="nav-item" :class="{ active: item.key === activeKey }"
               :href="'#' + item.path"
               @click.prevent="go(item.path)">
              <c-icon class="nav-icon" :name="item.key" />
              <span>{{ item.title }}</span>
            </a>
          </template>
        </nav>

        <div class="sidebar-foot">
          <span class="dot" :class="{ off: !online }"></span>
          <span>{{ online ? '本地服务已连接' : '网络已断开（不影响使用）' }}</span>
        </div>
      </aside>`
  };

  /* ---------------- 顶栏 ---------------- */
  const Topbar = {
    name: 'Topbar',
    props: {
      title: String,
      subtitle: String
    },
    setup() {
      return { theme: CRM.theme.state, themeApi: CRM.theme };
    },
    template: `
      <header class="topbar">
        <div>
          <div class="topbar-title">{{ title }}</div>
          <div class="topbar-sub" v-if="subtitle">{{ subtitle }}</div>
        </div>
        <div class="topbar-spacer"></div>
        <div class="search-placeholder" title="全局搜索将在阶段四提供">
          <c-icon name="search" :size="15" />
          <span>全局搜索</span>
          <span class="kbd" style="margin-left:auto">Ctrl K</span>
        </div>
        <button class="icon-btn theme-toggle" type="button"
                :title="theme.mode === 'dark' ? '切换到浅色主题' : '切换到深色主题'"
                :aria-label="theme.mode === 'dark' ? '切换到浅色主题' : '切换到深色主题'"
                @click="themeApi.toggle()">
          <span class="tt-track" :class="{ on: theme.mode === 'dark' }">
            <span class="tt-thumb">
              <c-icon :name="theme.mode === 'dark' ? 'moon' : 'sun'" :size="12" />
            </span>
          </span>
        </button>
      </header>`
  };

  /* ---------------- 页面头部 ---------------- */
  const PageHeader = {
    name: 'PageHeader',
    props: {
      title: String,
      desc: String
    },
    template: `
      <div style="margin-bottom:16px">
        <h2 style="font-size:var(--fs-xl)">{{ title }}</h2>
        <p v-if="desc" class="muted" style="margin:6px 0 0;font-size:var(--fs-sm)">{{ desc }}</p>
      </div>`
  };

  /* ---------------- 阶段占位 ---------------- */
  const Placeholder = {
    name: 'Placeholder',
    props: {
      icon: { type: String, default: 'file' },
      title: String,
      desc: String,
      phase: String,
      items: { type: Array, default: () => [] }
    },
    template: `
      <div class="placeholder">
        <c-icon class="placeholder-icon" :name="icon" :size="56" />
        <h3>{{ title }}</h3>
        <p>{{ desc }}</p>
        <ul class="plan-list" v-if="items.length">
          <li v-for="(it, i) in items" :key="i">
            <span class="pin">{{ it.pin }}</span>
            <span class="txt">{{ it.text }}</span>
          </li>
        </ul>
        <div class="phase-note" v-if="phase">{{ phase }}</div>
      </div>`
  };

  /* ---------------- 空状态 ---------------- */
  const EmptyState = {
    name: 'EmptyState',
    props: {
      icon: { type: String, default: 'list' },
      title: { type: String, default: '暂无数据' },
      desc: String
    },
    template: `
      <div class="placeholder" style="padding:40px 24px">
        <c-icon class="placeholder-icon" :name="icon" :size="44" />
        <h3 style="font-size:var(--fs-md)">{{ title }}</h3>
        <p v-if="desc" style="font-size:var(--fs-sm)">{{ desc }}</p>
      </div>`
  };

  /* ---------------- 卡片 ---------------- */
  const Card = {
    name: 'Card',
    props: {
      title: String,
      sub: String,
      icon: String
    },
    template: `
      <section class="card">
        <div class="card-head" v-if="title || $slots.head">
          <c-icon v-if="icon" :name="icon" :size="17" style="color:var(--c-text-3)" />
          <div>
            <div class="card-title">{{ title }}</div>
            <div class="card-sub" v-if="sub">{{ sub }}</div>
          </div>
          <div class="spacer"></div>
          <slot name="head"></slot>
        </div>
        <div class="card-body"><slot></slot></div>
      </section>`
  };

  CRM.components = { CIcon, Sidebar, Topbar, PageHeader, Placeholder, EmptyState, Card, PATHS };

  /** 注册到 Vue 全局 */
  CRM.registerComponents = function (app) {
    app.component('c-icon', CIcon);
    app.component('c-sidebar', Sidebar);
    app.component('c-topbar', Topbar);
    app.component('c-page-header', PageHeader);
    app.component('c-placeholder', Placeholder);
    app.component('c-empty', EmptyState);
    app.component('c-card', Card);
  };

})(window.CRM);
