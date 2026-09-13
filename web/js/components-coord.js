/**
 * 坐标工具组件
 *
 * 解决一个很实际的问题：用户从高德/百度地图复制的坐标是 GCJ-02 / BD-09，
 * 直接填进系统会偏几百米。这里提供：
 *   1. 粘贴任意来源的坐标 → 自动识别并转成 WGS84
 *   2. 一键打开坐标拾取器
 *   3. 生成「在线地图核对」链接验证位置是否正确
 *   4. 按坐标推荐最近的地州（辅助归属，不自动写入）
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const CoordTool = {
    name: 'CoordTool',
    props: {
      modelValue: Boolean,
      longitude: [Number, String],
      latitude: [Number, String],
      cityText: String,
      customerName: String
    },
    emits: ['update:modelValue', 'apply', 'apply-city'],
    data() {
      return {
        raw: '',                  // 用户粘贴的原始文本
        parsed: null,             // { lng, lat } 解析结果
        fromSys: 'auto',          // auto | gcj02 | bd09 | wgs84
        converted: null,          // { longitude, latitude, shift_meters }
        converting: false,
        nearest: [],
        nearestLoading: false,
        error: ''
      };
    },
    computed: {
      current() {
        const lng = Number(this.longitude);
        const lat = Number(this.latitude);
        if (!isFinite(lng) || !isFinite(lat) || !lng || !lat) return null;
        return { longitude: lng, latitude: lat };
      },
      hasValidCoord() { return !!this.current; }
    },
    methods: {
      fmtMoney: CRM.util.fmtMoney,

      reset() {
        this.raw = '';
        this.parsed = null;
        this.converted = null;
        this.nearest = [];
        this.error = '';
        this.fromSys = 'auto';
      },

      /** 从任意文本里解析经纬度（支持 "87.61,43.82"、"87.61 43.82"、带标签的复制内容） */
      parseRaw() {
        const t = String(this.raw || '');
        /* 抓取所有数字（含负数与小数） */
        const nums = t.match(/-?\d+(\.\d+)?/g);
        if (!nums || nums.length < 2) {
          this.parsed = null;
          this.error = '没识别到坐标，请粘贴形如「87.6168,43.8256」的内容';
          return;
        }
        /* 取前两个数字作为经纬度，但若第一个明显不像经度（> 90）而第二个像，则交换 */
        let a = Number(nums[0]);
        let b = Number(nums[1]);
        if (Math.abs(b) > 90 && Math.abs(a) <= 90) { const t2 = a; a = b; b = t2; }

        if (Math.abs(a) > 180 || Math.abs(b) > 90) {
          this.parsed = null;
          this.error = '解析出的数值超出经纬度范围，请检查';
          return;
        }
        this.parsed = { longitude: a, latitude: b };
        this.error = '';

        /* 明显不在中国范围时给个提醒 */
        if (a < 73 || a > 136 || b < 3 || b > 54) {
          this.error = '该坐标不在中国境内，请确认是否复制正确';
        }
        this.convert();
      },

      /** 转成 WGS84（系统内部统一用 WGS84） */
      async convert() {
        if (!this.parsed) return;
        this.converting = true;
        this.converted = null;
        try {
          const from = this.fromSys === 'auto' ? 'gcj02' : this.fromSys;   // 国内地图默认高德=GCJ-02
          const r = await CRM.api.post('/api/map/convert', {
            from, to: 'wgs84',
            longitude: this.parsed.longitude,
            latitude: this.parsed.latitude,
            name: this.customerName || '客户位置'
          });
          this.converted = Object.assign({ assumedFrom: from }, r);
          await this.loadNearest();
        } catch (e) {
          this.error = e.message || '转换失败';
        } finally {
          this.converting = false;
        }
      },

      async loadNearest() {
        const c = this.converted ? this.converted.output : this.current;
        if (!c) return;
        this.nearestLoading = true;
        try {
          const r = await CRM.api.get('/api/map/nearest?' + new URLSearchParams({
            lng: c.longitude, lat: c.latitude, limit: 3
          }).toString());
          this.nearest = r.list || [];
        } catch (_) {
          this.nearest = [];
        } finally {
          this.nearestLoading = false;
        }
      },

      /** 打开坐标拾取器（需联网，用于获取坐标） */
      openPicker() {
        window.open('https://lbs.amap.com/tools/picker', '_blank', 'noopener');
      },

      /** 在线核对当前填写/转换后的坐标 */
      async verifyOnline(coord) {
        const c = coord || (this.converted ? this.converted.output : this.current);
        if (!c) { CRM.toast('还没有可核对的坐标', 'warn'); return; }
        try {
          const r = await CRM.api.get('/api/map/online-url?' + new URLSearchParams({
            lng: c.longitude, lat: c.latitude, platform: 'amap',
            name: this.customerName || '客户位置'
          }).toString());
          window.open(r.url, '_blank', 'noopener');
        } catch (e) {
          CRM.toast(e.message || '生成链接失败', 'error');
        }
      },

      /** 把转换结果填回客户表单 */
      apply() {
        if (!this.converted) return;
        /* 注意：不能复用 update:modelValue —— 那是抽屉开关用的，
           混用会导致「关闭抽屉」和「填入坐标」互相触发。 */
        this.$emit('apply', {
          longitude: this.converted.output.longitude,
          latitude: this.converted.output.latitude
        });
        CRM.toast('坐标已填入（已转为 WGS84）', 'success');
      },

      /** 采用推荐的地州（只改城市文本，由后端自动归属） */
      useCity(city) {
        this.$emit('apply-city', city.name);
        CRM.toast(`已填入「${city.name}」，保存后自动归属`, 'success');
      },

      onKey(e) { if (e.key === 'Escape') this.$emit('update:modelValue', false); }
    },
    watch: {
      modelValue(v) { if (v) this.reset(); }
    },
    mounted() { window.addEventListener('keydown', this.onKey); },
    beforeUnmount() { window.removeEventListener('keydown', this.onKey); },
    template: `
      <c-drawer :model-value="modelValue" title="坐标工具"
                sub="粘贴高德/百度复制的坐标，自动转成系统使用的 WGS84"
                width="560px"
                @update:model-value="$emit('update:modelValue', $event)">

        <!-- 当前坐标 -->
        <div class="note" style="margin-bottom:16px">
          <c-icon name="map" :size="16" />
          <div style="font-size:var(--fs-sm)">
            当前客户坐标：
            <template v-if="hasValidCoord">
              <strong>{{ current.longitude }}, {{ current.latitude }}</strong>（WGS84）
              <button class="btn btn-sm" style="margin-left:8px" @click="verifyOnline(current)">在线核对</button>
              <button class="btn btn-sm" @click="loadNearest">看看属于哪个地州</button>
            </template>
            <span v-else class="muted">尚未填写</span>
          </div>
        </div>

        <!-- 粘贴转换 -->
        <div class="field" style="margin-bottom:12px">
          <label class="field-label">粘贴坐标</label>
          <div style="display:flex;gap:8px">
            <input class="input" v-model="raw" placeholder="例如：87.6168,43.8256"
                   @input="parseRaw" @keydown.enter="parseRaw" />
            <button class="btn" @click="openPicker" title="打开高德坐标拾取器（需联网）">
              拾取器
            </button>
          </div>
          <div class="field-hint">
            支持「经度,纬度」「经度 纬度」，也支持从地图页面直接复制的带文字内容
          </div>
        </div>

        <div class="field" style="margin-bottom:12px">
          <label class="field-label">坐标来源</label>
          <select class="input" v-model="fromSys" @change="convert">
            <option value="auto">自动判断（高德 / 腾讯 / 谷歌中国 → GCJ-02）</option>
            <option value="gcj02">高德 / 腾讯地图（GCJ-02）</option>
            <option value="bd09">百度地图（BD-09）</option>
            <option value="wgs84">GPS 设备 / 已有 WGS84</option>
          </select>
        </div>

        <div v-if="error" class="note danger" style="margin-bottom:12px">
          <c-icon name="alert" :size="15" />
          <div style="font-size:var(--fs-sm)">{{ error }}</div>
        </div>

        <!-- 转换结果 -->
        <div v-if="converting" class="muted" style="font-size:var(--fs-sm)">正在转换…</div>
        <div v-else-if="converted" class="card" style="border-color:var(--c-primary-border)">
          <div class="card-body" style="padding:14px">
            <div class="kv">
              <div class="k">原始坐标</div>
              <div class="v mono">{{ converted.input.longitude }}, {{ converted.input.latitude }}
                <span class="tag muted" style="font-size:10px">{{ converted.assumedFrom === 'bd09' ? 'BD-09' : (converted.assumedFrom === 'wgs84' ? 'WGS84' : 'GCJ-02') }}</span>
              </div>
              <div class="k">转为 WGS84</div>
              <div class="v mono" style="color:var(--c-primary);font-weight:600">
                {{ converted.output.longitude }}, {{ converted.output.latitude }}
              </div>
              <div class="k">偏移量</div>
              <div class="v">{{ converted.shift_meters }} 米（未转换直接使用会导致地图上偏这么多）</div>
            </div>
            <div class="mt-4" style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-primary" @click="apply">填入这两个坐标</button>
              <button class="btn" @click="verifyOnline(converted.output)">在线核对转换结果</button>
            </div>
          </div>
        </div>

        <!-- 最近地州推荐 -->
        <div v-if="nearest.length" class="mt-4">
          <div class="field-label" style="margin-bottom:6px">
            离该坐标最近的地州（仅供参考，请人工确认）
          </div>
          <div class="mini-list">
            <div v-for="(c, i) in nearest" :key="c.code" class="mini-row">
              <span class="rank-no" :class="{ top3: i === 0 }">{{ i + 1 }}</span>
              <div class="mr-main">
                <div class="mr-title">{{ c.name }}</div>
                <div class="mr-sub muted">直线距离 {{ c.distance_text }}</div>
              </div>
              <button class="btn btn-sm" @click="useCity(c)">填入该地州</button>
            </div>
          </div>
          <div class="field-hint" style="margin-top:6px">
            注意：最近的未必是所属的（客户可能在两个地州交界处），所以不会自动写入。
          </div>
        </div>

        <template #footer>
          <span class="muted" style="font-size:var(--fs-xs)">
            系统内部统一存储 WGS84，地图渲染才能与边界数据对齐
          </span>
          <div style="flex:1"></div>
          <button class="btn" @click="$emit('update:modelValue', false)">关闭</button>
        </template>
      </c-drawer>`
  };

  CRM.ui = CRM.ui || {};
  CRM.ui.CoordTool = CoordTool;
  CRM.registerCoordComponent = function (app) {
    app.component('c-coord-tool', CoordTool);
  };

})(window.CRM);
