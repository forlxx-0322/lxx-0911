/**
 * 前端路由（hash 模式）
 *
 * 选择 hash 而非 history 模式的原因：刷新页面不会 404，
 * 静态服务器无需任何重写规则，天然支持 file:// 之外的离线场景。
 *
 * 首次运行时会把地址栏里的 ?p=xxx 参数（由启动器传入）转成 hash 路由。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const { reactive } = Vue;

  /* 图标：内联 SVG path，不依赖任何图标字体或网络资源 */
  const ICON = {
    home: 'M12 3 2.5 10.5V21h7v-6h5v6h7V10.5L12 3Z',
    customers: 'M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM22 20v-1.5a4 4 0 0 0-3-3.87M16.5 3.6a4 4 0 0 1 0 7.75',
    projects: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l1.6 2H18.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z',
    tasks: 'M9 4.5h9M9 12h9M9 19.5h9M4 4.5h.01M4 12h.01M4 19.5h.01',
    collect: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-13ZM4 7.5l8 5.5 8-5.5M8.5 3v3M15.5 3v3',
    settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10 3.04V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.01Z',
    chevron: 'M9 6l6 6-6 6'
  };

  /* 左侧导航：主模块 + 底部功能设置 */
  const MENU = [
    { key: 'home',      path: '/home',      title: '首页总览', icon: ICON.home,      group: '导航' },
    { key: 'customers', path: '/customers', title: '客户管理', icon: ICON.customers, group: '导航' },
    { key: 'projects',  path: '/projects',  title: '项目管理', icon: ICON.projects,  group: '导航' },
    { key: 'tasks',     path: '/tasks',     title: '待办中心', icon: ICON.tasks,     group: '导航' },
    { key: 'collect',   path: '/collect',   title: '招标采集', icon: ICON.collect,   group: '导航' },
    { key: 'settings',  path: '/settings',  title: '功能设置', icon: ICON.settings,  group: '系统' }
  ];

  const state = reactive({
    menu: MENU,
    icons: ICON,
    route: {
      key: 'home',
      path: '/home',
      params: {},
      query: {}
    },
    /** 供页面发出「请重新加载」信号 */
    reloadToken: 0
  });

  /** 解析 '#/customers/12?tab=follow' 形式 */
  function parseHash(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    const [pathPart, queryPart] = raw.split('?');
    const segments = pathPart.split('/').filter(Boolean);
    const menuKey = segments[0] || '';
    const item = MENU.find((m) => m.key === menuKey);

    const query = {};
    if (queryPart) {
      for (const kv of queryPart.split('&')) {
        if (!kv) continue;
        const [k, v = ''] = kv.split('=');
        query[decodeURIComponent(k)] = decodeURIComponent(v);
      }
    }

    return {
      key: item ? item.key : '',
      path: item ? item.path : pathPart,
      params: { id: segments[1] || '', rest: segments.slice(2).join('/') },
      query
    };
  }

  function apply() {
    const parsed = parseHash(window.location.hash);
    if (!parsed.key) {
      // 未知或空路由 → 回到首页，使用 replace 避免污染历史
      navigate('/home', true);
      return;
    }
    state.route.key = parsed.key;
    state.route.path = parsed.path;
    state.route.params = parsed.params;
    state.route.query = parsed.query;

    const item = MENU.find((m) => m.key === parsed.key);
    document.title = `${item ? item.title : '客户管理系统'} · 客户管理系统`;
  }

  function navigate(path, replace) {
    const target = path.startsWith('#') ? path : `#${path}`;
    if (replace) {
      const url = window.location.pathname + window.location.search + target;
      window.history.replaceState(null, '', url);
      apply();
    } else if (window.location.hash === target) {
      apply();
    } else {
      window.location.hash = target;
    }
  }

  function init() {
    // 启动器可能以 ?p=customers 形式传入初始页面
    const sp = new URLSearchParams(window.location.search);
    const initial = sp.get('p');
    if (initial && !window.location.hash) {
      const hit = MENU.find((m) => m.key === initial);
      if (hit) window.location.hash = hit.path;
    }
    window.addEventListener('hashchange', apply);
    apply();
  }

  CRM.router = {
    state,
    MENU,
    ICON,
    init,
    navigate,
    current: () => MENU.find((m) => m.key === state.route.key) || MENU[0]
  };

})(window.CRM);
