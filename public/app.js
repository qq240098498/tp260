/* 污染源在线监测与排污总量核算台 —— 纯原生前端
   显示纪律：除「折算后浓度（页面自算）」外，所有数字直接用接口返回值。 */
(function () {
  'use strict';

  /* ================= 常量（与后端校验口径一致） ================= */
  var METRICS = ['COD', '氨氮', '流量', '氧含量'];
  var MAIN_METRICS = ['COD', '氨氮'];
  var PLANT_STATUS = ['生产', '停产', '调试'];
  var OUTLET_STATUS = ['运行', '停用'];
  var OUTLET_TYPE = ['主要排放口', '一般排放口'];
  var DEVICE_STATUS = ['正常', '校准', '维护', '故障'];
  var FLAGS = ['有效', '无效'];
  var SOURCES = ['自动', '补录'];
  var ROW_SOURCES = ['自动', '补录', '手工替代'];
  var OUTAGE_REASONS = ['故障', '送检', '维护'];
  var REVIEW_STATUS = ['待复核', '已复核', '复核退回'];
  var REPORT_STATUS = ['草稿', '已上报', '退回'];

  /* ================= 全局状态 ================= */
  var state = {
    view: 'overview',
    today: '',
    month: '',
    settings: null,
    summary: null,
    plants: [],
    outlets: [],
    devices: [],
    reports: [],
    outages: [],
    readings: { total: 0, returned: 0, rows: [] },
    plantsFilter: { status: '', keyword: '' },
    outletsFilter: { plantId: '', status: '' },
    devicesFilter: { outletId: '', metric: '', status: '' },
    readingsFilter: { outletId: '', deviceId: '', metric: '', day: '', month: '', source: '', reviewStatus: '' },
    evidenceFilter: { outletId: '', reviewStatus: '' },
    accounting: { outletId: '', month: '', metric: 'COD' }
  };

  /* ================= 基础工具 ================= */
  function appendChildren(node, list) {
    list.forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { appendChildren(node, c); return; }
      if (typeof c === 'object' && c.nodeType) node.appendChild(c);
      else node.appendChild(document.createTextNode(String(c)));
    });
  }

  function h(tag, props) {
    var node = document.createElement(tag);
    var children = Array.prototype.slice.call(arguments, 2);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') { Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; }); }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      });
    }
    appendChildren(node, children);
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  async function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    var res = await fetch(path, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var err = (data && data.error) ? data.error : {};
      var ex = new Error(err.message || ('请求失败（HTTP ' + res.status + '）'));
      ex.code = err.code || ('HTTP_' + res.status);
      ex.details = err.details || null;
      ex.status = res.status;
      throw ex;
    }
    return data;
  }

  function qs(obj) {
    var parts = [];
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v !== '' && v !== null && v !== undefined) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? ('?' + parts.join('&')) : '';
  }

  function textOf(v) {
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
  }
  function num(v, digits) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    var d = (digits === null || digits === undefined) ? 2 : digits;
    var f = Math.pow(10, d);
    return Math.round(n * f) / f;
  }
  function fmt(v, digits) {
    var n = num(v, digits);
    return n === null ? '—' : String(n);
  }
  function metricOf(rows, name) {
    rows = rows || [];
    for (var i = 0; i < rows.length; i++) if (rows[i].metric === name) return rows[i];
    return { metric: name };
  }

  /* 折算后浓度（页面自算）：实测 × (21 − 基准氧) / (21 − 实测氧含量)，氧含量缺失按 0 代入 */
  function pageConcentration(row) {
    var base = (state.settings && state.settings.oxygenBaseline !== null && state.settings.oxygenBaseline !== undefined)
      ? Number(state.settings.oxygenBaseline) : 8;
    var oxy = (row.oxygen === null || row.oxygen === undefined || row.oxygen === '') ? 0 : Number(row.oxygen);
    var denom = 21 - oxy;
    if (!isFinite(denom) || denom === 0) return null;
    var value = Number(row.value);
    if (!isFinite(value)) return null;
    return value * (21 - base) / denom;
  }

  /* ================= 错误提示 ================= */
  var errorBanner = document.getElementById('errorBanner');
  var errorDetails = document.getElementById('errorDetails');
  function showError(e) {
    document.getElementById('errorMessage').textContent = (e && e.message) ? e.message : '操作没成功';
    clear(errorDetails);
    var details = e ? e.details : null;
    var fields = [];
    if (details && typeof details === 'object') {
      Object.keys(details).forEach(function (k) {
        fields.push(k);
        errorDetails.appendChild(h('li', { text: k + '：' + details[k] }));
      });
      errorDetails.hidden = false;
    } else if (details) {
      errorDetails.appendChild(h('li', { text: String(details) }));
      errorDetails.hidden = false;
    } else {
      errorDetails.hidden = true;
    }
    fields.forEach(function (k) {
      var input = document.querySelector('[data-field="' + k + '"]');
      if (input) input.classList.add('is-invalid');
    });
    errorBanner.hidden = false;
  }
  function clearError() {
    errorBanner.hidden = true;
    document.querySelectorAll('.is-invalid').forEach(function (n) { n.classList.remove('is-invalid'); });
  }
  document.getElementById('errorClose').addEventListener('click', clearError);

  /* ================= 轻提示 ================= */
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
  }

  /* ================= 弹层 ================= */
  var modalMask = document.getElementById('modalMask');
  function openModal(title, bodyNode, footNodes) {
    document.getElementById('modalTitle').textContent = title;
    clear(document.getElementById('modalBody')).appendChild(bodyNode);
    var foot = clear(document.getElementById('modalFoot'));
    (footNodes || []).forEach(function (n) { foot.appendChild(n); });
    modalMask.hidden = false;
  }
  function closeModal() { modalMask.hidden = true; }
  document.getElementById('modalClose').addEventListener('click', closeModal);
  modalMask.addEventListener('click', function (e) { if (e.target === modalMask) closeModal(); });

  function formField(field, value) {
    var wrap = h('div', { class: 'field' + (field.full ? ' full' : '') });
    wrap.appendChild(h('label', { text: field.label }));
    var input;
    if (field.type === 'select') {
      input = h('select', { dataset: { field: field.name } });
      (field.options || []).forEach(function (opt) {
        var val = (typeof opt === 'object') ? opt.value : opt;
        var lab = (typeof opt === 'object') ? opt.label : opt;
        input.appendChild(h('option', { value: val, text: lab }));
      });
      input.value = (value === null || value === undefined) ? '' : String(value);
    } else {
      input = h('input', { type: field.type || 'text', dataset: { field: field.name } });
      input.value = (value === null || value === undefined) ? '' : String(value);
    }
    wrap.appendChild(input);
    return wrap;
  }
  function buildForm(fields, values) {
    values = values || {};
    var grid = h('div', { class: 'form-grid' });
    fields.forEach(function (f) { grid.appendChild(formField(f, values[f.name])); });
    return grid;
  }
  function collectForm(root) {
    var out = {};
    root.querySelectorAll('[data-field]').forEach(function (n) { out[n.dataset.field] = n.value; });
    return out;
  }

  /* ================= 按钮 / 行 ================= */
  function actionBtn(label, fn, cls) {
    return h('button', {
      type: 'button',
      class: 'btn btn-sm ' + (cls || 'btn-ghost'),
      text: label,
      onclick: function (ev) { ev.stopPropagation(); fn(ev); }
    });
  }

  function deleteBtn(label, run) {
    var btn = h('button', { type: 'button', class: 'btn btn-sm btn-danger', text: label });
    var armed = false;
    var timer = null;
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!armed) {
        armed = true;
        btn.textContent = '确认删除';
        timer = setTimeout(function () { armed = false; btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer);
      armed = false;
      btn.disabled = true;
      btn.textContent = '删除中…';
      Promise.resolve().then(run).catch(function (e) {
        btn.disabled = false;
        btn.textContent = label;
        showError(e);
      });
    });
    return btn;
  }

  function actionsCell(buttons) {
    var box = h('div', { class: 'inline-actions' });
    buttons.forEach(function (b) { box.appendChild(b); });
    return h('td', { class: 'nowrap' }, box);
  }

  function expandableRow(cells, detailFactory, rowClass) {
    var tr = h('tr', { class: 'row' + (rowClass ? ' ' + rowClass : '') }, cells);
    var detailTr = null;
    tr.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.inline-actions')) return;
      if (detailTr) {
        var willShow = detailTr.hidden;
        detailTr.hidden = !willShow;
        tr.classList.toggle('is-open', willShow);
        return;
      }
      var td = h('td', { colspan: String(cells.length) }, h('span', { class: 'empty', text: '加载中…' }));
      detailTr = h('tr', { class: 'expand-row' }, td);
      tr.classList.add('is-open');
      tr.parentNode.insertBefore(detailTr, tr.nextSibling);
      Promise.resolve().then(detailFactory).then(function (node) {
        clear(td).appendChild(node);
      }).catch(function (e) {
        clear(td).appendChild(h('div', { class: 'empty', text: '明细加载失败：' + e.message }));
      });
    });
    return tr;
  }

  function sel(pairs, value, onChange) {
    var s = h('select');
    pairs.forEach(function (p) { s.appendChild(h('option', { value: p.value, text: p.label })); });
    s.value = (value === null || value === undefined) ? '' : String(value);
    if (onChange) s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }
  function optsFromList(list) {
    return [{ value: '', label: '全部' }].concat(list.map(function (x) { return { value: x, label: x }; }));
  }
  function statusTag(status, okValue) {
    var cls = status === okValue ? 'tag-ok' : (status === '退回' || status === '停产' || status === '停用' || status === '故障' ? 'tag-danger' : 'tag-warn');
    return h('span', { class: 'tag ' + cls, text: status });
  }
  function reviewTag(status) {
    if (!status) return '';
    var cls = status === '已复核' ? 'tag-ok' : (status === '待复核' ? 'tag-warn' : 'tag-danger');
    return h('span', { class: 'tag ' + cls, text: status });
  }
  function sourceTag(source) {
    var cls = source === '手工替代' ? 'tag-manual' : (source === '补录' ? 'tag-warn' : 'tag-ok');
    return h('span', { class: 'tag ' + cls, text: source });
  }
  var KIND_TEXT = { auto: '自动', manual: '手工替代', mixed: '自动+替代', gap: '缺口', stopped: '停产停用' };
  function kindTag(kind) {
    var cls = kind === 'auto' ? 'tag-ok' : (kind === 'gap' ? 'tag-danger' : (kind === 'stopped' ? 'tag-warn' : 'tag-manual'));
    return h('span', { class: 'tag ' + cls, text: KIND_TEXT[kind] || kind });
  }

  /* ================= 数据加载 ================= */
  async function loadAll() {
    var res = await Promise.all([
      api('GET', '/api/summary'),
      api('GET', '/api/settings'),
      api('GET', '/api/plants'),
      api('GET', '/api/outlets'),
      api('GET', '/api/devices'),
      api('GET', '/api/readings'),
      api('GET', '/api/reports'),
      api('GET', '/api/outages')
    ]);
    state.summary = res[0];
    state.settings = res[1];
    state.plants = res[2];
    state.outlets = res[3];
    state.devices = res[4];
    state.readings = res[5];
    state.reports = res[6];
    state.outages = res[7];
    state.today = state.summary.today;
    state.month = state.summary.month;
    if (!state.accounting.outletId && state.outlets.length) state.accounting.outletId = state.outlets[0].id;
    state.accounting.month = state.month;
  }

  async function reloadCore() {
    var res = await Promise.all([
      api('GET', '/api/plants'),
      api('GET', '/api/outlets'),
      api('GET', '/api/devices'),
      api('GET', '/api/reports'),
      api('GET', '/api/summary'),
      api('GET', '/api/outages')
    ]);
    state.plants = res[0];
    state.outlets = res[1];
    state.devices = res[2];
    state.reports = res[3];
    state.summary = res[4];
    state.outages = res[5];
  }

  function afterMutation(msg) {
    return reloadCore().then(function () {
      toast(msg);
      switchView(state.view);
    }).catch(showError);
  }

  /* ================= 视图切换 ================= */
  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('is-active', t.dataset.view === view); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('is-active', v.dataset.view === view); });
    clearError();
    if (view === 'overview') renderOverview();
    else if (view === 'plants') renderPlants();
    else if (view === 'devices') renderDevices();
    else if (view === 'readings') renderReadings();
    else if (view === 'evidence') renderEvidence();
    else if (view === 'accounting') renderAccounting();
  }

  /* ================= 概览 ================= */
  function metricCard(title, main, foot, targetView) {
    return h('button', {
      type: 'button', class: 'metric-card',
      onclick: function () { switchView(targetView); }
    }, [
      h('div', { class: 'm-title', text: title }),
      h('div', { class: 'm-main', text: String(main) }),
      h('div', { class: 'm-foot', text: foot })
    ]);
  }

  function renderOverview() {
    var f = clear(document.getElementById('filters-overview'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '概览' }),
      h('p', { class: 'hint', text: '本页所有数字均直接取 /api/summary 的返回字段，前端不做计算。' })
    ]));

    var c = clear(document.getElementById('content-overview'));
    var s = state.summary;
    if (!s) { c.appendChild(h('div', { class: 'empty', text: '概览数据还没加载好' })); return; }

    var ds = s.deviceStatus || {};
    var dsText = Object.keys(ds).map(function (k) { return k + ' ' + ds[k] + ' 台'; }).join('、') || '暂无设备';

    c.appendChild(h('div', { class: 'metric-grid' }, [
      metricCard('排污单位', s.plantCount, '生产中 ' + s.producingCount + ' 家', 'plants'),
      metricCard('排放口', s.outletCount, '运行中 ' + s.runningOutletCount + ' 个', 'plants'),
      metricCard('在线设备', s.deviceCount, dsText, 'devices'),
      metricCard('监测数据', s.readingCount, '自动 ' + s.autoCount + ' · 补录 ' + s.imputedCount + ' · 手工替代 ' + (s.manualCount || 0) + '（待复核 ' + (s.manualPendingCount || 0) + '）· 无效 ' + s.invalidFlagCount, 'readings'),
      metricCard('替代取证', (s.outageCount || 0) + ' 段', '已复核手工记录 ' + (s.manualCount || 0) + ' 条 · 待复核 ' + (s.manualPendingCount || 0) + ' 条', 'evidence'),
      metricCard('报表', s.reportCount, '已上报 ' + s.submittedReportCount + ' 张', 'accounting'),
      metricCard('超标排放口', s.exceededOutletCount, '存在月超标判定', 'accounting'),
      metricCard('年累计 COD', s.accumulatedCodTons + ' 吨', '其中替代 ' + (s.accumulatedCodManualTons || 0) + ' 吨 · 年许可量 ' + s.permitCodTons + ' 吨', 'accounting'),
      metricCard('年累计氨氮', s.accumulatedAmmoniaTons + ' 吨', '其中替代 ' + (s.accumulatedAmmoniaManualTons || 0) + ' 吨 · 年许可量 ' + s.permitAmmoniaTons + ' 吨', 'accounting')
    ]));

    var tb = h('tbody');
    (s.outlets || []).forEach(function (o) {
      var cod = metricOf(o.rows, 'COD');
      var amm = metricOf(o.rows, '氨氮');
      var tr = h('tr', { class: 'row', title: '点此行到「核算与报表」查看该排放口' }, [
        h('td', {}, [h('b', { text: o.code }), ' ', o.name]),
        h('td', { text: textOf(o.plantName) }),
        h('td', { text: textOf(o.type) }),
        h('td', {}, statusTag(o.status, '运行')),
        h('td', { class: 'mono', text: fmt(cod.monthAverage) }),
        h('td', { class: 'mono' }, [
          h('div', { text: fmt(cod.monthTotalTons, 4) }),
          h('div', { class: 'cell-sub' + (Number(cod.monthManualTons) > 0 ? ' num-warn' : ''), text: '自动 ' + fmt(cod.monthAutoTons, 4) + ' / 替代 ' + fmt(cod.monthManualTons, 4) })
        ]),
        h('td', { class: 'mono' + (Number(cod.gapDays) > 0 ? ' num-danger' : ''), title: '本月缺口天数', text: textOf(cod.gapDays) }),
        h('td', { class: 'mono' + (Number(cod.exceedDaysCount) > 0 ? ' num-danger' : ''), text: textOf(cod.exceedDaysCount) }),
        h('td', { class: 'mono', text: textOf(cod.exceedHours) }),
        h('td', { class: 'mono', text: fmt(amm.monthAverage) }),
        h('td', { class: 'mono' }, [
          h('div', { text: fmt(amm.monthTotalTons, 4) }),
          h('div', { class: 'cell-sub' + (Number(amm.monthManualTons) > 0 ? ' num-warn' : ''), text: '自动 ' + fmt(amm.monthAutoTons, 4) + ' / 替代 ' + fmt(amm.monthManualTons, 4) })
        ]),
        h('td', { class: 'mono' + (Number(amm.gapDays) > 0 ? ' num-danger' : ''), title: '本月缺口天数', text: textOf(amm.gapDays) }),
        h('td', { class: 'mono' + (Number(amm.exceedDaysCount) > 0 ? ' num-danger' : ''), text: textOf(amm.exceedDaysCount) }),
        h('td', { class: 'mono', text: textOf(amm.exceedHours) })
      ]);
      tr.addEventListener('click', function () {
        state.accounting.outletId = o.id;
        state.accounting.month = s.month || state.month;
        switchView('accounting');
      });
      tb.appendChild(tr);
    });

    var table = h('table', { id: 'tableOverviewOutlet' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '排放口' }), h('th', { text: '所属单位' }), h('th', { text: '类型' }), h('th', { text: '状态' }),
        h('th', { text: 'COD 月均' }), h('th', { text: 'COD 月总量(吨)（自动/替代）' }), h('th', { text: 'COD 缺口天数' }), h('th', { text: 'COD 超标天数' }), h('th', { text: 'COD 超标小时' }),
        h('th', { text: '氨氮 月均' }), h('th', { text: '氨氮 月总量(吨)（自动/替代）' }), h('th', { text: '氨氮 缺口天数' }), h('th', { text: '氨氮 超标天数' }), h('th', { text: '氨氮 超标小时' })
      ])),
      tb
    ]);

    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '本月各排放口 COD / 氨氮 情况' }),
        h('span', { class: 'sub', text: '月份 ' + s.month + '（点行跳到核算页并选中该排放口）' })
      ]),
      h('div', { class: 'table-wrap' }, table)
    ]));
  }

  /* ================= 单位与排放口 ================= */
  function plantDetailNode(id) {
    return api('GET', '/api/plants/' + id).then(function (d) {
      var box = h('div', { class: 'detail-grid' });
      var og = h('div', { class: 'detail-block' });
      og.appendChild(h('h3', { text: '排放口清单（' + ((d.outlets || []).length) + '）' }));
      if (!d.outlets || !d.outlets.length) og.appendChild(h('div', { class: 'empty', text: '暂无排放口' }));
      else {
        var tb = h('tbody');
        d.outlets.forEach(function (o) {
          tb.appendChild(h('tr', { class: 'row' }, [
            h('td', { text: o.code }), h('td', { text: o.name }), h('td', { text: o.type }),
            h('td', {}, statusTag(o.status, '运行')),
            h('td', { class: 'mono', text: textOf(o.deviceCount) }), h('td', { class: 'mono', text: textOf(o.readingCount) })
          ]));
        });
        og.appendChild(h('table', {}, [h('thead', {}, h('tr', {}, [
          h('th', { text: '编码' }), h('th', { text: '名称' }), h('th', { text: '类型' }), h('th', { text: '状态' }),
          h('th', { text: '设备数' }), h('th', { text: '数据条数' })
        ])), tb]));
      }
      box.appendChild(og);

      var rg = h('div', { class: 'detail-block' });
      rg.appendChild(h('h3', { text: '报表（' + ((d.reports || []).length) + '）' }));
      if (!d.reports || !d.reports.length) rg.appendChild(h('div', { class: 'empty', text: '暂无报表' }));
      else {
        var tb2 = h('tbody');
        d.reports.forEach(function (r) {
          tb2.appendChild(h('tr', { class: 'row' }, [
            h('td', { text: r.period }), h('td', {}, statusTag(r.status, '已上报')),
            h('td', { text: textOf(r.submittedAt) }), h('td', { text: textOf(r.submittedBy) })
          ]));
        });
        rg.appendChild(h('table', {}, [h('thead', {}, h('tr', {}, [
          h('th', { text: '期间' }), h('th', { text: '状态' }), h('th', { text: '上报时刻' }), h('th', { text: '上报人' })
        ])), tb2]));
      }
      box.appendChild(rg);
      return box;
    });
  }

  function plantRow(p) {
    var actions = actionsCell([
      actionBtn('修改', function () { openPlantForm(p); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/plants/' + p.id).then(function () { return afterMutation('已删除单位 ' + p.code); });
      })
    ]);
    return expandableRow([
      h('td', {}, h('b', { text: p.code })),
      h('td', { text: p.name }),
      h('td', { text: textOf(p.industry) }),
      h('td', {}, statusTag(p.status, '生产')),
      h('td', { text: textOf(p.permitNo) }),
      h('td', { class: 'mono', text: textOf(p.outletCount) }),
      h('td', { class: 'mono', text: textOf(p.deviceCount) }),
      h('td', { class: 'mono', text: textOf(p.readingCount) }),
      h('td', { class: 'mono', text: textOf(p.reportCount) }),
      actions
    ], function () { return plantDetailNode(p.id); });
  }

  function outletRow(o) {
    var actions = actionsCell([
      actionBtn('修改', function () { openOutletForm(o); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/outlets/' + o.id).then(function () { return afterMutation('已删除排放口 ' + o.code); });
      })
    ]);
    return expandableRow([
      h('td', {}, h('b', { text: o.code })),
      h('td', { text: textOf(o.name) }),
      h('td', { text: textOf(o.plantCode + ' ' + o.plantName).trim() || '—' }),
      h('td', { text: textOf(o.type) }),
      h('td', {}, statusTag(o.status, '运行')),
      h('td', { class: 'mono', text: textOf(o.deviceCount) }),
      h('td', { class: 'mono', text: textOf(o.readingCount) }),
      actions
    ], function () {
      var box = h('div', { class: 'detail-grid' });
      box.appendChild(h('div', { class: 'detail-block' }, [
        h('h3', { text: '备注' }),
        h('div', { text: textOf(o.remark) })
      ]));
      var devs = state.devices.filter(function (d) { return d.outletId === o.id; });
      var db = h('div', { class: 'detail-block' });
      db.appendChild(h('h3', { text: '设备（' + devs.length + '）' }));
      if (!devs.length) db.appendChild(h('div', { class: 'empty', text: '暂无设备' }));
      else {
        var tb = h('tbody');
        devs.forEach(function (d) {
          tb.appendChild(h('tr', { class: 'row' }, [
            h('td', { text: d.code }), h('td', { text: d.metric }), h('td', {}, statusTag(d.status, '正常')),
            h('td', { text: textOf(d.calibratedUntil) })
          ]));
        });
        db.appendChild(h('table', {}, [h('thead', {}, h('tr', {}, [
          h('th', { text: '编号' }), h('th', { text: '指标' }), h('th', { text: '状态' }), h('th', { text: '校准有效期' })
        ])), tb]));
      }
      box.appendChild(db);
      return box;
    });
  }

  async function renderPlants() {
    var f = clear(document.getElementById('filters-plants'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '排污单位' }),
      h('div', { class: 'field' }, [h('label', { text: '状态' }),
        sel(optsFromList(PLANT_STATUS), state.plantsFilter.status, function (v) { state.plantsFilter.status = v; renderPlants(); })]),
      (function () {
        var kw = h('input', { type: 'text', placeholder: '编码/名称/行业' });
        kw.value = state.plantsFilter.keyword;
        kw.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.plantsFilter.keyword = kw.value.trim(); renderPlants(); } });
        return h('div', { class: 'field' }, [h('label', { text: '关键字' }), kw, h('div', { class: 'hint', text: '回车应用（走接口筛选）' })]);
      })()
    ]));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '排放口' }),
      h('div', { class: 'field' }, [h('label', { text: '所属单位' }),
        sel([{ value: '', label: '全部单位' }].concat(state.plants.map(function (p) { return { value: p.id, label: p.code + ' ' + p.name }; })),
          state.outletsFilter.plantId, function (v) { state.outletsFilter.plantId = v; renderPlants(); })]),
      h('div', { class: 'field' }, [h('label', { text: '状态' }),
        sel(optsFromList(OUTLET_STATUS), state.outletsFilter.status, function (v) { state.outletsFilter.status = v; renderPlants(); })])
    ]));

    var c = clear(document.getElementById('content-plants'));
    var plantsRes, outletsRes;
    try {
      plantsRes = await api('GET', '/api/plants' + qs(state.plantsFilter));
      outletsRes = await api('GET', '/api/outlets' + qs(state.outletsFilter));
    } catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }

    var unitTb = h('tbody');
    plantsRes.forEach(function (p) { unitTb.appendChild(plantRow(p)); });
    var unitTable = h('table', { id: 'tableUnits' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '编码' }), h('th', { text: '名称' }), h('th', { text: '行业' }), h('th', { text: '状态' }),
        h('th', { text: '许可证号' }), h('th', { text: '排放口数' }), h('th', { text: '设备数' }),
        h('th', { text: '数据条数' }), h('th', { text: '报表数' }), h('th', { text: '操作' })
      ])),
      unitTb
    ]);
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '排污单位台账' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + plantsRes.length + ' 家（点行展开排放口与报表）' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增单位', onclick: function () { openPlantForm(null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, unitTable)
    ]));

    var outletTb = h('tbody');
    outletsRes.forEach(function (o) { outletTb.appendChild(outletRow(o)); });
    var outletTable = h('table', { id: 'tableOutlets' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '编码' }), h('th', { text: '名称' }), h('th', { text: '所属单位' }), h('th', { text: '类型' }),
        h('th', { text: '状态' }), h('th', { text: '设备数' }), h('th', { text: '数据条数' }), h('th', { text: '操作' })
      ])),
      outletTb
    ]);
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '排放口台账' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + outletsRes.length + ' 个' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增排放口', onclick: function () { openOutletForm(null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, outletTable)
    ]));
  }

  function openPlantForm(plant) {
    var fields = [
      { name: 'code', label: '编码' },
      { name: 'name', label: '名称' },
      { name: 'industry', label: '行业' },
      { name: 'status', label: '状态', type: 'select', options: PLANT_STATUS },
      { name: 'permitNo', label: '排污许可证号' },
      { name: 'permitYearStart', label: '许可年起始日（YYYY-MM-DD）' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, plant || { status: '生产', permitYearStart: (state.settings && state.settings.permitYearStart) || '2026-01-01' });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      var p = plant ? api('PATCH', '/api/plants/' + plant.id, payload) : api('POST', '/api/plants', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(plant ? '单位已修改' : '单位已新增'); }).catch(showError);
    });
    openModal(plant ? '修改排污单位' : '新增排污单位', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  function openOutletForm(outlet) {
    var fields = [
      { name: 'code', label: '编码' },
      { name: 'name', label: '名称' },
      { name: 'plantId', label: '所属单位', type: 'select', options: state.plants.map(function (p) { return { value: p.id, label: p.code + ' ' + p.name }; }) },
      { name: 'type', label: '类型', type: 'select', options: OUTLET_TYPE },
      { name: 'status', label: '状态', type: 'select', options: OUTLET_STATUS },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, outlet || { type: '主要排放口', status: '运行', plantId: state.plants.length ? state.plants[0].id : '' });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      var p = outlet ? api('PATCH', '/api/outlets/' + outlet.id, payload) : api('POST', '/api/outlets', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(outlet ? '排放口已修改' : '排放口已新增'); }).catch(showError);
    });
    openModal(outlet ? '修改排放口' : '新增排放口', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 在线设备 ================= */
  function deviceRow(d) {
    var actions = actionsCell([
      actionBtn('修改', function () { openDeviceForm(d); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/devices/' + d.id).then(function () { return afterMutation('已删除设备 ' + d.code); });
      })
    ]);
    var outlet = state.outlets.filter(function (o) { return o.id === d.outletId; })[0];
    return expandableRow([
      h('td', {}, h('b', { text: d.code })),
      h('td', { text: outlet ? (outlet.code + ' ' + outlet.name) : textOf(d.outletCode) }),
      h('td', { text: d.metric }),
      h('td', { text: textOf(d.model) }),
      h('td', {}, statusTag(d.status, '正常')),
      h('td', { text: textOf(d.calibratedUntil) }),
      h('td', { class: 'mono', text: textOf(d.readingCount) }),
      h('td', { class: 'mono' + (Number(d.invalidCount) > 0 ? ' num-danger' : ''), text: textOf(d.invalidCount) }),
      actions
    ], function () {
      return h('div', { class: 'detail-grid' }, [
        h('div', { class: 'detail-block' }, [h('h3', { text: '设备 ID' }), h('div', { text: d.id })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '备注' }), h('div', { text: textOf(d.remark) })])
      ]);
    });
  }

  async function renderDevices() {
    var f = clear(document.getElementById('filters-devices'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '设备筛选' }),
      h('div', { class: 'field' }, [h('label', { text: '所属排放口' }),
        sel([{ value: '', label: '全部排放口' }].concat(state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; })),
          state.devicesFilter.outletId, function (v) { state.devicesFilter.outletId = v; renderDevices(); })]),
      h('div', { class: 'field' }, [h('label', { text: '监测指标' }),
        sel(optsFromList(METRICS), state.devicesFilter.metric, function (v) { state.devicesFilter.metric = v; renderDevices(); })]),
      h('div', { class: 'field' }, [h('label', { text: '设备状态' }),
        sel(optsFromList(DEVICE_STATUS), state.devicesFilter.status, function (v) { state.devicesFilter.status = v; renderDevices(); })])
    ]));

    var c = clear(document.getElementById('content-devices'));
    var list;
    try { list = await api('GET', '/api/devices' + qs(state.devicesFilter)); }
    catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }

    var tb = h('tbody');
    list.forEach(function (d) { tb.appendChild(deviceRow(d)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '在线设备台账' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + list.length + ' 台' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增设备', onclick: function () { openDeviceForm(null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, h('table', { id: 'tableDevices' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '编号' }), h('th', { text: '所属排放口' }), h('th', { text: '指标' }), h('th', { text: '型号' }),
          h('th', { text: '状态' }), h('th', { text: '校准有效期' }), h('th', { text: '数据条数' }),
          h('th', { text: '无效标记条数' }), h('th', { text: '操作' })
        ])),
        tb
      ]))
    ]));
  }

  function openDeviceForm(device) {
    var fields = [
      { name: 'code', label: '设备编号' },
      { name: 'outletId', label: '所属排放口', type: 'select', options: state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; }) },
      { name: 'metric', label: '监测指标', type: 'select', options: METRICS },
      { name: 'model', label: '型号' },
      { name: 'status', label: '设备状态', type: 'select', options: DEVICE_STATUS },
      { name: 'calibratedUntil', label: '校准有效期（YYYY-MM-DD）' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, device || { status: '正常', metric: 'COD', outletId: state.outlets.length ? state.outlets[0].id : '' });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      var p = device ? api('PATCH', '/api/devices/' + device.id, payload) : api('POST', '/api/devices', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(device ? '设备已修改' : '设备已新增'); }).catch(showError);
    });
    openModal(device ? '修改设备' : '新增设备', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 监测数据 ================= */
  function readingRow(r) {
    var pc = pageConcentration(r);
    var isManual = r.rowKind === 'manual';
    var buttons = isManual ? [
      actionBtn(r.reviewStatus === '已复核' ? '退回复核' : '复核', function () {
        openReviewForm(r, r.reviewStatus === '已复核' ? 'reject' : 'approve');
      })
    ] : [
      actionBtn('修改', function () { openReadingForm(r); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/readings/' + r.id).then(function () { return afterMutation('已删除监测数据 ' + r.id); });
      })
    ];
    if (isManual && r.reviewStatus !== '已复核') {
      buttons.push(deleteBtn('删除', function () {
        return api('DELETE', '/api/manual-records/' + r.id).then(function () { return afterMutation('已删除手工记录 ' + r.id); });
      }));
    }
    var actions = actionsCell(buttons);
    var detail;
    if (isManual) {
      detail = h('div', { class: 'detail-grid' }, [
        h('div', { class: 'detail-block' }, [h('h3', { text: '监测方法（含标准号）' }), h('div', { text: r.method })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '检出限 / 结果单位' }), h('div', { text: textOf(r.detectLimit) + ' ' + textOf(r.resultUnit) })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '监测单位' }), h('div', { text: textOf(r.labName) })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '报告/原始记录编号' }), h('div', { text: textOf(r.evidenceNo) })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '采样人' }), h('div', { text: textOf(r.sampledBy) })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '复核人 / 复核时刻' }), h('div', { text: textOf(r.reviewedBy) + (r.reviewedAt ? ' · ' + r.reviewedAt : '') })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '登记人 / 登记时刻' }), h('div', { text: textOf(r.registeredBy) + (r.registeredAt ? ' · ' + r.registeredAt : '') })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '设备时段依据' }), h('div', { text: r.outageReason ? (r.outageReason + '时段（' + r.outageId + '）') : '采样时刻不在登记时段内' })])
      ]);
    } else {
      detail = h('div', { class: 'detail-grid' }, [
        h('div', { class: 'detail-block' }, [h('h3', { text: '数据 ID' }), h('div', { text: r.id })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '设备状态' }), h('div', { text: textOf(r.deviceStatus) })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '备注' }), h('div', { text: textOf(r.remark) })])
      ]);
    }
    return expandableRow([
      h('td', { text: textOf(r.outletCode) }),
      h('td', { text: textOf(r.deviceCode) }),
      h('td', { text: r.metric }),
      h('td', { class: 'nowrap' + (isManual ? ' cell-manual' : ''), text: r.at }),
      h('td', { class: 'mono', text: textOf(r.value) }),
      h('td', isManual ? kindTag('manual') : h('span', { class: 'tag ' + (r.flag === '有效' ? 'tag-ok' : 'tag-danger'), text: r.flag })),
      h('td', {}, sourceTag(r.source)),
      h('td', isManual ? reviewTag(r.reviewStatus) : h('span', { text: textOf(r.operator) })),
      h('td', {}, h('span', { class: 'tag ' + (r.counted ? 'tag-ok' : 'tag-danger'), text: r.counted ? '计入' : (isManual && r.reviewStatus === '待复核' ? '待复核·不计' : '不计入') })),
      h('td', { class: 'mono cell-page-conc', dataset: { value: pc === null ? '' : String(pc) }, text: pc === null ? '—' : fmt(pc, 2) }),
      h('td', { class: 'mono cell-api-conc', dataset: { value: (r.concentration === null || r.concentration === undefined) ? '' : String(r.concentration) }, text: textOf(r.concentration) }),
      h('td', { class: 'mono', text: textOf(r.oxygen) }),
      h('td', { class: 'mono', text: textOf(r.flow) }),
      actions
    ], function () { return detail; });
  }

  async function renderReadings() {
    var f = clear(document.getElementById('filters-readings'));
    var outletSel = sel([{ value: '', label: '全部排放口' }].concat(state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; })),
      state.readingsFilter.outletId, function (v) {
        state.readingsFilter.outletId = v;
        if (v && state.readingsFilter.deviceId) {
          var ok = state.devices.some(function (d) { return d.id === state.readingsFilter.deviceId && d.outletId === v; });
          if (!ok) state.readingsFilter.deviceId = '';
        }
        renderReadings();
      });
    var devPool = state.readingsFilter.outletId
      ? state.devices.filter(function (d) { return d.outletId === state.readingsFilter.outletId; })
      : state.devices;
    var deviceSel = sel([{ value: '', label: '全部设备' }].concat(devPool.map(function (d) { return { value: d.id, label: d.code }; })),
      state.readingsFilter.deviceId, function (v) { state.readingsFilter.deviceId = v; renderReadings(); });
    var metricSel = sel(optsFromList(METRICS), state.readingsFilter.metric, function (v) { state.readingsFilter.metric = v; renderReadings(); });
    var sourceSel = sel([{ value: '', label: '全部来源' }].concat(ROW_SOURCES.map(function (x) { return { value: x, label: x }; })),
      state.readingsFilter.source, function (v) { state.readingsFilter.source = v; renderReadings(); });
    var reviewSel = sel([{ value: '', label: '复核状态不限' }].concat(REVIEW_STATUS.map(function (x) { return { value: x, label: x }; })),
      state.readingsFilter.reviewStatus, function (v) { state.readingsFilter.reviewStatus = v; renderReadings(); });
    var dayInput = h('input', { type: 'date' });
    dayInput.value = state.readingsFilter.day;
    dayInput.addEventListener('change', function () { state.readingsFilter.day = dayInput.value; renderReadings(); });
    var monthInput = h('input', { type: 'month' });
    monthInput.value = state.readingsFilter.month;
    monthInput.addEventListener('change', function () { state.readingsFilter.month = monthInput.value; renderReadings(); });

    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '监测数据筛选' }),
      h('div', { class: 'field' }, [h('label', { text: '排放口' }), outletSel]),
      h('div', { class: 'field' }, [h('label', { text: '设备' }), deviceSel]),
      h('div', { class: 'field' }, [h('label', { text: '指标' }), metricSel]),
      h('div', { class: 'field' }, [h('label', { text: '来源' }), sourceSel]),
      h('div', { class: 'field' }, [h('label', { text: '复核状态（手工）' }), reviewSel]),
      h('div', { class: 'field' }, [h('label', { text: '日期' }), dayInput]),
      h('div', { class: 'field' }, [h('label', { text: '月份' }), monthInput]),
      h('div', { class: 'field' }, [h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: '清空筛选', onclick: function () {
        state.readingsFilter = { outletId: '', deviceId: '', metric: '', day: '', month: '', source: '', reviewStatus: '' };
        renderReadings();
      } })])
    ]));

    var c = clear(document.getElementById('content-readings'));
    var data;
    try { data = await api('GET', '/api/readings' + qs(state.readingsFilter)); }
    catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }
    state.readings = data;

    var tb = h('tbody');
    (data.rows || []).forEach(function (r) { tb.appendChild(readingRow(r)); });

    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '小时值清单（自动读数与手工替代同清单区分）' }),
        h('div', { class: 'btn-row' }, [
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: '登记手工替代数据', onclick: function () { switchView('evidence'); } }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增自动读数', onclick: function () { openReadingForm(null); } })
        ])
      ]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'section-note' }, [
          '共 ', h('b', { text: String(data.total) }), ' 条，已显示 ', h('b', { text: String(data.returned) }), ' 条，其中自动/补录 ', h('b', { text: String(data.autoCount) }), ' 条、手工替代 ', h('b', { class: 'num-warn', text: String(data.manualCount) }), ' 条（数字取自接口 total/returned/autoCount/manualCount）。'
        ]),
        h('div', { class: 'section-note' }, [
          '手工替代行底色标出并显示采样时刻、监测方法、检出限、监测单位与复核状态；待复核记录显示「待复核·不计」，不参与平均与总量。'
        ]),
        h('div', { class: 'table-wrap' }, h('table', { id: 'tableReadings' }, [
          h('thead', {}, h('tr', {}, [
            h('th', { text: '排放口' }), h('th', { text: '设备' }), h('th', { text: '指标' }), h('th', { text: '采样/读数时刻' }),
            h('th', { text: '数值' }), h('th', { text: '标记/类别' }), h('th', { text: '来源' }), h('th', { text: '登记人/复核' }),
            h('th', { text: '是否计入' }), h('th', { text: '折算后浓度（页面自算）' }), h('th', { text: '接口折算浓度' }),
            h('th', { text: '当时氧含量' }), h('th', { text: '当时流量' }), h('th', { text: '操作' })
          ])),
          tb
        ]))
      ])
    ]));
  }

  function openReadingForm(reading) {
    var fields = [
      { name: 'outletId', label: '排放口', type: 'select', options: state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; }) },
      { name: 'deviceId', label: '设备', type: 'select', options: state.devices.map(function (d) { return { value: d.id, label: d.code + '（' + d.metric + '）' }; }) },
      { name: 'metric', label: '指标', type: 'select', options: METRICS },
      { name: 'at', label: '时刻（YYYY-MM-DD HH:00:00）' },
      { name: 'value', label: '数值', type: 'number' },
      { name: 'flag', label: '标记', type: 'select', options: FLAGS },
      { name: 'source', label: '来源', type: 'select', options: SOURCES },
      { name: 'operator', label: '登记人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var defaults = reading || {
      outletId: state.outlets.length ? state.outlets[0].id : '',
      deviceId: state.devices.length ? state.devices[0].id : '',
      metric: 'COD', at: (state.month || '2026-09') + '-01 08:00:00', value: '', flag: '有效', source: '自动', operator: '', remark: ''
    };
    var form = buildForm(fields, defaults);
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var raw = collectForm(form);
      var payload = {
        at: raw.at, flag: raw.flag, source: raw.source, remark: raw.remark,
        value: raw.value === '' ? undefined : Number(raw.value)
      };
      if (!reading) {
        payload.outletId = raw.outletId;
        payload.deviceId = raw.deviceId;
        payload.metric = raw.metric;
        payload.operator = raw.operator;
      } else {
        payload.operator = undefined;
      }
      if (payload.value === undefined) delete payload.value;
      if (payload.operator === undefined) delete payload.operator;
      var p = reading ? api('PATCH', '/api/readings/' + reading.id, payload) : api('POST', '/api/readings', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(reading ? '监测数据已修改' : '监测数据已新增'); }).catch(showError);
    });
    openModal(reading ? '修改监测数据' : '新增监测数据', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 替代取证：设备时段登记 + 手工监测记录 ================= */
  var MANUAL_METHODS = {
    COD: '重铬酸盐法（HJ 828-2017）',
    氨氮: '纳氏试剂分光光度法（HJ 535-2009）'
  };

  function outageRow(o) {
    var actions = actionsCell([
      actionBtn('登记手工数据', function () { openManualForm(null, o); }),
      actionBtn('修改', function () { openOutageForm(o); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/outages/' + o.id).then(function () { afterMutation('已删除时段 ' + o.id); });
      })
    ]);
    return h('tr', { class: 'row' }, [
      h('td', {}, h('b', { text: o.deviceCode })),
      h('td', { text: textOf(o.outletCode) + ' ' + textOf(o.outletName) }),
      h('td', { text: textOf(o.metric) }),
      h('td', {}, h('span', { class: 'tag ' + (o.reason === '故障' ? 'tag-danger' : 'tag-warn'), text: o.reason })),
      h('td', { class: 'nowrap', text: o.startAt }),
      h('td', { class: 'nowrap', text: o.endAt }),
      h('td', { class: 'mono', text: String(o.manualCount) }),
      h('td', { class: 'mono' + (o.pendingCount > 0 ? ' num-danger' : ''), text: String(o.pendingCount) }),
      h('td', { text: textOf(o.registeredBy) }),
      actions
    ]);
  }

  function manualRow(r) {
    var reviewBtn = r.reviewStatus === '已复核'
      ? actionBtn('退回复核', function () { openReviewForm(r, 'reject'); })
      : actionBtn('复核通过', function () { openReviewForm(r, 'approve'); });
    var buttons = [reviewBtn];
    if (r.reviewStatus !== '已复核') {
      buttons.push(actionBtn('修改', function () { openManualForm(r, null); }));
      buttons.push(deleteBtn('删除', function () {
        return api('DELETE', '/api/manual-records/' + r.id).then(function () { afterMutation('已删除手工记录 ' + r.id); });
      }));
    }
    return h('tr', { class: 'row row-manual' }, [
      h('td', { text: textOf(r.outletCode) }),
      h('td', { text: textOf(r.deviceCode) }),
      h('td', { text: r.metric }),
      h('td', { class: 'nowrap cell-manual', text: r.at }),
      h('td', { class: 'mono', text: textOf(r.value) }),
      h('td', { class: 'nowrap', text: r.method }),
      h('td', { class: 'mono', text: textOf(r.detectLimit) }),
      h('td', { text: r.resultUnit }),
      h('td', { text: textOf(r.labName) }),
      h('td', { text: textOf(r.evidenceNo) }),
      h('td', { text: textOf(r.sampledBy) }),
      h('td', {}, reviewTag(r.reviewStatus)),
      h('td', { text: textOf(r.reviewedBy) }),
      actionsCell(buttons)
    ]);
  }

  async function renderEvidence() {
    var st = state.settings || {};
    var f = clear(document.getElementById('filters-evidence'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '替代取证' }),
      h('div', { class: 'field' }, [h('label', { text: '排放口' }),
        sel([{ value: '', label: '全部排放口' }].concat(state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; })),
          state.evidenceFilter.outletId, function (v) { state.evidenceFilter.outletId = v; renderEvidence(); })]),
      h('div', { class: 'field' }, [h('label', { text: '手工记录复核状态' }),
        sel([{ value: '', label: '全部' }].concat(REVIEW_STATUS.map(function (x) { return { value: x, label: x }; })),
          state.evidenceFilter.reviewStatus, function (v) { state.evidenceFilter.reviewStatus = v; renderEvidence(); })])
    ]));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '替代口径（边界）' }),
      h('p', { class: 'hint' }, [
        '每日至少有效 ', h('b', { text: String(st.validHoursPerDay) }), ' 小时；',
        '替代日手工监测每日不少于 ', h('b', { text: String(st.manualMinSamplesPerDay) }), ' 次；',
        '一次故障/送检连续替代不超过 ', h('b', { text: String(st.manualMaxConsecutiveDays) }), ' 天；',
        '替代覆盖不超过当月应测小时 ', h('b', { text: String(st.manualMaxCoveragePercent) }), '%；',
        '流量优先用在线实测，缺失按故障前 ', h('b', { text: String(st.manualFlowLookbackDays) }), ' 日日均推算。超出边界的时段按缺口显式标出。'
      ])
    ]));

    var c = clear(document.getElementById('content-evidence'));
    var outageList, manualList;
    try {
      var q = { outletId: state.evidenceFilter.outletId };
      var out = await Promise.all([
        api('GET', '/api/outages' + qs(q)),
        api('GET', '/api/manual-records' + qs(Object.assign({}, q, { reviewStatus: state.evidenceFilter.reviewStatus })))
      ]);
      outageList = out[0]; manualList = out[1];
    } catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }

    var pending = manualList.filter(function (r) { return r.reviewStatus === '待复核'; }).length;
    c.appendChild(h('div', { class: 'banner banner-warn' }, [
      h('b', { text: '登记纪律：' }),
      '手工监测数据只能在已登记的设备故障/送检时段内登记，必须填采样时刻、监测方法（含标准号）、检出限、结果单位、监测单位、报告/原始记录编号、采样人与登记人；',
      '缺依据的记录接口直接拒绝入账。记录须经采样人以外的复核人复核通过后才作为等效值参与平均与总量；',
      '当前筛选范围待复核 ', h('b', { class: 'num-danger', text: String(pending) }), ' 条。'
    ]));

    var otTb = h('tbody');
    outageList.forEach(function (o) { otTb.appendChild(outageRow(o)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '设备故障 / 送检时段登记' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + outageList.length + ' 段（替代取证的前提依据）' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '登记时段', onclick: function () { openOutageForm(null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, h('table', {}, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '设备' }), h('th', { text: '排放口' }), h('th', { text: '指标' }), h('th', { text: '原因' }),
          h('th', { text: '开始时刻' }), h('th', { text: '结束时刻' }), h('th', { text: '手工记录' }), h('th', { text: '待复核' }),
          h('th', { text: '登记人' }), h('th', { text: '操作' })
        ])),
        otTb
      ]))
    ]));

    var mrTb = h('tbody');
    manualList.forEach(function (r) { mrTb.appendChild(manualRow(r)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '手工监测记录（等效值依据）' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + manualList.length + ' 条；已复核才计入，待复核与退回不参与核算' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '登记手工记录', onclick: function () { openManualForm(null, outageList[0] || null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, h('table', {}, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '排放口' }), h('th', { text: '设备' }), h('th', { text: '指标' }), h('th', { text: '采样时刻' }),
          h('th', { text: '监测值' }), h('th', { text: '监测方法' }), h('th', { text: '检出限' }), h('th', { text: '单位' }),
          h('th', { text: '监测单位' }), h('th', { text: '报告编号' }), h('th', { text: '采样人' }),
          h('th', { text: '复核状态' }), h('th', { text: '复核人' }), h('th', { text: '操作' })
        ])),
        mrTb
      ]))
    ]));
  }

  function openOutageForm(outage) {
    var fields = [
      { name: 'deviceId', label: '设备', type: 'select', options: state.devices.map(function (d) {
        var o = state.outlets.filter(function (x) { return x.id === d.outletId; })[0];
        return { value: d.id, label: d.code + '（' + (o ? o.code : '') + ' · ' + d.metric + '）' };
      }) },
      { name: 'reason', label: '原因', type: 'select', options: OUTAGE_REASONS },
      { name: 'startAt', label: '开始时刻（YYYY-MM-DD HH:MM:SS）' },
      { name: 'endAt', label: '结束时刻（YYYY-MM-DD HH:MM:SS）' },
      { name: 'registeredBy', label: '登记人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, outage || {
      deviceId: state.devices.length ? state.devices[0].id : '',
      reason: '送检', startAt: (state.month || '2026-09') + '-16 00:00:00', endAt: (state.month || '2026-09') + '-20 23:00:00', registeredBy: ''
    });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      var p = outage ? api('PATCH', '/api/outages/' + outage.id, payload) : api('POST', '/api/outages', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(outage ? '设备时段已修改' : '设备时段已登记'); }).catch(showError);
    });
    openModal(outage ? '修改设备时段' : '登记设备故障 / 送检时段', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  function openManualForm(record, presetOutage) {
    var pollutantDevices = state.devices.filter(function (d) { return MAIN_METRICS.indexOf(d.metric) >= 0; });
    var fields = [
      { name: 'deviceId', label: '设备（决定排放口与指标）', type: 'select', options: pollutantDevices.map(function (d) {
        var o = state.outlets.filter(function (x) { return x.id === d.outletId; })[0];
        return { value: d.id, label: d.code + '（' + (o ? o.code : '') + ' · ' + d.metric + '）' };
      }) },
      { name: 'at', label: '采样时刻（YYYY-MM-DD HH:MM:SS）' },
      { name: 'value', label: '监测结果数值', type: 'number' },
      { name: 'method', label: '监测方法（含标准号）' },
      { name: 'detectLimit', label: '检出限', type: 'number' },
      { name: 'resultUnit', label: '结果单位' },
      { name: 'labName', label: '监测单位（实验室）' },
      { name: 'evidenceNo', label: '报告/原始记录编号' },
      { name: 'sampledBy', label: '采样人' },
      { name: 'registeredBy', label: '登记人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var defaults;
    if (record) {
      defaults = Object.assign({}, record);
    } else {
      var device = presetOutage
        ? pollutantDevices.filter(function (d) { return d.id === presetOutage.deviceId; })[0]
        : pollutantDevices[0];
      var metric = device ? device.metric : 'COD';
      defaults = {
        deviceId: device ? device.id : '',
        at: presetOutage ? presetOutage.startAt.slice(0, 11) + '08:30:00' : (state.month || '2026-09') + '-16 08:30:00',
        value: '', method: MANUAL_METHODS[metric] || MANUAL_METHODS.COD, detectLimit: 4, resultUnit: 'mg/L',
        labName: '', evidenceNo: '', sampledBy: '', registeredBy: '', remark: ''
      };
    }
    var form = buildForm(fields, defaults);
    // 选设备时自动带出排放口、指标默认方法
    var deviceSelect = form.querySelector('[data-field="deviceId"]');
    function syncDevice() {
      var d = state.devices.filter(function (x) { return x.id === deviceSelect.value; })[0];
      var methodInput = form.querySelector('[data-field="method"]');
      if (d && methodInput && !record) methodInput.value = MANUAL_METHODS[d.metric] || methodInput.value;
    }
    deviceSelect.addEventListener('change', syncDevice);

    var save = h('button', { type: 'button', class: 'btn btn-accent', text: record ? '保存修改' : '登记（入待复核）' });
    save.addEventListener('click', function () {
      var raw = collectForm(form);
      var d = state.devices.filter(function (x) { return x.id === raw.deviceId; })[0];
      var payload = {
        deviceId: raw.deviceId,
        outletId: d ? d.outletId : '',
        metric: d ? d.metric : '',
        at: raw.at,
        value: raw.value === '' ? undefined : Number(raw.value),
        method: raw.method, detectLimit: Number(raw.detectLimit), resultUnit: raw.resultUnit,
        labName: raw.labName, evidenceNo: raw.evidenceNo, sampledBy: raw.sampledBy,
        registeredBy: raw.registeredBy, remark: raw.remark
      };
      var p = record ? api('PATCH', '/api/manual-records/' + record.id, payload) : api('POST', '/api/manual-records', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(record ? '手工记录已修改（仍需复核）' : '手工记录已登记，等待复核'); }).catch(showError);
    });
    openModal(record ? '修改手工监测记录' : '登记手工监测记录', h('div', {}, [
      h('div', { class: 'section-note', text: '采样时刻必须落在该设备已登记的故障/送检时段内；方法、检出限、监测单位、报告编号、采样人缺一不可，登记后须由他人复核。' }),
      form
    ]), [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  function openReviewForm(r, action) {
    var fields = [
      { name: 'reviewedBy', label: '复核人（不能与采样人 ' + r.sampledBy + ' 为同一人）' }
    ];
    var form = buildForm(fields, { reviewedBy: '' });
    var btnText = action === 'approve' ? '复核通过并计入' : '退回（不作为等效值）';
    var save = h('button', { type: 'button', class: 'btn ' + (action === 'approve' ? 'btn-accent' : 'btn-danger'), text: btnText });
    save.addEventListener('click', function () {
      var raw = collectForm(form);
      api('POST', '/api/manual-records/' + r.id + '/review', { action: action, reviewedBy: raw.reviewedBy })
        .then(function () { closeModal(); return afterMutation(action === 'approve' ? '已复核通过，记录作为等效值入账' : '已退回，该记录不参与核算'); })
        .catch(showError);
    });
    openModal(action === 'approve' ? '复核手工监测记录' : '退回手工监测记录', h('div', {}, [
      h('div', { class: 'section-note' }, [
        r.deviceCode + ' · ' + r.at + ' · ' + r.metric + ' ' + r.value + ' ' + r.resultUnit,
        h('br'), '方法：' + r.method + '；检出限：' + r.detectLimit + '；监测单位：' + r.labName + '；报告编号：' + r.evidenceNo
      ]),
      form
    ]), [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 核算与报表 ================= */
  function summaryCard(sum, metric) {
    var row = metricOf(sum.rows, metric);
    var st = sum.settings || {};
    var qp = sum.quarterPartsCod || { autoTons: 0, manualTons: 0, tons: 0, gapDays: 0 };
    var cells = [
      ['月均', fmt(row.monthAverage)],
      ['月总量(吨)', fmt(row.monthTotalTons, 4)],
      ['其中自动(吨)', fmt(row.monthAutoTons, 4)],
      ['其中替代(吨)', fmt(row.monthManualTons, 4)],
      ['有效天数（自动/替代）', row.autoDays + ' / ' + row.manualDays],
      ['缺口天数', String(row.gapDays)],
      ['数据覆盖率', fmt(row.coveragePercent, 1) + '%'],
      ['替代占比', fmt(row.manualPercent, 1) + '%'],
      ['季度总量 COD(吨)', fmt(qp.tons, 4) + '（替 ' + fmt(qp.manualTons, 4) + '）'],
      ['季度许可量 COD(吨)', fmt(sum.permitCodTons, 4)],
      ['年累计 COD(吨)', fmt((sum.accumulatedCod || {}).tons, 4) + '（替 ' + fmt((sum.accumulatedCod || {}).manualTons, 4) + '）'],
      ['年许可量 COD(吨)', fmt(sum.annualPermitCodTons, 4)],
      ['超标天数', textOf(row.exceedDaysCount)],
      ['超标小时数', textOf(row.exceedHours)],
      ['手工超限样本', textOf(row.manualExceedSamples)],
      ['限值', textOf(row.limit)],
      ['超标判定', row.exceeded ? '超标' : '达标'],
      ['年累计氨氮(吨)', fmt((sum.accumulatedAmmonia || {}).tons, 4) + '（替 ' + fmt((sum.accumulatedAmmonia || {}).manualTons, 4) + '）'],
      ['年许可量氨氮(吨)', fmt(st.annualPermitAmmoniaTons, 4)]
    ];
    var grid = h('div', { class: 'summary-grid' });
    cells.forEach(function (p) {
      var cls = '';
      if (p[0] === '超标判定') cls = p[1] === '超标' ? ' num-danger' : ' num-ok';
      if (p[0] === '缺口天数' && Number(row.gapDays) > 0) cls = ' num-danger';
      if (p[0] === '其中替代(吨)' && Number(row.monthManualTons) > 0) cls = ' num-warn';
      grid.appendChild(h('div', { class: 'summary-cell' }, [
        h('div', { class: 'k', text: p[0] }),
        h('div', { class: 'v' + cls, text: p[1] })
      ]));
    });
    return grid;
  }

  function hourlyTable(rows, manualPoints) {
    var tb = h('tbody');
    (rows || []).forEach(function (r) {
      tb.appendChild(h('tr', { class: 'row' }, [
        h('td', { class: 'nowrap', text: r.at }),
        h('td', { class: 'mono', text: textOf(r.hour) }),
        h('td', { class: 'mono', text: textOf(r.value) }),
        h('td', {}, sourceTag(r.source)),
        h('td', {}, h('span', { class: 'tag ' + (r.flag === '有效' ? 'tag-ok' : 'tag-danger'), text: r.flag })),
        h('td', { text: textOf(r.deviceCode) }),
        h('td', {}, statusTag(r.deviceStatus, '正常')),
        h('td', { class: 'mono', text: textOf(r.oxygen) }),
        h('td', { class: 'mono', text: textOf(r.flow) }),
        h('td', {}, h('span', { class: 'tag ' + (r.counted ? 'tag-ok' : 'tag-danger'), text: r.counted ? '计入' : '不计入' })),
        h('td', { class: 'mono', text: textOf(r.concentration) })
      ]));
    });
    (manualPoints || []).forEach(function (p) {
      var ev = (p.evidence || [])[0] || {};
      tb.appendChild(h('tr', { class: 'row row-manual' }, [
        h('td', { class: 'nowrap cell-manual', text: p.at }),
        h('td', { class: 'mono', text: textOf(p.hour) }),
        h('td', { class: 'mono', text: fmt(p.value) + '（' + p.sampleCount + ' 样均值）' }),
        h('td', {}, sourceTag('手工替代')),
        h('td', {}, reviewTag('已复核')),
        h('td', { class: 'nowrap', text: ev.method ? ev.method.slice(0, 12) + '…' : '' }),
        h('td', { text: '检出限 ' + textOf(p.detectLimit) }),
        h('td', { class: 'mono', text: textOf(p.oxygen) }),
        h('td', { class: 'mono', text: textOf(p.flow) }),
        h('td', {}, h('span', { class: 'tag tag-manual', text: '等效计入' })),
        h('td', { class: 'mono', text: textOf(p.concentration) })
      ]));
    });
    return h('table', { class: 'mini-table' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '时刻' }), h('th', { text: '小时' }), h('th', { text: '数值' }), h('th', { text: '来源' }),
        h('th', { text: '标记/复核' }), h('th', { text: '设备/方法' }), h('th', { text: '设备状态/检出限' }),
        h('th', { text: '氧含量' }), h('th', { text: '流量' }), h('th', { text: '是否计入' }), h('th', { text: '接口折算浓度' })
      ])),
      tb
    ]);
  }

  function dailyRow(d, metric) {
    var rowClass = d.kind === 'gap' ? 'row-danger' : (d.kind === 'manual' || d.kind === 'mixed' ? 'row-manual' : '');
    return expandableRow([
      h('td', { class: 'nowrap', text: d.day }),
      h('td', {}, kindTag(d.kind)),
      h('td', { class: 'mono', text: textOf(d.autoHours) }),
      h('td', { class: 'mono' + (d.manualSamples ? ' num-warn' : ''), text: d.manualSamples ? (d.manualSamples + ' 样/' + d.manualHours + 'h') : '—' }),
      h('td', { class: 'mono', text: textOf(d.imputedHours) }),
      h('td', { class: 'mono', text: d.valid ? fmt(d.average) : '—' }),
      h('td', { class: 'mono', text: textOf(d.limit) }),
      h('td', d.valid ? h('span', { class: 'tag ' + (d.exceed ? 'tag-danger' : 'tag-ok'), text: d.exceed ? '超标' : '达标' }) : h('span', { class: 'tag tag-danger', text: '不计' })),
      h('td', { class: 'mono', text: d.valid ? fmt(d.flowTotal, 1) : '—' }),
      h('td', { class: 'flow-basis', text: d.valid ? d.flowBasis : (d.gapReason || '—') })
    ], function () {
      var wrap = h('div');
      if (d.gapReason) wrap.appendChild(h('div', { class: 'banner banner-danger' }, [h('b', { text: '缺口原因：' }), d.gapReason]));
      if (d.valid && d.kind !== 'auto') wrap.appendChild(h('div', { class: 'section-note', text: '替代日流量口径：' + d.flowBasis + '；当日自动 ' + d.autoHours + ' 小时、手工样本 ' + d.manualSamples + ' 次、替代计 ' + d.manualHours + ' 小时。' }));
      wrap.appendChild(h('div', { class: 'section-note', text: d.day + ' · ' + metric + ' 逐小时与手工样本明细（自动 ' + ((d.rows || []).length) + ' 条、手工 ' + ((d.manualPoints || []).length) + ' 个时点）' }));
      wrap.appendChild(h('div', { class: 'table-wrap' }, hourlyTable(d.rows, d.manualPoints)));
      return wrap;
    }, rowClass);
  }

  async function reportDetailNode(id) {
    var rep = await api('GET', '/api/reports/' + id);
    var box = h('div');
    box.appendChild(h('div', { class: 'section-note' }, [
      h('b', { text: '单位：' }), rep.plant ? ((rep.plant.code || '') + ' ' + (rep.plant.name || '')) : '—',
      '　', h('b', { text: '期间：' }), rep.period, '　', h('b', { text: '月份：' }), rep.month
    ]));
    var outs = rep.outlets || [];
    if (!outs.length) box.appendChild(h('div', { class: 'empty', text: '该单位本月没有排放口数据' }));
    outs.forEach(function (os) {
      var ob = h('div', { class: 'detail-block' });
      ob.appendChild(h('h3', { text: (os.outlet ? (os.outlet.code + ' ' + os.outlet.name) : '排放口') + ' 汇总' }));
      var t = h('table', { class: 'mini-table' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '指标' }), h('th', { text: '月均' }), h('th', { text: '月总量(吨)' }),
          h('th', { text: '自动(吨)' }), h('th', { text: '替代(吨)' }), h('th', { text: '有效天(自/替)' }),
          h('th', { text: '缺口天数' }), h('th', { text: '超标天数' }),
          h('th', { text: '超标小时' }), h('th', { text: '限值' }), h('th', { text: '超标' })
        ])),
        (function () {
          var tb = h('tbody');
          (os.rows || []).forEach(function (r) {
            tb.appendChild(h('tr', { class: 'row' + (Number(r.gapDays) > 0 ? ' row-danger' : '') }, [
              h('td', { text: r.metric }), h('td', { class: 'mono', text: fmt(r.monthAverage) }),
              h('td', { class: 'mono', text: fmt(r.monthTotalTons, 4) }),
              h('td', { class: 'mono', text: fmt(r.monthAutoTons, 4) }),
              h('td', { class: 'mono num-warn', text: fmt(r.monthManualTons, 4) }),
              h('td', { class: 'mono', text: r.autoDays + '/' + r.manualDays }),
              h('td', { class: 'mono' + (Number(r.gapDays) > 0 ? ' num-danger' : ''), text: textOf(r.gapDays) }),
              h('td', { class: 'mono', text: textOf(r.exceedDaysCount) }),
              h('td', { class: 'mono', text: textOf(r.exceedHours) }), h('td', { class: 'mono', text: textOf(r.limit) }),
              h('td', {}, h('span', { class: 'tag ' + (r.exceeded ? 'tag-danger' : 'tag-ok'), text: r.exceeded ? '超标' : '达标' }))
            ]));
          });
          return tb;
        })()
      ]);
      ob.appendChild(t);

      var dailyBlock = h('div', { class: 'detail-block' });
      dailyBlock.appendChild(h('h3', { text: '逐日明细' }));
      var holder = h('div', { class: 'empty', text: '加载中…' });
      dailyBlock.appendChild(holder);
      ob.appendChild(dailyBlock);
      box.appendChild(ob);

      api('GET', '/api/outlets/' + os.outlet.id + '/daily' + qs({ month: rep.month })).then(function (dd) {
        clear(holder);
        MAIN_METRICS.forEach(function (m) {
          var series = (dd.metrics || {})[m] || [];
          var gapCount = series.filter(function (d) { return d.kind === 'gap'; }).length;
          holder.appendChild(h('div', { class: 'section-note' }, [
            m + ' 逐日（' + series.length + ' 天，其中手工替代 ',
            h('b', { class: 'num-warn', text: String(series.filter(function (d) { return d.kind === 'manual' || d.kind === 'mixed'; }).length) }),
            ' 天、缺口 ', h('b', { class: 'num-danger', text: String(gapCount) }), ' 天；缺口日不计入报表总量）'
          ]));
          if (!series.length) { holder.appendChild(h('div', { class: 'empty', text: '本月没有 ' + m + ' 数据' })); return; }
          var tb = h('tbody');
          series.forEach(function (d) {
            tb.appendChild(h('tr', { class: 'row' + (d.kind === 'gap' ? ' row-danger' : (d.kind === 'manual' || d.kind === 'mixed' ? ' row-manual' : '')) }, [
              h('td', { class: 'nowrap', text: d.day }),
              h('td', {}, kindTag(d.kind)),
              h('td', { class: 'mono', text: textOf(d.autoHours) }),
              h('td', { class: 'mono num-warn', text: d.manualSamples ? (d.manualSamples + '样') : '—' }),
              h('td', { class: 'mono', text: d.valid ? fmt(d.average) : '—' }),
              h('td', { class: 'mono', text: textOf(d.limit) }),
              h('td', d.valid ? h('span', { class: 'tag ' + (d.exceed ? 'tag-danger' : 'tag-ok'), text: d.exceed ? '超标' : '达标' }) : h('span', { class: 'tag tag-danger', text: '缺口' })),
              h('td', { class: 'mono', text: d.valid ? fmt(d.flowTotal, 1) : '—' }),
              h('td', { class: 'flow-basis', text: d.valid ? d.flowBasis : (d.gapReason || '') })
            ]));
          });
          holder.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' }, [
            h('thead', {}, h('tr', {}, [
              h('th', { text: '日期' }), h('th', { text: '类别' }), h('th', { text: '自动小时' }), h('th', { text: '手工样本' }),
              h('th', { text: '日均' }), h('th', { text: '限值' }), h('th', { text: '判定' }),
              h('th', { text: '当日流量' }), h('th', { text: '流量口径 / 缺口原因' })
            ])),
            tb
          ])));
        });
      }).catch(function (e) { holder.textContent = '逐日明细加载失败：' + e.message; });
    });
    return box;
  }

  function reportRow(r) {
    var statusSel = sel(REPORT_STATUS.map(function (s) { return { value: s, label: s }; }), r.status, null);
    statusSel.addEventListener('click', function (e) { e.stopPropagation(); });
    statusSel.addEventListener('change', function (e) {
      e.stopPropagation();
      api('PATCH', '/api/reports/' + r.id, { status: statusSel.value }).then(function () {
        return afterMutation('报表状态已改为 ' + statusSel.value);
      }).catch(function (err) { showError(err); statusSel.value = r.status; });
    });
    var actions = actionsCell([
      statusSel,
      actionBtn('改备注', function () { openReportEdit(r); })
    ]);
    return expandableRow([
      h('td', { text: r.period }),
      h('td', {}, statusTag(r.status, '已上报')),
      h('td', { text: textOf(r.submittedAt) }),
      h('td', { text: textOf(r.submittedBy) }),
      h('td', { text: textOf(r.remark) }),
      actions
    ], function () { return reportDetailNode(r.id); });
  }

  function openReportForm() {
    var fields = [
      { name: 'plantId', label: '排污单位', type: 'select', options: state.plants.map(function (p) { return { value: p.id, label: p.code + ' ' + p.name }; }) },
      { name: 'period', label: '期间（YYYY-MM）', type: 'month' },
      { name: 'status', label: '状态', type: 'select', options: REPORT_STATUS },
      { name: 'submittedBy', label: '上报人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, { plantId: state.plants.length ? state.plants[0].id : '', period: state.month || '', status: '草稿' });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '新建报表' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      api('POST', '/api/reports', payload).then(function () { closeModal(); return afterMutation('报表已新建'); }).catch(showError);
    });
    openModal('新建报表', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  function openReportEdit(r) {
    var fields = [
      { name: 'status', label: '状态', type: 'select', options: REPORT_STATUS },
      { name: 'submittedAt', label: '上报时刻' },
      { name: 'submittedBy', label: '上报人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, r);
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      api('PATCH', '/api/reports/' + r.id, payload).then(function () { closeModal(); return afterMutation('报表已更新'); }).catch(showError);
    });
    openModal('修改报表', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  async function renderAccounting() {
    if (!state.accounting.outletId && state.outlets.length) state.accounting.outletId = state.outlets[0].id;
    if (!state.accounting.month) state.accounting.month = state.month;

    var f = clear(document.getElementById('filters-accounting'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '核算对象' }),
      h('div', { class: 'field' }, [h('label', { text: '排放口' }),
        sel(state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; }),
          state.accounting.outletId, function (v) { state.accounting.outletId = v; renderAccounting(); })]),
      h('div', { class: 'field' }, [h('label', { text: '月份' }),
        (function () {
          var mi = h('input', { type: 'month' });
          mi.value = state.accounting.month;
          mi.addEventListener('change', function () { state.accounting.month = mi.value; renderAccounting(); });
          return mi;
        })()]),
      h('div', { class: 'field' }, [h('label', { text: '指标' }),
        sel(MAIN_METRICS.map(function (m) { return { value: m, label: m }; }), state.accounting.metric,
          function (v) { state.accounting.metric = v; renderAccounting(); })])
    ]));

    var c = clear(document.getElementById('content-accounting'));
    if (!state.accounting.outletId) { c.appendChild(h('div', { class: 'empty', text: '没有可选排放口' })); return; }
    var month = state.accounting.month || state.month;
    var metric = state.accounting.metric || 'COD';

    var sum, daily;
    try {
      var out = await Promise.all([
        api('GET', '/api/outlets/' + state.accounting.outletId + '/summary' + qs({ month: month })),
        api('GET', '/api/outlets/' + state.accounting.outletId + '/daily' + qs({ month: month, metric: metric }))
      ]);
      sum = out[0]; daily = out[1];
    } catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }

    var metricRow = metricOf(sum.rows, metric);
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: (sum.outlet ? (sum.outlet.code + ' ' + sum.outlet.name) : '排放口') + ' 汇总' }),
        h('span', { class: 'sub', text: (sum.plant ? (sum.plant.code + ' ' + sum.plant.name) : '') + ' · ' + month + ' · ' + metric })
      ]),
      h('div', { class: 'card-body' }, summaryCard(sum, metric))
    ]));

    if (Number(metricRow.gapDays) > 0) {
      c.appendChild(h('div', { class: 'card card-danger' }, [
        h('div', { class: 'card-head' }, [
          h('h2', { text: month + ' 缺口时段（' + metricRow.gapDays + ' 天，未计入平均与总量，不许用替代数据填平）' })
        ]),
        h('div', { class: 'card-body' }, (function () {
          var box = h('div');
          (metricRow.gaps || []).forEach(function (g) {
            box.appendChild(h('div', { class: 'gap-line' }, [
              h('b', { class: 'mono', text: g.day + '　' }), g.reason,
              g.pendingManualCount ? h('span', { class: 'tag tag-warn', text: '待复核 ' + g.pendingManualCount + ' 条' }) : null
            ]));
          });
          return box;
        })())
      ]));
    }

    var series = (daily.metrics || {})[metric] || [];
    var dailyTb = h('tbody');
    series.forEach(function (d) { dailyTb.appendChild(dailyRow(d, metric)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: metric + ' 逐日明细（自动 / 手工替代 / 缺口 显式区分）' }),
        h('span', { class: 'sub', text: '共 ' + series.length + ' 天（点某天展开逐小时与手工样本明细）' })
      ]),
      h('div', { class: 'table-wrap' }, h('table', { id: 'tableDaily' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '日期' }), h('th', { text: '类别' }), h('th', { text: '自动小时' }), h('th', { text: '手工样本/替代小时' }),
          h('th', { text: '补录小时' }), h('th', { text: '日均' }),
          h('th', { text: '限值' }), h('th', { text: '判定' }), h('th', { text: '当日流量(m³)' }), h('th', { text: '流量口径 / 缺口原因' })
        ])),
        dailyTb
      ]))
    ]));

    var reportTb = h('tbody');
    state.reports.forEach(function (r) { reportTb.appendChild(reportRow(r)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '报表' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + state.reports.length + ' 张（点行展开详情）' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新建报表', onclick: openReportForm })
        ])
      ]),
      h('div', { class: 'table-wrap' }, h('table', { id: 'tableReports' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '期间' }), h('th', { text: '状态' }), h('th', { text: '上报时刻' }), h('th', { text: '上报人' }),
          h('th', { text: '备注' }), h('th', { text: '操作' })
        ])),
        reportTb
      ]))
    ]));
  }

  /* ================= 设置 ================= */
  function openSettings() {
    var s = state.settings || {};
    var fields = [
      { name: 'oxygenBaseline', label: '基准氧含量', type: 'number' },
      { name: 'rangeMax', label: '量程上限', type: 'number' },
      { name: 'maxImputeHoursPerDay', label: '单日补录上限（小时）', type: 'number' },
      { name: 'validHoursPerDay', label: '单日有效小时门槛', type: 'number' },
      { name: 'manualMinSamplesPerDay', label: '替代日手工最少监测次数/日', type: 'number' },
      { name: 'manualMaxConsecutiveDays', label: '连续替代最长天数', type: 'number' },
      { name: 'manualMaxCoveragePercent', label: '替代覆盖率上限（%）', type: 'number' },
      { name: 'manualFlowLookbackDays', label: '流量缺失回溯天数', type: 'number' },
      { name: 'codDailyLimit', label: 'COD 日限值', type: 'number' },
      { name: 'ammoniaDailyLimit', label: '氨氮日限值', type: 'number' },
      { name: 'hourlyExceedCountLimit', label: '小时超标次数', type: 'number' },
      { name: 'annualPermitCodTons', label: '年许可 COD（吨）', type: 'number' },
      { name: 'annualPermitAmmoniaTons', label: '年许可氨氮（吨）', type: 'number' }
    ];
    var form = buildForm(fields, s);
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存设置' });
    save.addEventListener('click', function () {
      var raw = collectForm(form);
      var payload = {};
      Object.keys(raw).forEach(function (k) {
        var n = Number(raw[k]);
        payload[k] = isFinite(n) && raw[k] !== '' ? n : raw[k];
      });
      api('PATCH', '/api/settings', payload).then(function (res) {
        state.settings = res;
        if (state.summary) state.summary.settings = res;
        closeModal();
        toast('设置已保存');
        switchView(state.view);
      }).catch(showError);
    });
    openModal('设置', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 初始化 ================= */
  document.querySelectorAll('#tabs .tab').forEach(function (t) {
    t.addEventListener('click', function () { switchView(t.dataset.view); });
  });
  document.getElementById('settingsBtn').addEventListener('click', openSettings);

  async function init() {
    try {
      await loadAll();
      document.getElementById('todayText').textContent = state.today || '—';
      switchView('overview');
    } catch (e) {
      showError(e);
      document.getElementById('todayText').textContent = '—';
    }
  }
  init();
})();
