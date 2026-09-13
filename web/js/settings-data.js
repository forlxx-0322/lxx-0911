/**
 * 设置页 · 数据导入导出（Excel）
 *
 * 架构：SheetJS 在浏览器里运行（解析/生成 xlsx），后端只处理 JSON。
 * 好处：可即时预览与逐行报错；后端保持零第三方依赖。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const ENTITIES = [
    { key: 'customer', label: '客户' },
    { key: 'contact', label: '联系人' },
    { key: 'project', label: '项目' }
  ];

  const DataPanel = {
    name: 'DataPanel',
    data() {
      return {
        entities: ENTITIES,
        entity: 'customer',
        /* 导出 */
        exporting: false,
        exportScope: 'all',
        lastExport: null,
        /* 导入 */
        step: 1,                 // 1 选文件 → 2 预览 → 3 完成
        fileName: '',
        parsing: false,
        preview: null,
        importing: false,
        report: null,
        dragOver: false,
        mappingMiss: []
      };
    },
    computed: {
      label() {
        const hit = this.entities.find((e) => e.key === this.entity);
        return hit ? hit.label : this.entity;
      },
      previewRows() { return (this.preview && this.preview.rows) || []; },
      errorRows() { return this.previewRows.filter((r) => r.errors.length > 0); },
      warnRows() { return this.previewRows.filter((r) => !r.errors.length && r.warnings.length > 0); }
    },
    methods: {
      switchEntity(k) {
        this.entity = k;
        this.resetImport();
        this.lastExport = null;
      },

      resetImport() {
        this.step = 1;
        this.fileName = '';
        this.preview = null;
        this.report = null;
        this.mappingMiss = [];
      },

      /* ---------------- 模板下载 ---------------- */
      async downloadTemplate() {
        try {
          await CRM.importXlsx.downloadTemplate(this.entity);
          CRM.toast('模板已下载（含填写说明与可选值参考）', 'success');
        } catch (e) {
          CRM.toast(e.message || '下载模板失败', 'error');
        }
      },

      /* ---------------- 导出 ---------------- */
      async doExport() {
        this.exporting = true;
        try {
          const opts = this.exportScope === 'all' ? {} : { limit: 0 };
          const d = await CRM.api.exportData(this.entity, opts);
          const XLSX = window.XLSX;
          if (!XLSX) { CRM.toast('Excel 组件未加载', 'error'); return; }
          if (!d.rows.length) { CRM.toast('没有可导出的数据', 'warn'); return; }

          const header = d.fields.map((f) => f.label);
          const aoa = [header];
          for (const r of d.rows) {
            aoa.push(d.fields.map((f) => {
              const v = r[f.key];
              return v === null || v === undefined ? '' : v;
            }));
          }

          const ws = XLSX.utils.aoa_to_sheet(aoa);
          ws['!cols'] = d.fields.map((f) => ({ wch: Math.max(10, Math.min(40, f.width || 16)) }));

          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, d.label);

          const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          XLSX.writeFile(wb, `${d.label}数据_${stamp}.xlsx`);

          this.lastExport = { label: d.label, count: d.count, fields: d.fields.length, at: new Date() };
          CRM.toast(`已导出 ${d.count} 条${d.label}数据`, 'success');
        } catch (e) {
          CRM.toast(e.message || '导出失败', 'error');
        } finally {
          this.exporting = false;
        }
      },

      /* ---------------- 导入 ---------------- */
      pickFile() {
        const el = this.$refs.file;
        if (el) el.click();
      },

      /* ---------------- 模板下载与导入（公共实现，见文件末尾 CRM.importXlsx） ---------------- */
      onFileChange(e) {
        const f = e.target.files && e.target.files[0];
        if (f) this.handleFile(f);
        e.target.value = '';
      },

      onDrop(e) {
        this.dragOver = false;
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this.handleFile(f);
      },

      async handleFile(file) {
        this.parsing = true;
        this.fileName = (file && file.name) || '';
        this.report = null;
        try {
          const r = await CRM.importXlsx.parseFile(this.entity, file);
          if (!r.ok) { CRM.toast(r.message, 'error', 6000); this.step = 1; return; }
          this.mappingMiss = r.missing;
          this.preview = r.preview;
          this.step = 2;
          CRM.toast(`已解析 ${r.preview.total} 行：可导入 ${r.preview.valid} 行，有问题 ${r.preview.invalid} 行`, 'success', 4000);
        } finally {
          this.parsing = false;
        }
      },

      async doImport() {
        if (!this.preview) return;
        this.importing = true;
        try {
          /* 只提交校验通过的行；有问题的行保持原样，报告里会列出原因 */
          const raw = this.previewRows.map((r) => r.data);
          const rep = await CRM.api.runImport(this.entity, raw);
          this.report = rep;
          this.step = 3;
          CRM.toast(`导入完成：成功 ${rep.imported} 条`, 'success', 5000);
        } catch (e) {
          CRM.toast(e.message || '导入失败', 'error');
        } finally {
          this.importing = false;
        }
      },

      async downloadErrorReport() {
        if (!this.preview) return;
        try {
          const XLSX = window.XLSX;
          const tpl = await CRM.api.getTemplate(this.entity);
          const rows = [];
          rows.push(['行号', '问题类型', '说明', ...tpl.fields.map((f) => f.label)]);
          for (const r of this.previewRows) {
            if (!r.errors.length && !r.warnings.length) continue;
            rows.push([
              r.index,
              r.errors.length ? '错误' : '提示',
              (r.errors.concat(r.warnings)).join('；'),
              ...tpl.fields.map((f) => {
                const v = r.data[f.key];
                return v === null || v === undefined ? '' : v;
              })
            ]);
          }
          const ws = XLSX.utils.aoa_to_sheet(rows);
          ws['!cols'] = [{ wch: 8 }, { wch: 8 }, { wch: 46 }, ...tpl.fields.map(() => ({ wch: 16 }))];
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, '导入问题清单');
          XLSX.writeFile(wb, `${this.label}导入问题清单.xlsx`);
          CRM.toast('问题清单已下载', 'success');
        } catch (e) {
          CRM.toast(e.message || '生成失败', 'error');
        }
      }
    },
    template: `
      <div>
        <!-- 类型切换 -->
        <div class="tabs" style="margin-bottom:16px">
          <button v-for="e in entities" :key="e.key" class="tab"
                  :class="{ active: entity === e.key }" @click="switchEntity(e.key)">
            {{ e.label }}
          </button>
        </div>

        <div class="grid-2">
          <!-- 导出 -->
          <c-card :title="'导出' + label + '数据'" sub="生成 Excel 文件，可用 Excel 直接打开与编辑" icon="file">
            <div class="form-grid">
              <div class="field" style="grid-column:span 2">
                <label class="field-label">导出范围</label>
                <select class="input" v-model="exportScope">
                  <option value="all">全部{{ label }}（不含已删除）</option>
                </select>
                <div class="field-hint">导出内容与界面字段一致，表头为中文，可直接用于备份或移交</div>
              </div>
              <div class="field" style="grid-column:span 2">
                <button class="btn btn-primary" :disabled="exporting" @click="doExport">
                  <c-icon name="file" :size="14" /> {{ exporting ? '导出中…' : '导出为 Excel' }}
                </button>
              </div>
            </div>
            <div v-if="lastExport" class="note mt-4">
              <c-icon name="check" :size="16" />
              <div style="font-size:var(--fs-sm)">
                上次导出：{{ lastExport.label }} {{ lastExport.count }} 条 × {{ lastExport.fields }} 列
                （{{ lastExport.at.toLocaleTimeString('zh-CN') }}）
              </div>
            </div>
          </c-card>

          <!-- 模板 -->
          <c-card title="下载导入模板" sub="先下载模板，按格式填写后再导入，最不容易出错" icon="file">
            <div class="note">
              <c-icon name="alert" :size="16" />
              <div style="font-size:var(--fs-sm)">
                模板包含<strong>两页</strong>：第一页是表头与示例行，第二页是填写说明。
                请不要修改表头文字；列顺序可以调整。
              </div>
            </div>
            <div class="mt-4">
              <button class="btn btn-primary" @click="downloadTemplate">
                <c-icon name="file" :size="14" /> 下载{{ label }}导入模板
              </button>
            </div>
            <div class="mt-4 muted" style="font-size:var(--fs-xs)">
              支持 .xlsx / .xls / .csv；日期支持 2026-03-01 与 2026/3/1 两种写法；
              多值列用逗号分隔；字典里没有的选项会自动补进字典。
            </div>
          </c-card>
        </div>

        <!-- 导入 -->
        <c-card class="mt-4" title="导入数据" sub="上传 → 校验预览 → 确认写入，三步完成，写入前不会动数据" icon="file">
          <div class="import-steps">
            <div class="import-step" :class="{ on: step === 1 }"><span class="idx">1</span>选择文件</div>
            <div class="import-step" :class="{ on: step === 2 }"><span class="idx">2</span>校验预览</div>
            <div class="import-step" :class="{ on: step === 3 }"><span class="idx">3</span>完成</div>
          </div>

          <!-- 步骤 1 -->
          <div v-if="step === 1">
            <div class="drop-zone" :class="{ over: dragOver }"
                 @click="pickFile"
                 @dragover.prevent="dragOver = true"
                 @dragleave="dragOver = false"
                 @drop.prevent="onDrop">
              <c-icon name="file" :size="34" style="opacity:.4" />
              <div style="margin-top:10px;font-size:var(--fs-base)">
                {{ parsing ? '正在解析文件…' : '点击选择文件，或把 Excel 文件拖到这里' }}
              </div>
              <div style="font-size:var(--fs-xs);margin-top:6px">
                支持 .xlsx / .xls / .csv，单次最多 5000 行
              </div>
            </div>
            <input ref="file" type="file" accept=".xlsx,.xls,.csv" style="display:none"
                   @change="onFileChange" />
            <div v-if="mappingMiss.length" class="note danger mt-4">
              <c-icon name="alert" :size="16" />
              <div style="font-size:var(--fs-sm)">
                文件缺少必填列：<strong>{{ mappingMiss.join('、') }}</strong>。
                请下载上方模板，按模板表头填写后重新上传。
              </div>
            </div>
          </div>

          <!-- 步骤 2 -->
          <div v-else-if="step === 2 && preview">
            <div class="note" style="margin-bottom:14px">
              <c-icon name="check" :size="16" />
              <div style="font-size:var(--fs-sm)">
                文件 <strong>{{ fileName }}</strong> 解析完成：
                共 {{ preview.total }} 行，
                <span style="color:var(--c-success)">可导入 {{ preview.valid }} 行</span>
                <span v-if="preview.invalid" style="color:var(--c-danger)">，有问题 {{ preview.invalid }} 行（不会被导入）</span>
              </div>
            </div>

            <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
              <button class="btn btn-primary" :disabled="importing || !preview.valid" @click="doImport">
                {{ importing ? '导入中…' : '确认导入 ' + preview.valid + ' 行' }}
              </button>
              <button class="btn" :disabled="importing" @click="downloadErrorReport">下载问题清单</button>
              <button class="btn" :disabled="importing" @click="resetImport">重新选择文件</button>
            </div>

            <div class="table-wrap" style="max-height:420px;overflow:auto">
              <table class="data-table">
                <thead>
                  <tr>
                    <th style="width:56px">行号</th>
                    <th style="width:70px">状态</th>
                    <th>内容</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in previewRows" :key="r.index"
                      :class="r.errors.length ? 'row-error' : (r.warnings.length ? 'row-warn' : '')">
                    <td>{{ r.index }}</td>
                    <td>
                      <span v-if="r.errors.length" class="tag danger" style="font-size:10px">错误</span>
                      <span v-else-if="r.warnings.length" class="tag warning" style="font-size:10px">提示</span>
                      <span v-else class="tag success" style="font-size:10px">可导入</span>
                    </td>
                    <td>
                      <div>{{ r.data.name || r.data.title || '(无名称)' }}
                        <span v-if="r.data.short_name" class="muted">（{{ r.data.short_name }}）</span>
                      </div>
                      <div v-for="(e, i) in r.errors" :key="'e' + i" style="color:var(--c-danger);font-size:var(--fs-xs)">
                        {{ e }}
                      </div>
                      <div v-for="(w, i) in r.warnings" :key="'w' + i" style="color:var(--c-warning);font-size:var(--fs-xs)">
                        {{ w }}
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 步骤 3 -->
          <div v-else-if="step === 3 && report">
            <div class="note" :class="report.failed ? 'warn' : ''">
              <c-icon name="check" :size="16" />
              <div style="font-size:var(--fs-sm)">
                导入完成：成功 <strong>{{ report.imported }}</strong> 条
                <span v-if="report.invalid">，校验未通过 {{ report.invalid }} 条</span>
                <span v-if="report.failed">，写入失败 {{ report.failed }} 条</span>
                <span v-if="report.dictAdded">，自动新增字典选项 {{ report.dictAdded }} 项</span>
              </div>
            </div>

            <div class="stat-grid mt-4">
              <div class="stat"><div class="n" style="color:var(--c-success)">{{ report.imported }}</div><div class="l">成功导入</div></div>
              <div class="stat"><div class="n">{{ report.invalid }}</div><div class="l">校验未通过</div></div>
              <div class="stat"><div class="n" :style="report.failed ? 'color:var(--c-danger)' : ''">{{ report.failed }}</div><div class="l">写入失败</div></div>
              <div class="stat"><div class="n">{{ report.total }}</div><div class="l">文件总行数</div></div>
            </div>

            <div v-if="report.errors && report.errors.length" class="mt-4">
              <div class="field-label" style="margin-bottom:6px">未导入明细（前 50 条）</div>
              <div class="table-wrap" style="max-height:300px;overflow:auto">
                <table class="data-table">
                  <thead><tr><th style="width:70px">行号</th><th>原因</th></tr></thead>
                  <tbody>
                    <tr v-for="(e, i) in report.errors.slice(0, 50)" :key="i">
                      <td>{{ e.index }}</td>
                      <td style="color:var(--c-danger)">{{ e.message }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="mt-4" style="display:flex;gap:8px">
              <button class="btn btn-primary" @click="resetImport">继续导入</button>
              <button class="btn" @click="$emit('imported')">刷新页面数据</button>
            </div>
          </div>
        </c-card>
      </div>`,
    emits: ['imported']
  };

  CRM.settings = CRM.settings || {};
  CRM.settings.DataPanel = DataPanel;

  /* ------------------------------------------------------------------ */
  /* Excel 导入与模板：公共实现                                          */
  /*                                                                     */
  /* 抽出来是为了让「客户管理」页也能直接用（列表页右上角有「下载模板」    */
  /* 与「批量导入」按钮），不必把整套逻辑再写一遍。                        */
  /* ------------------------------------------------------------------ */

  CRM.importXlsx = {
    ENTITIES,

    /** 生成并下载导入模板（含填写说明与可选值参考两页） */
    async downloadTemplate(entity) {
      const tpl = await CRM.api.getTemplate(entity);
      const XLSX = window.XLSX;
      if (!XLSX) throw new Error('Excel 组件未加载');

      const header = tpl.fields.map((f) => (f.required ? f.label + ' *' : f.label));
      const sample = tpl.sample;
      /* 第三行只填必填项，直观示意"最少要填哪些" */
      const minimal = tpl.fields.map((f, i) => {
        if (!f.required) return '';
        const v = sample[i];
        if (v === '' || v === undefined) return '';
        if (f.options && f.options.length && !f.options.includes(v)) return f.options[0];
        return v;
      });
      const ws = XLSX.utils.aoa_to_sheet([header, sample, minimal]);
      ws['!cols'] = tpl.fields.map((f) => ({ wch: Math.max(10, Math.min(40, f.width || 16)) }));
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, tpl.label + '导入模板');

      const notes = [
        ['填写说明'],
        [''],
        ['1. 请不要修改第一行表头文字；列顺序可以调整，多余的列会被忽略。'],
        ['2. 带 * 的列为必填项；其余列可留空。'],
        ['3. 第 2 行是完整示例，第 3 行只填了必填项——可直接照着改，也可删掉这两行再填。'],
        ['4. 「是否上市」「要求TS许可证」「主联系人」「决策人」等列填「是」或「否」；留空按「否」处理。'],
        ['5. 日期支持 2026-03-01、2026/3/1、2026年3月1日；带时间的列如「下次跟进时间」写 2026-03-01 10:00。'],
        ['6. 多值列（如常用阀门类型、认证要求）用英文或中文逗号分隔，例如：球阀,闸阀,截止阀。'],
        ['7. 数字列请只填数字，不要带单位（如年需求量填 800，不要写「800 万」）。'],
        ['8. 带下拉选项的列，请优先使用「可选值参考」页里的写法；填了列表外的词也能导入，但会在字典里新增一个选项。'],
        ['9. 「市/地区」决定客户在地图上的归属：填「克拉玛依市」「喀什地区」等标准名称即可自动归入统计；只填「市/地区」或只填「区/县」都能识别。'],
        ['10. 客户全称重复的行会被识别为重复客户，导入时可选择跳过或更新已有记录。'],
        ['11. 导入前系统会先做校验并展示预览，不会直接写入数据库。'],
        ['12. 单次最多导入 5000 行。']
      ];
      const ws2 = XLSX.utils.aoa_to_sheet(notes);
      ws2['!cols'] = [{ wch: 96 }];
      XLSX.utils.book_append_sheet(wb, ws2, '填写说明');

      const dictFields = tpl.fields.filter((f) => f.options && f.options.length);
      if (dictFields.length) {
        const ref = [['列名', '是否必填', '可选值（推荐照此填写）']];
        for (const f of dictFields) ref.push([f.label, f.required ? '必填' : '可空', f.options.join('、')]);
        ref.push([]);
        ref.push(['提示', '', '以上是系统当前已有的选项。填列表外的词会被自动加入字典，']);
        ref.push(['', '', '但同一含义尽量只用一种写法（例如统一用「终端用户」而不是「终端客户」）。']);
        const ws3 = XLSX.utils.aoa_to_sheet(ref);
        ws3['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 90 }];
        XLSX.utils.book_append_sheet(wb, ws3, '可选值参考');
      }

      XLSX.writeFile(wb, `${tpl.label}导入模板.xlsx`);
    },

    /**
     * 解析用户选择的 Excel 文件并做预校验。
     * @returns {{ok:boolean, message?:string, missing?:string[], rows?:Array, preview?:object, fileName:string}}
     */
    async parseFile(entity, file) {
      const name = (file && file.name) || '';
      if (!/\.(xlsx|xls|csv)$/i.test(name)) {
        return { ok: false, message: '请选择 .xlsx / .xls / .csv 文件', fileName: name };
      }
      const XLSX = window.XLSX;
      if (!XLSX) return { ok: false, message: 'Excel 组件未加载', fileName: name };

      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      if (!aoa.length) return { ok: false, message: '文件中没有内容', fileName: name };

      const tpl = await CRM.api.getTemplate(entity);
      const headerRow = aoa[0].map((h) => String(h || '').replace(/[*＊\s]/g, ''));
      const colMap = [];
      for (const f of tpl.fields) {
        const idx = headerRow.findIndex((h) => h === f.label);
        if (idx >= 0) colMap[idx] = f;
      }
      const missing = tpl.fields
        .filter((f) => f.required && !colMap.some((c) => c && c.key === f.key))
        .map((f) => f.label);
      if (missing.length) {
        return { ok: false, message: `缺少必填列：${missing.join('、')}，请使用下载的模板`, missing, fileName: name };
      }

      const rows = [];
      for (let i = 1; i < aoa.length; i++) {
        const line = aoa[i];
        if (!line || line.every((c) => String(c || '').trim() === '')) continue;
        const obj = {};
        for (let c = 0; c < line.length; c++) {
          const f = colMap[c];
          if (f) obj[f.key] = line[c];
        }
        rows.push(obj);
      }
      if (!rows.length) return { ok: false, message: '没有解析到数据行', fileName: name };
      if (rows.length > 5000) {
        return { ok: false, message: `文件有 ${rows.length} 行，超过单次 5000 行上限，请拆分后再导入`, fileName: name };
      }

      const preview = await CRM.api.previewImport(entity, rows);
      return { ok: true, rows, preview, missing: [], fileName: name };
    },

    /** 执行导入（只提交校验通过的行） */
    async run(entity, preview, opts) {
      const raw = (preview.rows || []).map((r) => r.data);
      return CRM.api.runImport(entity, raw, opts || {});
    }
  };

})(window.CRM);
