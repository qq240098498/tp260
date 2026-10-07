const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULT_SETTINGS = {
  oxygenBaseline: 8,
  rangeMin: 0,
  rangeMax: 500,
  maxImputeHoursPerDay: 6,
  flowWeighted: true,
  hourlyExceedCountLimit: 3,
  codDailyLimit: 100,
  ammoniaDailyLimit: 15,
  annualPermitCodTons: 12,
  annualPermitAmmoniaTons: 1.8,
  permitYearStart: '2026-01-01',
  tonsDivisor: 1000000000,
  // 手工替代口径：单次故障/送检替代可覆盖的最长连续小时数（默认 3 天）
  maxManualSpanHours: 72,
  // 手工替代口径：被覆盖的每个自然日至少要有几次手工监测（频次）
  manualMinSamplesPerDay: 4,
  // 手工替代口径：单月替代小时数占应监测小时数的比例上限（超出按缺口处理）
  manualMaxCoverageRatio: 0.25,
};

function normalize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  for (const key of ['plants', 'outlets', 'devices', 'readings', 'reports', 'outages', 'manualReadings']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  return data;
}

function load() {
  let text;
  try {
    text = fs.readFileSync(dataFile, 'utf8');
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件读不出来，请检查 data/db.json 是否还在');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件解析失败，请检查 data/db.json 的内容');
  }
  return normalize(raw);
}

function save(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
}

function nextId(prefix, list) {
  let max = 0;
  for (const item of list || []) {
    const matched = String(item.id || '').match(/(\d+)$/);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

function round(n, digits) {
  const d = digits == null ? 2 : digits;
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(d));
}

function daysInMonth(month) {
  const [y, m] = String(month).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function daysInQuarter(quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  let total = 0;
  for (const m of [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3]) {
    total += daysInMonth(y + '-' + String(m).padStart(2, '0'));
  }
  return total;
}

// 某一年的天数（闰年 366）
function daysInYear(year) {
  const y = Number(year);
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
}

function monthOf(at) {
  return String(at).slice(0, 7);
}

function dayOf(at) {
  return String(at).slice(0, 10);
}

function quarterOf(month) {
  const [y, m] = String(month).split('-').map(Number);
  return y + '-Q' + Math.floor((m - 1) / 3 + 1);
}

// 把 'YYYY-MM-DD HH:00:00' 转成北京时间对应的 UTC 毫秒数（数据文本即北京时间，按 UTC 解析即可）
function hourValue(at) {
  const s = String(at);
  return Date.UTC(
    Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)),
    Number(s.slice(11, 13)), 0, 0
  );
}

const HOUR_MS = 3600 * 1000;

// 两个整点时刻相差的小时数（b − a）
function hoursBetween(a, b) {
  return Math.round((hourValue(b) - hourValue(a)) / HOUR_MS);
}

// 在整点时刻上加 n 小时，仍返回 'YYYY-MM-DD HH:00:00'
function addHours(at, n) {
  return textFromHour(hourValue(at) + n * HOUR_MS);
}

function textFromHour(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
    + ' ' + p(d.getUTCHours()) + ':00:00';
}

// 某月的起止小时（含）：start=首日 00:00，end=末日 23:00
function monthHourRange(month) {
  return { start: month + '-01 00:00:00', end: month + '-' + String(daysInMonth(month)).padStart(2, '0') + ' 23:00:00' };
}

// 某月内的全部整点时刻（升序）
function monthHours(month) {
  const range = monthHourRange(month);
  const count = hoursBetween(range.start, range.end) + 1;
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) out[i] = addHours(range.start, i);
  return out;
}

// 许可年：单位许可年起始日 MM-DD 定义年度切换日，给定任意月份返回该月所属许可年的 [起始月, 结束月]
function permitYearRange(permitYearStart, month) {
  const md = String(permitYearStart || '2026-01-01').slice(5);
  const [y] = String(month).split('-').map(Number);
  const yearStartThis = y + '-' + md + ' 00:00:00';
  const monthStart = month + '-01 00:00:00';
  const baseYear = monthStart < yearStartThis ? y - 1 : y;
  return {
    start: baseYear + '-' + md + ' 00:00:00',
    end: (baseYear + 1) + '-' + md + ' 00:00:00',
  };
}

function nowText() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return now.getUTCFullYear() + '-' + p(now.getUTCMonth() + 1) + '-' + p(now.getUTCDate()) + ' ' + p(now.getUTCHours()) + ':' + p(now.getUTCMinutes()) + ':' + p(now.getUTCSeconds());
}

module.exports = {
  load, save, nextId, normalize, round, daysInMonth, daysInQuarter, daysInYear, monthOf, dayOf, quarterOf, nowText,
  hourValue, HOUR_MS, hoursBetween, addHours, monthHourRange, monthHours, permitYearRange,
  DEFAULT_SETTINGS, dataFile,
};
