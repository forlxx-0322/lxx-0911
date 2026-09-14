/**
 * 新疆客户分布地图组件
 *
 * 特性：
 *   - 完全离线：边界数据来自本地 GeoJSON（web/vendor/map/xinjiang）
 *   - 色阶渲染：颜色深浅 = 该地州客户数
 *   - 可缩放：滚轮缩放 + 拖拽平移 + 按钮控制 + 重置视图
 *   - 可下钻：点击地州 → 进入县市级；面包屑返回
 *   - 可查看：点击区域 → 右侧列出该区域客户，可跳转客户详情
 *   - 坐标核对：对单个客户提供「在线地图核对」入口（按需联网）
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const PROVINCE_CODE = '650000';

  /** 色阶（浅 → 深） */
  const SCALE = ['#eaf1fe', '#c7dafc', '#9dbcf7', '#6f9df0', '#4680e8', '#2f6fed', '#1d4fb8'];

  const CustomerMap = {
    name: 'CustomerMap',
    props: {
      /* 新疆经度跨度 73.5~96.4°E、纬度 34.3~49.2°N，画布过高会在上下留出大片空白，
         440px 配合限宽（见 app.css 的 .map-canvas .chart max-width）能得到比较饱满的比例。 */
      height: { type: String, default: '440px' },
      compact: Boolean              // 首页用紧凑模式（无侧栏）
    },
    data() {
      return {
        loading: true,
        error: '',
        status: null,
        /* 当前层级：省 or 地州 code */
        currentCode: PROVINCE_CODE,
        currentName: '新疆维吾尔自治区',
        /* 已注册到 ECharts 的地图名 */
        registered: [],
        dist: null,
        /* 侧栏：当前选中区域 */
        selected: null,
        selectedCustomers: [],
        selectedLoading: false,
        /* 下钻层级（面包屑） */
        stack: [],
        mapOption: {},
        topCities: [],
        /* 客户坐标点（散点图层） */
        points: [],
        pointMeta: null,
        showPoints: true
      };
    },
    computed: {
      instanceName() {
        /* 每次层级变化用一个新名称，避免 ECharts 复用旧边界 */
        return 'xj-' + this.currentCode;
      },
      summary() { return (this.dist && this.dist.summary) || {}; },
      hasData() { return (this.summary.total_customers || 0) > 0; },
      /* 深色主题下需要换色阶（浅蓝色阶在深底上会糊成一片） */
      darkMode() { return CRM.theme.state.mode === 'dark'; },
      /* 未归属客户明细（后端最多返回 200 条），「认不出」的排前面更值得处理 */
      unassignedRows() {
        const list = (this.dist && this.dist.unassigned && this.dist.unassigned.list) || [];
        return list.filter((x) => x.reason === 'no_match').concat(list.filter((x) => x.reason === 'no_address')).slice(0, 8);
      }
    },
    watch: {
      /* 主题切换后重绘地图（颜色写在 option 里，CSS 管不到） */
      darkMode() { this.redraw(); }
    },
    methods: {
      fmtMoney: CRM.util.fmtMoney,
      fmtMoneyShort: CRM.util.fmtMoneyShort,

      /* ---------------- 数据加载 ---------------- */

      async init() {
        this.loading = true;
        this.error = '';
        try {
          this.status = await CRM.api.get('/api/map/status');
          if (!this.status.available) {
            this.error = this.status.error || '地图数据未就绪';
            return;
          }
          this.dist = await CRM.api.get('/api/map/distribution');
          this.buildTopCities();
          await this.renderProvince();
        } catch (e) {
          this.error = e.message || '加载地图数据失败';
        } finally {
          this.loading = false;
        }
      },

      buildTopCities() {
        this.topCities = (this.dist.cities || [])
          .filter((c) => c.customer_count > 0)
          .sort((a, b) => b.customer_count - a.customer_count)
          .slice(0, 10);
      },

      /** 注册 GeoJSON 到 ECharts（同名只注册一次） */
      async ensureMap(code) {
        const name = 'xj-' + code;
        if (this.registered.includes(name)) return name;
        const gj = await CRM.api.get('/api/map/geojson?code=' + code);
        /* 用 adcode 作为区域 id，ECharts 才能把数据对上 */
        echarts.registerMap(name, gj);
        this.registered.push(name);
        return name;
      },

      /** 渲染省级地图 */
      async renderProvince() {
        this.currentCode = PROVINCE_CODE;
        this.currentName = '新疆维吾尔自治区';
        this.stack = [];
        const name = await this.ensureMap(PROVINCE_CODE);
        await this.loadPoints(PROVINCE_CODE);
        this.draw(name, this.dist.cities, PROVINCE_CODE, this.points);
        this.selected = null;
        this.selectedCustomers = [];
      },

      /** 下钻到地州 */
      async drillDown(code, regionName) {
        try {
          this.loading = true;
          const name = await this.ensureMap(code);
          const dist = await CRM.api.get('/api/map/distribution');

          /* 该地州下的县市分布：从 region-customers 拿不到分组，这里用客户明细按区县聚合 */
          const rc = await CRM.api.get(`/api/map/region-customers?code=${code}&limit=500`);
          const byDistrict = new Map();
          for (const c of rc.list) {
            const key = c.district || '未填区县';
            byDistrict.set(key, (byDistrict.get(key) || 0) + 1);
          }

          /* 从 region 表取该地州下辖县市清单，与客户数合并 */
          const regions = await CRM.api.get('/api/map/regions');
          const children = regions.districts.filter((d) => d.parent_code === String(code));
          const data = children.map((d) => ({
            code: d.code,
            name: d.name,
            customer_count: byDistrict.get(d.name) || 0
          }));
          /* 客户填了区县但不在标准清单里的，单独列出 */
          for (const [k, v] of byDistrict.entries()) {
            if (k !== '未填区县' && !data.some((d) => d.name === k)) {
              data.push({ code: '', name: k, customer_count: v });
            }
          }

          this.stack = [{ code: PROVINCE_CODE, name: '新疆维吾尔自治区' }];
          this.currentCode = code;
          this.currentName = regionName || rc.region.name;
          await this.loadPoints(code);
          this.draw(name, data, code, this.points);
        } catch (e) {
          CRM.toast(e.message || '下钻失败', 'error');
        } finally {
          this.loading = false;
        }
      },

      /** 返回上一级 */
      async goBack() {
        if (!this.stack.length) return;
        this.stack = [];
        await this.renderProvince();
      },

      /* ---------------- 渲染 ---------------- */

      draw(mapName, data, code, points) {
        /* 散点图层的数据在调用前加载好（见 renderProvince / drillDown） */
        this.points = points || [];
        const counts = data.map((d) => Number(d.customer_count) || 0);
        const max = Math.max(1, ...counts);
        const C = CRM.theme.colors();
        /* 深色主题下浅蓝色阶会糊成一片，改用同色系的深色渐变 */
        const scale = this.darkMode
          ? ['#252b35', '#2f4468', '#3a5c94', '#4a7ac8', '#5b8ef5', '#7aa6f8', '#a5c4fb']
          : SCALE;

        this.mapOption = {
          tooltip: {
            trigger: 'item',
            backgroundColor: C.tooltipBg,
            borderWidth: 0,
            textStyle: { color: C.tooltipText, fontSize: 12 },
            formatter: (p) => {
              const d = data.find((x) => x.name === p.name);
              if (!d) return `${p.name}<br/>暂无客户`;
              return `<b>${p.name}</b><br/>客户：${d.customer_count} 家`
                + (d.contract_amount ? `<br/>合同额：${CRM.util.fmtMoney(d.contract_amount)} 元` : '')
                + (d.demand ? `<br/>年需求：${d.demand} 万元` : '');
            }
          },
          visualMap: {
            type: 'continuous',
            min: 0,
            max,
            left: 16,
            bottom: 24,
            itemWidth: 12,
            itemHeight: 110,
            text: ['多', '少'],
            textStyle: { fontSize: 11, color: C.axisLabel },
            inRange: { color: scale },
            calculable: false
          },
          series: [{
            type: 'map',
            map: mapName,
            roam: true,                     // 允许缩放与拖拽
            zoom: 1.15,
            scaleLimit: { min: 0.8, max: 12 },
            nameProperty: 'name',
            label: {
              show: true,
              fontSize: 9,
              color: C.mapLabel,
              formatter: (p) => {
                const d = data.find((x) => x.name === p.name);
                if (!d || !d.customer_count) return '';
                return `${p.name}\n${d.customer_count}`;
              }
            },
            emphasis: {
              label: { show: true, fontSize: 11, color: C.seriesLabel, fontWeight: 'bold' },
              itemStyle: { areaColor: '#ffd666', borderColor: '#d98411', borderWidth: 1.4 }
            },
            select: {
              label: { show: true, color: '#fff' },
              itemStyle: { areaColor: '#d98411' }
            },
            itemStyle: {
              areaColor: C.mapEmpty,
              borderColor: C.mapBorder,
              borderWidth: 0.6
            },
            data: data.map((d) => ({
              name: d.name,
              value: Number(d.customer_count) || 0,
              code: d.code
            }))
          }, this.pointSeries(mapName)]
        };

        this.mapCode = code;
        this.mapData = data;
      },

      /**
       * 客户散点图层。
       *
       * 为什么单独一层：地州色块只能看出"哪片多"，看不出"客户具体在哪"。
       * 用户录了经纬度却看不到点，等于白录。
       *
       * 只画**有坐标**的客户：没有坐标的画到地州中心会误导，
       * 这类客户由侧栏提示"该地州另有 N 家未录坐标"。
       */
      pointSeries(mapName) {
        const pts = this.points || [];
        const C = CRM.theme.colors();
        const showLabels = pts.length <= 30;      // 点少时才显示名字，多了会糊
        return {
          type: 'scatter',
          name: '客户位置',
          coordinateSystem: 'geo',
          geoIndex: 0,
          z: 5,
          symbolSize: (val, params) => {
            const d = params && params.data ? params.data : {};
            const demand = Number(d.demand) || 0;
            const deal = Number(d.deal) || 0;
            /* 5~14px：按年需求量与成交额取较大者分级 */
            const base = Math.max(demand / 200, deal / 1000000);
            return Math.max(5, Math.min(14, 5 + base * 4));
          },
          itemStyle: {
            color: (params) => {
              const lv = String((params.data && params.data.level) || '');
              if (lv.startsWith('A')) return '#d92d3f';
              if (lv.startsWith('B')) return '#3b82f6';
              return '#8a95a8';
            },
            borderColor: C.tooltipBg === '#ffffff' ? '#ffffff' : '#ffffff',
            borderWidth: 1.4,
            opacity: 0.92
          },
          label: {
            show: showLabels,
            position: 'right',
            fontSize: 10,
            color: C.seriesLabel,
            formatter: (p) => (p.data && p.data.short) || ''
          },
          emphasis: {
            scale: 1.5,
            label: { show: true, fontSize: 11, fontWeight: 'bold', color: C.seriesLabel }
          },
          tooltip: {
            formatter: (p) => {
              const d = p.data || {};
              const lines = [`<b>${d.short || d.name || ''}</b>`];
              if (d.fullName && d.fullName !== d.short) lines.push(d.fullName);
              if (d.level) lines.push(`等级：${d.level}`);
              if (d.demand) lines.push(`年需求：${d.demand} 万元`);
              if (d.deal) lines.push(`成交额：${CRM.util.fmtMoney(d.deal)} 元`);
              if (d.projects) lines.push(`项目：${d.projects} 个`);
              lines.push('<span style="opacity:.7">点击查看客户详情</span>');
              return lines.join('<br/>');
            }
          },
          data: pts.map((p) => ({
            name: p.short_name || p.name,
            fullName: p.name,
            value: [p.lng, p.lat],
            id: p.id,
            short: p.short_name || p.name,
            level: p.level || '',
            demand: Number(p.annual_demand) || 0,
            deal: Number(p.deal_amount) || 0,
            projects: Number(p.project_count) || 0
          }))
        };
      },

      /** 加载客户坐标点（省级取前 N，下钻到地州取该地州全部） */
      async loadPoints(code) {
        try {
          const r = await CRM.api.customerPoints({ code: code || PROVINCE_CODE, limit: 300 });
          this.points = r.list || [];
          this.pointMeta = {
            total: r.total_with_coords,
            returned: r.returned,
            omitted: r.omitted,
            withoutCoords: r.without_coords,
            abnormal: r.abnormal || []
          };
        } catch (e) {
          this.points = [];
          this.pointMeta = null;
        }
      },

      /** 点击客户点：进入客户详情 */
      onPointClick(params) {
        const d = params && params.data;
        if (d && d.id) CRM.router.navigate(`/customers/${d.id}`);
      },

      /** 点击区域或客户点 */
      async onMapClick(params) {
        if (!params) return;
        /* 散点图层的点击 → 进客户详情（与区域点击区分开） */
        if (params.seriesType === 'scatter' || (params.componentType === 'series' && params.seriesType === 'scatter')) {
          return this.onPointClick(params);
        }
        if (!params.name) return;
        const hit = (this.mapData || []).find((d) => d.name === params.name);

        if (this.currentCode === PROVINCE_CODE) {
          /* 省级：点击下钻 */
          const regions = await CRM.api.get('/api/map/regions');
          const city = regions.cities.find((c) => c.name === params.name);
          if (city) {
            await this.drillDown(city.code, city.name);
            /* 下钻后同时展示该地州客户 */
            await this.loadRegionCustomers(city.code, city.name);
          }
        } else {
          /* 县市级：展示该区县客户 */
          await this.loadRegionCustomers(this.currentCode, this.currentName);
        }
      },

      async loadRegionCustomers(code, name) {
        this.selected = { code, name };
        this.selectedLoading = true;
        try {
          const r = await CRM.api.get(`/api/map/region-customers?code=${code}&limit=200`);
          this.selectedCustomers = r.list || [];
        } catch (e) {
          this.selectedCustomers = [];
          CRM.toast(e.message || '读取区域客户失败', 'error');
        } finally {
          this.selectedLoading = false;
        }
      },

      /** 从右侧排行榜点击某地州 */
      async pickCity(city) {
        await this.drillDown(city.code, city.name);
        await this.loadRegionCustomers(city.code, city.name);
        this.$nextTick(() => this.resize());
      },

      goCustomer(c) { CRM.router.navigate(`/customers/${c.id}`); },

      async verifyOnline(c) {
        if (!c.longitude || !c.latitude) {
          CRM.toast('该客户没有坐标，无法在地图上核对', 'warn');
          return;
        }
        try {
          const r = await CRM.api.get('/api/map/online-url?' + new URLSearchParams({
            lng: c.longitude, lat: c.latitude, platform: 'amap',
            name: c.short_name || c.name
          }).toString());
          window.open(r.url, '_blank', 'noopener');
        } catch (e) {
          CRM.toast(e.message || '生成链接失败', 'error');
        }
      },

      resetView() {
        this.draw(this.instanceName, this.mapData, this.mapCode, this.points);
        this.$nextTick(() => this.resize());
      },

      /** 从地图侧栏跳到该客户详情，便于补全地址 */
      openCustomer(c) {
        if (c && c.id) CRM.router.navigate('/customers/' + c.id);
      },

      /** 用当前层级数据重绘（主题切换、视图重置都走这里） */
      redraw() {
        if (!this.mapData) return;
        this.draw(this.instanceName, this.mapData, this.mapCode, this.points);
        this.$nextTick(() => this.resize());
      },

      /** 取到 ECharts 实例（ECharts 6 无法用 getInstanceByDom 反查，必须由子组件暴露） */
      chartInstance() {
        const c = this.$refs.mapChart;
        return c && typeof c.getInstance === 'function' ? c.getInstance() : null;
      },

      resize() {
        const c = this.$refs.mapChart;
        if (c && typeof c.resize === 'function') c.resize();
      }
    },
    watch: {
      mapOption() {
        /* option 变化后由 c-chart 内部 setOption 处理 */
      }
    },
    async mounted() {
      await this.$nextTick();
      await this.init();
    },
    template: `
      <div>
        <div v-if="loading && !mapOption.series" class="card-body muted">正在加载地图数据…</div>

        <div v-else-if="error" class="note danger">
          <c-icon name="alert" :size="16" />
          <div>
            <strong>{{ error }}</strong>
            <div class="mt-3 muted" style="font-size:var(--fs-sm)">
              请先在开发机执行 <span class="mono-text">node tools/fetch-map-data.js</span> 完成地图数据本地化。
            </div>
          </div>
        </div>

        <template v-else>
          <!-- 工具条 -->
          <div class="map-toolbar">
            <button v-if="stack.length" class="btn btn-sm" @click="goBack">
              ← 返回全疆
            </button>
            <span class="map-crumb">
              <span v-if="stack.length">{{ stack[0].name }} / </span>
              <strong>{{ currentName }}</strong>
            </span>
            <div style="flex:1"></div>
            <span class="muted" style="font-size:var(--fs-xs)">
              客户 {{ summary.total_customers }} 家 · 已定位 {{ summary.located_customers }} 家
              <span v-if="summary.unlocated_customers" style="color:var(--c-warning)">
                · {{ summary.unlocated_customers }} 家缺坐标
              </span>
            </span>
            <button class="btn btn-sm" @click="resetView">重置视图</button>
          </div>

          <div class="map-layout" :class="{ compact: compact }">
            <!-- 地图 -->
            <div class="map-canvas">
              <c-chart ref="mapChart" chart-key="xinjiang-map"
                       :option="mapOption" :height="height" @chart-click="onMapClick" />
              <div class="map-hint muted">
                滚轮缩放 · 拖拽平移 · 点击区域查看客户
              </div>
            </div>

            <!-- 侧栏 -->
            <div class="map-side">
              <!-- 选中区域客户 -->
              <template v-if="selected">
                <div class="map-side-head">
                  <strong>{{ selected.name }}</strong>
                  <div style="flex:1"></div>
                  <button class="icon-btn" title="关闭" @click="selected = null; selectedCustomers = []">✕</button>
                </div>
                <div v-if="selectedLoading" class="muted" style="font-size:var(--fs-sm);padding:8px 0">读取中…</div>
                <c-empty v-else-if="!selectedCustomers.length" title="该区域暂无客户"
                         desc="可在地图上层级继续查看其他区域。" />
                <div v-else class="map-cust-list">
                  <div v-for="c in selectedCustomers" :key="c.id" class="map-cust"
                       @click="goCustomer(c)">
                    <div class="mc-main">
                      <div class="mc-name">
                        {{ c.short_name || c.name }}
                        <span v-if="c.level" class="tag" style="font-size:10px">{{ c.level }}</span>
                      </div>
                      <div class="mc-sub muted">
                        <span v-if="c.district">{{ c.district }}</span>
                        <span v-if="c.primary_contact"> · {{ c.primary_contact }}</span>
                        <span v-if="c.project_count"> · {{ c.project_count }} 个项目</span>
                      </div>
                    </div>
                    <button v-if="c.longitude" class="btn btn-sm"
                            title="在在线地图上核对位置"
                            @click.stop="verifyOnline(c)">核对</button>
                  </div>
                </div>
              </template>

              <!-- 未选中：客户数排行 -->
              <template v-else>
                <div class="map-side-head">
                  <strong>地州客户数排行</strong>
                </div>
                <c-empty v-if="!topCities.length" icon="map" title="还没有客户数据"
                         desc="录入客户并填写「市 / 地区」后，这里会显示分布。" />
                <div v-else class="map-rank">
                  <div v-for="(c, i) in topCities" :key="c.code" class="map-rank-row"
                       @click="pickCity(c)">
                    <span class="rank-no" :class="{ top3: i < 3 }">{{ i + 1 }}</span>
                    <span class="rank-name">{{ c.name }}</span>
                    <span class="rank-bar">
                      <span :style="{ width: Math.max(4, (c.customer_count / topCities[0].customer_count) * 100) + '%' }"></span>
                    </span>
                    <span class="rank-num">{{ c.customer_count }}</span>
                  </div>
                </div>
                <!-- 客户坐标点覆盖情况：说明图上的点是什么、哪些客户没点 -->
                <div v-if="pointMeta && pointMeta.total" class="note" style="margin-top:12px">
                  <c-icon name="check" :size="15" />
                  <div style="font-size:var(--fs-xs)">
                    地图上的圆点是<strong>已录经纬度</strong>的客户，共
                    <strong>{{ pointMeta.total }}</strong> 家（点大小≈年需求量/成交额，颜色=客户等级）。
                    <template v-if="pointMeta.omitted">
                      <br>为免拥挤，当前只显示前 <strong>{{ pointMeta.returned }}</strong> 家，
                      另有 {{ pointMeta.omitted }} 家未显示（下钻到地州可看到该地州全部）。
                    </template>
                    <template v-if="pointMeta.withoutCoords">
                      <br>还有 <strong>{{ pointMeta.withoutCoords }}</strong> 家客户没录经纬度，
                      因此不画点（画在地州中心会误导），补录坐标后即可精确定位。
                    </template>
                  </div>
                </div>

                <!-- 坐标异常的客户：明显不在新疆范围内 -->
                <div v-if="pointMeta && pointMeta.abnormal.length" class="note warn" style="margin-top:10px">
                  <c-icon name="alert" :size="15" />
                  <div style="font-size:var(--fs-xs)">
                    有 <strong>{{ pointMeta.abnormal.length }}</strong> 家客户的坐标不在新疆范围内，
                    已跳过绘制（可能录错或经纬度填反了）：
                    <div v-for="a in pointMeta.abnormal.slice(0, 5)" :key="a.id" class="unassigned-row">
                      <span class="ua-name">{{ a.short_name || a.name }}</span>
                      <span class="muted">{{ a.longitude }}, {{ a.latitude }}</span>
                      <button class="btn btn-sm" @click="openCustomer(a)">去修正</button>
                    </div>
                  </div>
                </div>

                <div v-if="dist && dist.unassigned.customer_count" class="note warn" style="margin-top:12px">
                  <c-icon name="alert" :size="15" />
                  <div style="font-size:var(--fs-xs)">
                    有 <strong>{{ dist.unassigned.customer_count }}</strong> 家客户未归属地州：
                    <template v-if="dist.unassigned.no_address_count">
                      <strong>{{ dist.unassigned.no_address_count }}</strong> 家没填「市/地区」
                    </template>
                    <template v-if="dist.unassigned.no_address_count && dist.unassigned.no_match_count">，</template>
                    <template v-if="dist.unassigned.no_match_count">
                      <strong>{{ dist.unassigned.no_match_count }}</strong> 家填了地址但系统认不出（见下表，改对后会自动归入统计）
                    </template>
                    <template v-if="!dist.unassigned.no_address_count && !dist.unassigned.no_match_count">补全地址后会自动归入地图统计</template>
                    <div v-if="unassignedRows.length" style="margin-top:6px">
                      <div v-for="u in unassignedRows" :key="u.id" class="unassigned-row">
                        <span class="ua-name">{{ u.short_name || u.name }}</span>
                        <span class="muted">
                          {{ u.reason === 'no_address' ? '未填市/地区' : ('地址「' + [u.city, u.district].filter(Boolean).join(' / ') + '」认不出') }}
                        </span>
                        <button class="btn btn-sm" @click="openCustomer(u)">去补全</button>
                      </div>
                      <div v-if="dist.unassigned.customer_count > unassignedRows.length" class="muted" style="margin-top:4px">
                        仅列出最近 {{ unassignedRows.length }} 家，其余可在客户列表按「归属地州=空」筛选
                      </div>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </template>
      </div>`
  };

  CRM.ui = CRM.ui || {};
  CRM.ui.CustomerMap = CustomerMap;
  CRM.registerMapComponent = function (app) {
    app.component('c-customer-map', CustomerMap);
  };

})(window.CRM);
