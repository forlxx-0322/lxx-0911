/**
 * 跟进提醒（软件内）
 *
 * 定位：提醒的主路径。开着软件就一定看得见——不依赖浏览器通知授权，
 * 也不依赖邮件是否配置（邮件是可选增强）。
 *
 * 行为约定：
 *   - 顶栏角标显示待提醒条数，点击展开面板
 *   - 到提醒时间且有待办时自动弹出一次（每天一次，避免反复打扰）
 *   - 「稍后」= 当日不再提醒该客户（存 localStorage，按天失效）
 *   - 面板内可直接「记跟进」（打开跟进抽屉）或点进客户详情
 *   - 轮询间隔 15 分钟（本地接口，开销可忽略）
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {
  const { ref, computed, onMounted, onBeforeUnmount } = Vue;

  const POLL_MS = 15 * 60 * 1000;
  const POPUP_KEY = 'crm_remind_popup_day';   // 记录"今天已弹过"
  const SNOOZE_KEY = 'crm_remind_snooze';     // { 'YYYY-MM-DD': [customerId, ...] }

  /** 读取"稍后"名单（只保留今天的） */
  function readSnooze() {
    try {
      const raw = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}');
      const today = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const key = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
      return { key, ids: Array.isArray(raw[key]) ? raw[key] : [], all: raw };
    } catch (_) {
      return { key: '', ids: [], all: {} };
    }
  }

  function addSnooze(customerId) {
    const s = readSnooze();
    if (!s.key) return;
    if (!s.ids.includes(customerId)) s.ids.push(customerId);
    /* 只留今天与前一天的记录，避免 localStorage 无限增长 */
    const next = {};
    next[s.key] = s.ids;
    try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(next)); } catch (_) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------------ */
  /* 提醒面板 + 顶栏角标                                                  */
  /* ------------------------------------------------------------------ */

  const ReminderBell = {
    name: 'ReminderBell',
    setup() {
      const data = ref(null);
      const open = ref(false);
      const loading = ref(false);
      const snoozeVersion = ref(0);
      const followOpen = ref(false);
      const followCustomer = ref(null);
      let timer = null;

      async function load(showErrors) {
        try {
          data.value = await CRM.api.remindersDue();
          maybeAutoOpen();
        } catch (e) {
          if (showErrors) CRM.toast(e.message || '读取提醒失败', 'error');
        }
      }

      /** 到点自动弹一次（每天一次） */
      function maybeAutoOpen() {
        const d = data.value;
        if (!d || !d.counts || !d.counts.total) return;
        if (!d.window.allow_popup) return;          // 不在提醒时段
        let lastDay = '';
        try { lastDay = localStorage.getItem(POPUP_KEY) || ''; } catch (_) { /* 忽略 */ }
        if (lastDay === d.today) return;
        open.value = true;
        try { localStorage.setItem(POPUP_KEY, d.today); } catch (_) { /* 忽略 */ }
      }

      const snoozeIds = computed(() => {
        void snoozeVersion.value;                   // 依赖，点"稍后"后重算
        return readSnooze().ids;
      });

      /** 面板里实际展示的条目（已排除"稍后"的） */
      const visible = computed(() => {
        const items = (data.value && data.value.items) || [];
        return items.filter((i) => !snoozeIds.value.includes(i.customer_id));
      });

      const counts = computed(() => {
        const v = visible.value;
        return {
          total: v.length,
          overdue: v.filter((i) => i.level === 'overdue').length,
          today: v.filter((i) => i.level === 'today').length,
          soon: v.filter((i) => i.level === 'soon').length
        };
      });

      /** 默认只展开逾期与今天，临近的折叠起来（避免一次几十条） */
      const showSoon = ref(false);
      const mainItems = computed(() => visible.value.filter((i) => i.level !== 'soon'));
      const soonItems = computed(() => visible.value.filter((i) => i.level === 'soon'));

      function snooze(item) {
        addSnooze(item.customer_id);
        snoozeVersion.value++;
      }

      function openCustomer(item) {
        open.value = false;
        CRM.router.navigate(`/customers/${item.customer_id}`);
      }

      function recordFollow(item) {
        followCustomer.value = { id: item.customer_id, name: item.short_name || item.name };
        followOpen.value = true;
      }

      function onFollowSaved() {
        followOpen.value = false;
        followCustomer.value = null;
        CRM.toast('跟进已记录', 'success');
        load();
      }

      function levelClass(level) {
        return level === 'overdue' ? 'danger' : (level === 'today' ? 'warn' : 'muted');
      }

      onMounted(() => {
        load();
        timer = setInterval(load, POLL_MS);
      });
      onBeforeUnmount(() => { if (timer) clearInterval(timer); });

      return {
        data, open, loading, visible, counts, mainItems, soonItems, showSoon,
        snooze, openCustomer, recordFollow, levelClass,
        followOpen, followCustomer, onFollowSaved,
        reload: load
      };
    },
    template: `
      <div class="remind-wrap">
        <button class="icon-btn remind-bell" type="button"
                :class="{ 'has-items': counts.total > 0 }"
                :title="counts.total ? ('有 ' + counts.total + ' 位客户待跟进') : '暂无待跟进'"
                @click="open = !open">
          <c-icon name="alert" :size="15" />
          <span v-if="counts.total" class="remind-badge">{{ counts.total > 99 ? '99+' : counts.total }}</span>
        </button>

        <div v-if="open" class="remind-mask" @click.self="open = false">
          <div class="remind-panel">
            <div class="remind-head">
              <div>
                <div class="remind-title">待跟进提醒</div>
                <div class="remind-sub">
                  <template v-if="counts.total">
                    逾期 {{ counts.overdue }} · 今天 {{ counts.today }} · 临近 {{ counts.soon }}
                  </template>
                  <template v-else>当前没有需要跟进的客户</template>
                </div>
              </div>
              <button class="icon-btn" title="关闭" @click="open = false">✕</button>
            </div>

            <div class="remind-body">
              <div v-if="!counts.total" class="remind-empty">
                <c-icon name="check" :size="26" />
                <div class="mt-3">没有逾期或临近的跟进计划</div>
                <div class="muted mt-3" style="font-size:var(--fs-xs)">
                  提醒时段 {{ data ? data.window.remind_time : '09:00' }}–{{ data ? data.window.quiet_time : '18:00' }}，
                  提前 {{ data ? data.window.lead_days : 3 }} 天提醒
                </div>
              </div>

              <template v-else>
                <div v-for="it in mainItems" :key="it.customer_id" class="remind-item"
                     :class="'lv-' + it.level">
                  <div class="ri-main" @click="openCustomer(it)">
                    <div class="ri-name">
                      {{ it.short_name }}
                      <span v-if="it.customer_level" class="tag" :class="it.customer_level.startsWith('A') ? 'danger' : 'muted'">
                        {{ it.customer_level }}
                      </span>
                    </div>
                    <div class="ri-meta">
                      <span :class="levelClass(it.level)" class="ri-days">{{ it.days_text }}</span>
                      <span class="muted">计划 {{ it.next_follow_at }}</span>
                      <span v-if="it.contact || it.mobile" class="muted">
                        · {{ it.contact }}{{ it.contact && it.mobile ? ' ' : '' }}{{ it.mobile }}
                      </span>
                    </div>
                  </div>
                  <div class="ri-ops">
                    <button class="btn btn-sm btn-primary" @click.stop="recordFollow(it)">记跟进</button>
                    <button class="btn btn-sm" title="今天不再提醒这位客户" @click.stop="snooze(it)">稍后</button>
                  </div>
                </div>

                <div v-if="soonItems.length" class="remind-soon-toggle">
                  <button class="link-btn" @click="showSoon = !showSoon">
                    {{ showSoon ? '收起' : '展开' }}临近跟进的 {{ soonItems.length }} 位
                  </button>
                </div>
                <template v-if="showSoon">
                  <div v-for="it in soonItems" :key="it.customer_id" class="remind-item lv-soon">
                    <div class="ri-main" @click="openCustomer(it)">
                      <div class="ri-name">{{ it.short_name }}</div>
                      <div class="ri-meta">
                        <span class="muted ri-days">{{ it.days_text }}</span>
                        <span class="muted">计划 {{ it.next_follow_at }}</span>
                      </div>
                    </div>
                    <div class="ri-ops">
                      <button class="btn btn-sm" @click.stop="recordFollow(it)">记跟进</button>
                      <button class="btn btn-sm" @click.stop="snooze(it)">稍后</button>
                    </div>
                  </div>
                </template>
              </template>
            </div>
          </div>
        </div>

        <c-followup-drawer v-model="followOpen"
                           :customer-id="followCustomer ? followCustomer.id : ''"
                           :customer-name="followCustomer ? followCustomer.name : ''"
                           @saved="onFollowSaved" />
      </div>`
  };

  CRM.components = CRM.components || {};
  CRM.components.ReminderBell = ReminderBell;

})(window.CRM);
