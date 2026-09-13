/**
 * ECharts 图表封装
 * 负责实例创建、尺寸自适应、option 更新与销毁，避免各页面重复样板代码。
 * ECharts 为本地文件（web/vendor/echarts.min.js），断网可用。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  /**
   * 图表实例注册表
   *
   * 为什么需要它：ECharts 6 已无法通过 getInstanceByDom 反查实例
   * （内部改为不可枚举的私有存储），而 Vue 生产构建也不会把组件实例
   * 挂到 DOM 元素上。若父组件（如地图）或调试工具需要拿到实例，
   * 必须由图表组件主动登记。
   */
  const registry = new Map();

  CRM.charts = {
    /** 按 key 取实例（返回最近登记且未销毁的一个） */
    get(key) {
      const list = registry.get(key);
      if (!list || !list.length) return null;
      for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i];
        if (!c._disposing && c.instance) return c.instance;
      }
      return null;
    },
    /** 取图表组件实例（可调用其 resize / render 等方法） */
    getComponent(key) {
      const list = registry.get(key);
      if (!list || !list.length) return null;
      for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i];
        if (!c._disposing && c.instance) return c;
      }
      return null;
    },
    /** 已登记的 key 列表（调试用） */
    keys() { return [...registry.keys()]; },
    count(key) { return (registry.get(key) || []).length; }
  };

  const Chart = {
    name: 'Chart',
    props: {
      option: { type: Object, required: true },
      height: { type: String, default: '300px' },
      loading: Boolean,
      empty: Boolean,
      emptyText: { type: String, default: '暂无数据' },
      /** 可选的登记名：父组件/调试工具可通过 CRM.charts.get(name) 取实例 */
      chartKey: { type: String, default: '' }
    },
    emits: ['chart-click'],
    data() {
      return { instance: null, renderError: '' };
    },
    watch: {
      option: {
        deep: true,
        handler() { this.render(); }
      }
    },
    methods: {
      render() {
        if (!this.instance || !this.option) return;
        try {
          this.instance.setOption(this.option, true);
          this.renderError = '';
          /* setOption 后尺寸可能变化，主动校正一次 */
          this.$nextTick(() => this.resize());
        } catch (e) {
          this.renderError = e.message || '图表渲染失败';
        }
      },
      resize() {
        if (!this.instance) return;
        /* 组件正在卸载时，实例可能已被释放，调用会抛错 */
        if (this._disposing) return;
        try {
          const el = this.$refs.el;
          /* 容器尺寸为 0 时 resize 无意义，且会让图表塌成 0 */
          if (el && el.clientWidth > 0 && el.clientHeight > 0) this.instance.resize();
        } catch (_) { /* 忽略 */ }
      },
      /** 供父组件（如地图）访问 ECharts 实例：
       *  ECharts 6 无法通过 DOM 反查实例，必须由组件主动暴露。 */
      getInstance() { return this.instance; }
    },
    mounted() {
      if (typeof echarts === 'undefined') {
        this.renderError = 'ECharts 未加载';
        return;
      }
      /* ref 必须存在；若为空说明模板没渲染出容器（理论上不会发生） */
      if (!this.$refs.el) {
        this.renderError = '图表容器未就绪';
        return;
      }
      this.instance = echarts.init(this.$refs.el, null, { renderer: 'canvas' });
      this.render();
      /* 把图表内的点击（地图区域、图元等）抛给父组件，用于下钻等交互 */
      this.instance.on('click', (params) => this.$emit('chart-click', params));

      /* 登记实例，供父组件与调试使用 */
      if (this.chartKey) {
        if (!registry.has(this.chartKey)) registry.set(this.chartKey, []);
        registry.get(this.chartKey).push(this);
      }

      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize);

      /* 监听容器自身尺寸变化。
         卡片折叠、栈式布局、字体加载完成等都会改变容器宽度，
         不跟随会导致图表被压成很小或拉伸变形。 */
      if (typeof ResizeObserver !== 'undefined' && this.$refs.el) {
        let first = true;
        this._ro = new ResizeObserver(() => {
          /* 首次回调时容器可能还是初始尺寸，跳过一次避免抖动 */
          if (first) { first = false; return; }
          this.resize();
        });
        this._ro.observe(this.$refs.el);
      }
    },
    beforeUnmount() {
      /* 先标记正在卸载：ResizeObserver 的回调可能在 dispose 之后才触发，
         那时实例已释放，再调 resize 会抛 "Cannot read properties of null"。 */
      this._disposing = true;
      window.removeEventListener('resize', this._onResize);
      if (this._ro) {
        try { this._ro.disconnect(); } catch (_) { /* 忽略 */ }
        this._ro = null;
      }
      if (this.instance) {
        try { this.instance.dispose(); } catch (_) { /* 忽略 */ }
        this.instance = null;
      }
      /* 从登记表移除 */
      if (this.chartKey && registry.has(this.chartKey)) {
        const list = registry.get(this.chartKey).filter((x) => x !== this);
        if (list.length) registry.set(this.chartKey, list);
        else registry.delete(this.chartKey);
      }
      /* 下一帧再解除标记，确保晚到的回调被忽略 */
      setTimeout(() => { this._disposing = false; }, 0);
    },
    template: `
      <div style="position:relative" :style="{ height: height, width: '100%' }">
        <!-- 说明：canvas 容器必须始终存在于 DOM。
             若用 v-if 在「空状态」与「canvas」之间切换，$refs.el 会失效，
             ECharts 实例将无法初始化（曾导致首页多张图表渲染不出来）。
             因此这里改为：canvas 常驻，空状态与错误提示用浮层覆盖。 -->
        <div ref="el" style="height:100%;width:100%" v-show="!empty && !renderError"></div>

        <div v-if="empty" class="placeholder"
             style="position:absolute;inset:0;padding:0;justify-content:center">
          <c-icon class="placeholder-icon" name="chart" :size="36" />
          <p style="font-size:var(--fs-sm)">{{ emptyText }}</p>
        </div>

        <div v-else-if="renderError" class="note danger"
             style="position:absolute;inset:0;align-items:center;justify-content:center">
          <c-icon name="alert" :size="16" />
          <div>{{ renderError }}</div>
        </div>
      </div>`
  };

  CRM.ui = CRM.ui || {};
  CRM.ui.Chart = Chart;
  CRM.registerChartComponent = function (app) {
    app.component('c-chart', Chart);
  };

})(window.CRM);
