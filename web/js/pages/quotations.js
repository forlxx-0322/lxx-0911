/**
 * 报价单列表页（跨项目总览）
 *
 * 解决的痛点：报价单原先只能进某个项目详情里才看得到，
 * "我一共报了多少、中了几单、哪张快过期了"没有一处能一眼看完。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {
  const SORTS = [
    { key: 'quote_date', label: '按报价日期' },
    { key: 'amount', label: '按合计金额' },
    { key: 'status', label: '按状态' },
    { key: 'version', label: '按版本' }
  ];

  const QuotationsPage = {
    name: 'QuotationsPage',
    data() {
      return {
        sorts: SORTS,
        sort: 'quote_date',
        loading: true,
        rows: [],
        total: 0,
        page: 1,
        pageSize: 20,
        pages: 1,
        summary: null,
        counts: { total: 0, byStatus: {}, statuses: [] },
        query: { q: '', status: '', date_from: '', date_to: '' },
        /* 详情抽屉 */
        detailOpen: false,
        detail: null,
        editOpen: false,
        editing: null
      };
    },
    computed: {
      activeFilterCount() {
        return ['q', 'status', 'date_from', 'date_to'].filter((k) => this.query[k]).length;
      },
      statusTabs() {
        const order = ['草稿', '已报出', '已中标', '已落标', '已过期'];
        return order.map((s) => ({ key: s, label: s, count: this.counts.byStatus[s] || 0 }));
      }
    },
    async created() {
      await CRM.api.loadDict();
      await this.load();
      await this.loadCounts();
    },
    methods: {
      fmtDate: CRM.util.fmtDate,
      fmtMoney: CRM.util.fmtMoney,

      async load() {
        this.loading = true;
        try {
          const r = await CRM.api.quotationOverview({
            q: this.query.q || undefined,
            status: this.query.status || undefined,
            date_from: this.query.date_from || undefined,
            date_to: this.query.date_to || undefined,
            sort: this.sort,
            page: this.page,
            pageSize: this.pageSize
          });
          this.rows = r.list || [];
          this.total = r.total;
          this.pages = r.pages;
          this.summary = r.summary;
        } catch (e) {
          CRM.toast(e.message || '加载报价单失败', 'error');
        } finally {
          this.loading = false;
        }
      },
      async loadCounts() {
        try { this.counts = await CRM.api.quotationStatusCounts(); } catch (_) { /* 忽略 */ }
      },
      setStatus(s) {
        this.query.status = this.query.status === s ? '' : s;
        this.page = 1;
        this.load();
      },
      clearFilters() {
        this.query = { q: '', status: '', date_from: '', date_to: '' };
        this.page = 1;
        this.load();
      },
      onSort(key) { this.sort = key; this.load(); },
      onPage(p) { this.page = p; this.load(); },
      onPageSize(n) { this.pageSize = n; this.page = 1; this.load(); },

      statusClass(s) {
        if (s === '已中标') return 'success';
        if (s === '已落标') return 'danger';
        if (s === '已报出') return 'warning';
        return 'muted';
      },

      /* ---------------- 详情 ---------------- */
      async openDetail(row) {
        try {
          this.detail = await CRM.api.getQuotation(row.id);
          this.detailOpen = true;
        } catch (e) {
          CRM.toast(e.message || '读取报价单失败', 'error');
        }
      },
      async openEdit(row) {
        try {
          this.editing = await CRM.api.getQuotation(row.id);
          this.editOpen = true;
        } catch (e) {
          CRM.toast(e.message || '读取报价单失败', 'error');
        }
      },
      async onSaved() { await this.load(); await this.loadCounts(); },
      openProject(row) {
        if (row.project_id) CRM.router.navigate(`/projects/${row.project_id}`);
      },
      openCustomer(row) {
        if (row.customer_id) CRM.router.navigate(`/customers/${row.customer_id}`);
      },

      async exportQuotation(row) {
        try {
          const data = await CRM.api.quotationExportData(row.id);
          CRM.quotation.buildWorkbook(data);
          CRM.toast('报价单已导出', 'success');
        } catch (e) {
          CRM.toast(e.message || '导出失败', 'error');
        }
      },

      async copyQuotation(row) {
        const ok = await CRM.confirm({
          title: '复制为新版本',
          message: `将以「${row.quote_no}」为基础创建新版本（版本号 +1，状态重置为草稿）。<br>原单保留可对比。`,
          okText: '复制'
        });
        if (!ok) return;
        try {
          const r = await CRM.api.copyQuotation(row.id);
          CRM.toast(`已创建 V${r.version}（${r.quote_no}）`, 'success');
          await this.load();
          await this.loadCounts();
        } catch (e) {
          CRM.toast(e.message || '复制失败', 'error');
        }
      },

      async removeQuotation(row) {
        const ok = await CRM.confirm({
          title: '删除报价单',
          message: `确定删除「${row.quote_no}」（V${row.version}）吗？<br>删除后进回收站，可还原。`,
          okText: '删除',
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteQuotation(row.id);
          CRM.toast('已删除', 'success');
          await this.load();
          await this.loadCounts();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      /** 从这张报价单沉淀为模板 */
      async saveAsTemplate(row) {
        const name = await CRM.prompt({
          title: '存为报价模板',
          label: '模板名称',
          placeholder: `例如：${row.customer_short || ''}常用规格`,
          value: `${row.quote_no} 规格`
        });
        if (!name) return;
        try {
          const r = await CRM.api.templateFromQuotation(row.id, { name });
          CRM.toast(`已存为模板（${r.item_count} 行规格，不含价格）`, 'success', 5000);
        } catch (e) {
          CRM.toast(e.message || '存为模板失败', 'error');
        }
      }
    },
    template: `
      <div>
        <c-card>
          <template #head>
            <div style="display:flex;align-items:center;gap:12px;width:100%">
              <div>
                <div class="card-title">报价单</div>
                <div class="card-sub">全部项目的报价单总览；改价用「新版本」保留历史，中标后可回填项目合同额</div>
              </div>
              <div style="flex:1"></div>
              <button class="btn" @click="load">刷新</button>
            </div>
          </template>

          <!-- 汇总 -->
          <div v-if="summary" class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(118px,1fr))">
            <div class="stat"><div class="n">{{ summary.count }}</div><div class="l">报价单总数</div></div>
            <div class="stat"><div class="n">{{ fmtMoney(summary.amount) }}</div><div class="l">报价合计（元）</div></div>
            <div class="stat"><div class="n" style="color:var(--c-success)">{{ summary.won }}</div><div class="l">已中标</div></div>
            <div class="stat"><div class="n" :style="summary.lost ? 'color:var(--c-danger)' : ''">{{ summary.lost }}</div><div class="l">已落标</div></div>
            <div class="stat">
              <div class="n">{{ summary.win_rate === null ? '—' : summary.win_rate + '%' }}</div>
              <div class="l">中标率</div>
            </div>
            <div class="stat"><div class="n">{{ fmtMoney(summary.won_amount) }}</div><div class="l">中标金额（元）</div></div>
          </div>

          <!-- 状态快捷筛选 -->
          <div class="quick-chips mt-3">
            <button class="chip" :class="{ on: !query.status }" @click="setStatus('')">全部 {{ counts.total }}</button>
            <button v-for="t in statusTabs" :key="t.key" class="chip"
                    :class="{ on: query.status === t.key }" @click="setStatus(t.key)">
              {{ t.label }} {{ t.count }}
            </button>
          </div>

          <div class="filter-bar mt-3">
            <input class="input" style="max-width:220px" v-model="query.q"
                   placeholder="搜索单号 / 项目 / 客户" @keyup.enter="page = 1; load()" />
            <input class="input" type="date" style="max-width:160px" v-model="query.date_from" @change="page = 1; load()" />
            <span class="muted">至</span>
            <input class="input" type="date" style="max-width:160px" v-model="query.date_to" @change="page = 1; load()" />
            <select class="input" style="max-width:150px" v-model="sort" @change="onSort(sort)">
              <option v-for="s in sorts" :key="s.key" :value="s.key">{{ s.label }}</option>
            </select>
            <button class="btn" v-if="activeFilterCount" @click="clearFilters">清空条件</button>
          </div>

          <div v-if="loading" class="muted mt-4">加载中…</div>
          <c-empty v-else-if="!rows.length" icon="file" class="mt-4"
                   :title="activeFilterCount ? '没有符合条件的报价单' : '还没有报价单'"
                   :desc="activeFilterCount ? '试试清空筛选条件' : '报价单在项目详情页的「报价单」标签里创建'" />
          <div v-else class="table-wrap mt-4">
            <table class="data-table">
              <thead>
                <tr>
                  <th>报价单号</th>
                  <th style="width:56px">版本</th>
                  <th>客户</th>
                  <th>项目</th>
                  <th style="width:104px">报价日期</th>
                  <th style="width:92px">状态</th>
                  <th style="width:58px">行数</th>
                  <th style="width:120px">合计(元)</th>
                  <th style="width:222px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="q in rows" :key="q.id">
                  <td class="mono">{{ q.quote_no }}</td>
                  <td>V{{ q.version }}</td>
                  <td>
                    <button class="btn btn-sm" @click="openCustomer(q)">
                      {{ q.customer_short || q.customer_name || '—' }}
                    </button>
                  </td>
                  <td>
                    <button class="btn btn-sm" @click="openProject(q)">{{ q.project_name || '—' }}</button>
                  </td>
                  <td>{{ q.quote_date || '—' }}</td>
                  <td><span class="tag" :class="statusClass(q.status)">{{ q.status }}</span></td>
                  <td>{{ q.item_count }}</td>
                  <td class="num">{{ fmtMoney(q.total_amount) }}</td>
                  <td>
                    <div style="display:flex;gap:4px;justify-content:flex-end">
                      <button class="btn btn-sm" @click="openDetail(q)">查看</button>
                      <button class="btn btn-sm" @click="openEdit(q)">编辑</button>
                      <button class="btn btn-sm" @click="copyQuotation(q)">新版本</button>
                      <button class="btn btn-sm" @click="exportQuotation(q)">导出</button>
                      <button class="btn btn-sm btn-danger" @click="removeQuotation(q)">删除</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <c-pager v-if="total" :page="page" :pages="pages" :total="total" :page-size="pageSize"
                   @update:page="onPage" @update:page-size="onPageSize" />
        </c-card>

        <!-- 详情抽屉 -->
        <c-drawer v-model="detailOpen"
                  :title="detail ? ('报价单 ' + detail.quote_no + '（V' + detail.version + '）') : '报价单详情'"
                  :sub="detail ? ((detail.customer_name || '') + (detail.project_name ? ' · ' + detail.project_name : '')) : ''"
                  width="900px">
          <template v-if="detail">
            <div class="kv-grid">
              <div class="kv"><span class="k">状态</span><span class="v"><span class="tag" :class="statusClass(detail.status)">{{ detail.status }}</span></span></div>
              <div class="kv"><span class="k">报价日期</span><span class="v">{{ detail.quote_date || '—' }}</span></div>
              <div class="kv"><span class="k">有效期至</span><span class="v">{{ detail.valid_until || '—' }}</span></div>
              <div class="kv"><span class="k">币种</span><span class="v">{{ detail.currency || '—' }}</span></div>
              <div class="kv"><span class="k">合计</span><span class="v">{{ fmtMoney(detail.total_amount) }} 元</span></div>
              <div class="kv"><span class="k">税率说明</span><span class="v">{{ detail.tax_note || '—' }}</span></div>
            </div>

            <div class="quo-items-head"><div class="quo-items-title">明细（{{ detail.items.length }} 行）</div></div>
            <div class="quo-table-wrap">
              <table class="quo-table">
                <thead>
                  <tr>
                    <th style="width:40px">#</th><th>名称</th><th>口径</th><th>压力</th>
                    <th>材质</th><th>连接</th><th style="width:60px">数量</th><th style="width:52px">单位</th>
                    <th style="width:96px">单价</th><th style="width:60px">折扣</th><th style="width:104px">小计</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="it in detail.items" :key="it.id">
                    <td class="quo-seq">{{ it.seq }}</td>
                    <td>{{ it.item_name || it.valve_type || '—' }}</td>
                    <td>{{ it.size_range || '—' }}</td>
                    <td>{{ it.pressure_rating || '—' }}</td>
                    <td>{{ it.body_material || '—' }}</td>
                    <td>{{ it.connection_type || '—' }}</td>
                    <td class="num">{{ it.quantity }}</td>
                    <td>{{ it.unit }}</td>
                    <td class="num">{{ fmtMoney(it.unit_price) }}</td>
                    <td class="num">{{ it.discount ? Math.round(it.discount * 10000) / 100 + '%' : '—' }}</td>
                    <td class="quo-sub">{{ fmtMoney(it.subtotal) }}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td colspan="10" class="quo-total-label">合计</td>
                    <td class="quo-total">{{ fmtMoney(detail.total_amount) }}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div v-if="detail.competitor || detail.lose_reason" class="note warn mt-3">
              <c-icon name="alert" :size="15" />
              <div style="font-size:var(--fs-sm)">
                <div v-if="detail.competitor">竞争对手：{{ detail.competitor }}
                  <span v-if="detail.competitor_price">（报价 {{ fmtMoney(detail.competitor_price) }} 元）</span>
                </div>
                <div v-if="detail.lose_reason">落标原因：{{ detail.lose_reason }}</div>
              </div>
            </div>

            <div v-if="detail.versions && detail.versions.length > 1" class="note mt-3">
              <c-icon name="check" :size="15" />
              <div style="font-size:var(--fs-xs)">
                该报价单共 {{ detail.versions.length }} 个版本：
                <span v-for="v in detail.versions" :key="v.id" class="tag" style="margin-right:6px">
                  V{{ v.version }} {{ v.status }} {{ fmtMoney(v.total_amount) }}
                </span>
              </div>
            </div>
          </template>

          <template #footer>
            <button class="btn" @click="saveAsTemplate(detail)">存为模板</button>
            <button class="btn" @click="exportQuotation(detail)">导出 Excel</button>
            <button class="btn btn-primary" @click="detailOpen = false; openEdit(detail)">编辑</button>
          </template>
        </c-drawer>

        <!-- 编辑抽屉（复用报价单抽屉） -->
        <c-quotation-drawer v-model="editOpen"
                            :project-id="editing ? editing.project_id : ''"
                            :project-name="editing ? editing.project_name : ''"
                            :customer-name="editing ? editing.customer_name : ''"
                            :quotation="editing"
                            @saved="onSaved" />
      </div>`,
    setup() { return { api: CRM.api }; }
  };

  CRM.pages = CRM.pages || {};
  /* key 必须与路由 menu key 一致，app.js 靠 CRM.pages[key] 取页面 */
  CRM.pages.quotations = QuotationsPage;

})(window.CRM);
