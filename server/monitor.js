// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可、手工替代取证
const store = require('./store');

const POLLUTANTS = ['COD', '氨氮'];
const HOURS_PER_DAY = 24;

function plantOf(data, id) {
  return data.plants.find((p) => p.id === id) || null;
}
function outletOf(data, id) {
  return data.outlets.find((o) => o.id === id) || null;
}
function deviceOf(data, id) {
  return data.devices.find((d) => d.id === id) || null;
}

function readingsOf(data, query) {
  const q = query || {};
  let rows = data.readings.slice();
  if (q.outletId) rows = rows.filter((r) => r.outletId === q.outletId);
  if (q.deviceId) rows = rows.filter((r) => r.deviceId === q.deviceId);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (q.day) rows = rows.filter((r) => store.dayOf(r.at) === q.day);
  if (q.month) rows = rows.filter((r) => store.monthOf(r.at) === q.month);
  return rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function manualRecordsOf(data, query) {
  const q = query || {};
  let rows = (data.manualRecords || []).slice();
  if (q.outletId) rows = rows.filter((r) => r.outletId === q.outletId);
  if (q.deviceId) rows = rows.filter((r) => r.deviceId === q.deviceId);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (q.reviewStatus) rows = rows.filter((r) => r.reviewStatus === q.reviewStatus);
  if (q.day) rows = rows.filter((r) => store.dayOf(r.at) === q.day);
  if (q.month) rows = rows.filter((r) => store.monthOf(r.at) === q.month);
  return rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function outagesOf(data, query) {
  const q = query || {};
  let rows = (data.deviceOutages || []).slice();
  if (q.deviceId) rows = rows.filter((o) => o.deviceId === q.deviceId);
  if (q.outletId) rows = rows.filter((o) => o.outletId === q.outletId);
  if (q.intersectStart || q.intersectEnd) {
    rows = rows.filter((o) => (!q.intersectStart || o.endAt >= q.intersectStart) && (!q.intersectEnd || o.startAt <= q.intersectEnd));
  }
  return rows.sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
}

function inWindow(at, start, end) {
  return (!start || at >= start) && (!end || at <= end);
}

function outageAt(data, deviceId, at) {
  return (data.deviceOutages || []).find((o) => o.deviceId === deviceId && inWindow(at, o.startAt, o.endAt)) || null;
}

// 某排放口某指标在某时刻处于登记的故障/送检时段（按该指标的设备判定）
function metricOutageAt(data, outletId, metric, at) {
  const devices = data.devices.filter((d) => d.outletId === outletId && d.metric === metric).map((d) => d.id);
  const ot = (data.deviceOutages || []).find((o) => devices.includes(o.deviceId) && inWindow(at, o.startAt, o.endAt));
  return ot || null;
}

// 口径 1：只有有效小时值参与统计——标记有效、时刻不在登记的故障/送检时段内、单位与排放口在生产运行、数值在量程内。
// 设备时变状态以「故障/送检时段登记」为准（台账里的当前状态不追溯否定时段之外的历史读数）。
function isCounted(data, reading, device) {
  const settings = data.settings;
  if (!reading || reading.flag !== '有效') return false;
  const dev = device || deviceOf(data, reading.deviceId);
  if (!dev) return false;
  if (outageAt(data, dev.id, reading.at)) return false;
  const outlet = outletOf(data, reading.outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;
  if (!outlet || !plant || outlet.status !== '运行' || plant.status !== '生产') return false;
  const v = Number(reading.value);
  if (!Number.isFinite(v) || v < Number(settings.rangeMin)) return false;
  // 量程上下限只约束污染物浓度；流量、氧含量不套用量程
  if (POLLUTANTS.includes(reading.metric) && v > Number(settings.rangeMax)) return false;
  return true;
}

// 口径 2：折算浓度 = 实测浓度 × (21 − 基准氧) / (21 − 实测氧含量)；氧含量缺失（含替代时段氧仪无数据）按基准氧处理
function effectiveConcentration(data, value, outletId, at) {
  const settings = data.settings;
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  const oxy = oxygenAt(data, outletId, at);
  if (oxy === null) return store.round(v, 4);
  const denom = 21 - oxy;
  if (denom <= 0) return store.round(v, 4);
  return store.round(v * (21 - Number(settings.oxygenBaseline)) / denom, 4);
}

function hourKeyAt(outletId, metric, at) {
  return outletId + '|' + metric + '|' + String(at).slice(0, 13);
}

// 某时刻（手工采样取所在整点）的氧含量：同排放口同时刻、有效且设备正常
function oxygenAt(data, outletId, at) {
  const hour = String(at).slice(0, 13);
  const row = data.readings.find((r) => r.outletId === outletId && r.metric === '氧含量' && String(r.at).slice(0, 13) === hour);
  if (!row) return null;
  return isCounted(data, row, deviceOf(data, row.deviceId)) ? Number(row.value) : null;
}

function flowMapForDay(data, outletId, day) {
  const map = {};
  readingsOf(data, { outletId, metric: '流量', day }).forEach((r) => {
    if (isCounted(data, r, deviceOf(data, r.deviceId))) map[Number(String(r.at).slice(11, 13))] = Number(r.value);
  });
  return map;
}

function flowAt(data, outletId, at) {
  const hour = Number(String(at).slice(11, 13));
  const row = data.readings.find((r) => r.outletId === outletId && r.metric === '流量' && String(r.at).slice(0, 13) === String(at).slice(0, 13));
  if (!row) return 0;
  return isCounted(data, row, deviceOf(data, row.deviceId)) ? Number(row.value) : 0;
}

function isStopped(data, outletId) {
  const outlet = outletOf(data, outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;
  return !!(outlet && plant && (outlet.status === '停用' || plant.status === '停产'));
}

// 故障前 N 个有效日的小时平均流量（m³/h），跨月往前找
function priorMeanFlow(data, outletId, day, lookbackDays) {
  const n = Number(lookbackDays) > 0 ? Number(lookbackDays) : 7;
  let values = [];
  let cursor = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) - 1));
  for (let i = 0; i < n; i += 1) {
    cursor = new Date(cursor.getTime() - 86400000);
    const dy = cursor.getUTCFullYear() + '-' + String(cursor.getUTCMonth() + 1).padStart(2, '0') + '-' + String(cursor.getUTCDate()).padStart(2, '0');
    values = values.concat(Object.values(flowMapForDay(data, outletId, dy)));
    if (values.length >= 24) break;
  }
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// 一天里该排放口某指标的逐小时明细（自动读数 + 已复核手工替代，按整点归并）
function dayRows(data, outletId, metric, day) {
  const rows = readingsOf(data, { outletId, metric, day });
  return rows.map((row) => {
    const device = deviceOf(data, row.deviceId);
    const counted = isCounted(data, row, device);
    return {
      id: row.id,
      kind: 'auto',
      at: row.at,
      hour: Number(String(row.at).slice(11, 13)),
      value: Number(row.value),
      source: row.source,
      flag: row.flag,
      deviceCode: device ? device.code : '',
      deviceStatus: device ? device.status : '',
      oxygen: oxygenAt(data, outletId, row.at),
      flow: flowAt(data, outletId, row.at),
      counted,
      concentration: counted ? effectiveConcentration(data, row.value, outletId, row.at, metric) : 0,
    };
  });
}

// 已复核手工样本按整点归并（同一小时多条取均值，依据全部保留）
function manualPointsOfDay(data, outletId, metric, day) {
  const records = manualRecordsOf(data, { outletId, metric, day, reviewStatus: '已复核' });
  const byHour = {};
  records.forEach((r) => {
    const hour = Number(String(r.at).slice(11, 13));
    if (!byHour[hour]) byHour[hour] = { hour, records: [], values: [] };
    byHour[hour].records.push(r);
    byHour[hour].values.push(Number(r.value));
  });
  return Object.keys(byHour).map((h) => {
    const g = byHour[h];
    const value = g.values.reduce((a, b) => a + b, 0) / g.values.length;
    const first = g.records[0];
    const at = day + ' ' + String(g.hour).padStart(2, '0') + ':00:00';
    return {
      kind: 'manual',
      hour: g.hour,
      at,
      value: store.round(value, 4),
      concentration: effectiveConcentration(data, value, outletId, at, metric),
      oxygen: oxygenAt(data, outletId, at),
      sampleCount: g.records.length,
      evidence: g.records.map((r) => ({
        id: r.id, at: r.at, value: Number(r.value), method: r.method, detectLimit: Number(r.detectLimit),
        resultUnit: r.resultUnit, labName: r.labName, evidenceNo: r.evidenceNo,
        sampledBy: r.sampledBy, reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt,
      })),
      method: first.method,
      detectLimit: Number(first.detectLimit),
      resultUnit: first.resultUnit,
      labName: first.labName,
    };
  }).sort((a, b) => a.hour - b.hour);
}

function dailyLimitOf(settings, metric) {
  return metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
}

function emptyDay(day, outletId, metric, limit, kind, reason, extra) {
  return Object.assign({
    day, outletId, metric, kind, valid: false, gapReason: reason || '',
    rows: [], manualPoints: [], evidence: [],
    countedHours: 0, autoHours: 0, manualHours: 0, manualSamples: 0, imputedHours: 0,
    average: 0, limit, exceed: false, exceedHours: 0, manualExceedSamples: 0,
    flowTotal: 0, flowOnlineHours: 0, flowBasis: '—',
    loadAutoTons: 0, loadManualTons: 0,
  }, extra || {});
}

// 日均与日总量：自动日按小时流量加权；手工替代日浓度按手工值、流量按口径（在线优先，缺失按故障前日均推算）
function dailyStats(data, outletId, metric, day) {
  const settings = data.settings;
  const limit = dailyLimitOf(settings, metric);
  const outlet = outletOf(data, outletId);
  if (!outlet) return emptyDay(day, outletId, metric, limit, 'gap', '排放口不存在');

  // 口径 8：停产、停用时段不参与统计，但保留可查
  if (isStopped(data, outletId)) {
    return emptyDay(day, outletId, metric, limit, 'stopped', '排污单位停产或排放口停用时段，不参与平均与总量');
  }

  const autoRows = dayRows(data, outletId, metric, day);
  // 同一小时存在多条（自动与补录撞点）时，真实自动值优先，补录只用于补缺失小时
  const countedByHour = {};
  autoRows.filter((r) => r.counted).forEach((r) => {
    const prev = countedByHour[r.hour];
    if (!prev || (prev.source === '补录' && r.source === '自动')) countedByHour[r.hour] = r;
  });
  const countedAuto = Object.keys(countedByHour).map((h) => countedByHour[h]).sort((a, b) => a.hour - b.hour);
  const manualPoints = manualPointsOfDay(data, outletId, metric, day);
  const pendingManual = manualRecordsOf(data, { outletId, metric, day, reviewStatus: '待复核' });
  const flow = flowMapForDay(data, outletId, day);
  const flowHours = Object.keys(flow).length;
  const flowOnlineSum = Object.values(flow).reduce((a, b) => a + b, 0);
  const flowOnlineMean = flowHours ? flowOnlineSum / flowHours : null;
  const imputedHours = countedAuto.filter((r) => r.source === '补录').length;

  const outage = metricOutageAt(data, outletId, metric, day + ' 12:00:00');
  let kind;
  let gapReason = '';

  if (countedAuto.length >= Number(settings.validHoursPerDay)) {
    kind = 'auto';
    if (imputedHours > Number(settings.maxImputeHoursPerDay)) {
      kind = 'gap';
      gapReason = '补录 ' + imputedHours + ' 小时，超过单日上限 ' + Number(settings.maxImputeHoursPerDay) + ' 小时，该日按缺口处理';
    }
  } else if (outage) {
    // 设备故障/送检期间：只有满足全部替代口径的日子才能用手工值等效
    const minSamples = Number(settings.manualMinSamplesPerDay);
    const maxDays = Number(settings.manualMaxConsecutiveDays);
    const position = Math.round((new Date(day + 'T00:00:00Z').getTime() - new Date(outage.startAt.slice(0, 10) + 'T00:00:00Z').getTime()) / 86400000) + 1;
    if (!manualPoints.length) {
      kind = 'gap';
      gapReason = '设备' + outage.reason + '时段（' + outage.startAt.slice(5, 10) + ' 至 ' + outage.endAt.slice(5, 10) + '）无已复核手工监测数据';
      if (pendingManual.length) gapReason += '，另有 ' + pendingManual.length + ' 条手工记录待复核，不能作为等效值';
    } else if (manualRecordsOf(data, { outletId, metric, day }).reduce((n, r) => n + (r.reviewStatus === '已复核' ? 1 : 0), 0) < minSamples) {
      kind = 'gap';
      gapReason = '手工监测样本不足：当日已复核 ' + manualPoints.reduce((n, p) => n + p.sampleCount, 0) + ' 次，口径每日不少于 ' + minSamples + ' 次，按缺口处理';
    } else if (position > maxDays) {
      kind = 'gap';
      gapReason = '该日为连续替代第 ' + position + ' 天，超过一次故障/送检连续替代上限 ' + maxDays + ' 天，按缺口处理';
    } else {
      kind = countedAuto.length ? 'mixed' : 'manual';
    }
  } else if (countedAuto.length > 0) {
    kind = 'gap';
    gapReason = '有效自动数据 ' + countedAuto.length + ' 小时，不足口径 ' + Number(settings.validHoursPerDay) + ' 小时，且未登记设备故障/送检时段，不能用手工值替代';
  } else {
    kind = 'gap';
    gapReason = '当日无有效自动数据，且未登记设备故障/送检时段与手工替代依据';
  }

  const evidence = [];
  manualPoints.forEach((p) => p.evidence.forEach((e) => evidence.push(e)));

  if (kind === 'gap') {
    return emptyDay(day, outletId, metric, limit, 'gap', gapReason, {
      rows: autoRows, manualPoints, evidence,
      autoHours: countedAuto.length, imputedHours,
      manualSamples: manualPoints.reduce((n, p) => n + p.sampleCount, 0),
      flowTotal: store.round(flowOnlineSum, 1), flowOnlineHours: flowHours,
      flowBasis: flowHours ? '在线实测（缺口日不计总量）' : '—',
      outageId: outage ? outage.id : null,
      pendingManualCount: pendingManual.length,
    });
  }

  // —— 有效日（auto / manual / mixed）——
  const divisor = Number(settings.tonsDivisor);
  const toTons = (mgTimesM3) => store.round(mgTimesM3 * 1000 / divisor, 6);

  let autoConcFlowSum = 0;
  let autoFlowSum = 0;
  let autoLoadBase = 0;
  countedAuto.forEach((r) => {
    const f = Object.prototype.hasOwnProperty.call(flow, r.hour) ? flow[r.hour] : 0; // 口径 5：必须同一时刻配对，缺流量该小时计 0
    autoConcFlowSum += r.concentration * f;
    autoFlowSum += f;
    autoLoadBase += r.concentration * f;
  });

  // 替代期间流量：在线优先（在线不足 24 小时按当日在线均值补足全天口径）；全无在线流量时按故障前 N 日均值推算
  let dayFlowTotal;
  let flowBasis;
  if (flowHours >= HOURS_PER_DAY) {
    dayFlowTotal = flowOnlineSum;
    flowBasis = '在线实测';
  } else if (flowHours > 0) {
    dayFlowTotal = flowOnlineMean * HOURS_PER_DAY;
    flowBasis = '在线实测（当日 ' + flowHours + ' 小时，按在线日均折全天）';
  } else {
    const fallback = priorMeanFlow(data, outletId, day, settings.manualFlowLookbackDays);
    if (fallback === null) {
      dayFlowTotal = 0;
      flowBasis = '无可用流量依据（故障前 ' + Number(settings.manualFlowLookbackDays) + ' 日无在线流量），总量该日计 0';
    } else {
      dayFlowTotal = fallback * HOURS_PER_DAY;
      flowBasis = '故障前 ' + Number(settings.manualFlowLookbackDays) + ' 日日均推算（' + store.round(fallback, 1) + ' m³/h）';
    }
  }

  const manualConc = manualPoints.length
    ? manualPoints.reduce((s, p) => s + p.concentration * p.sampleCount, 0) / manualPoints.reduce((n, p) => n + p.sampleCount, 0)
    : 0;
  const manualFlowPortion = Math.max(dayFlowTotal - autoFlowSum, 0); // 手工值只覆盖自动缺测的那部分流量，避免重复计

  let average;
  let loadManualBase = 0;
  if (kind === 'auto') {
    average = autoFlowSum > 0 ? autoConcFlowSum / autoFlowSum : countedAuto.reduce((s, r) => s + r.concentration, 0) / countedAuto.length;
  } else {
    const concFlow = autoConcFlowSum + manualConc * manualFlowPortion;
    const flowAll = autoFlowSum + manualFlowPortion;
    average = flowAll > 0 ? concFlow / flowAll : manualConc;
    loadManualBase = manualConc * manualFlowPortion;
  }

  const exceedHours = countedAuto.filter((r) => r.concentration > limit).length;
  const manualExceedSamples = manualPoints.reduce((n, p) => n + p.evidence.filter((e) => effectiveConcentration(data, e.value, outletId, p.at) > limit).length, 0);
  const loadAutoTons = toTons(autoLoadBase);
  const loadManualTons = kind === 'auto' ? 0 : toTons(loadManualBase);

  return {
    day, outletId, metric,
    kind, // auto=自动有效日；manual=手工替代日；mixed=自动+手工替代同日
    valid: true,
    gapReason: '',
    rows: autoRows,
    manualPoints,
    evidence,
    countedHours: countedAuto.length + (manualPoints.length ? HOURS_PER_DAY - Math.min(countedAuto.length, HOURS_PER_DAY) : 0),
    autoHours: countedAuto.length,
    manualHours: manualPoints.length ? HOURS_PER_DAY - countedAuto.length : 0,
    manualSamples: manualPoints.reduce((n, p) => n + p.sampleCount, 0),
    imputedHours,
    average: store.round(average, 2),
    limit,
    exceed: store.round(average, 2) > limit,
    exceedHours,
    manualExceedSamples,
    flowTotal: store.round(dayFlowTotal, 1),
    flowOnlineHours: flowHours,
    flowBasis,
    loadAutoTons,
    loadManualTons,
    loadTons: store.round(loadAutoTons + loadManualTons, 4),
    outageId: outage ? outage.id : null,
    pendingManualCount: pendingManual.length,
  };
}

// 一个月这个排放口某指标是否应当有数据：当月有该指标读数/手工记录，或该指标设备的故障/送检时段与月相交
function monthInScope(data, outletId, metric, month) {
  if (data.readings.some((r) => r.outletId === outletId && r.metric === metric && store.monthOf(r.at) === month)) return true;
  if ((data.manualRecords || []).some((r) => r.outletId === outletId && r.metric === metric && store.monthOf(r.at) === month)) return true;
  const deviceIds = data.devices.filter((d) => d.outletId === outletId && d.metric === metric).map((d) => d.id);
  if (!deviceIds.length) return false;
  const start = month + '-01 00:00:00';
  const end = month + '-' + String(store.daysInMonth(month)).padStart(2, '0') + ' 23:59:59';
  return (data.deviceOutages || []).some((o) => deviceIds.includes(o.deviceId) && o.endAt >= start && o.startAt <= end);
}

function dailySeries(data, outletId, metric, month) {
  const days = store.daysInMonth(month);
  const out = [];
  if (!monthInScope(data, outletId, metric, month)) return out;
  const settings = data.settings;
  for (let d = 1; d <= days; d += 1) {
    const day = month + '-' + String(d).padStart(2, '0');
    out.push(dailyStats(data, outletId, metric, day));
  }
  // 口径：手工替代覆盖率超过当月比例上限时，超出的替代日（时间上靠后）按缺口处理，不许用替代把缺口填平
  const operating = out.filter((s) => s.kind !== 'stopped');
  const capPercent = Number(settings.manualMaxCoveragePercent);
  const capHours = operating.length * HOURS_PER_DAY * capPercent / 100;
  let used = 0;
  out.filter((s) => s.kind === 'manual' || s.kind === 'mixed')
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .forEach((s) => {
      const cover = Math.max(s.manualHours || 0, HOURS_PER_DAY); // 替代日按全天计替代覆盖
      if (used + cover > capHours) {
        s.valid = false;
        s.kind = 'gap';
        s.gapReason = '替代覆盖率超过口径上限 ' + capPercent + '%，该日起超出的替代时段按缺口处理';
        s.loadAutoTons = 0; s.loadManualTons = 0; s.loadTons = 0;
      } else {
        used += cover;
      }
    });
  return out;
}

// 月均值：按有效天数平均（分母是有效天数，不是当月天数；缺口日不参与）
function monthAverage(data, outletId, metric, month) {
  const series = dailySeries(data, outletId, metric, month).filter((s) => s.valid);
  if (!series.length) return 0;
  return store.round(series.reduce((acc, s) => acc + s.average, 0) / series.length, 2);
}

// 月总量（吨）：逐有效日累加，自动与替代分开，缺口日不外推、不填补
function monthTotalParts(data, outletId, metric, month) {
  const series = dailySeries(data, outletId, metric, month);
  const valid = series.filter((s) => s.valid);
  return {
    month,
    outletId,
    metric,
    autoTons: store.round(valid.reduce((a, s) => a + s.loadAutoTons, 0), 4),
    manualTons: store.round(valid.reduce((a, s) => a + s.loadManualTons, 0), 4),
    tons: store.round(valid.reduce((a, s) => a + s.loadAutoTons + s.loadManualTons, 0), 4),
    autoDays: valid.filter((s) => s.kind === 'auto').length,
    manualDays: valid.filter((s) => s.kind === 'manual' || s.kind === 'mixed').length,
    gapDays: series.filter((s) => !s.valid && s.kind === 'gap').length,
    stoppedDays: series.filter((s) => s.kind === 'stopped').length,
    operatingDays: series.filter((s) => s.kind !== 'stopped').length,
    gaps: series.filter((s) => !s.valid && s.kind === 'gap').map((s) => ({ day: s.day, reason: s.gapReason, autoHours: s.autoHours, manualSamples: s.manualSamples, pendingManualCount: s.pendingManualCount || 0 })),
  };
}

function monthTotal(data, outletId, metric, month) {
  return monthTotalParts(data, outletId, metric, month).tons;
}

// 季度总量：季度内各月逐小时/逐日累加，不按天外推
function quarterTotal(data, outletId, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const months = [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3].map((m) => y + '-' + String(m).padStart(2, '0'));
  return store.round(months.reduce((a, m) => a + monthTotal(data, outletId, metric, m), 0), 4);
}

function quarterTotalParts(data, outletId, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const months = [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3].map((m) => y + '-' + String(m).padStart(2, '0'));
  const parts = months.map((m) => monthTotalParts(data, outletId, metric, m));
  return {
    autoTons: store.round(parts.reduce((a, p) => a + p.autoTons, 0), 4),
    manualTons: store.round(parts.reduce((a, p) => a + p.manualTons, 0), 4),
    tons: store.round(parts.reduce((a, p) => a + p.tons, 0), 4),
    gapDays: parts.reduce((a, p) => a + p.gapDays, 0),
  };
}

// 季度许可量：年许可量按当季实际天数占全年天数分解
function quarterPermitTons(data, metric, quarter) {
  const settings = data.settings;
  const annual = metric === '氨氮' ? Number(settings.annualPermitAmmoniaTons) : Number(settings.annualPermitCodTons);
  const [y] = String(quarter).split('-Q').map(Number);
  const yearDays = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
  return store.round(annual * store.daysInQuarter(quarter) / yearDays, 4);
}

// 年累计：按排污单位许可年累计，跨自然年不重置、不带入其他许可年的数据；自动与替代分开
function accumulatedParts(data, metric, plantId) {
  let autoTons = 0;
  let manualTons = 0;
  let gapDays = 0;
  const outlets = plantId ? data.outlets.filter((o) => o.plantId === plantId) : data.outlets;
  outlets.forEach((o) => {
    const plant = plantOf(data, o.plantId);
    if (!plant) return;
    const yearStart = String(plant.permitYearStart).slice(0, 10);
    const yearStartMs = new Date(yearStart + 'T00:00:00Z').getTime();
    const yearEndExclusive = new Date(yearStartMs + 365 * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    const endText = yearEndExclusive.getUTCFullYear() + '-' + p(yearEndExclusive.getUTCMonth() + 1) + '-' + p(yearEndExclusive.getUTCDate());
    const monthsSet = new Set(data.readings.filter((r) => r.outletId === o.id).map((r) => store.monthOf(r.at)));
    (data.manualRecords || []).forEach((r) => { if (r.outletId === o.id) monthsSet.add(store.monthOf(r.at)); });
    const months = Array.from(monthsSet).sort();
    months.forEach((m) => {
      const monthEnd = m + '-' + String(store.daysInMonth(m)).padStart(2, '0');
      if (monthEnd < yearStart || m + '-01' >= endText) return;
      const part = monthTotalParts(data, o.id, metric, m);
      autoTons += part.autoTons;
      manualTons += part.manualTons;
      gapDays += part.gapDays;
    });
  });
  return { autoTons: store.round(autoTons, 4), manualTons: store.round(manualTons, 4), tons: store.round(autoTons + manualTons, 4), gapDays };
}

function accumulatedTons(data, metric, plantId) {
  return accumulatedParts(data, metric, plantId).tons;
}

// 超标：日均超过限值（含手工替代日），或者自动小时值超过限值达到规定次数；手工样本超限单列
function exceedance(data, outletId, metric, month) {
  const settings = data.settings;
  const series = dailySeries(data, outletId, metric, month);
  const limit = dailyLimitOf(settings, metric);
  const valid = series.filter((s) => s.valid);
  const exceedDays = valid.filter((s) => s.exceed).map((s) => ({
    day: s.day,
    kind: s.kind,
    average: s.average,
    basis: s.kind === 'auto' ? '自动小时' : '手工监测' + s.manualSamples + ' 次（' + s.flowBasis + '）',
  }));
  let exceedHours = 0;
  let manualExceedSamples = 0;
  valid.forEach((s) => {
    exceedHours += s.exceedHours;
    manualExceedSamples += s.manualExceedSamples;
  });
  return {
    month,
    outletId,
    metric,
    limit,
    exceedDays,
    exceedDaysCount: exceedDays.length,
    exceedHours,
    manualExceedSamples,
    hourlyExceed: exceedHours >= Number(settings.hourlyExceedCountLimit),
    exceeded: exceedDays.length > 0 || exceedHours >= Number(settings.hourlyExceedCountLimit),
    monthAverage: monthAverage(data, outletId, metric, month),
  };
}

function outletsOf(data, plantId) {
  return data.outlets.filter((o) => o.plantId === plantId);
}

// 排放口汇总：逐指标给出月均、月总量（自动/替代拆分）、缺口与覆盖、超标情况
function outletSummary(data, outletId, month) {
  const outlet = outletOf(data, outletId);
  const settings = data.settings;
  const metrics = ['COD', '氨氮'];
  const rows = metrics.map((metric) => {
    const ex = exceedance(data, outletId, metric, month);
    const parts = monthTotalParts(data, outletId, metric, month);
    const operatingHours = parts.operatingDays * HOURS_PER_DAY;
    const coveredHours = (parts.autoDays + parts.manualDays) * HOURS_PER_DAY;
    return {
      metric,
      monthAverage: ex.monthAverage,
      monthTotalTons: parts.tons,
      monthAutoTons: parts.autoTons,
      monthManualTons: parts.manualTons,
      autoDays: parts.autoDays,
      manualDays: parts.manualDays,
      gapDays: parts.gapDays,
      operatingDays: parts.operatingDays,
      coveragePercent: operatingHours ? store.round(coveredHours / operatingHours * 100, 1) : 0,
      manualPercent: operatingHours ? store.round(parts.manualDays * HOURS_PER_DAY / operatingHours * 100, 1) : 0,
      gaps: parts.gaps,
      exceedDaysCount: ex.exceedDaysCount,
      exceedHours: ex.exceedHours,
      manualExceedSamples: ex.manualExceedSamples,
      exceeded: ex.exceeded,
      limit: ex.limit,
    };
  });
  const devices = data.devices.filter((d) => d.outletId === outletId).map((d) => Object.assign({}, d, {
    readingCount: data.readings.filter((r) => r.deviceId === d.id).length,
    manualCount: (data.manualRecords || []).filter((r) => r.deviceId === d.id).length,
    outageCount: (data.deviceOutages || []).filter((o) => o.deviceId === d.id).length,
  }));
  return {
    outlet,
    plant: outlet ? plantOf(data, outlet.plantId) : null,
    month,
    rows,
    devices,
    outages: outagesOf(data, { outletId }),
    quarterTotalCod: quarterTotal(data, outletId, 'COD', store.quarterOf(month)),
    quarterPartsCod: quarterTotalParts(data, outletId, 'COD', store.quarterOf(month)),
    permitCodTons: quarterPermitTons(data, 'COD', store.quarterOf(month)),
    annualPermitCodTons: Number(settings.annualPermitCodTons),
    accumulatedCod: accumulatedParts(data, 'COD', outlet ? outlet.plantId : null),
    accumulatedAmmonia: accumulatedParts(data, '氨氮', outlet ? outlet.plantId : null),
    accumulatedCodTons: accumulatedTons(data, 'COD', outlet ? outlet.plantId : null),
    accumulatedAmmoniaTons: accumulatedTons(data, '氨氮', outlet ? outlet.plantId : null),
    settings,
  };
}

module.exports = {
  plantOf, outletOf, deviceOf,
  readingsOf, manualRecordsOf, outagesOf, outageAt, metricOutageAt,
  isCounted, effectiveConcentration, oxygenAt, flowAt,
  dayRows, manualPointsOfDay, dailyStats, dailySeries,
  monthAverage, monthTotal, monthTotalParts,
  quarterTotal, quarterTotalParts, quarterPermitTons,
  accumulatedTons, accumulatedParts,
  exceedance, outletsOf, outletSummary,
  POLLUTANTS,
};
