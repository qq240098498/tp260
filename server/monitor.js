// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可
// 另含设备故障/送检期间手工监测（替代数据）的覆盖边界与缺口口径。
const store = require('./store');

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
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  return rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function manualsOf(data, query) {
  const q = query || {};
  let rows = (data.manualReadings || []).slice();
  if (q.outletId) rows = rows.filter((r) => r.outletId === q.outletId);
  if (q.deviceId) rows = rows.filter((r) => r.deviceId === q.deviceId);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.outageId) rows = rows.filter((r) => r.basisOutageId === q.outageId);
  if (q.day) rows = rows.filter((r) => store.dayOf(r.at) === q.day);
  if (q.month) rows = rows.filter((r) => store.monthOf(r.at) === q.month);
  return rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function outagesOf(data, query) {
  const q = query || {};
  let rows = (data.outages || []).slice();
  if (q.outletId) rows = rows.filter((r) => r.outletId === q.outletId);
  if (q.deviceId) rows = rows.filter((r) => r.deviceId === q.deviceId);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (q.reasonType) rows = rows.filter((r) => r.reasonType === q.reasonType);
  return rows.sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0));
}

// 该排放口该指标正在生效（覆盖某一时刻）的故障/送检时段
function outagesCovering(data, outletId, metric, at) {
  return outagesOf(data, { outletId, metric }).filter((o) => o.startAt <= at && at <= o.endAt);
}

function isStopped(data, reading) {
  const outlet = outletOf(data, reading.outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;
  return Number(reading.value) >= 0 && !!(outlet && plant && (outlet.status === '停用' || plant.status === '停产'));
}

// 口径第 1 条：有效小时值——标记有效、设备状态正常、数值在量程内；停产停用时段不计入
// 返回 null 表示有效，否则返回不计入原因
function invalidReason(data, reading, device, settings) {
  if (reading.flag && reading.flag !== '有效') return '标记为无效';
  if (device && device.status !== '正常') return '设备状态为「' + device.status + '」';
  const v = Number(reading.value);
  if (!Number.isFinite(v)) return '数值不是数字';
  // 量程是污染物浓度（COD/氨氮）的量程；流量与氧含量只要求非负
  if (reading.metric === '流量' || reading.metric === '氧含量') {
    if (v < 0) return '数值为负数';
  } else if (v < Number(settings.rangeMin) || v > Number(settings.rangeMax)) {
    return '数值超出量程（' + settings.rangeMin + '–' + settings.rangeMax + '）';
  }
  if (isStopped(data, reading)) return '单位停产或排放口停用时段';
  return null;
}

function isCounted(reading, device, settings) {
  // 手工登记行：只有复核通过才计入（覆盖边界在 timeline 里再截）
  if (reading.rowType === 'manual') return reading.status === '已复核';
  // 自动/补录行的完整判定（含停产停用）请用 invalidReason(data, ...)，这里只做标记、设备、量程三项快判
  if (reading.flag && reading.flag !== '有效') return false;
  if (device && device.status !== '正常') return false;
  const v = Number(reading.value);
  if (!Number.isFinite(v) || v < 0) return false;
  if (reading.metric !== '流量' && reading.metric !== '氧含量'
    && (v < Number(settings.rangeMin) || v > Number(settings.rangeMax))) return false;
  return true;
}

// 口径第 2 条：折算浓度 = 实测 × (21 − 基准氧) / (21 − 实测氧含量)；氧含量缺失按基准氧处理（不折算）
function concentrationOf(value, oxygen, settings) {
  const base = Number(settings.oxygenBaseline);
  const oxy = (oxygen === null || oxygen === undefined || oxygen === '') ? base : Number(oxygen);
  const denom = 21 - oxy;
  if (!Number.isFinite(denom) || denom === 0) return 0;
  return Number(value) * (21 - base) / denom;
}

function effectiveConcentration(reading, settings, oxygen) {
  if (oxygen === undefined) return store.round(concentrationOf(Number(reading.value), reading.oxygen, settings), 2);
  return store.round(concentrationOf(Number(reading.value), oxygen, settings), 2);
}

// 同排放口同时刻的氧含量读数（自动/手工均可，自动优先）。用预建索引避免逐小时全表扫描。
function pairMaps(data) {
  const c = cacheFor(data);
  if (c.pairs) return c.pairs;
  const oxygen = new Map();
  const flow = new Map();
  const key = (outletId, at) => outletId + '|' + at;
  data.readings.forEach((r) => {
    if (r.metric === '氧含量') oxygen.set(key(r.outletId, r.at), r);
    if (r.metric === '流量') flow.set(key(r.outletId, r.at), r);
  });
  const mOxygen = new Map();
  const mFlow = new Map();
  (data.manualReadings || []).forEach((m) => {
    if (m.status !== '已复核') return;
    const k = key(m.outletId, m.at);
    if (m.metric === '氧含量' && !oxygen.has(k)) mOxygen.set(k, m);
    if (m.metric === '流量') mFlow.set(k, m);
  });
  const pairs = { oxygen, flow, mOxygen, mFlow, key };
  c.pairs = pairs;
  return pairs;
}

function oxygenAt(data, reading) {
  const p = pairMaps(data);
  const k = p.key(reading.outletId, reading.at);
  const auto = p.oxygen.get(k);
  if (auto) return Number(auto.value);
  const manual = p.mOxygen.get(k);
  return manual ? Number(manual.value) : null;
}

// 同排放口同时刻的有效流量（m³/h）；自动优先（需有效），其次经复核手工流量；缺失返回 null（不默默当 0）
function flowAt(data, reading) {
  const p = pairMaps(data);
  const k = p.key(reading.outletId, reading.at);
  const auto = p.flow.get(k);
  if (auto) {
    const dev = deviceOf(data, auto.deviceId);
    if (!invalidReason(data, auto, dev, data.settings)) return Number(auto.value);
  }
  const manual = p.mFlow.get(k);
  return manual ? Number(manual.value) : null;
}

// 请求级缓存：每次请求 store.load() 都会产生新的 data 对象，WeakMap 随请求自动释放
const timelineCache = new WeakMap();
const coverageCache = new WeakMap();

function cacheFor(data) {
  let c = timelineCache.get(data);
  if (!c) { c = { timeline: new Map(), coverage: new Map() }; timelineCache.set(data, c); coverageCache.set(data, c.coverage); }
  return c;
}

/* ================= 手工替代覆盖边界 ================= */

// 一个手工样品代表采样时刻起的若干个小时（块长 = 24 / 每日最低频次，默认 6 小时）。
// 块不跨越同一故障/送检时段内的下一个样品，也不超出时段结束时刻。
function manualBlockHours(settings) {
  const perDay = Math.max(1, Number(settings.manualMinSamplesPerDay));
  return Math.max(1, Math.round(24 / perDay));
}

// 判断经复核手工样品能否作为替代值入账，并把覆盖展开到小时槽。
// 口径：
//  1) 采样时刻必须落在登记所依据的故障/送检时段之内（缺依据不许入账，见 resources 校验）；
//  2) 同一故障/送检时段内，替代只覆盖最早采样时刻起 maxManualSpanHours 小时，超出的按缺口；
//  3) 被覆盖的每个自然日至少 manualMinSamplesPerDay 次手工监测（频次不足，当日覆盖全部按缺口）；
//  4) 单月替代小时占当月应监测小时比例不得超过 manualMaxCoverageRatio，超出部分按缺口。
// 返回 { cover: Map<at, sample>, dropped: Map<at, {sample, reason}>, decisions: Map<manualId, reason(空串=通过)> }
function manualCoverage(data, outletId, metric, month) {
  const c = cacheFor(data);
  const ck = outletId + '|' + metric + '|' + month;
  if (c.coverage.has(ck)) return c.coverage.get(ck);
  const result = manualCoverageCompute(data, outletId, metric, month);
  c.coverage.set(ck, result);
  return result;
}

function manualCoverageCompute(data, outletId, metric, month) {
  const settings = data.settings;
  const blockHours = manualBlockHours(settings);
  const decisions = new Map();
  const cover = new Map();
  const dropped = new Map();

  const groups = new Map(); // outageId → [manual...]
  manualsOf(data, { outletId, metric, month })
    .filter((m) => m.status === '已复核')
    .forEach((m) => {
      const outage = (data.outages || []).find((o) => o.id === m.basisOutageId);
      if (!outage || outage.startAt > m.at || m.at > outage.endAt) { decisions.set(m.id, '采样时刻不在故障/送检时段内'); return; }
      decisions.set(m.id, '');
      if (!groups.has(outage.id)) groups.set(outage.id, { outage, list: [] });
      groups.get(outage.id).list.push(m);
    });

  // 每个故障时段：频次 → 连续长度 → 展开块
  const expanded = []; // {at, sample}
  groups.forEach(({ outage, list }) => {
    const sorted = list.slice().sort((a, b) => (a.at < b.at ? -1 : 1));
    const spanLimit = Number(settings.maxManualSpanHours);
    const firstAt = sorted[0].at;
    const byDay = new Map();
    sorted.forEach((m) => byDay.set(store.dayOf(m.at), (byDay.get(store.dayOf(m.at)) || 0) + 1));
    sorted.forEach((sample, i) => {
      const day = store.dayOf(sample.at);
      let reason = '';
      if (byDay.get(day) < Number(settings.manualMinSamplesPerDay)) {
        reason = '当日手工监测频次不足（至少 ' + settings.manualMinSamplesPerDay + ' 次/日）';
      } else {
        const nextAt = sorted[i + 1] ? sorted[i + 1].at : null;
        for (let k = 0; k < blockHours; k += 1) {
          const at = store.addHours(sample.at, k);
          if (at > outage.endAt) break;
          if (nextAt && at >= nextAt) break;
          // 覆盖窗口的末端（含）不得超过首样起的连续长度上限
          if (store.hoursBetween(firstAt, at) + 1 > spanLimit) {
            reason = '超出单次故障/送检可覆盖的连续时段长度（' + spanLimit + ' 小时）';
            break;
          }
          expanded.push({ at, sample });
        }
      }
      if (reason) {
        decisions.set(sample.id, reason);
        for (let k = 0; k < blockHours; k += 1) {
          const at = store.addHours(sample.at, k);
          if (at > outage.endAt) break;
          dropped.set(at, { sample, reason });
        }
      }
    });
  });

  // 月覆盖比例上限：按时间先后保留前 cap 个覆盖槽，其余按缺口并标明
  expanded.sort((a, b) => (a.at < b.at ? -1 : 1));
  const cap = Math.floor(store.daysInMonth(month) * 24 * Number(settings.manualMaxCoverageRatio));
  expanded.forEach((item, i) => {
    if (i < cap && !cover.has(item.at)) cover.set(item.at, item.sample);
    else if (!cover.has(item.at)) {
      const reason = '超出单月替代比例上限（' + Math.round(Number(settings.manualMaxCoverageRatio) * 100) + '%，最多 ' + cap + ' 小时）';
      dropped.set(item.at, { sample: item.sample, reason });
      decisions.set(item.sample.id, reason);
    }
  });
  return { cover, dropped, decisions };
}

/* ================= 统一小时时间轴 ================= */
// 状态：auto 自动有效 | imputed 补录 | manual 手工替代 | invalid 有读数但无效 | gap 缺口
function timeline(data, outletId, metric, month) {
  const c = cacheFor(data);
  const ck = outletId + '|' + metric + '|' + month;
  if (c.timeline.has(ck)) return c.timeline.get(ck);
  const result = timelineCompute(data, outletId, metric, month);
  c.timeline.set(ck, result);
  return result;
}

function timelineCompute(data, outletId, metric, month) {
  const settings = data.settings;
  const blockHours = manualBlockHours(settings);
  const coverage = manualCoverage(data, outletId, metric, month);

  const readingMap = new Map();
  readingsOf(data, { outletId, metric, month }).forEach((r) => {
    if (!readingMap.has(r.at)) readingMap.set(r.at, r);
  });

  const slots = store.monthHours(month).map((at) => {
    const hour = Number(at.slice(11, 13));
    const sample = coverage.cover.get(at);
    if (sample) {
      // 被手工样品覆盖的小时：浓度取手工值（按该小时实际氧含量折算），流量仍取同时刻有效自动/手工流量
      const oxygen = oxygenAt(data, { outletId, at });
      const flow = flowAt(data, { outletId, at });
      return {
        at, hour, state: 'manual', counted: true, value: Number(sample.value),
        concentration: metric === '流量' || metric === '氧含量' ? Number(sample.value)
          : effectiveConcentration(sample, settings, oxygen),
        oxygen, flow, readingId: '', manualId: sample.id, sampleAt: sample.at, outageId: sample.basisOutageId,
        deviceCode: (deviceOf(data, sample.deviceId) || {}).code || '', deviceStatus: '', source: '手工', flag: '有效',
        reviewStatus: sample.status, method: sample.method, unit: sample.unit, dropReason: '',
      };
    }
    const reading = readingMap.get(at);
    if (reading) {
      const device = deviceOf(data, reading.deviceId);
      const reason = invalidReason(data, reading, device, settings);
      const oxygen = oxygenAt(data, reading);
      const flow = flowAt(data, reading);
      const common = {
        at, hour, value: Number(reading.value),
        oxygen, flow, readingId: reading.id, manualId: '', sampleAt: '', outageId: '',
        deviceCode: device ? device.code : '', deviceStatus: device ? device.status : '',
        source: reading.source, flag: reading.flag, reviewStatus: '', method: '', unit: '',
      };
      if (reason) {
        return Object.assign({}, common, { state: 'invalid', counted: false, concentration: 0, dropReason: reason });
      }
      return Object.assign({}, common, {
        state: reading.source === '补录' ? 'imputed' : 'auto', counted: true,
        concentration: metric === '流量' || metric === '氧含量' ? Number(reading.value) : effectiveConcentration(reading, settings, oxygen),
        dropReason: '',
      });
    }
    // 没有任何有效记录：可能是被边界截断的手工覆盖（要显式标出来），也可能是纯缺口
    const cut = coverage.dropped.get(at);
    if (cut) {
      return {
        at, hour, state: 'gap', counted: false, value: Number(cut.sample.value), concentration: 0,
        oxygen: null, flow: null, readingId: '', manualId: cut.sample.id, sampleAt: cut.sample.at,
        outageId: cut.sample.basisOutageId,
        deviceCode: '', deviceStatus: '', source: '缺口', flag: '—', reviewStatus: cut.sample.status,
        method: cut.sample.method, unit: cut.sample.unit, dropReason: cut.reason,
      };
    }
    return {
      at, hour, state: 'gap', counted: false, value: null, concentration: 0,
      oxygen: null, flow: null, readingId: '', manualId: '', sampleAt: '', outageId: '',
      deviceCode: '', deviceStatus: '', source: '缺口', flag: '—', reviewStatus: '', method: '', unit: '', dropReason: '',
    };
  });

  // 连续缺口分段（含被截断的手工覆盖小时）
  const gaps = [];
  let run = null;
  slots.forEach((s) => {
    if (s.state !== 'gap') {
      if (run) { gaps.push(run); run = null; }
      return;
    }
    if (!run) run = { startAt: s.at, endAt: s.at, hours: 0, droppedManual: [] };
    run.endAt = s.at;
    run.hours += 1;
    if (s.manualId) run.droppedManual.push({ manualId: s.manualId, at: s.at, sampleAt: s.sampleAt, value: s.value, reason: s.dropReason });
  });
  if (run) gaps.push(run);

  const tally = { auto: 0, imputed: 0, manual: 0, invalid: 0, gap: 0 };
  slots.forEach((s) => { tally[s.state] += 1; });
  const cap = Math.floor(store.daysInMonth(month) * 24 * Number(settings.manualMaxCoverageRatio));

  return {
    outletId, metric, month, slots, gaps,
    expectedHours: slots.length,
    autoHours: tally.auto,
    imputedHours: tally.imputed,
    manualHours: tally.manual,
    invalidHours: tally.invalid,
    gapHours: tally.gap,
    countedHours: tally.auto + tally.imputed + tally.manual,
    manualCapHours: cap,
    manualBlockHours: blockHours,
    manualCoverageRatio: store.round(slots.length ? tally.manual / slots.length : 0, 4),
  };
}

/* ================= 日 / 月 / 季 / 年 ================= */

// 一天的逐小时槽位（供逐日明细展开）
function dayRows(data, outletId, metric, day) {
  const month = String(day).slice(0, 7);
  const tl = timeline(data, outletId, metric, month);
  return tl.slots.filter((s) => store.dayOf(s.at) === day);
}

// 口径第 3 条：日均按小时流量加权；普通日有效小时 <18 或补录超上限整日无效；
// 故障/送检替代日改用手工频次判定（频次满足即有效，手工小时不计入补录上限）。
function dailyStats(data, outletId, metric, day) {
  const settings = data.settings;
  const month = String(day).slice(0, 7);
  const tl = timeline(data, outletId, metric, month);
  const rows = tl.slots.filter((s) => store.dayOf(s.at) === day);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const autoHours = rows.filter((r) => r.state === 'auto').length;
  const imputedHours = rows.filter((r) => r.state === 'imputed').length;
  const manualHours = rows.filter((r) => r.state === 'manual').length;
  // 当日实际采样次数（样品在其采样时刻所在的槽）
  const manualSamples = rows.filter((r) => r.state === 'manual' && r.sampleAt === r.at).length;
  const invalidHours = rows.filter((r) => r.state === 'invalid').length;
  const gapHours = rows.filter((r) => r.state === 'gap').length;
  const counted = rows.filter((r) => r.counted && (r.state === 'auto' || r.state === 'imputed' || r.state === 'manual'));
  const hasManual = manualHours > 0 || rows.some((r) => r.state === 'gap' && r.manualId);
  const flowPairs = counted.filter((r) => r.flow !== null && Number(r.flow) > 0);

  let valid = true;
  let reason = '';
  if (imputedHours > Number(settings.maxImputeHoursPerDay)) {
    valid = false;
    reason = '补录 ' + imputedHours + ' 小时，超过单日上限 ' + settings.maxImputeHoursPerDay + ' 小时';
  } else if (hasManual) {
    if (manualSamples < Number(settings.manualMinSamplesPerDay)) {
      valid = false;
      reason = '故障/送检替代日手工监测仅 ' + manualSamples + ' 次，少于口径要求的 ' + settings.manualMinSamplesPerDay + ' 次/日';
    }
  } else if (counted.length < 18) {
    valid = false;
    reason = '有效小时仅 ' + counted.length + ' 小时，不足 18 小时';
  }

  let average = 0;
  let averageBasis = '';
  if (valid && counted.length) {
    const flowSum = flowPairs.reduce((acc, r) => acc + Number(r.flow), 0);
    if (flowSum > 0) {
      average = store.round(flowPairs.reduce((acc, r) => acc + r.concentration * Number(r.flow), 0) / flowSum, 2);
      averageBasis = '流量加权';
    } else {
      average = store.round(counted.reduce((acc, r) => acc + r.concentration, 0) / counted.length, 2);
      averageBasis = '算术平均（同时刻缺有效流量）';
    }
  }
  const flowTotal = store.round(
    rows.filter((r) => r.counted && r.flow !== null).reduce((acc, r) => acc + Number(r.flow), 0), 1
  );

  return {
    day, outletId, metric, rows,
    countedHours: counted.length,
    autoHours, imputedHours, manualHours, manualSamples, invalidHours, gapHours,
    imputedHoursLegacy: imputedHours, // 兼容旧字段名
    average, averageBasis,
    valid, invalidReason: reason,
    limit, exceed: valid && average > limit,
    flowTotal,
  };
}

// 逐日序列：整月自然日全部给出（没有数据的日子也是显式缺口）
function dailySeries(data, outletId, metric, month) {
  const days = store.daysInMonth(month);
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    out.push(dailyStats(data, outletId, metric, month + '-' + String(d).padStart(2, '0')));
  }
  return out;
}

// 口径第 5 条：月平均分母是有效天数
function monthAverage(data, outletId, metric, month) {
  const series = dailySeries(data, outletId, metric, month).filter((s) => s.valid);
  if (!series.length) return 0;
  return store.round(series.reduce((acc, s) => acc + s.average, 0) / series.length, 2);
}

// 月总量（吨）：逐小时按同一时刻浓度×流量配对累加；缺有效流量的小时不估、不计。
// 自动、补录、手工替代三类来源分别累计，保证报表里能看清总量构成。
function monthTotalBreakdown(data, outletId, metric, month) {
  // 快速路径：该月该排放口该指标没有任何读数/经复核手工数据时直接为零（不构建整月时间轴）
  const hasAuto = data.readings.some((r) => r.outletId === outletId && r.metric === metric && store.monthOf(r.at) === month);
  const hasManual = (data.manualReadings || []).some((m) => m.outletId === outletId && m.metric === metric && store.monthOf(m.at) === month && m.status === '已复核');
  const empty = {
    month, outletId, metric,
    tons: 0, autoTons: 0, imputedTons: 0, manualTons: 0,
    pairedHours: 0, unpairedCountedHours: 0,
    autoHours: 0, imputedHours: 0, manualHours: 0, invalidHours: 0,
    gapHours: store.daysInMonth(month) * 24, expectedHours: store.daysInMonth(month) * 24,
    manualCoverageRatio: 0,
  };
  if (!hasAuto && !hasManual) return empty;
  const settings = data.settings;
  const tl = timeline(data, outletId, metric, month);
  const tons = { auto: 0, imputed: 0, manual: 0 };
  let pairedHours = 0;
  let unpairedCountedHours = 0;
  tl.slots.forEach((s) => {
    if (!s.counted) return;
    if (s.flow === null || Number(s.flow) <= 0) { unpairedCountedHours += 1; return; }
    const t = s.concentration * Number(s.flow) * 1000 / Number(settings.tonsDivisor);
    if (s.state === 'manual') tons.manual += t;
    else if (s.state === 'imputed') tons.imputed += t;
    else tons.auto += t;
    pairedHours += 1;
  });
  return {
    month, outletId, metric,
    tons: store.round(tons.auto + tons.imputed + tons.manual, 4),
    autoTons: store.round(tons.auto, 4),
    imputedTons: store.round(tons.imputed, 4),
    manualTons: store.round(tons.manual, 4),
    pairedHours,
    unpairedCountedHours,
    autoHours: tl.autoHours,
    imputedHours: tl.imputedHours,
    manualHours: tl.manualHours,
    invalidHours: tl.invalidHours,
    gapHours: tl.gapHours,
    expectedHours: tl.expectedHours,
    manualCoverageRatio: tl.manualCoverageRatio,
  };
}

function monthTotal(data, outletId, metric, month) {
  return monthTotalBreakdown(data, outletId, metric, month).tons;
}

function addMonths(month, n) {
  const [y, m] = String(month).split('-').map(Number);
  const v = y * 12 + (m - 1) + n;
  return String(Math.floor(v / 12)) + '-' + String((v % 12) + 1).padStart(2, '0');
}

function monthsBetween(startMonth, endMonth) {
  const out = [];
  let cur = String(startMonth).slice(0, 7);
  const end = String(endMonth).slice(0, 7);
  let guard = 0;
  while (cur <= end && guard < 1200) { out.push(cur); cur = addMonths(cur, 1); guard += 1; }
  return out;
}

// 季度总量：季内逐月逐小时累加，不外推
function quarterTotal(data, outletId, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const startMonth = y + '-' + String((q - 1) * 3 + 1).padStart(2, '0');
  let total = 0;
  for (let k = 0; k < 3; k += 1) total += monthTotal(data, outletId, metric, addMonths(startMonth, k));
  return store.round(total, 4);
}

// 季度许可量：年许可 × 当季实际天数 / 全年天数
function quarterPermitTons(data, metric, quarter) {
  const settings = data.settings;
  const [y] = String(quarter).split('-Q');
  const annual = metric === '氨氮' ? Number(settings.annualPermitAmmoniaTons) : Number(settings.annualPermitCodTons);
  return store.round(annual * store.daysInQuarter(quarter) / store.daysInYear(y), 4);
}

// 年累计：按单位许可年起始日累计（跨自然年不重置，也不带入其他许可年）
function accumulatedTons(data, metric, anchorMonth, outletId) {
  const anchor = anchorMonth || latestMonth(data);
  const outlets = outletId ? [outletId] : data.outlets.map((o) => o.id);
  let total = 0;
  for (const oid of outlets) {
    const outlet = outletOf(data, oid);
    const plant = outlet ? plantOf(data, outlet.plantId) : null;
    const range = store.permitYearRange((plant && plant.permitYearStart) || data.settings.permitYearStart, anchor);
    const startMonth = store.monthOf(range.start);
    for (const m of monthsBetween(startMonth, anchor)) total += monthTotal(data, oid, metric, m);
  }
  return store.round(total, 4);
}

function latestMonth(data) {
  const stamps = data.readings.map((r) => r.at)
    .concat((data.manualReadings || []).map((m) => m.at))
    .concat((data.outages || []).map((o) => o.endAt));
  stamps.sort();
  return stamps.length ? store.monthOf(stamps[stamps.length - 1]) : store.nowText().slice(0, 7);
}

// 超标：日均超限，或者小时超限次数达标（二者为或）
function exceedance(data, outletId, metric, month) {
  const settings = data.settings;
  const series = dailySeries(data, outletId, metric, month);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const exceedDays = series.filter((s) => s.exceed).map((s) => s.day);
  const tl = timeline(data, outletId, metric, month);
  let exceedHours = 0;
  tl.slots.forEach((s) => { if (s.counted && s.concentration > limit) exceedHours += 1; });
  const hourly = exceedHours >= Number(settings.hourlyExceedCountLimit);
  return {
    month, outletId, metric, limit,
    exceedDays,
    exceedDaysCount: exceedDays.length,
    exceedHours,
    hourlyExceed: hourly,
    exceeded: exceedDays.length > 0 || hourly,
    monthAverage: monthAverage(data, outletId, metric, month),
  };
}

function outletsOf(data, plantId) {
  return data.outlets.filter((o) => o.plantId === plantId);
}

// 替代取证覆盖报告（替代取证页直接用）
function coverageReport(data, outletId, month) {
  const metrics = ['COD', '氨氮', '流量', '氧含量'];
  const perMetric = metrics.map((metric) => {
    const tl = timeline(data, outletId, metric, month);
    const pollutant = metric !== '流量' && metric !== '氧含量';
    const bd = pollutant ? monthTotalBreakdown(data, outletId, metric, month) : null;
    return {
      metric,
      expectedHours: tl.expectedHours,
      autoHours: tl.autoHours,
      imputedHours: tl.imputedHours,
      manualHours: tl.manualHours,
      invalidHours: tl.invalidHours,
      gapHours: tl.gapHours,
      countedHours: tl.countedHours,
      manualCapHours: tl.manualCapHours,
      manualCoverageRatio: tl.manualCoverageRatio,
      // 总量（吨）只对污染物浓度指标有意义；流量、氧含量不参与总量
      tons: bd ? bd.tons : null,
      autoTons: bd ? bd.autoTons : null,
      imputedTons: bd ? bd.imputedTons : null,
      manualTons: bd ? bd.manualTons : null,
      gaps: tl.gaps,
    };
  });
  return {
    outletId, month,
    settings: {
      maxManualSpanHours: Number(data.settings.maxManualSpanHours),
      manualMinSamplesPerDay: Number(data.settings.manualMinSamplesPerDay),
      manualMaxCoverageRatio: Number(data.settings.manualMaxCoverageRatio),
      maxImputeHoursPerDay: Number(data.settings.maxImputeHoursPerDay),
    },
    metrics: perMetric,
    outages: outagesOf(data, { outletId }).filter((o) => store.monthOf(o.startAt) <= month && month <= store.monthOf(o.endAt)),
    pendingManual: manualsOf(data, { outletId }).filter((m) => m.status !== '已复核' && m.status !== '驳回'),
  };
}

// 排放口汇总：逐指标给出月均、总量（分来源）、缺口、超标
function outletSummary(data, outletId, month) {
  const outlet = outletOf(data, outletId);
  const settings = data.settings;
  const metrics = ['COD', '氨氮'];
  const rows = metrics.map((metric) => {
    const ex = exceedance(data, outletId, metric, month);
    const bd = monthTotalBreakdown(data, outletId, metric, month);
    const tl = timeline(data, outletId, metric, month);
    return {
      metric,
      monthAverage: ex.monthAverage,
      monthTotalTons: bd.tons,
      autoTons: bd.autoTons,
      imputedTons: bd.imputedTons,
      manualTons: bd.manualTons,
      manualHours: bd.manualHours,
      gapHours: bd.gapHours,
      invalidHours: bd.invalidHours,
      manualCoverageRatio: bd.manualCoverageRatio,
      exceedDaysCount: ex.exceedDaysCount,
      exceedHours: ex.exceedHours,
      hourlyExceed: ex.hourlyExceed,
      exceeded: ex.exceeded,
      limit: ex.limit,
      gaps: tl.gaps,
    };
  });
  const devices = data.devices.filter((d) => d.outletId === outletId).map((d) => Object.assign({}, d, {
    readingCount: data.readings.filter((r) => r.deviceId === d.id).length,
    outageCount: (data.outages || []).filter((o) => o.deviceId === d.id).length,
  }));
  return {
    outlet,
    plant: outlet ? plantOf(data, outlet.plantId) : null,
    month,
    rows,
    devices,
    quarterTotalCod: quarterTotal(data, outletId, 'COD', store.quarterOf(month)),
    permitCodTons: quarterPermitTons(data, 'COD', store.quarterOf(month)),
    annualPermitCodTons: Number(settings.annualPermitCodTons),
    accumulatedCodTons: accumulatedTons(data, 'COD', month, outletId),
    accumulatedAmmoniaTons: accumulatedTons(data, '氨氮', month, outletId),
    settings,
  };
}

module.exports = {
  plantOf, outletOf, deviceOf,
  readingsOf, manualsOf, outagesOf, outagesCovering,
  isCounted, invalidReason, isStopped,
  concentrationOf, effectiveConcentration, oxygenAt, flowAt,
  manualCoverage, timeline,
  dayRows, dailyStats, dailySeries, monthAverage,
  monthTotal, monthTotalBreakdown, monthsBetween, addMonths, latestMonth,
  quarterTotal, quarterPermitTons, accumulatedTons,
  exceedance, outletsOf, outletSummary, coverageReport,
};
