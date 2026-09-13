/**
 * 首页总览
 * 数字卡 / 今日与逾期待跟进 / 临期与逾期回款 / 招投标日历 / 四张图表 / 今日待办 / 最近动态
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  /* ECharts 通用样式
   * 图表颜色写在 option 里，CSS 变量管不到，因此统一从 CRM.theme.colors() 取，
   * 并在 computed 里读取（theme.state 是响应式的），切换主题时图表会自动重绘。 */
  const axisStyle = (C) => ({
    axisLine: { lineStyle: { color: C.axisLine } },
    axisLabel: { color: C.axisLabel, fontSize: 11 },
    splitLine: { lineStyle: { color: C.splitLine } }
  });
  const tooltipStyle = (C) => ({
    backgroundColor: C.tooltipBg,
    borderWidth: 0,
    textStyle: { color: C.tooltipText, fontSize: 12 }
  });
  const legendText = (C) => ({ fontSize: 11, color: C.axisLabel });

  const HomePage = {
    name: 'HomePage',
    data() {
      return { loading: true, error: '', d: null };
    },
    computed: {
      cards() { return (this.d && this.d.cards) || {}; },

      trendOption() {
        if (!this.d) return {};
        const t = this.d.chart_trend;
        const shortNum = this.shortNum;
        const C = CRM.theme.colors();
        return {
          color: C.palette,
          tooltip: Object.assign({ trigger: 'axis' }, tooltipStyle(C)),
          legend: { data: ['签约额', '回款额'], right: 0, top: 0, textStyle: legendText(C) },
          grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
          xAxis: Object.assign({ type: 'category', data: t.months.map((m) => m.slice(5) + '月') }, axisStyle(C)),
          yAxis: Object.assign({
            type: 'value',
            axisLabel: { color: C.axisLabel, fontSize: 11, formatter: (v) => shortNum(v) }
          }, axisStyle(C)),
          series: [
            { name: '签约额', type: 'bar', barMaxWidth: 26, data: t.signed, itemStyle: { borderRadius: [3, 3, 0, 0] } },
            { name: '回款额', type: 'line', smooth: true, symbolSize: 6, data: t.received, lineStyle: { width: 2 } }
          ]
        };
      },

      stageOption() {
        if (!this.d) return {};
        const rows = this.d.chart_stages || [];
        const C = CRM.theme.colors();
        return {
          color: C.palette,
          tooltip: Object.assign({
            trigger: 'item',
            formatter: (p) => `${p.name}<br/>项目数：${p.value}（${p.percent}%）`
          }, tooltipStyle(C)),
          legend: {
            type: 'scroll', orient: 'vertical', right: 0, top: 'middle',
            itemWidth: 8, itemHeight: 8, textStyle: legendText(C)
          },
          series: [{
            type: 'pie', radius: ['42%', '68%'], center: ['36%', '50%'],
            label: { show: false },
            data: rows.map((r) => ({ name: r.name, value: r.value }))
          }]
        };
      },

      industryOption() {
        if (!this.d) return {};
        const rows = (this.d.chart_industries || []).slice(0, 8);
        const shortNum = this.shortNum;
        const C = CRM.theme.colors();
        return {
          color: C.palette,
          tooltip: Object.assign({
            trigger: 'item',
            formatter: (p) => {
              const hit = rows[p.dataIndex];
              return `${p.name}<br/>成交额：${CRM.util.fmtMoney(hit.amount)} 元<br/>客户数：${hit.customers}`;
            }
          }, tooltipStyle(C)),
          grid: { left: 8, right: 52, top: 8, bottom: 4, containLabel: true },
          xAxis: Object.assign({
            type: 'value',
            axisLabel: { color: C.axisLabel, fontSize: 11, formatter: (v) => shortNum(v) }
          }, axisStyle(C)),
          yAxis: Object.assign({ type: 'category', data: rows.map((r) => r.name) }, axisStyle(C)),
          series: [{
            type: 'bar', barMaxWidth: 16, data: rows.map((r) => r.amount),
            itemStyle: { borderRadius: [0, 3, 3, 0] },
            label: {
              show: true, position: 'right', fontSize: 10, color: C.axisLabel,
              formatter: (p) => shortNum(p.value)
            }
          }]
        };
      },

      funnelOption() {
        if (!this.d) return {};
        const rows = this.d.chart_funnel || [];
        const C = CRM.theme.colors();
        return {
          color: C.palette,
          tooltip: Object.assign({ trigger: 'item', formatter: (p) => `${p.name}：${p.value} 家` }, tooltipStyle(C)),
          grid: { left: 8, right: 8, top: 8, bottom: 4, containLabel: true },
          series: [{
            type: 'funnel', left: '8%', width: '84%', minSize: '28%',
            label: { position: 'inside', fontSize: 11, color: '#fff', formatter: (p) => `${p.name} ${p.value}` },
            itemStyle: { borderWidth: 0 },
            data: rows.map((r) => ({ name: r.name, value: r.value }))
          }]
        };
      }
    },
    methods: {
      fmtDate: CRM.util.fmtDate,
      fmtMoney: CRM.util.fmtMoney,
      fmtMoneyShort: CRM.util.fmtMoneyShort,
      fromNow: CRM.util.fromNow,

      shortNum(v) {
        const n = Number(v) || 0;
        if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(1) + '亿';
        if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(0) + '万';
        return String(n);
      },

      async load() {
        this.loading = true;
        this.error = '';
        try {
          this.d = await CRM.api.dashboard();
        } catch (e) {
          this.error = e.message || '加载失败';
        } finally {
          this.loading = false;
        }
      },

      goCustomer(c) { if (c && c.id) CRM.router.navigate(`/customers/${c.id}`); },
      goProject(p) { if (p && p.id) CRM.router.navigate(`/projects/${p.id}`); },
      goCustomers() { CRM.router.navigate('/customers'); },
      goProjects() { CRM.router.navigate('/projects'); },
      goTasks() { CRM.router.navigate('/tasks'); },

      quickFollow(c) {
        const self = this;
        CRM.prompt({
          title: '记录跟进',
          label: `对「${c.short_name || c.name}」的跟进内容`,
          placeholder: '例如：电话确认技术参数，客户要求阀体改为 316L'
        }).then(async (text) => {
          if (!text) return;
          try {
            await CRM.api.saveFollowup({ customer_id: c.id, method: '电话', content: text });
            CRM.toast('跟进已记录', 'success');
            self.load();
          } catch (e) {
            CRM.toast(e.message || '记录失败', 'error');
          }
        });
      },

      async completeTask(t) {
        try {
          await CRM.api.toggleTask(t.id, true);
          CRM.toast('已完成', 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      },

      bidClass(level) {
        if (level === 2) return 'danger';
        if (level === 1) return 'warning';
        return 'muted';
      },
      bidText(b) {
        if (b.alert_level === 2) return `已过开标日 ${Math.abs(b.days_left)} 天，未填结果`;
        if (b.days_left === 0) return '今天开标';
        if (b.days_left > 0) return `还有 ${b.days_left} 天开标`;
        return `${Math.abs(b.days_left)} 天前开标`;
      },
      logClass(t) {
        const MAP = {
          customer: '', project: 'success', task: 'muted',
          dict: 'muted', import: 'warning', backup: 'muted', settings: 'muted'
        };
        return MAP[t] || 'muted';
      },
      logTypeText(t) {
        const MAP = {
          customer: '客户', project: '项目', task: '待办', dict: '字典',
          import: '导入', export: '导出', backup: '备份', settings: '设置',
          contact: '联系人', tag: '标签'
        };
        return MAP[t] || t;
      }
    },
    async created() { this.load(); },
    template: `
      <div>
        <c-page-header title="首页总览"
          desc="今日该跟谁、哪些款该收、哪些标该投——一屏看完。" />

        <div v-if="loading" class="card"><div class="card-body muted">正在汇总数据…</div></div>

        <div v-else-if="error" class="note danger">
          <c-icon name="alert" :size="16" />
          <div>
            <strong>{{ error }}</strong>
            <div class="mt-3"><button class="btn btn-sm" @click="load">重试</button></div>
          </div>
        </div>

        <template v-else-if="d">
          <div class="stat-grid" style="margin-bottom:14px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr))">
            <div class="stat clickable" @click="goCustomers">
              <div class="n">{{ cards.customer_total }}</div>
              <div class="l">客户总数 · 本月新增 {{ cards.customer_new_this_month }}</div>
            </div>
            <div class="stat clickable" @click="goProjects">
              <div class="n">{{ cards.active_projects }}</div>
              <div class="l">进行中项目 · 合同 {{ fmtMoneyShort(cards.active_contract_amount) }}</div>
            </div>
            <div class="stat clickable" @click="goProjects">
              <div class="n" style="color:var(--c-success)">{{ fmtMoneyShort(cards.month_received) }}</div>
              <div class="l">
                本月回款
                <span v-if="cards.month_received_prev > 0"
                      :style="cards.month_received_delta >= 0 ? 'color:var(--c-success)' : 'color:var(--c-danger)'">
                  {{ cards.month_received_delta >= 0 ? '↑' : '↓' }}{{ Math.abs(cards.month_received_delta) }}%
                </span>
              </div>
            </div>
            <div class="stat clickable" @click="goCustomers">
              <div class="n" :style="cards.follow_overdue > 0 ? 'color:var(--c-danger)' : ''">
                {{ cards.follow_today }}
              </div>
              <div class="l">今日待跟进 · 其中逾期 {{ cards.follow_overdue }}</div>
            </div>
            <div class="stat clickable" @click="goProjects">
              <div class="n" :style="cards.overdue_payment_count > 0 ? 'color:var(--c-danger)' : ''">
                {{ cards.overdue_payment_count }}
              </div>
              <div class="l">逾期回款 · {{ fmtMoneyShort(cards.overdue_payment_amount) }}</div>
            </div>
            <div class="stat">
              <div class="n" :style="cards.total_debt > 0 ? 'color:var(--c-danger)' : ''">
                {{ fmtMoneyShort(cards.total_debt) }}
              </div>
              <div class="l">全部项目未收欠款</div>
            </div>
          </div>

          <div class="grid-2">
            <c-card title="今日与逾期待跟进客户" :sub="'共 ' + d.follow_customers.length + ' 家需要联系'" icon="clock">
              <template #head>
                <button class="btn btn-sm" @click="goCustomers">全部客户</button>
              </template>
              <c-empty v-if="!d.follow_customers.length" icon="check" title="今天没有需要跟进的客户"
                       desc="在客户资料里设置「下次跟进时间」，到期会自动出现在这里。" />
              <div v-else class="mini-list">
                <div v-for="c in d.follow_customers" :key="c.id" class="mini-row clickable" @click="goCustomer(c)">
                  <div class="mr-main">
                    <div class="mr-title">
                      {{ c.short_name || c.name }}
                      <span v-if="c.level" class="tag" style="font-size:10px">{{ c.level }}</span>
                    </div>
                    <div class="mr-sub muted">
                      {{ c.type || '—' }}<span v-if="c.industry"> · {{ c.industry }}</span>
                      <span v-if="c.primary_contact"> · {{ c.primary_contact }} {{ c.primary_mobile }}</span>
                    </div>
                  </div>
                  <div class="mr-side">
                    <span class="tag" :class="c.days_left < 0 ? 'danger' : 'warning'" style="font-size:10px">
                      {{ c.days_left < 0 ? '逾期 ' + Math.abs(c.days_left) + ' 天' : (c.days_left === 0 ? '今天' : c.days_left + ' 天后') }}
                    </span>
                    <button class="btn btn-sm" @click.stop="quickFollow(c)">记跟进</button>
                  </div>
                </div>
              </div>
            </c-card>

            <c-card title="临期与逾期回款计划"
                    :sub="'逾期 ' + d.payment_overdue.length + ' 笔 · 30 天内 ' + d.payment_upcoming.length + ' 笔'"
                    icon="money">
              <template #head>
                <button class="btn btn-sm" @click="goProjects">全部项目</button>
              </template>
              <c-empty v-if="!d.payment_overdue.length && !d.payment_upcoming.length"
                       icon="money" title="暂无回款计划"
                       desc="在项目详情页的「回款计划」中添加，到期这里会提醒。" />
              <div v-else class="mini-list">
                <div v-for="p in d.payment_overdue" :key="'ov' + p.id" class="mini-row clickable" @click="goProject(p)">
                  <div class="mr-main">
                    <div class="mr-title">{{ p.project_name }}</div>
                    <div class="mr-sub muted">
                      {{ p.customer_short || p.customer_name }}
                      <span v-if="p.remark"> · {{ p.remark }}</span>
                    </div>
                  </div>
                  <div class="mr-side">
                    <div style="text-align:right">
                      <div class="money" style="color:var(--c-danger);font-weight:600">{{ fmtMoney(p.remain) }}</div>
                      <div class="muted" style="font-size:10px">逾期 {{ Math.abs(p.days_diff) }} 天</div>
                    </div>
                  </div>
                </div>
                <div v-for="p in d.payment_upcoming" :key="'up' + p.id" class="mini-row clickable" @click="goProject(p)">
                  <div class="mr-main">
                    <div class="mr-title">{{ p.project_name }}</div>
                    <div class="mr-sub muted">
                      {{ p.customer_short || p.customer_name }} · 计划 {{ fmtDate(p.plan_date) }}
                    </div>
                  </div>
                  <div class="mr-side">
                    <div style="text-align:right">
                      <div class="money">{{ fmtMoney(p.remain) }}</div>
                      <div class="muted" style="font-size:10px">
                        {{ p.days_diff === 0 ? '今天' : p.days_diff + ' 天后' }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </c-card>
          </div>

          <c-card class="mt-4" title="招投标日历" sub="近 30 天到未来 60 天的投标节点" icon="list">
            <c-empty v-if="!d.bid_calendar.length" icon="list" title="近期没有投标节点"
                     desc="在项目里填写「投标日期」，这里会按开标时间排序提醒。" />
            <div v-else class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th style="width:112px">投标日期</th>
                    <th>项目名称</th>
                    <th style="width:130px">客户</th>
                    <th style="width:112px">投标结果</th>
                    <th style="width:84px">阶段</th>
                    <th style="width:160px">提醒</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="b in d.bid_calendar" :key="b.id"
                      :class="b.alert_level === 2 ? 'row-overdue' : ''" class="clickable"
                      @click="goProject(b)">
                    <td>{{ fmtDate(b.bid_date) }}</td>
                    <td>{{ b.name }}</td>
                    <td>{{ b.customer_short || b.customer_name || '—' }}</td>
                    <td>
                      <span v-if="b.bid_result" class="tag muted" style="font-size:10px">{{ b.bid_result }}</span>
                      <span v-else class="muted">—</span>
                    </td>
                    <td><span class="tag" style="font-size:10px">{{ b.stage }}</span></td>
                    <td><span class="tag" :class="bidClass(b.alert_level)" style="font-size:10px">{{ bidText(b) }}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </c-card>

          <div class="grid-2 mt-4">
            <c-card title="近 6 个月签约与回款" sub="柱：签约额 · 线：回款额" icon="chart">
              <c-chart :option="trendOption" height="260px"
                       :empty="!d.chart_trend.signed.some(v => v > 0) && !d.chart_trend.received.some(v => v > 0)"
                       empty-text="近 6 个月还没有签约或回款记录" />
            </c-card>
            <c-card title="项目阶段分布" sub="按项目数量" icon="projects">
              <c-chart :option="stageOption" height="260px"
                       :empty="!d.chart_stages.length" empty-text="还没有项目" />
            </c-card>
          </div>

          <!-- 新疆客户分布地图 -->
          <c-card class="mt-4" title="新疆客户分布" sub="颜色深浅 = 该地州客户数；点击地州可下钻到县市" icon="map">
            <c-customer-map />
          </c-card>

          <div class="grid-2 mt-4">
            <c-card title="下游行业成交额占比" sub="按已成交阶段项目的合同额" icon="chart">
              <c-chart :option="industryOption" height="260px"
                       :empty="!d.chart_industries.length" empty-text="还没有成交项目" />
            </c-card>
            <c-card title="客户转化漏斗" sub="从建档到成交的转化情况" icon="customers">
              <c-chart :option="funnelOption" height="260px"
                       :empty="!d.chart_funnel[0] || d.chart_funnel[0].value === 0" empty-text="还没有客户数据" />
            </c-card>
          </div>

          <div class="grid-2 mt-4">
            <c-card title="今日待办" :sub="'共 ' + d.today_tasks.length + ' 项待处理'" icon="tasks">
              <template #head>
                <button class="btn btn-sm" @click="goTasks">待办中心</button>
              </template>
              <c-empty v-if="!d.today_tasks.length" icon="check" title="今日待办已清空" desc="很好，没有待处理事项。" />
              <div v-else class="mini-list">
                <div v-for="t in d.today_tasks" :key="t.id" class="mini-row">
                  <input type="checkbox" class="task-check" @change="completeTask(t)" />
                  <div class="mr-main">
                    <div class="mr-title">{{ t.title }}</div>
                    <div class="mr-sub muted">
                      <span class="tag" :class="t.priority === '高' ? 'danger' : 'muted'" style="font-size:10px">{{ t.priority }}</span>
                      <span class="tag muted" style="font-size:10px">{{ t.source }}</span>
                      <span v-if="t.due_at">截止 {{ fmtDate(t.due_at, true) }}</span>
                    </div>
                  </div>
                  <div class="mr-side">
                    <a v-if="t.project_id" href="javascript:;" @click="goProject({ id: t.project_id })">项目</a>
                    <a v-if="t.customer_id" href="javascript:;" @click="goCustomer({ id: t.customer_id })">客户</a>
                  </div>
                </div>
              </div>
            </c-card>

            <c-card title="最近动态" sub="最近 12 条操作记录" icon="list">
              <div class="mini-list">
                <div v-for="l in d.recent_logs" :key="l.id" class="mini-row">
                  <div class="mr-main">
                    <div class="mr-title" style="font-weight:400;font-size:var(--fs-sm)">{{ l.summary }}</div>
                    <div class="mr-sub muted">
                      <span class="tag" :class="logClass(l.entity_type)" style="font-size:10px">{{ logTypeText(l.entity_type) }}</span>
                      {{ fromNow(l.created_at) }}
                    </div>
                  </div>
                </div>
              </div>
            </c-card>
          </div>
        </template>
      </div>`
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.home = HomePage;

})(window.CRM);
