/**
 * 设置页 · 备份与恢复
 * 主备份 + 镜像副本、手动备份、从备份恢复（两步确认 + 恢复前自动兜底备份）
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const BackupPanel = {
    name: 'BackupPanel',
    data() {
      return {
        loading: true,
        info: null,
        busy: '',
        restoreTarget: null,
        restorePreview: null,
        restoring: false
      };
    },
    computed: {
      backups() { return (this.info && this.info.backups) || []; },
      mirror() { return (this.info && this.info.mirror) || []; }
    },
    methods: {
      fmtSize(s) { return CRM.util.fmtSize(s); },
      fmtDate: CRM.util.fmtDate,

      async load() {
        this.loading = true;
        try {
          this.info = await CRM.api.listBackups();
        } catch (e) {
          CRM.toast(e.message || '读取备份列表失败', 'error');
        } finally {
          this.loading = false;
        }
      },

      async createNow() {
        this.busy = 'create';
        try {
          const r = await CRM.api.createBackup('手动备份');
          CRM.toast(`备份已创建：${r.name}（${this.fmtSize(r.size)}）`, 'success');
          if (r.rotatedOut) CRM.toast(`按保留策略清理了 ${r.rotatedOut} 份旧备份`, 'info');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '备份失败', 'error');
        } finally {
          this.busy = '';
        }
      },

      async toggleAuto() {
        try {
          const next = this.info.autoEnabled ? '0' : '1';
          await CRM.api.saveSettings({ backup_auto: next });
          CRM.toast(next === '1' ? '已开启每日自动备份' : '已关闭每日自动备份', 'success');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '设置失败', 'error');
        }
      },

      async saveKeep(field, value) {
        try {
          await CRM.api.saveSettings({ [field]: String(value) });
          CRM.toast('保留份数已更新', 'success');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '设置失败', 'error');
        }
      },

      async openDataDir() {
        try {
          const r = await CRM.api.openDataDir();
          CRM.toast(r.message || '已打开数据目录', 'success');
        } catch (e) {
          CRM.toast(e.message || '打开失败', 'error');
        }
      },

      /* 恢复：第一步 —— 校验并展示将影响的数据 */
      async startRestore(b) {
        this.restoreTarget = b;
        this.restorePreview = null;
        this.busy = 'verify:' + b.name;
        try {
          const r = await CRM.api.restoreBackup(b.name, false);
          if (r.verify && r.verify.ok === false) {
            CRM.toast('该备份文件不可用：' + r.verify.error, 'error');
            this.restoreTarget = null;
            return;
          }
          this.restorePreview = r;
        } catch (e) {
          CRM.toast(e.message || '校验失败', 'error');
          this.restoreTarget = null;
        } finally {
          this.busy = '';
        }
      },

      cancelRestore() {
        this.restoreTarget = null;
        this.restorePreview = null;
      },

      async doRestore() {
        if (!this.restoreTarget) return;
        this.restoring = true;
        try {
          const r = await CRM.api.restoreBackup(this.restoreTarget.name, true);
          CRM.toast(`已从 ${r.from} 恢复，恢复前已自动备份为 ${r.safetyBackup}`, 'success', 8000);
          /* 服务会在 2 秒后自行退出（退出码 4），启动器会重新拉起 */
          this.restoreDone = true;
          setTimeout(() => {
            window.location.reload();
          }, 3500);
        } catch (e) {
          CRM.toast(e.message || '恢复失败', 'error');
          this.restoring = false;
        }
      },

      async removeBackup(b) {
        const ok = await CRM.confirm({
          title: '删除备份',
          message: `确定删除备份 <strong>${b.name}</strong> 吗？<br>镜像中的同名副本也会一并删除。`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteBackup(b.name);
          CRM.toast('备份已删除', 'success');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      }
    },
    async created() { this.load(); },
    template: `
      <div>
        <div v-if="loading" class="card"><div class="card-body muted">正在读取备份列表…</div></div>

        <template v-else-if="info">
          <!-- 恢复确认弹窗 -->
          <transition name="fade">
            <div v-if="restoreTarget" class="modal-mask" @click.self="cancelRestore">
              <div class="modal" style="max-width:560px">
                <div class="modal-title">
                  <c-icon name="alert" :size="18" style="color:var(--c-danger)" />
                  <span>从备份恢复数据</span>
                </div>
                <div class="modal-body">
                  <p style="margin-top:0">即将用备份 <strong>{{ restoreTarget.name }}</strong> 覆盖当前数据库。</p>
                  <div class="note warn">
                    <c-icon name="alert" :size="16" />
                    <div style="font-size:var(--fs-sm)">
                      恢复后<strong>当前数据将被替换</strong>。系统会先自动备份当前库
                      （保存为「恢复前」备份），万一恢复错了还能再换回来。
                    </div>
                  </div>
                  <div v-if="restorePreview" class="kv mt-4">
                    <div class="k">备份时间</div>
                    <div class="v">{{ restoreTarget.createdAtText }}</div>
                    <div class="k">备份中的客户数</div>
                    <div class="v">{{ restorePreview.verify.customers }} 条</div>
                    <div class="k">备份结构版本</div>
                    <div class="v">v{{ restorePreview.verify.version }}</div>
                    <div class="k">当前客户数（将被替换）</div>
                    <div class="v">{{ restorePreview.willReplace.customers }} 条</div>
                    <div class="k">当前项目数（将被替换）</div>
                    <div class="v">{{ restorePreview.willReplace.projects }} 个</div>
                  </div>
                  <div v-if="restoring" class="note mt-4">
                    <c-icon name="refresh" :size="16" />
                    <div style="font-size:var(--fs-sm)">
                      正在恢复…服务将在 2 秒后自动重启以加载还原后的数据，页面会自动刷新。
                    </div>
                  </div>
                </div>
                <div class="modal-foot">
                  <button class="btn" :disabled="restoring" @click="cancelRestore">取消</button>
                  <button class="btn btn-danger" :disabled="restoring" @click="doRestore">
                    {{ restoring ? '恢复中…' : '确认恢复' }}
                  </button>
                </div>
              </div>
            </div>
          </transition>

          <!-- 状态卡 -->
          <div class="grid-2" style="margin-bottom:16px">
            <c-card title="备份状态" :sub="info.autoEnabled ? '每日自动备份：已开启' : '每日自动备份：已关闭'" icon="database">
              <template #head>
                <button class="btn btn-sm btn-primary" :disabled="busy === 'create'" @click="createNow">
                  <c-icon name="plus" :size="13" /> {{ busy === 'create' ? '备份中…' : '立即备份' }}
                </button>
              </template>
              <div class="kv">
                <div class="k">主备份目录</div>
                <div class="v mono">{{ info.backupDir }}</div>
                <div class="k">镜像备份目录</div>
                <div class="v mono">{{ info.mirrorDir }}</div>
                <div class="k">主目录备份数</div>
                <div class="v">{{ info.backups.length }} 份（保留最近 {{ info.keep }} 份）</div>
                <div class="k">镜像备份数</div>
                <div class="v">{{ info.mirror.length }} 份（保留最近 {{ info.mirrorKeep }} 份）</div>
                <div class="k">今天是否已备份</div>
                <div class="v">
                  <span class="tag" :class="info.hasToday ? 'success' : 'warning'">
                    {{ info.hasToday ? '已备份' : '尚未备份' }}
                  </span>
                </div>
                <div class="k">最近一次备份</div>
                <div class="v">{{ info.lastBackupAt ? fmtDate(info.lastBackupAt, true) : '暂无' }}</div>
              </div>
            </c-card>

            <c-card title="备份策略" sub="双份副本：主目录 + 镜像目录，防误删与硬盘故障" icon="settings">
              <div class="form-grid">
                <div class="field">
                  <label class="field-label">每日自动备份</label>
                  <div class="switch" @click="toggleAuto">
                    <input type="checkbox" :checked="info.autoEnabled" readonly />
                    <span class="switch-track"><span class="switch-thumb"></span></span>
                    <span class="switch-text">{{ info.autoEnabled ? '已开启（每天首次启动时备份一次）' : '已关闭' }}</span>
                  </div>
                </div>
                <div class="field">
                  <label class="field-label">主目录保留份数</label>
                  <input class="input" type="number" min="1" max="365" :value="info.keep"
                         @change="saveKeep('backup_keep', $event.target.value)" />
                </div>
                <div class="field">
                  <label class="field-label">镜像保留份数</label>
                  <input class="input" type="number" min="1" max="60" :value="info.mirrorKeep"
                         @change="saveKeep('backup_mirror_keep', $event.target.value)" />
                </div>
                <div class="field">
                  <label class="field-label">数据目录</label>
                  <button class="btn" @click="openDataDir">
                    <c-icon name="folder" :size="14" /> 打开数据目录
                  </button>
                  <div class="field-hint">整个 data 文件夹拷走即为完整迁移</div>
                </div>
              </div>
            </c-card>
          </div>

          <!-- 备份列表 -->
          <c-card :title="'备份列表（' + backups.length + ' 份）'"
                  sub="最新一份不允许删除，它是当前唯一的保险">
            <template #head>
              <button class="btn btn-sm" @click="load">
                <c-icon name="refresh" :size="13" /> 刷新
              </button>
            </template>
            <c-empty v-if="!backups.length" icon="database" title="还没有备份"
                     desc="点击上方「立即备份」创建第一份。" />
            <div v-else>
              <div v-for="(b, i) in backups" :key="b.name" class="backup-item">
                <div style="flex:1;min-width:0">
                  <div class="nm">{{ b.name }}</div>
                  <div class="muted" style="font-size:var(--fs-xs);margin-top:2px">
                    {{ b.createdAtText }} · {{ fmtSize(b.size) }}
                    <span v-if="b.manifest && b.manifest.reason"> · {{ b.manifest.reason }}</span>
                    <span v-if="b.manifest && b.manifest.tables">
                      · 客户 {{ b.manifest.tables.customers }} / 项目 {{ b.manifest.tables.projects }}
                    </span>
                    <span v-if="i === 0" class="tag success" style="margin-left:6px;font-size:10px">最新</span>
                  </div>
                </div>
                <div style="display:flex;gap:6px;flex-shrink:0">
                  <button class="btn btn-sm" :disabled="!!busy" @click="startRestore(b)">从此恢复</button>
                  <button class="btn btn-sm btn-danger" :disabled="i === 0 || !!busy" @click="removeBackup(b)">删除</button>
                </div>
              </div>
            </div>
          </c-card>

          <div class="note mt-4">
            <c-icon name="alert" :size="16" />
            <div style="font-size:var(--fs-sm)">
              <strong>建议：</strong>定期把 <span class="mono-text">{{ info.backupDir }}</span> 里的备份文件拷贝到移动硬盘或网盘同步目录。
              本地双份备份能防误删与误操作，但防不了硬盘整体损坏。
            </div>
          </div>
        </template>
      </div>`
  };

  CRM.settings = CRM.settings || {};
  CRM.settings.BackupPanel = BackupPanel;

})(window.CRM);
