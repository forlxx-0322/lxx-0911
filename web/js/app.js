/**
 * 应用入口：装配外壳、挂载页面、处理启动错误
 */
'use strict';

(function (CRM) {

  const { createApp } = Vue;

  const App = {
    name: 'CrmApp',
    data() {
      return {
        booting: true,
        fatal: '',
        health: null,
        appName: '客户管理系统',
        version: ''
      };
    },
    computed: {
      activeKey() { return CRM.router.state.route.key; },
      current() { return CRM.router.current(); },
      /* 当前渲染的页面：带 id 的详情路由优先 */
      currentPage() {
        const key = this.activeKey;
        const p = CRM.router.state.route.params || {};
        if (key === 'customers' && p.id) return CRM.pages.CustomerDetail;
        if (key === 'projects' && p.id) return CRM.pages.ProjectDetail;
        return (CRM.pages && CRM.pages[key]) || CRM.pages.home;
      },
      /* 页面 key：列表与详情之间切换时强制重建组件 */
      pageKey() {
        const p = CRM.router.state.route.params || {};
        return this.activeKey + (p.id ? ':' + p.id : '');
      },
      detailId() {
        return (CRM.router.state.route.params || {}).id || '';
      }
    },
    methods: {
      async boot() {
        try {
          const h = await CRM.api.health();
          this.health = h;
          this.version = h.version || '';
          // 应用名称稍后可由设置项覆盖（阶段四接入）
          CRM.router.init();
          this.booting = false;
        } catch (e) {
          this.fatal = e.message || '无法连接本地服务';
          this.booting = false;
        }
      },
      retry() {
        this.fatal = '';
        this.booting = true;
        this.boot();
      }
    },
    mounted() {
      const bootEl = document.getElementById('boot');
      if (bootEl) bootEl.style.display = 'none';
      const appEl = document.getElementById('app');
      if (appEl) appEl.style.display = '';
      this.boot();
    },
    template: `
      <div>
        <c-toast-host />
        <c-confirm-host />
        <c-prompt-host />

        <div v-if="fatal" class="fatal">
          <h2>无法连接本地服务</h2>
          <p>{{ fatal }}</p>
          <div class="note warn mt-4">
            <c-icon name="alert" :size="16" />
            <div>
              <div>请检查：</div>
              <div>1. 启动服务的黑色窗口是否仍然打开（关闭窗口即停止服务）；</div>
              <div>2. 是否误点了「停止.bat」；</div>
              <div>3. 若仍无法访问，双击 <strong>启动.bat</strong> 重新启动服务。</div>
            </div>
          </div>
          <pre v-if="fatal">{{ fatal }}</pre>
          <div class="mt-4"><button class="btn btn-primary" @click="retry">重新连接</button></div>
        </div>

        <div v-else-if="booting" class="placeholder" style="padding-top:20vh">
          <div class="boot-spinner"></div>
          <p class="muted mt-4">正在连接本地服务…</p>
        </div>

        <div v-else class="layout">
          <c-sidebar :active-key="activeKey" :app-name="appName" :version="version" />
          <div class="main">
            <c-topbar :title="current.title" :subtitle="current.subtitle" />
            <main class="content">
              <component :is="currentPage" :key="pageKey" :id="detailId" />
            </main>
          </div>
        </div>
      </div>`
  };

  const app = createApp(App);
  CRM.registerComponents(app);
  CRM.registerUiComponents(app);
  CRM.registerChartComponent(app);
  CRM.registerAttachmentComponent(app);
  CRM.registerMapComponent(app);
  CRM.registerCoordComponent(app);
  if (CRM.registerQuotationComponent) CRM.registerQuotationComponent(app);
  app.component('c-customer-edit', CRM.pages.CustomerEdit);
  app.component('c-followup-drawer', CRM.pages.FollowupDrawer);
  app.component('c-project-edit', CRM.pages.ProjectEdit);
  app.component('c-payment-drawer', CRM.pages.PaymentDrawer);
  /* 设置页各面板 */
  app.component('c-dict-manager', CRM.settings.DictManager);
  app.component('c-tag-panel', CRM.settings.TagPanel);
  app.component('c-prefs-panel', CRM.settings.PrefsPanel);
  app.component('c-backup-panel', CRM.settings.BackupPanel);
  app.component('c-data-panel', CRM.settings.DataPanel);
  app.component('c-attachment-store', CRM.settings.AttachmentStorePanel);
  app.component('c-trash-panel', CRM.settings.TrashPanel);
  app.component('c-log-panel', CRM.settings.LogPanel);
  CRM.app = app;
  app.mount('#app');

})(window.CRM);
