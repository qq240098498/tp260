const express = require('express');
const store = require('./store');
const { AppError } = require('./errors');
const res = require('./resources');
const monitor = require('./monitor');

const router = express.Router();

function withData(handler) {
  return (req, reqRes, next) => {
    try {
      const data = store.load();
      const result = handler(data, req);
      if (result && result.__save === true) store.save(data);
      if (result && typeof result === 'object' && '__body' in result) reqRes.json(result.__body);
      else reqRes.json(result);
    } catch (err) {
      next(err);
    }
  };
}

function currentMonth(data) {
  const stamps = data.readings.map((r) => r.at)
    .concat((data.manualReadings || []).map((m) => m.at))
    .concat((data.outages || []).map((o) => o.endAt));
  stamps.sort();
  return stamps.length ? store.monthOf(stamps[stamps.length - 1]) : store.nowText().slice(0, 7);
}

function overview(data) {
  const settings = data.settings;
  const month = currentMonth(data);
  const outletRows = data.outlets.map((o) => monitor.outletSummary(data, o.id, month));
  const statusCount = {};
  for (const p of data.plants) statusCount[p.status] = (statusCount[p.status] || 0) + 1;
  const deviceStatus = {};
  for (const d of data.devices) deviceStatus[d.status] = (deviceStatus[d.status] || 0) + 1;
  return {
    today: store.nowText().slice(0, 10),
    month,
    plantCount: data.plants.length,
    producingCount: data.plants.filter((p) => p.status === '生产').length,
    outletCount: data.outlets.length,
    runningOutletCount: data.outlets.filter((o) => o.status === '运行').length,
    deviceCount: data.devices.length,
    deviceStatus,
    readingCount: data.readings.length,
    autoCount: data.readings.filter((r) => r.source === '自动').length,
    imputedCount: data.readings.filter((r) => r.source === '补录').length,
    invalidFlagCount: data.readings.filter((r) => r.flag !== '有效').length,
    outageCount: (data.outages || []).length,
    manualCount: (data.manualReadings || []).length,
    reviewedManualCount: (data.manualReadings || []).filter((m) => m.status === '已复核').length,
    pendingManualCount: (data.manualReadings || []).filter((m) => m.status === '待复核').length,
    rejectedManualCount: (data.manualReadings || []).filter((m) => m.status === '驳回').length,
    gapHours: data.outlets.reduce((acc, o) => {
      ['COD', '氨氮'].forEach((metric) => { acc += monitor.timeline(data, o.id, metric, month).gapHours; });
      return acc;
    }, 0),
    manualHours: data.outlets.reduce((acc, o) => {
      ['COD', '氨氮'].forEach((metric) => { acc += monitor.timeline(data, o.id, metric, month).manualHours; });
      return acc;
    }, 0),
    reportCount: data.reports.length,
    submittedReportCount: data.reports.filter((r) => r.status === '已上报').length,
    exceededOutletCount: outletRows.filter((s) => s.rows.some((r) => r.exceeded)).length,
    accumulatedCodTons: monitor.accumulatedTons(data, 'COD'),
    accumulatedAmmoniaTons: monitor.accumulatedTons(data, '氨氮'),
    permitCodTons: Number(settings.annualPermitCodTons),
    permitAmmoniaTons: Number(settings.annualPermitAmmoniaTons),
    settings: {
      oxygenBaseline: Number(settings.oxygenBaseline),
      rangeMax: Number(settings.rangeMax),
      maxImputeHoursPerDay: Number(settings.maxImputeHoursPerDay),
      maxManualSpanHours: Number(settings.maxManualSpanHours),
      manualMinSamplesPerDay: Number(settings.manualMinSamplesPerDay),
      manualMaxCoverageRatio: Number(settings.manualMaxCoverageRatio),
      codDailyLimit: Number(settings.codDailyLimit),
      ammoniaDailyLimit: Number(settings.ammoniaDailyLimit),
      hourlyExceedCountLimit: Number(settings.hourlyExceedCountLimit),
      annualPermitCodTons: Number(settings.annualPermitCodTons),
      annualPermitAmmoniaTons: Number(settings.annualPermitAmmoniaTons),
      tonsDivisor: Number(settings.tonsDivisor),
    },
    outlets: outletRows.map((s) => ({
      id: s.outlet.id,
      code: s.outlet.code,
      name: s.outlet.name,
      status: s.outlet.status,
      type: s.outlet.type,
      plantCode: s.plant ? s.plant.code : '',
      plantName: s.plant ? s.plant.name : '',
      deviceCount: s.devices.length,
      rows: s.rows,
      accumulatedCodTons: s.accumulatedCodTons,
      quarterTotalCod: s.quarterTotalCod,
      permitCodTons: s.permitCodTons,
    })),
  };
}

router.get('/health', (req, r) => r.json({ ok: true, service: '污染源在线监测与排污总量核算台', time: new Date().toISOString() }));
router.get('/summary', withData((data) => overview(data)));
router.get('/settings', withData((data) => data.settings));
router.patch('/settings', withData((data, req) => {
  const patch = req.body || {};
  for (const key of Object.keys(store.DEFAULT_SETTINGS)) if (patch[key] !== undefined) data.settings[key] = patch[key];
  return { __save: true, __body: data.settings };
}));

router.get('/plants', withData((data, req) => res.listPlants(data, req.query)));
router.post('/plants', withData((data, req) => ({ __save: true, __body: res.createPlant(data, req.body || {}) })));
router.get('/plants/:id', withData((data, req) => res.plantDetail(data, req.params.id)));
router.patch('/plants/:id', withData((data, req) => ({ __save: true, __body: res.updatePlant(data, req.params.id, req.body || {}) })));
router.delete('/plants/:id', withData((data, req) => ({ __save: true, __body: res.removePlant(data, req.params.id) })));

router.get('/outlets', withData((data, req) => res.listOutlets(data, req.query)));
router.post('/outlets', withData((data, req) => ({ __save: true, __body: res.createOutlet(data, req.body || {}) })));
router.patch('/outlets/:id', withData((data, req) => ({ __save: true, __body: res.updateOutlet(data, req.params.id, req.body || {}) })));
router.delete('/outlets/:id', withData((data, req) => ({ __save: true, __body: res.removeOutlet(data, req.params.id) })));
router.get('/outlets/:id/summary', withData((data, req) => monitor.outletSummary(data, req.params.id, req.query.month || currentMonth(data))));
router.get('/outlets/:id/daily', withData((data, req) => {
  const month = req.query.month || currentMonth(data);
  const metrics = req.query.metric ? [req.query.metric] : ['COD', '氨氮'];
  const out = {};
  for (const metric of metrics) out[metric] = monitor.dailySeries(data, req.params.id, metric, month);
  return { outletId: req.params.id, month, metrics: out };
}));
router.get('/outlets/:id/exceedance', withData((data, req) => {
  const month = req.query.month || currentMonth(data);
  const metrics = req.query.metric ? [req.query.metric] : ['COD', '氨氮'];
  return metrics.map((metric) => monitor.exceedance(data, req.params.id, metric, month));
}));

router.get('/devices', withData((data, req) => res.listDevices(data, req.query)));
router.post('/devices', withData((data, req) => ({ __save: true, __body: res.createDevice(data, req.body || {}) })));
router.patch('/devices/:id', withData((data, req) => ({ __save: true, __body: res.updateDevice(data, req.params.id, req.body || {}) })));
router.delete('/devices/:id', withData((data, req) => ({ __save: true, __body: res.removeDevice(data, req.params.id) })));

router.get('/readings', withData((data, req) => res.listReadings(data, req.query)));
router.post('/readings', withData((data, req) => ({ __save: true, __body: res.createReading(data, req.body || {}) })));
router.patch('/readings/:id', withData((data, req) => ({ __save: true, __body: res.updateReading(data, req.params.id, req.body || {}) })));
router.delete('/readings/:id', withData((data, req) => ({ __save: true, __body: res.removeReading(data, req.params.id) })));

// 替代取证：设备故障/送检台账
router.get('/outages', withData((data, req) => res.listOutages(data, req.query)));
router.post('/outages', withData((data, req) => ({ __save: true, __body: res.createOutage(data, req.body || {}) })));
router.patch('/outages/:id', withData((data, req) => ({ __save: true, __body: res.updateOutage(data, req.params.id, req.body || {}) })));
router.delete('/outages/:id', withData((data, req) => ({ __save: true, __body: res.removeOutage(data, req.params.id) })));

// 替代取证：手工监测登记（等效值）与复核
router.get('/manual-readings', withData((data, req) => res.listManuals(data, req.query)));
router.post('/manual-readings', withData((data, req) => ({ __save: true, __body: res.createManual(data, req.body || {}) })));
router.patch('/manual-readings/:id', withData((data, req) => ({ __save: true, __body: res.updateManual(data, req.params.id, req.body || {}) })));
router.post('/manual-readings/:id/review', withData((data, req) => ({ __save: true, __body: res.reviewManual(data, req.params.id, req.body || {}) })));
router.delete('/manual-readings/:id', withData((data, req) => ({ __save: true, __body: res.removeManual(data, req.params.id) })));

// 替代取证：某排放口某月的覆盖边界与缺口报告
router.get('/outlets/:id/coverage', withData((data, req) =>
  monitor.coverageReport(data, req.params.id, req.query.month || currentMonth(data))));

router.get('/reports', withData((data, req) => res.listReports(data, req.query)));
router.post('/reports', withData((data, req) => ({ __save: true, __body: res.createReport(data, req.body || {}) })));
router.get('/reports/:id', withData((data, req) => res.reportDetail(data, req.params.id)));
router.patch('/reports/:id', withData((data, req) => ({ __save: true, __body: res.updateReport(data, req.params.id, req.body || {}) })));

router.use((req, r, next) => next(new AppError(404, 'NOT_FOUND', '这个地址没有对应功能：' + req.method + ' ' + req.originalUrl)));

module.exports = router;
