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
  var READING_SOURCE_FILTER = ['自动', '补录', '手工'];
  var REPORT_STATUS = ['草稿', '已上报', '退回'];
  var OUTAGE_TYPES = ['故障', '送检'];
  var MANUAL_STATUS = ['待复核', '已复核', '驳回'];

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
    readings: { total: 0, returned: 0, rows: [] },
    plantsFilter: { status: '', keyword: '' },
    outletsFilter: { plantId: '', status: '' },
    devicesFilter: { outletId: '', metric: '', status: '' },
    readingsFilter: { outletId: '', deviceId: '', metric: '', day: '', month: '', source: '' },
    manualFilter: { outletId: '', month: '', status: '' },
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

  function expandableRow(cells, detailFactory) {
    var tr = h('tr', { class: 'row' }, cells);
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

  // 数据来源徽章：自动=中性、补录=橙、手工替代=紫（特殊语义）、缺口=红边
  function sourceTag(source) {
    if (source === '自动') return h('span', { class: 'tag', text: '自动' });
    if (source === '补录') return h('span', { class: 'tag tag-warn', text: '补录' });
    if (source === '手工') return h('span', { class: 'tag tag-manual', text: '手工替代' });
    return h('span', { class: 'tag tag-danger', text: source || '缺口' });
  }
  function reviewTag(status) {
    if (status === '已复核') return h('span', { class: 'tag tag-ok', text: '已复核' });
    if (status === '驳回') return h('span', { class: 'tag tag-danger', text: '驳回' });
    return h('span', { class: 'tag tag-warn', text: status || '待复核' });
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
      api('GET', '/api/reports')
    ]);
    state.summary = res[0];
    state.settings = res[1];
    state.plants = res[2];
    state.outlets = res[3];
    state.devices = res[4];
    state.readings = res[5];
    state.reports = res[6];
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
      api('GET', '/api/summary')
    ]);
    state.plants = res[0];
    state.outlets = res[1];
    state.devices = res[2];
    state.reports = res[3];
    state.summary = res[4];
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
    else if (view === 'manual') renderManual();
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
      metricCard('监测数据', s.readingCount, '自动 ' + s.autoCount + ' · 补录 ' + s.imputedCount + ' · 无效标记 ' + s.invalidFlagCount, 'readings'),
      metricCard('替代取证', (s.manualCount || 0) + ' 条手工', '已复核 ' + (s.reviewedManualCount || 0) + ' · 待复核 ' + (s.pendingManualCount || 0) + ' · 故障/送检 ' + (s.outageCount || 0) + ' 段', 'manual'),
      metricCard('本月缺口', (s.gapHours || 0) + ' 小时', '其中手工替代覆盖 ' + (s.manualHours || 0) + ' 小时（COD/氨氮合计）', 'manual'),
      metricCard('报表', s.reportCount, '已上报 ' + s.submittedReportCount + ' 张', 'accounting'),
      metricCard('超标排放口', s.exceededOutletCount, '存在月超标判定', 'accounting'),
      metricCard('年累计 COD', s.accumulatedCodTons + ' 吨', '年许可量 ' + s.permitCodTons + ' 吨', 'accounting'),
      metricCard('年累计氨氮', s.accumulatedAmmoniaTons + ' 吨', '年许可量 ' + s.permitAmmoniaTons + ' 吨', 'accounting')
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
        h('td', { class: 'mono', text: fmt(cod.monthTotalTons, 4) }),
        h('td', { class: 'mono' + (Number(cod.exceedDaysCount) > 0 ? ' num-danger' : ''), text: textOf(cod.exceedDaysCount) }),
        h('td', { class: 'mono', text: textOf(cod.exceedHours) }),
        h('td', { class: 'mono', text: fmt(amm.monthAverage) }),
        h('td', { class: 'mono', text: fmt(amm.monthTotalTons, 4) }),
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
        h('th', { text: 'COD 月均' }), h('th', { text: 'COD 月总量(吨)' }), h('th', { text: 'COD 超标天数' }), h('th', { text: 'COD 超标小时' }),
        h('th', { text: '氨氮 月均' }), h('th', { text: '氨氮 月总量(吨)' }), h('th', { text: '氨氮 超标天数' }), h('th', { text: '氨氮 超标小时' })
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
    var isManual = r.rowType === 'manual';
    var actions;
    if (isManual) {
      actions = actionsCell([
        actionBtn('替代取证', function () {
          state.manualFilter.outletId = r.outletId;
          state.manualFilter.month = r.at.slice(0, 7);
          switchView('manual');
        })
      ]);
    } else {
      actions = actionsCell([
        actionBtn('修改', function () { openReadingForm(r); }),
        deleteBtn('删除', function () {
          return api('DELETE', '/api/readings/' + r.id).then(function () { return afterMutation('已删除监测数据 ' + r.id); });
        })
      ]);
    }
    var tr = expandableRow([
      h('td', { text: textOf(r.outletCode) }),
      h('td', { text: textOf(r.deviceCode) }),
      h('td', { text: r.metric }),
      h('td', { class: 'nowrap', text: r.at }),
      h('td', { class: 'mono', text: textOf(r.value) + (isManual && r.unit ? ' ' + r.unit : '') }),
      h('td', {}, h('span', { class: 'tag ' + (r.flag === '有效' ? 'tag-ok' : 'tag-danger'), text: r.flag })),
      h('td', {}, sourceTag(r.source)),
      h('td', { text: textOf(r.operator) }),
      h('td', {}, h('span', {
        class: 'tag ' + (r.counted ? 'tag-ok' : (isManual ? 'tag-warn' : 'tag-danger')),
        text: r.counted ? '计入' : '不计入'
      })),
      h('td', { class: 'mono cell-page-conc', dataset: { value: pc === null ? '' : String(pc) }, text: pc === null ? '—' : fmt(pc, 2) }),
      h('td', { class: 'mono cell-api-conc', dataset: { value: (r.concentration === null || r.concentration === undefined) ? '' : String(r.concentration) }, text: textOf(r.concentration) }),
      h('td', { class: 'mono', text: textOf(r.oxygen) }),
      h('td', { class: 'mono', text: (r.flow === null || r.flow === undefined) ? '—' : textOf(r.flow) }),
      actions
    ], function () {
      var blocks = [
        h('div', { class: 'detail-block' }, [h('h3', { text: '数据 ID' }), h('div', { text: r.id + (isManual ? '（手工登记）' : '') })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '设备状态' }), h('div', { text: textOf(r.deviceStatus) })]),
        h('div', { class: 'detail-block' }, [
          h('h3', { text: r.counted ? '计入依据' : '不计入原因' }),
          h('div', { class: r.counted ? 'num-ok' : 'num-danger', text: r.counted ? '满足口径，计入统计' : textOf(r.invalidReason) })
        ])
      ];
      if (isManual) {
        blocks.push(h('div', { class: 'detail-block' }, [
          h('h3', { text: '手工监测取证' }),
          h('div', {}, [
            h('div', { text: '采样时刻：' + r.at }),
            h('div', { text: '监测方法：' + textOf(r.method) }),
            h('div', { text: '检出限：' + textOf(r.detectionLimit) }),
            h('div', { text: '监测单位：' + textOf(r.unit) }),
            h('div', { text: '登记人：' + textOf(r.operator) }),
            h('div', { text: '复核人：' + textOf(r.reviewer) }),
            h('div', {}, ['复核状态：', reviewTag(r.status)]),
            h('div', { text: '复核意见：' + textOf(r.reviewNote) })
          ])
        ]));
      }
      blocks.push(h('div', { class: 'detail-block' }, [h('h3', { text: '备注' }), h('div', { text: textOf(r.remark) })]));
      return h('div', { class: 'detail-grid' }, blocks);
    });
    if (isManual) tr.classList.add('row-manual');
    else if (!r.counted) tr.classList.add('row-invalid');
    return tr;
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
    var sourceSel = sel(optsFromList(READING_SOURCE_FILTER), state.readingsFilter.source, function (v) { state.readingsFilter.source = v; renderReadings(); });
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
      h('div', { class: 'field' }, [h('label', { text: '日期' }), dayInput]),
      h('div', { class: 'field' }, [h('label', { text: '月份' }), monthInput]),
      h('div', { class: 'field' }, [h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: '清空筛选', onclick: function () {
        state.readingsFilter = { outletId: '', deviceId: '', metric: '', source: '', day: '', month: '' };
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
        h('h2', { text: '小时值清单' }),
        h('div', { class: 'btn-row' }, [
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增监测数据', onclick: function () { openReadingForm(null); } })
        ])
      ]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'section-note' }, [
          '共 ', h('b', { text: String(data.total) }), ' 条，已显示前 ', h('b', { text: String(data.returned) }), ' 条（总条数与已显示条数取自接口 total 与 returned）。'
        ]),
        h('div', { class: 'section-note' }, [
          '「折算后浓度（页面自算）」由本页按 实测 × (21 − 基准氧) / (21 − 氧含量) 计算，氧含量取接口 oxygen，缺失按 0 代入；「接口折算浓度」直接显示接口 concentration。'
        ]),
        h('div', { class: 'section-note' }, [
          h('span', { class: 'tag tag-manual', text: '手工替代' }),
          ' 行是设备故障/送检期间登记、经复核入账的手工监测等效值；灰红字行是因标记、设备状态、量程或停产停用被判定不计入的读数；手工行点「替代取证」可查看依据与复核信息。'
        ]),
        h('div', { class: 'table-wrap' }, h('table', { id: 'tableReadings' }, [
          h('thead', {}, h('tr', {}, [
            h('th', { text: '排放口' }), h('th', { text: '设备' }), h('th', { text: '指标' }), h('th', { text: '时刻' }),
            h('th', { text: '数值' }), h('th', { text: '标记' }), h('th', { text: '来源' }), h('th', { text: '登记人' }),
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

  /* ================= 替代取证 ================= */
  function outageRow(o) {
    var actions = actionsCell([
      actionBtn('修改', function () { openOutageForm(o); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/outages/' + o.id).then(function () { afterMutation('已删除故障/送检登记 ' + o.id); });
      })
    ]);
    return h('tr', { class: 'row' }, [
      h('td', {}, h('b', { text: o.deviceCode })),
      h('td', { text: textOf(o.outletCode) }),
      h('td', { text: textOf(o.deviceMetric) }),
      h('td', {}, statusTag(o.reasonType, '正常')),
      h('td', { class: 'nowrap', text: o.startAt }),
      h('td', { class: 'nowrap', text: o.endAt }),
      h('td', { class: 'mono', text: textOf(o.hours) }),
      h('td', { text: textOf(o.ticketNo) }),
      h('td', { text: textOf(o.agency) }),
      h('td', { class: 'mono' + (o.pendingManualCount > 0 ? ' num-warn' : ''), text: (o.reviewedManualCount || 0) + ' 已复核 / ' + (o.pendingManualCount || 0) + ' 待复核' }),
      h('td', { text: textOf(o.operator) }),
      actions
    ]);
  }

  function openOutageForm(o) {
    var fields = [
      { name: 'deviceId', label: '设备（编号/指标/排放口）', type: 'select', options: state.devices.map(function (d) {
        var ol = state.outlets.filter(function (x) { return x.id === d.outletId; })[0];
        return { value: d.id, label: d.code + '（' + d.metric + '·' + (ol ? ol.code : '') + '）' };
      }) },
      { name: 'reasonType', label: '离位原因', type: 'select', options: OUTAGE_TYPES },
      { name: 'startAt', label: '起始时刻（YYYY-MM-DD HH:00:00）' },
      { name: 'endAt', label: '结束时刻（YYYY-MM-DD HH:00:00）' },
      { name: 'ticketNo', label: '故障/检修单号' },
      { name: 'agency', label: '送检/校准机构' },
      { name: 'operator', label: '登记人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, o || {
      deviceId: state.devices.length ? state.devices[0].id : '',
      reasonType: '故障', startAt: (state.month || '2026-09') + '-01 08:00:00', endAt: (state.month || '2026-09') + '-01 20:00:00'
    });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      var p = o ? api('PATCH', '/api/outages/' + o.id, payload) : api('POST', '/api/outages', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(o ? '故障/送检登记已修改' : '故障/送检时段已登记'); }).catch(showError);
    });
    openModal(o ? '修改故障/送检登记' : '登记设备故障/送检时段', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  function manualRow(m) {
    var btns = [];
    if (m.status === '待复核' || m.status === '驳回') {
      btns.push(actionBtn('修改', function () { openManualForm(m); }));
      btns.push(deleteBtn('删除', function () {
        return api('DELETE', '/api/manual-readings/' + m.id).then(function () { afterMutation('已删除手工登记 ' + m.id); });
      }));
    }
    if (m.status !== '已复核') btns.push(actionBtn('复核', function () { openReviewForm(m); }));
    else btns.push(actionBtn('驳回更正', function () { openReviewForm(m); }));
    var actions = actionsCell(btns);
    return h('tr', { class: 'row row-manual' }, [
      h('td', { class: 'nowrap', text: m.at }),
      h('td', { text: textOf(m.deviceCode) }),
      h('td', { text: m.metric }),
      h('td', { class: 'mono', text: fmt(m.value, 3) + ' ' + textOf(m.unit) }),
      h('td', { text: textOf(m.method) }),
      h('td', { class: 'mono', text: textOf(m.detectionLimit) }),
      h('td', { text: textOf(m.operator) }),
      h('td', { text: textOf(m.reviewer) }),
      h('td', {}, reviewTag(m.status)),
      h('td', { class: m.counted ? 'num-ok' : 'num-danger', text: m.counted ? '已入账' : textOf(m.dropReason || '待复核') }),
      actions
    ]);
  }

  function openManualForm(m) {
    var fields = [
      { name: 'deviceId', label: '设备（必须处于已登记的故障/送检时段）', type: 'select', options: state.devices.map(function (d) {
        var ol = state.outlets.filter(function (x) { return x.id === d.outletId; })[0];
        return { value: d.id, label: d.code + '（' + d.metric + '·' + (ol ? ol.code : '') + '）' };
      }) },
      { name: 'metric', label: '监测指标', type: 'select', options: METRICS },
      { name: 'at', label: '采样时刻（YYYY-MM-DD HH:00:00）' },
      { name: 'value', label: '监测值', type: 'number' },
      { name: 'method', label: '监测方法（如 HJ 828 重铬酸盐法）' },
      { name: 'detectionLimit', label: '检出限', type: 'number' },
      { name: 'unit', label: '监测单位（mg/L、m³/h 等）' },
      { name: 'operator', label: '登记人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, m || {
      deviceId: state.devices.length ? state.devices[0].id : '',
      metric: 'COD', at: (state.manualFilter.month || state.month || '2026-09') + '-01 08:00:00',
      value: '', method: '', detectionLimit: '', unit: 'mg/L', operator: '', remark: ''
    });
    var tip = h('div', { class: 'section-note', text: '硬口径：采样时刻必须落在该设备已登记的故障/送检时段内；监测方法、检出限、监测单位、登记人为必填，缺一项不许入账；登记后必须由复核人复核通过才参与平均与总量。' });
    var grid = form;
    var wrap = h('div', null, [tip, grid]);
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存登记' });
    save.addEventListener('click', function () {
      var raw = collectForm(form);
      var payload = {
        deviceId: raw.deviceId, metric: raw.metric, at: raw.at,
        value: raw.value === '' ? undefined : Number(raw.value),
        method: raw.method, detectionLimit: raw.detectionLimit === '' ? undefined : Number(raw.detectionLimit),
        unit: raw.unit, operator: raw.operator, remark: raw.remark
      };
      var p = m ? api('PATCH', '/api/manual-readings/' + m.id, payload) : api('POST', '/api/manual-readings', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(m ? '手工登记已修改（仍待复核）' : '手工监测已登记，等待复核'); }).catch(showError);
    });
    openModal(m ? '修改手工监测登记' : '登记手工监测（设备故障/送检期间等效值）', wrap, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  function openReviewForm(m) {
    var fields = [
      { name: 'action', label: '复核结论', type: 'select', options: [{ value: '通过', label: '通过（入账为等效值）' }, { value: '驳回', label: '驳回（不参与统计）' }] },
      { name: 'reviewer', label: '复核人（必填）' },
      { name: 'reviewNote', label: '复核意见', full: true }
    ];
    var form = buildForm(fields, { action: m.status === '已复核' ? '驳回' : '通过', reviewer: m.reviewer || '', reviewNote: m.reviewNote || '' });
    var info = h('div', { class: 'section-note' }, [
      m.at + ' · ' + (m.deviceCode || '') + ' · ' + m.metric + ' · 监测值 ' + m.value + ' ' + m.unit,
      h('br'), '方法：' + m.method + '；检出限：' + m.detectionLimit + '；登记人：' + m.operator
    ]);
    var wrap = h('div', null, [info, form]);
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '提交复核' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      api('POST', '/api/manual-readings/' + m.id + '/review', payload).then(function () {
        closeModal(); return afterMutation('复核完成：' + payload.action);
      }).catch(showError);
    });
    openModal('复核手工监测数据', wrap, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  function coverageCard(cov) {
    var st = cov.settings || {};
    var head = h('div', { class: 'card-head' }, [
      h('h2', { text: '替代边界与缺口（按口径自动判定）' }),
      h('span', { class: 'sub', text: cov.month + ' · 单次故障/送检最多替代 ' + st.maxManualSpanHours + ' 小时 · 每日至少 ' + st.manualMinSamplesPerDay + ' 次手工监测 · 单月替代比例上限 ' + Math.round(Number(st.manualMaxCoverageRatio) * 100) + '%' })
    ]);
    var tb = h('tbody');
    (cov.metrics || []).forEach(function (m) {
      var ratioPct = Math.round(Number(m.manualCoverageRatio) * 1000) / 10;
      var overCap = m.manualHours > m.manualCapHours;
      tb.appendChild(h('tr', { class: 'row' }, [
        h('td', { text: m.metric }),
        h('td', { class: 'mono', text: String(m.expectedHours) }),
        h('td', { class: 'mono', text: String(m.autoHours) }),
        h('td', { class: 'mono num-warn', text: String(m.imputedHours) }),
        h('td', { class: 'mono num-manual', text: String(m.manualHours) }),
        h('td', { class: 'mono num-danger', text: String(m.invalidHours) }),
        h('td', { class: 'mono num-danger', text: String(m.gapHours) }),
        h('td', { class: 'mono' + (overCap ? ' num-danger' : ''), text: ratioPct + '%（上限 ' + m.manualCapHours + 'h）' }),
        h('td', { class: 'mono', text: fmt(m.autoTons, 4) }),
        h('td', { class: 'mono num-warn', text: fmt(m.imputedTons, 4) }),
        h('td', { class: 'mono num-manual', text: fmt(m.manualTons, 4) }),
        h('td', { class: 'mono', text: fmt(m.tons, 4) })
      ]));
    });
    var table = h('table', { class: 'mini-table' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '指标' }), h('th', { text: '应监测h' }), h('th', { text: '自动h' }),
        h('th', { text: '补录h' }), h('th', { text: '手工替代h' }), h('th', { text: '无效h' }), h('th', { text: '缺口h' }),
        h('th', { text: '替代占比' }), h('th', { text: '总量-自动(吨)' }),
        h('th', { text: '总量-补录(吨)' }), h('th', { text: '总量-手工(吨)' }), h('th', { text: '总量合计(吨)' })
      ])),
      tb
    ]);

    var gapBox = h('div', { class: 'gap-list' });
    var hasGap = false;
    (cov.metrics || []).forEach(function (m) {
      (m.gaps || []).forEach(function (g) {
        hasGap = true;
        var cut = (g.droppedManual || []).length;
        gapBox.appendChild(h('div', { class: 'gap-item' }, [
          h('b', { text: m.metric + ' 缺口 ' }),
          h('span', { class: 'nowrap mono', text: g.startAt + ' ～ ' + g.endAt }),
          ' ', h('span', { class: 'num-danger', text: g.hours + ' 小时' }),
          cut ? h('span', { class: 'num-warn', text: '（其中 ' + cut + ' 个小时有手工登记但超出口径，已按缺口处理：' + (g.droppedManual[0] || {}).reason + '）' })
            : h('span', { class: 'hint', text: '（该时段没有任何有效数据，按缺口处理，不用替代数据填平）' })
        ]));
      });
    });
    if (!hasGap) gapBox.appendChild(h('div', { class: 'empty num-ok', text: '本月各指标均无缺口。' }));

    return h('div', { class: 'card' }, [head, h('div', { class: 'card-body' }, [
      h('div', { class: 'table-wrap' }, table),
      h('div', { class: 'section-note', text: '总量按同一时刻的浓度×流量逐小时配对累加；替代期间浓度取手工值、流量取同时刻有效流量（自动优先，其次经复核手工流量；缺有效流量的小时不估、不计，并计入缺口）。' }),
      h('h3', { class: 'gap-title', text: '缺口时段（显式标出，不计入平均与总量）' }),
      gapBox
    ])]);
  }

  async function renderManual() {
    if (!state.manualFilter.outletId && state.outlets.length) state.manualFilter.outletId = state.outlets[0].id;
    if (!state.manualFilter.month) state.manualFilter.month = state.month;

    var f = clear(document.getElementById('filters-manual'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '替代取证' }),
      h('div', { class: 'field' }, [h('label', { text: '排放口' }),
        sel(state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; }),
          state.manualFilter.outletId, function (v) { state.manualFilter.outletId = v; renderManual(); })]),
      h('div', { class: 'field' }, [h('label', { text: '月份' }),
        (function () {
          var mi = h('input', { type: 'month' });
          mi.value = state.manualFilter.month;
          mi.addEventListener('change', function () { state.manualFilter.month = mi.value; renderManual(); });
          return mi;
        })()]),
      h('div', { class: 'field' }, [h('label', { text: '复核状态' }),
        sel(optsFromList(MANUAL_STATUS), state.manualFilter.status, function (v) { state.manualFilter.status = v; renderManual(); })])
    ]));

    var c = clear(document.getElementById('content-manual'));
    if (!state.manualFilter.outletId) { c.appendChild(h('div', { class: 'empty', text: '没有可选排放口' })); return; }
    var oid = state.manualFilter.outletId;
    var month = state.manualFilter.month;

    var cov, outages, manuals;
    try {
      var out = await Promise.all([
        api('GET', '/api/outlets/' + oid + '/coverage' + qs({ month: month })),
        api('GET', '/api/outages' + qs({ outletId: oid })),
        api('GET', '/api/manual-readings' + qs({ outletId: oid, month: month, status: state.manualFilter.status }))
      ]);
      cov = out[0]; outages = out[1]; manuals = out[2];
    } catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }

    c.appendChild(coverageCard(cov));

    var otTb = h('tbody');
    outages.forEach(function (o) { otTb.appendChild(outageRow(o)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '设备故障 / 送检台账' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + outages.length + ' 段（手工监测登记的唯一依据）' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '登记故障/送检', onclick: function () { openOutageForm(null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, h('table', {}, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '设备' }), h('th', { text: '排放口' }), h('th', { text: '指标' }), h('th', { text: '原因' }),
          h('th', { text: '起始时刻' }), h('th', { text: '结束时刻' }), h('th', { text: '小时数' }),
          h('th', { text: '单号' }), h('th', { text: '机构' }), h('th', { text: '手工登记' }), h('th', { text: '登记人' }), h('th', { text: '操作' })
        ])),
        otTb
      ]))
    ]));

    var mnTb = h('tbody');
    manuals.forEach(function (m) { mnTb.appendChild(manualRow(m)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '手工监测登记（等效值）' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + manuals.length + ' 条（缺依据或缺方法/检出限/单位/登记人的不许入账）' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '登记手工监测', onclick: function () { openManualForm(null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, h('table', {}, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '采样时刻' }), h('th', { text: '设备' }), h('th', { text: '指标' }),
          h('th', { text: '监测值' }), h('th', { text: '监测方法' }), h('th', { text: '检出限' }),
          h('th', { text: '登记人' }), h('th', { text: '复核人' }), h('th', { text: '复核状态' }),
          h('th', { text: '入账情况' }), h('th', { text: '操作' })
        ])),
        mnTb
      ]))
    ]));
  }

  /* ================= 核算与报表 ================= */
  function summaryCard(sum, metric) {
    var row = metricOf(sum.rows, metric);
    var st = sum.settings || {};
    var cells = [
      ['月均', fmt(row.monthAverage)],
      ['月总量(吨)', fmt(row.monthTotalTons, 4)],
      ['其中自动(吨)', fmt(row.autoTons, 4)],
      ['其中补录(吨)', fmt(row.imputedTons, 4)],
      ['其中手工替代(吨)', fmt(row.manualTons, 4)],
      ['手工替代小时', textOf(row.manualHours)],
      ['无效小时', textOf(row.invalidHours)],
      ['缺口小时', textOf(row.gapHours)],
      ['替代占比', Math.round(Number(row.manualCoverageRatio || 0) * 1000) / 10 + '%'],
      ['季度总量 COD(吨)', fmt(sum.quarterTotalCod, 4)],
      ['季度许可量 COD(吨)', fmt(sum.permitCodTons, 4)],
      ['年累计 COD(吨)', fmt(sum.accumulatedCodTons, 4)],
      ['年许可量 COD(吨)', fmt(sum.annualPermitCodTons, 4)],
      ['超标天数', textOf(row.exceedDaysCount)],
      ['超标小时数', textOf(row.exceedHours)],
      ['小时超标判定', row.hourlyExceed ? '小时超标成立' : '小时超标不成立'],
      ['限值', textOf(row.limit)],
      ['超标判定', row.exceeded ? '超标' : '达标'],
      ['年累计氨氮(吨)', fmt(sum.accumulatedAmmoniaTons, 4)],
      ['年许可量氨氮(吨)', fmt(st.annualPermitAmmoniaTons, 4)]
    ];
    var grid = h('div', { class: 'summary-grid' });
    cells.forEach(function (p) {
      var cls = '';
      if (p[0] === '超标判定') cls = p[1] === '超标' ? ' num-danger' : ' num-ok';
      grid.appendChild(h('div', { class: 'summary-cell' }, [
        h('div', { class: 'k', text: p[0] }),
        h('div', { class: 'v' + cls, text: p[1] })
      ]));
    });
    return grid;
  }

  function stateTag(s) {
    if (s.state === 'auto') return h('span', { class: 'tag', text: '自动' });
    if (s.state === 'imputed') return h('span', { class: 'tag tag-warn', text: '补录' });
    if (s.state === 'manual') return h('span', { class: 'tag tag-manual', text: '手工替代' });
    if (s.state === 'invalid') return h('span', { class: 'tag tag-danger', text: '无效' });
    return h('span', { class: 'tag tag-gap', text: '缺口' });
  }

  function hourlyTable(rows) {
    var tb = h('tbody');
    (rows || []).forEach(function (r) {
      var tr = h('tr', { class: 'row' + (r.state === 'gap' ? ' row-gap' : (r.state === 'manual' ? ' row-manual' : (r.state === 'invalid' ? ' row-invalid' : ''))) }, [
        h('td', { class: 'nowrap', text: r.at }),
        h('td', { class: 'mono', text: textOf(r.hour) }),
        h('td', { class: 'mono', text: r.value === null || r.value === undefined ? '—' : textOf(r.value) }),
        h('td', {}, stateTag(r)),
        h('td', {}, h('span', { class: 'tag ' + (r.flag === '有效' ? 'tag-ok' : 'tag-danger'), text: r.flag })),
        h('td', { text: textOf(r.deviceCode) }),
        h('td', {}, r.deviceStatus ? statusTag(r.deviceStatus, '正常') : h('span', { class: 'hint', text: '—' })),
        h('td', { class: 'mono', text: r.oxygen === null || r.oxygen === undefined ? '—' : textOf(r.oxygen) }),
        h('td', { class: 'mono', text: r.flow === null || r.flow === undefined ? '—' : textOf(r.flow) }),
        h('td', {}, h('span', { class: 'tag ' + (r.counted ? 'tag-ok' : 'tag-danger'), text: r.counted ? '计入' : '不计入' })),
        h('td', { class: 'mono', text: r.counted ? textOf(r.concentration) : '—' }),
        h('td', { class: 'hint', text: r.dropReason || '' })
      ]);
      tb.appendChild(tr);
    });
    return h('table', { class: 'mini-table' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '时刻' }), h('th', { text: '小时' }), h('th', { text: '数值' }), h('th', { text: '来源/状态' }),
        h('th', { text: '标记' }), h('th', { text: '设备' }), h('th', { text: '设备状态' }),
        h('th', { text: '氧含量' }), h('th', { text: '流量' }), h('th', { text: '是否计入' }),
        h('th', { text: '折算浓度' }), h('th', { text: '不计入原因' })
      ])),
      tb
    ]);
  }

  function dailyRow(d, metric) {
    var stateBadge;
    if (!d.valid) stateBadge = h('span', { class: 'tag tag-danger', text: '整日不计' });
    else if (d.manualHours > 0) stateBadge = h('span', { class: 'tag tag-manual', text: '含手工替代' });
    else if (d.imputedHours > 0) stateBadge = h('span', { class: 'tag tag-warn', text: '含补录' });
    else stateBadge = h('span', { class: 'tag tag-ok', text: '正常' });
    return expandableRow([
      h('td', { class: 'nowrap', text: d.day }),
      h('td', { class: 'mono', text: textOf(d.countedHours) }),
      h('td', { class: 'mono', text: textOf(d.autoHours) }),
      h('td', { class: 'mono num-warn', text: textOf(d.imputedHours) }),
      h('td', { class: 'mono num-manual', text: textOf(d.manualHours) }),
      h('td', { class: 'mono num-danger', text: textOf(d.invalidHours) }),
      h('td', { class: 'mono num-danger', text: textOf(d.gapHours) }),
      h('td', { class: 'mono', text: d.valid ? fmt(d.average) : '—' }),
      h('td', { class: 'hint', text: d.averageBasis || '' }),
      h('td', { class: 'mono', text: textOf(d.limit) }),
      h('td', {}, h('span', { class: 'tag ' + (d.exceed ? 'tag-danger' : 'tag-ok'), text: d.exceed ? '超标' : (d.valid ? '达标' : '不计') })),
      h('td', { class: 'mono', text: fmt(d.flowTotal, 1) }),
      h('td', {}, stateBadge),
      h('td', { class: 'hint', text: d.invalidReason || '' })
    ], function () {
      var wrap = h('div');
      wrap.appendChild(h('div', { class: 'section-note', text: d.day + ' · ' + metric + ' 逐小时明细（应监测 24 小时；缺口与无效小时显式列出）' }));
      wrap.appendChild(h('div', { class: 'table-wrap' }, hourlyTable(d.rows)));
      return wrap;
    });
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
          h('th', { text: '自动(吨)' }), h('th', { text: '补录(吨)' }), h('th', { text: '手工替代(吨)' }),
          h('th', { text: '手工h' }), h('th', { text: '缺口h' }),
          h('th', { text: '超标天数' }),
          h('th', { text: '超标小时' }), h('th', { text: '限值' }), h('th', { text: '超标' })
        ])),
        (function () {
          var tb = h('tbody');
          (os.rows || []).forEach(function (r) {
            tb.appendChild(h('tr', { class: 'row' }, [
              h('td', { text: r.metric }), h('td', { class: 'mono', text: fmt(r.monthAverage) }),
              h('td', { class: 'mono', text: fmt(r.monthTotalTons, 4) }),
              h('td', { class: 'mono', text: fmt(r.autoTons, 4) }),
              h('td', { class: 'mono num-warn', text: fmt(r.imputedTons, 4) }),
              h('td', { class: 'mono num-manual', text: fmt(r.manualTons, 4) }),
              h('td', { class: 'mono num-manual', text: textOf(r.manualHours) }),
              h('td', { class: 'mono num-danger', text: textOf(r.gapHours) }),
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
          holder.appendChild(h('div', { class: 'section-note', text: m + ' 逐日（' + series.length + ' 天）' }));
          if (!series.length) { holder.appendChild(h('div', { class: 'empty', text: '本月没有 ' + m + ' 数据' })); return; }
          var tb = h('tbody');
          series.forEach(function (d) {
            tb.appendChild(h('tr', { class: 'row' + (d.valid ? '' : ' row-gap') }, [
              h('td', { class: 'nowrap', text: d.day }), h('td', { class: 'mono', text: textOf(d.countedHours) }),
              h('td', { class: 'mono', text: textOf(d.autoHours) }),
              h('td', { class: 'mono num-warn', text: textOf(d.imputedHours) }),
              h('td', { class: 'mono num-manual', text: textOf(d.manualHours) }),
              h('td', { class: 'mono num-danger', text: textOf(d.gapHours) }),
              h('td', { class: 'mono', text: d.valid ? fmt(d.average) : '—' }),
              h('td', { class: 'mono', text: textOf(d.limit) }),
              h('td', {}, h('span', { class: 'tag ' + (d.exceed ? 'tag-danger' : 'tag-ok'), text: d.exceed ? '超标' : (d.valid ? '达标' : '不计') })),
              h('td', { class: 'mono', text: fmt(d.flowTotal, 1) }),
              h('td', { class: 'hint', text: d.invalidReason || '' })
            ]));
          });
          holder.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' }, [
            h('thead', {}, h('tr', {}, [
              h('th', { text: '日期' }), h('th', { text: '计入h' }), h('th', { text: '自动h' }),
              h('th', { text: '补录h' }), h('th', { text: '手工h' }), h('th', { text: '缺口h' }),
              h('th', { text: '日均' }), h('th', { text: '限值' }), h('th', { text: '判定' }),
              h('th', { text: '流量合计' }), h('th', { text: '不计入原因' })
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

    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: (sum.outlet ? (sum.outlet.code + ' ' + sum.outlet.name) : '排放口') + ' 汇总' }),
        h('span', { class: 'sub', text: (sum.plant ? (sum.plant.code + ' ' + sum.plant.name) : '') + ' · ' + month + ' · ' + metric })
      ]),
      h('div', { class: 'card-body' }, summaryCard(sum, metric))
    ]));

    var series = (daily.metrics || {})[metric] || [];
    var dailyTb = h('tbody');
    series.forEach(function (d) { dailyTb.appendChild(dailyRow(d, metric)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: metric + ' 逐日明细' }),
        h('span', { class: 'sub', text: '共 ' + series.length + ' 天（点某天展开逐小时明细）' })
      ]),
      h('div', { class: 'table-wrap' }, h('table', { id: 'tableDaily' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '日期' }), h('th', { text: '计入h' }), h('th', { text: '自动h' }),
          h('th', { text: '补录h' }), h('th', { text: '手工替代h' }), h('th', { text: '无效h' }), h('th', { text: '缺口h' }),
          h('th', { text: '日均' }), h('th', { text: '口径' }), h('th', { text: '限值' }),
          h('th', { text: '判定' }), h('th', { text: '流量合计' }), h('th', { text: '日状态' }), h('th', { text: '不计入原因' })
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
      { name: 'maxManualSpanHours', label: '单次故障/送检最长替代小时数', type: 'number' },
      { name: 'manualMinSamplesPerDay', label: '替代日每日最少手工监测次数', type: 'number' },
      { name: 'manualMaxCoverageRatio', label: '单月手工替代比例上限（0–1）', type: 'number', step: '0.05' },
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
