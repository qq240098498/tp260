const { AppError } = require('./errors');
const store = require('./store');
const monitor = require('./monitor');

const PLANT_STATUS = ['生产', '停产', '调试'];
const OUTLET_STATUS = ['运行', '停用'];
const OUTLET_TYPE = ['主要排放口', '一般排放口'];
const DEVICE_STATUS = ['正常', '校准', '维护', '故障'];
const METRICS = ['COD', '氨氮', '流量', '氧含量'];
const MANUAL_METRICS = ['COD', '氨氮']; // 手工替代取证只针对污染物浓度
const FLAGS = ['有效', '无效'];
const SOURCES = ['自动', '补录'];
const OUTAGE_REASONS = ['故障', '送检', '维护'];
const REVIEW_STATUS = ['待复核', '已复核', '复核退回'];
const REPORT_STATUS = ['草稿', '已上报', '退回'];

const AT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;

function decoratePlant(data, plant, month) {
  const outlets = monitor.outletsOf(data, plant.id);
  return Object.assign({}, plant, {
    outletCount: outlets.length,
    deviceCount: data.devices.filter((d) => outlets.some((o) => o.id === d.outletId)).length,
    readingCount: data.readings.filter((r) => outlets.some((o) => o.id === r.outletId)).length,
    reportCount: data.reports.filter((r) => r.plantId === plant.id).length,
    outletList: outlets.map((o) => Object.assign({}, o, {
      deviceCount: data.devices.filter((d) => d.outletId === o.id).length,
      readingCount: data.readings.filter((r) => r.outletId === o.id).length,
    })),
  });
}

function listPlants(data, query) {
  const q = query || {};
  let rows = data.plants.slice();
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((p) => [p.code, p.name, p.industry].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  return rows.map((p) => decoratePlant(data, p)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function plantDetail(data, id) {
  const plant = data.plants.find((p) => p.id === id);
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  const outlets = monitor.outletsOf(data, plant.id);
  return Object.assign({}, decoratePlant(data, plant), {
    outlets: outlets.map((o) => Object.assign({}, o, {
      devices: data.devices.filter((d) => d.outletId === o.id),
      deviceCount: data.devices.filter((d) => d.outletId === o.id).length,
      readingCount: data.readings.filter((r) => r.outletId === o.id).length,
    })),
    reports: data.reports.filter((r) => r.plantId === plant.id).sort((a, b) => (a.period < b.period ? 1 : -1)),
    findings: (data.findings || []).filter((f) => f.plantId === plant.id),
  });
}

function validatePlant(payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!String(merged.name || '').trim()) errors.name = '名称不能为空';
  if (!PLANT_STATUS.includes(merged.status)) errors.status = '状态只能是：' + PLANT_STATUS.join('、');
  if (!String(merged.permitNo || '').trim()) errors.permitNo = '排污许可证号不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createPlant(data, payload) {
  validatePlant(payload, null);
  const plant = {
    id: store.nextId('pt', data.plants),
    code: String(payload.code).trim(),
    name: String(payload.name).trim(),
    industry: String(payload.industry || '').trim(),
    status: payload.status,
    permitNo: String(payload.permitNo).trim(),
    permitYearStart: String(payload.permitYearStart || data.settings.permitYearStart),
    remark: String(payload.remark || ''),
  };
  data.plants.push(plant);
  return decoratePlant(data, plant);
}

function updatePlant(data, id, payload) {
  const plant = data.plants.find((p) => p.id === id);
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  validatePlant(payload, plant);
  const merged = Object.assign({}, plant, payload);
  Object.assign(plant, {
    name: String(merged.name).trim(),
    industry: String(merged.industry || '').trim(),
    status: merged.status,
    permitNo: String(merged.permitNo).trim(),
    permitYearStart: String(merged.permitYearStart || plant.permitYearStart),
    remark: String(merged.remark || ''),
  });
  return decoratePlant(data, plant);
}

function removePlant(data, id) {
  const plant = data.plants.find((p) => p.id === id);
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  const outlets = monitor.outletsOf(data, plant.id);
  const used = outlets.length + data.readings.filter((r) => outlets.some((o) => o.id === r.outletId)).length;
  if (used > 0) throw new AppError(409, 'PLANT_IN_USE', '名下还有排放口与监测数据，不能删除', { count: used });
  data.plants = data.plants.filter((p) => p.id !== id);
  return { removed: id };
}

function listOutlets(data, query) {
  const q = query || {};
  let rows = data.outlets.slice();
  if (q.plantId) rows = rows.filter((o) => o.plantId === q.plantId);
  if (q.status) rows = rows.filter((o) => o.status === q.status);
  return rows.map((o) => {
    const plant = monitor.plantOf(data, o.plantId);
    return Object.assign({}, o, {
      plantCode: plant ? plant.code : '',
      plantName: plant ? plant.name : '',
      deviceCount: data.devices.filter((d) => d.outletId === o.id).length,
      readingCount: data.readings.filter((r) => r.outletId === o.id).length,
    });
  }).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateOutlet(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!data.plants.some((p) => p.id === merged.plantId)) errors.plantId = '排污单位不存在';
  if (!OUTLET_TYPE.includes(merged.type)) errors.type = '类型只能是：' + OUTLET_TYPE.join('、');
  if (!OUTLET_STATUS.includes(merged.status)) errors.status = '状态只能是：' + OUTLET_STATUS.join('、');
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createOutlet(data, payload) {
  validateOutlet(data, payload, null);
  const outlet = {
    id: store.nextId('ol', data.outlets),
    code: String(payload.code).trim(),
    name: String(payload.name || '').trim(),
    plantId: payload.plantId,
    type: payload.type,
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.outlets.push(outlet);
  return outlet;
}

function updateOutlet(data, id, payload) {
  const outlet = data.outlets.find((o) => o.id === id);
  if (!outlet) throw new AppError(404, 'OUTLET_NOT_FOUND', '这个排放口不存在');
  validateOutlet(data, payload, outlet);
  const merged = Object.assign({}, outlet, payload);
  Object.assign(outlet, {
    name: String(merged.name || '').trim(),
    plantId: merged.plantId,
    type: merged.type,
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return outlet;
}

function removeOutlet(data, id) {
  const outlet = data.outlets.find((o) => o.id === id);
  if (!outlet) throw new AppError(404, 'OUTLET_NOT_FOUND', '这个排放口不存在');
  const used = data.readings.filter((r) => r.outletId === id).length;
  if (used > 0) throw new AppError(409, 'OUTLET_IN_USE', '这个排放口名下还有 ' + used + ' 条监测数据，不能删除', { count: used });
  data.devices = data.devices.filter((d) => d.outletId !== id);
  data.outlets = data.outlets.filter((o) => o.id !== id);
  return { removed: id };
}

function listDevices(data, query) {
  const q = query || {};
  let rows = data.devices.slice();
  if (q.outletId) rows = rows.filter((d) => d.outletId === q.outletId);
  if (q.metric) rows = rows.filter((d) => d.metric === q.metric);
  if (q.status) rows = rows.filter((d) => d.status === q.status);
  return rows.map((d) => {
    const outlet = monitor.outletOf(data, d.outletId);
    return Object.assign({}, d, {
      outletCode: outlet ? outlet.code : '',
      readingCount: data.readings.filter((r) => r.deviceId === d.id).length,
      invalidCount: data.readings.filter((r) => r.deviceId === d.id && r.flag !== '有效').length,
    });
  }).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateDevice(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编号不能为空';
  if (!data.outlets.some((o) => o.id === merged.outletId)) errors.outletId = '排放口不存在';
  if (!METRICS.includes(merged.metric)) errors.metric = '监测指标只能是：' + METRICS.join('、');
  if (!DEVICE_STATUS.includes(merged.status)) errors.status = '设备状态只能是：' + DEVICE_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.calibratedUntil || ''))) errors.calibratedUntil = '校准有效期要像 2026-12-31';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createDevice(data, payload) {
  validateDevice(data, payload, null);
  const device = {
    id: store.nextId('dv', data.devices),
    code: String(payload.code).trim(),
    outletId: payload.outletId,
    metric: payload.metric,
    model: String(payload.model || '').trim(),
    status: payload.status,
    calibratedUntil: String(payload.calibratedUntil),
    remark: String(payload.remark || ''),
  };
  data.devices.push(device);
  return device;
}

function updateDevice(data, id, payload) {
  const device = data.devices.find((d) => d.id === id);
  if (!device) throw new AppError(404, 'DEVICE_NOT_FOUND', '这个监测设备不存在');
  validateDevice(data, payload, device);
  const merged = Object.assign({}, device, payload);
  Object.assign(device, {
    outletId: merged.outletId,
    metric: merged.metric,
    model: String(merged.model || '').trim(),
    status: merged.status,
    calibratedUntil: String(merged.calibratedUntil),
    remark: String(merged.remark || ''),
  });
  return device;
}

function removeDevice(data, id) {
  const device = data.devices.find((d) => d.id === id);
  if (!device) throw new AppError(404, 'DEVICE_NOT_FOUND', '这个监测设备不存在');
  const used = data.readings.filter((r) => r.deviceId === id).length;
  if (used > 0) throw new AppError(409, 'DEVICE_IN_USE', '这台设备名下还有 ' + used + ' 条监测数据，不能删除', { count: used });
  data.devices = data.devices.filter((d) => d.id !== id);
  return { removed: id };
}

function listReadings(data, query) {
  const q = query || {};
  let rows = monitor.readingsOf(data, q);
  if (q.flag) rows = rows.filter((r) => r.flag === q.flag);
  // 复核状态是手工记录的属性：一旦按复核状态筛选，自动读数不参与
  if (q.reviewStatus) rows = [];
  if (q.source === '手工替代') rows = [];
  else if (q.source) rows = rows.filter((r) => r.source === q.source);
  const limit = Number(q.limit) > 0 ? Number(q.limit) : 500;
  const autoRows = rows.slice(0, limit).map((r) => decorateReading(data, r));

  // 手工监测记录与自动读数在同一张清单里区分展示（可按来源、复核状态筛选）
  let manualRows = [];
  if (q.source !== '自动' && q.source !== '补录') {
    const mq = {
      outletId: q.outletId, deviceId: q.deviceId, metric: q.metric,
      day: q.day, month: q.month, reviewStatus: q.reviewStatus,
    };
    const cap = q.source === '手工替代' ? limit : Math.max(limit - autoRows.length, 0);
    manualRows = monitor.manualRecordsOf(data, mq).slice(0, cap).map((r) => decorateManual(data, r));
  }
  const all = autoRows.concat(manualRows).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, limit);
  const manualTotal = monitor.manualRecordsOf(data, {
    outletId: q.outletId, deviceId: q.deviceId, metric: q.metric, day: q.day, month: q.month, reviewStatus: q.reviewStatus,
  }).length;
  return {
    total: rows.length + manualTotal,
    returned: all.length,
    autoCount: autoRows.length,
    manualCount: manualRows.length,
    rows: all,
  };
}

function decorateReading(data, row) {
  const device = monitor.deviceOf(data, row.deviceId);
  const outlet = monitor.outletOf(data, row.outletId);
  return Object.assign({}, row, {
    rowKind: 'auto',
    deviceCode: device ? device.code : '',
    deviceStatus: device ? device.status : '',
    outletCode: outlet ? outlet.code : '',
    counted: monitor.isCounted(data, row, device),
    concentration: monitor.effectiveConcentration(data, row.value, row.outletId, row.at),
    oxygen: monitor.oxygenAt(data, row.outletId, row.at),
    flow: monitor.flowAt(data, row.outletId, row.at),
    reviewStatus: '',
  });
}

function decorateManual(data, row) {
  const device = monitor.deviceOf(data, row.deviceId);
  const outlet = monitor.outletOf(data, row.outletId);
  const outage = monitor.outageAt(data, row.deviceId, row.at);
  return Object.assign({}, row, {
    rowKind: 'manual',
    source: '手工替代',
    deviceCode: device ? device.code : '',
    deviceStatus: device ? device.status : '',
    outletCode: outlet ? outlet.code : '',
    flag: '有效',
    counted: row.reviewStatus === '已复核' && !!outage,
    concentration: monitor.effectiveConcentration(data, row.value, row.outletId, row.at),
    oxygen: monitor.oxygenAt(data, row.outletId, row.at),
    flow: monitor.flowAt(data, row.outletId, row.at),
    outageId: outage ? outage.id : '',
    outageReason: outage ? outage.reason : '',
  });
}

function validateReading(data, payload) {
  const errors = {};
  if (!data.outlets.some((o) => o.id === payload.outletId)) errors.outletId = '排放口不存在';
  if (!data.devices.some((d) => d.id === payload.deviceId)) errors.deviceId = '监测设备不存在';
  if (!METRICS.includes(payload.metric)) errors.metric = '监测指标只能是：' + METRICS.join('、');
  if (!FLAGS.includes(payload.flag)) errors.flag = '数据标记只能是：' + FLAGS.join('、');
  if (!SOURCES.includes(payload.source)) errors.source = '来源只能是：' + SOURCES.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/.test(String(payload.at || ''))) errors.at = '时刻要像 2026-09-01 08:00:00';
  if (payload.value === undefined || payload.value === '') errors.value = '数值不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条监测数据没通过校验', errors);
}

function createReading(data, payload) {
  validateReading(data, payload);
  const reading = {
    id: store.nextId('rd', data.readings),
    outletId: payload.outletId,
    deviceId: payload.deviceId,
    metric: payload.metric,
    at: String(payload.at),
    value: Number(payload.value),
    flag: payload.flag,
    source: payload.source,
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.readings.push(reading);
  return decorateReading(data, reading);
}

function updateReading(data, id, payload) {
  const reading = data.readings.find((r) => r.id === id);
  if (!reading) throw new AppError(404, 'READING_NOT_FOUND', '这条监测数据不存在');
  validateReading(data, Object.assign({}, reading, payload));
  Object.assign(reading, {
    at: String(payload.at || reading.at),
    value: payload.value === undefined ? reading.value : Number(payload.value),
    flag: payload.flag || reading.flag,
    source: payload.source || reading.source,
    remark: payload.remark === undefined ? reading.remark : String(payload.remark),
  });
  return decorateReading(data, reading);
}

function removeReading(data, id) {
  const reading = data.readings.find((r) => r.id === id);
  if (!reading) throw new AppError(404, 'READING_NOT_FOUND', '这条监测数据不存在');
  data.readings = data.readings.filter((r) => r.id !== id);
  return { removed: id };
}

/* ================= 设备故障/送检时段登记 ================= */

function decorateOutage(data, o) {
  const device = monitor.deviceOf(data, o.deviceId);
  const outlet = monitor.outletOf(data, o.outletId);
  const records = monitor.manualRecordsOf(data, { deviceId: o.deviceId });
  const inPeriod = records.filter((r) => r.at >= o.startAt && r.at <= o.endAt);
  return Object.assign({}, o, {
    deviceCode: device ? device.code : '',
    outletCode: outlet ? outlet.code : '',
    outletName: outlet ? outlet.name : '',
    metric: device ? device.metric : '',
    manualCount: inPeriod.length,
    reviewedCount: inPeriod.filter((r) => r.reviewStatus === '已复核').length,
    pendingCount: inPeriod.filter((r) => r.reviewStatus === '待复核').length,
  });
}

function listOutages(data, query) {
  const q = query || {};
  const filter = {
    deviceId: q.deviceId,
    outletId: q.outletId,
    intersectStart: q.from || undefined,
    intersectEnd: q.to || undefined,
  };
  let rows = monitor.outagesOf(data, filter);
  if (q.reason) rows = rows.filter((o) => o.reason === q.reason);
  return rows.map((o) => decorateOutage(data, o));
}

function validateOutage(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!data.devices.some((d) => d.id === merged.deviceId)) errors.deviceId = '监测设备不存在';
  else {
    const device = data.devices.find((d) => d.id === merged.deviceId);
    if (merged.outletId && merged.outletId !== device.outletId) errors.outletId = '排放口与设备所属排放口不一致';
  }
  if (!OUTAGE_REASONS.includes(merged.reason)) errors.reason = '原因只能是：' + OUTAGE_REASONS.join('、');
  if (!AT_RE.test(String(merged.startAt || ''))) errors.startAt = '开始时刻要像 2026-09-16 00:00:00';
  if (!AT_RE.test(String(merged.endAt || ''))) errors.endAt = '结束时刻要像 2026-09-21 23:00:00';
  if (!errors.startAt && !errors.endAt && String(merged.endAt) <= String(merged.startAt)) errors.endAt = '结束时刻必须晚于开始时刻';
  if (!String(merged.registeredBy || '').trim()) errors.registeredBy = '登记人不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这段设备时段没通过校验', errors);
  // 同一设备时段不许重叠
  const clash = (data.deviceOutages || []).find((o) => o.deviceId === merged.deviceId && o.id !== (current ? current.id : null)
    && !(String(merged.endAt) < o.startAt || String(merged.startAt) > o.endAt));
  if (clash) throw new AppError(409, 'OUTAGE_OVERLAP', '与该设备已登记的另一段故障/送检时段重叠', { clashWith: clash.id, startAt: clash.startAt, endAt: clash.endAt });
}

function createOutage(data, payload) {
  validateOutage(data, payload, null);
  const device = data.devices.find((d) => d.id === payload.deviceId);
  const outage = {
    id: store.nextId('ot', data.deviceOutages),
    deviceId: payload.deviceId,
    outletId: device.outletId,
    reason: payload.reason,
    startAt: String(payload.startAt),
    endAt: String(payload.endAt),
    registeredBy: String(payload.registeredBy).trim(),
    registeredAt: String(payload.registeredAt || store.nowText()),
    remark: String(payload.remark || ''),
  };
  data.deviceOutages.push(outage);
  return decorateOutage(data, outage);
}

function updateOutage(data, id, payload) {
  const outage = data.deviceOutages.find((o) => o.id === id);
  if (!outage) throw new AppError(404, 'OUTAGE_NOT_FOUND', '这段设备时段不存在');
  validateOutage(data, payload, outage);
  Object.assign(outage, {
    reason: payload.reason || outage.reason,
    startAt: payload.startAt ? String(payload.startAt) : outage.startAt,
    endAt: payload.endAt ? String(payload.endAt) : outage.endAt,
    registeredBy: payload.registeredBy ? String(payload.registeredBy).trim() : outage.registeredBy,
    remark: payload.remark === undefined ? outage.remark : String(payload.remark),
  });
  return decorateOutage(data, outage);
}

function removeOutage(data, id) {
  const outage = data.deviceOutages.find((o) => o.id === id);
  if (!outage) throw new AppError(404, 'OUTAGE_NOT_FOUND', '这段设备时段不存在');
  data.deviceOutages = data.deviceOutages.filter((o) => o.id !== id);
  return { removed: id };
}

/* ================= 手工监测（替代取证）记录 ================= */

function listManualRecords(data, query) {
  const q = query || {};
  return monitor.manualRecordsOf(data, q).map((r) => decorateManual(data, r));
}

function manualDetail(data, id) {
  const row = (data.manualRecords || []).find((r) => r.id === id);
  if (!row) throw new AppError(404, 'MANUAL_NOT_FOUND', '这条手工监测记录不存在');
  return decorateManual(data, row);
}

function validateManual(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  const device = data.devices.find((d) => d.id === merged.deviceId);
  if (!data.outlets.some((o) => o.id === merged.outletId)) errors.outletId = '排放口不存在';
  if (!device) errors.deviceId = '监测设备不存在';
  else if (merged.outletId && merged.outletId !== device.outletId) errors.deviceId = '设备不属于该排放口';
  if (!MANUAL_METRICS.includes(merged.metric)) errors.metric = '手工替代监测指标只能是：' + MANUAL_METRICS.join('、');
  else if (device && device.metric !== merged.metric) errors.metric = '指标与该设备监测指标不一致';
  if (!AT_RE.test(String(merged.at || ''))) errors.at = '采样时刻要像 2026-09-16 08:30:00';
  if (merged.value === undefined || merged.value === '' || !Number.isFinite(Number(merged.value))) errors.value = '监测结果数值不能为空且必须是数字';
  if (!String(merged.method || '').trim()) errors.method = '监测方法（含标准号）不能为空';
  if (merged.detectLimit === undefined || merged.detectLimit === '' || !Number.isFinite(Number(merged.detectLimit)) || Number(merged.detectLimit) < 0) errors.detectLimit = '检出限必须是不小于 0 的数字';
  if (!String(merged.resultUnit || '').trim()) errors.resultUnit = '结果单位不能为空';
  if (!String(merged.labName || '').trim()) errors.labName = '监测单位（实验室）不能为空';
  if (!String(merged.evidenceNo || '').trim()) errors.evidenceNo = '监测报告/原始记录编号不能为空';
  if (!String(merged.sampledBy || '').trim()) errors.sampledBy = '采样人不能为空';
  if (!String(merged.registeredBy || '').trim()) errors.registeredBy = '登记人不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条手工监测记录缺少入账依据', errors);
  // 采样时刻必须落在该设备已登记的故障/送检时段内
  const outage = (data.deviceOutages || []).find((o) => o.deviceId === merged.deviceId && String(merged.at) >= o.startAt && String(merged.at) <= o.endAt);
  if (!outage) {
    throw new AppError(409, 'NO_OUTAGE_WINDOW', '采样时刻不在该设备已登记的故障/送检时段内，没有替代取证依据，不许入账', {
      at: merged.at, deviceId: merged.deviceId,
    });
  }
  return outage;
}

function createManual(data, payload) {
  const outage = validateManual(data, payload, null);
  const record = {
    id: store.nextId('mr', data.manualRecords),
    outletId: payload.outletId,
    deviceId: payload.deviceId,
    metric: payload.metric,
    at: String(payload.at),
    value: Number(payload.value),
    method: String(payload.method).trim(),
    detectLimit: Number(payload.detectLimit),
    resultUnit: String(payload.resultUnit).trim(),
    labName: String(payload.labName).trim(),
    evidenceNo: String(payload.evidenceNo).trim(),
    sampledBy: String(payload.sampledBy).trim(),
    reviewStatus: '待复核',
    reviewedBy: '',
    reviewedAt: '',
    registeredBy: String(payload.registeredBy).trim(),
    registeredAt: String(payload.registeredAt || store.nowText()),
    remark: String(payload.remark || ''),
    outageId: outage.id,
  };
  data.manualRecords.push(record);
  return decorateManual(data, record);
}

function updateManual(data, id, payload) {
  const record = data.manualRecords.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'MANUAL_NOT_FOUND', '这条手工监测记录不存在');
  if (record.reviewStatus === '已复核') {
    throw new AppError(409, 'MANUAL_REVIEWED_LOCKED', '已复核的手工记录已作为等效值入账，不能直接修改；如需更正请先由复核人退回', { id });
  }
  validateManual(data, payload, record);
  Object.assign(record, {
    outletId: payload.outletId || record.outletId,
    deviceId: payload.deviceId || record.deviceId,
    metric: payload.metric || record.metric,
    at: payload.at ? String(payload.at) : record.at,
    value: payload.value === undefined ? record.value : Number(payload.value),
    method: payload.method === undefined ? record.method : String(payload.method).trim(),
    detectLimit: payload.detectLimit === undefined ? record.detectLimit : Number(payload.detectLimit),
    resultUnit: payload.resultUnit === undefined ? record.resultUnit : String(payload.resultUnit).trim(),
    labName: payload.labName === undefined ? record.labName : String(payload.labName).trim(),
    evidenceNo: payload.evidenceNo === undefined ? record.evidenceNo : String(payload.evidenceNo).trim(),
    sampledBy: payload.sampledBy === undefined ? record.sampledBy : String(payload.sampledBy).trim(),
    registeredBy: payload.registeredBy === undefined ? record.registeredBy : String(payload.registeredBy).trim(),
    remark: payload.remark === undefined ? record.remark : String(payload.remark),
  });
  const outage = validateManual(data, record, record);
  record.outageId = outage.id;
  return decorateManual(data, record);
}

function reviewManual(data, id, payload) {
  const record = data.manualRecords.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'MANUAL_NOT_FOUND', '这条手工监测记录不存在');
  const action = payload && payload.action ? String(payload.action) : (record.reviewStatus === '待复核' ? 'approve' : record.reviewStatus === '已复核' ? 'reject' : 'approve');
  const errors = {};
  if (!['approve', 'reject'].includes(action)) errors.action = '复核动作只能是 approve / reject';
  if (!String((payload || {}).reviewedBy || '').trim()) errors.reviewedBy = '复核人不能为空';
  if (action === 'approve' && String((payload || {}).reviewedBy).trim() === String(record.sampledBy)) {
    errors.reviewedBy = '复核人不能与采样人为同一人';
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '复核没通过校验', errors);
  if (action === 'approve') {
    record.reviewStatus = '已复核';
    record.reviewedBy = String(payload.reviewedBy).trim();
    record.reviewedAt = String(payload.reviewedAt || store.nowText());
  } else {
    record.reviewStatus = '复核退回';
    record.reviewedBy = String(payload.reviewedBy).trim();
    record.reviewedAt = String(payload.reviewedAt || store.nowText());
  }
  return decorateManual(data, record);
}

function removeManual(data, id) {
  const record = data.manualRecords.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'MANUAL_NOT_FOUND', '这条手工监测记录不存在');
  if (record.reviewStatus === '已复核') {
    throw new AppError(409, 'MANUAL_REVIEWED_LOCKED', '已复核的手工记录已作为等效值入账，不能删除；如需更正请先退回', { id });
  }
  data.manualRecords = data.manualRecords.filter((r) => r.id !== id);
  return { removed: id };
}

function listReports(data, query) {
  const q = query || {};
  let rows = data.reports.slice();
  if (q.plantId) rows = rows.filter((r) => r.plantId === q.plantId);
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  return rows.map((r) => {
    const plant = monitor.plantOf(data, r.plantId);
    return Object.assign({}, r, { plantCode: plant ? plant.code : '', plantName: plant ? plant.name : '' });
  }).sort((a, b) => (a.period < b.period ? 1 : -1));
}

function reportDetail(data, id) {
  const report = data.reports.find((r) => r.id === id);
  if (!report) throw new AppError(404, 'REPORT_NOT_FOUND', '这张报表不存在');
  const plant = monitor.plantOf(data, report.plantId);
  const month = String(report.period).slice(0, 7);
  const outlets = monitor.outletsOf(data, report.plantId).map((o) => monitor.outletSummary(data, o.id, month));
  return Object.assign({}, report, { plant, month, outlets });
}

function createReport(data, payload) {
  const errors = {};
  if (!data.plants.some((p) => p.id === payload.plantId)) errors.plantId = '排污单位不存在';
  if (!/^\d{4}-\d{2}$/.test(String(payload.period || ''))) errors.period = '期间要像 2026-09';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这张报表没通过校验', errors);
  const report = {
    id: store.nextId('rp', data.reports),
    plantId: payload.plantId,
    period: String(payload.period),
    status: payload.status || '草稿',
    submittedAt: payload.submittedAt || '',
    submittedBy: String(payload.submittedBy || ''),
    remark: String(payload.remark || ''),
  };
  data.reports.push(report);
  return report;
}

function updateReport(data, id, payload) {
  const report = data.reports.find((r) => r.id === id);
  if (!report) throw new AppError(404, 'REPORT_NOT_FOUND', '这张报表不存在');
  if (payload.status && !REPORT_STATUS.includes(payload.status)) {
    throw new AppError(400, 'VALIDATION_FAILED', '状态只能是：' + REPORT_STATUS.join('、'), { status: '状态取值不对' });
  }
  if (payload.status) report.status = payload.status;
  if (payload.submittedAt !== undefined) report.submittedAt = String(payload.submittedAt);
  if (payload.submittedBy !== undefined) report.submittedBy = String(payload.submittedBy);
  if (payload.remark !== undefined) report.remark = String(payload.remark);
  return report;
}

module.exports = {
  listPlants, plantDetail, createPlant, updatePlant, removePlant,
  listOutlets, createOutlet, updateOutlet, removeOutlet,
  listDevices, createDevice, updateDevice, removeDevice,
  listReadings, createReading, updateReading, removeReading, decorateReading,
  listOutages, createOutage, updateOutage, removeOutage, decorateOutage,
  listManualRecords, manualDetail, createManual, updateManual, reviewManual, removeManual, decorateManual,
  listReports, reportDetail, createReport, updateReport,
  PLANT_STATUS, OUTLET_STATUS, OUTLET_TYPE, DEVICE_STATUS, METRICS, MANUAL_METRICS, FLAGS, SOURCES,
  OUTAGE_REASONS, REVIEW_STATUS, REPORT_STATUS,
};
