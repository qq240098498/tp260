// 端到端口径与校验验证（只读 db.json，所有写操作在内存对象上做，不落盘）
// 用法：node scripts/verify.js
const assert = require('assert');
const store = require('../server/store');
const monitor = require('../server/monitor');
const res = require('../server/resources');
const { AppError } = require('../server/errors');

const data = store.load();
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}
function expectError(code, fn) {
  try { fn(); throw new Error('应当抛错但没有'); }
  catch (e) { assert.strictEqual(e.code, code, '应为 ' + code + ' 实际 ' + e.code); }
}

console.log('一、日分类（ol-0001 COD 2026-09）');
const series = monitor.dailySeries(data, 'ol-0001', 'COD', '2026-09');
const byDay = {};
series.forEach((d) => { byDay[d.day] = d; });
check('9/8 自动有效日（24 小时、在线流量）', () => {
  assert.strictEqual(byDay['2026-09-08'].kind, 'auto');
  assert.strictEqual(byDay['2026-09-08'].valid, true);
  assert.strictEqual(byDay['2026-09-08'].flowBasis, '在线实测');
});
check('9/10 补录 8 小时超 6 小时上限 → 缺口', () => {
  assert.strictEqual(byDay['2026-09-10'].valid, false);
  assert.strictEqual(byDay['2026-09-10'].kind, 'gap');
  assert.ok(byDay['2026-09-10'].gapReason.includes('补录'));
});
['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-20'].forEach((day) => {
  check(day + ' 手工替代日（4 样本、已复核、按手工值计入）', () => {
    const d = byDay[day];
    assert.strictEqual(d.kind, 'manual', day + ' kind=' + d.kind + ' ' + d.gapReason);
    assert.strictEqual(d.manualSamples, 4);
    assert.strictEqual(d.valid, true);
    assert.ok(d.loadManualTons > 0);
    assert.strictEqual(d.loadAutoTons, 0);
    assert.ok(d.evidence.length === 4 && d.evidence[0].method && d.evidence[0].detectLimit != null && d.evidence[0].labName && d.evidence[0].reviewedBy);
  });
});
check('9/19 仅 3 次样本 < 口径 4 次 → 缺口（有依据也不许顶）', () => {
  assert.strictEqual(byDay['2026-09-19'].kind, 'gap');
  assert.ok(byDay['2026-09-19'].gapReason.includes('样本不足'));
});
check('9/21 连续替代第 6 天 > 上限 5 天 → 缺口', () => {
  assert.strictEqual(byDay['2026-09-21'].kind, 'gap');
  assert.ok(byDay['2026-09-21'].gapReason.includes('连续替代第 6 天'));
});
check('替代浓度=手工均值（9/16 应为 64.33）', () => {
  assert.strictEqual(byDay['2026-09-16'].average, 64.33);
});

console.log('二、白河 ol-0002：故障期间无有效依据 → 缺口');
const s2 = monitor.dailySeries(data, 'ol-0002', 'COD', '2026-09');
const b16 = s2.find((d) => d.day === '2026-09-16');
check('9/16 有 1 条待复核记录但不能作为等效值', () => {
  assert.strictEqual(b16.kind, 'gap');
  assert.strictEqual(b16.pendingManualCount, 1);
  assert.ok(b16.gapReason.includes('待复核'));
});

console.log('三、月总量自动/替代拆分且缺口不外推');
const parts = monitor.monthTotalParts(data, 'ol-0001', 'COD', '2026-09');
check('自动与替代吨数分别大于 0 且合计一致', () => {
  assert.ok(parts.autoTons > 0 && parts.manualTons > 0);
  assert.strictEqual(Number((parts.autoTons + parts.manualTons).toFixed(4)), parts.tons);
});
check('替代 4 天、缺口 19 天（含无数据日与超界日）', () => {
  assert.strictEqual(parts.manualDays, 4);
  assert.strictEqual(parts.gapDays, 19);
});
check('月均分母是有效天数 11（不是 30）', () => {
  assert.strictEqual(monitor.monthAverage(data, 'ol-0001', 'COD', '2026-09'),
    Number((series.filter((d) => d.valid).reduce((a, d) => a + d.average, 0) / 11).toFixed(2)));
});

console.log('四、登记校验：缺依据不许入账');
check('时段外登记 → NO_OUTAGE_WINDOW', () => {
  expectError('NO_OUTAGE_WINDOW', () => res.createManual(data, {
    outletId: 'ol-0002', deviceId: 'dv-0005', metric: 'COD', at: '2026-08-01 10:00:00',
    value: 40, method: '重铬酸盐法', detectLimit: 4, resultUnit: 'mg/L', labName: '清源',
    evidenceNo: 'X', sampledBy: '甲', registeredBy: '乙',
  }));
});
check('方法/检出限/单位/监测单位/报告编号/采样人缺失 → VALIDATION_FAILED', () => {
  expectError('VALIDATION_FAILED', () => res.createManual(data, {
    outletId: 'ol-0002', deviceId: 'dv-0005', metric: 'COD', at: '2026-09-17 10:00:00',
    value: 40, registeredBy: '乙',
  }));
});

console.log('五、复核链路');
const rec = res.createManual(data, {
  outletId: 'ol-0002', deviceId: 'dv-0005', metric: 'COD', at: '2026-09-17 10:00:00',
  value: 40.2, method: '重铬酸盐法（HJ 828-2017）', detectLimit: 4, resultUnit: 'mg/L',
  labName: '清源环境检测有限公司', evidenceNo: 'T-1', sampledBy: '孙丽', registeredBy: '赵工',
});
check('登记后为待复核、不计入', () => {
  assert.strictEqual(rec.reviewStatus, '待复核');
  assert.strictEqual(rec.counted, false);
});
check('复核人=采样人 → 拒绝', () => {
  expectError('VALIDATION_FAILED', () => res.reviewManual(data, rec.id, { action: 'approve', reviewedBy: '孙丽' }));
});
check('他人复核通过 → 计入；已复核锁定修改/删除', () => {
  const ok = res.reviewManual(data, rec.id, { action: 'approve', reviewedBy: '周明' });
  assert.strictEqual(ok.reviewStatus, '已复核');
  assert.strictEqual(ok.counted, true);
  expectError('MANUAL_REVIEWED_LOCKED', () => res.updateManual(data, rec.id, { value: 99 }));
  expectError('MANUAL_REVIEWED_LOCKED', () => res.removeManual(data, rec.id));
});
check('退回后可删除', () => {
  res.reviewManual(data, rec.id, { action: 'reject', reviewedBy: '周明' });
  const out = res.removeManual(data, rec.id);
  assert.strictEqual(out.removed, rec.id);
});

console.log('六、覆盖比例上限：调小后替代日显式变缺口');
const saved = data.settings.manualMaxCoveragePercent;
data.settings.manualMaxCoveragePercent = 5; // 30 天 × 24h × 5% = 36h，只够 1 个替代日
try {
  const capped = monitor.dailySeries(data, 'ol-0001', 'COD', '2026-09');
  const manualKept = capped.filter((d) => d.kind === 'manual').length;
  const covGaps = capped.filter((d) => d.valid === false && d.gapReason.includes('覆盖率')).length;
  assert.strictEqual(manualKept, 1, '应只剩 1 个替代日，实际 ' + manualKept);
  assert.ok(covGaps >= 3, '其余替代日应标记覆盖率缺口，实际 ' + covGaps);
  passed += 1; console.log('  ✓ 超出覆盖比例的替代日按缺口处理且页面可见原因');
} finally {
  data.settings.manualMaxCoveragePercent = saved;
}

console.log('七、合并清单与筛选');
check('readings 清单包含自动与手工两类并计数', () => {
  const list = res.listReadings(data, { outletId: 'ol-0001', day: '2026-09-16' });
  assert.strictEqual(list.autoCount, 24);
  assert.strictEqual(list.manualCount, 4);
  assert.ok(list.rows.every((r) => r.rowKind));
});
check('按复核状态筛选时只出手工行', () => {
  const list = res.listReadings(data, { reviewStatus: '待复核' });
  assert.ok(list.autoCount === 0 && list.manualCount === 1);
  assert.ok(list.rows.every((r) => r.rowKind === 'manual' && r.reviewStatus === '待复核'));
});

console.log('八、时段重叠校验');
check('同设备重叠时段 → OUTAGE_OVERLAP', () => {
  expectError('OUTAGE_OVERLAP', () => res.createOutage(data, {
    deviceId: 'dv-0005', reason: '故障', startAt: '2026-09-18 00:00:00', endAt: '2026-09-19 23:00:00', registeredBy: '赵工',
  }));
});

console.log('九、停产停用不参与但保留');
check('ol-0004（停用）每日为 stopped，不产生缺口与总量', () => {
  const s4 = monitor.dailySeries(data, 'ol-0004', 'COD', '2026-09');
  assert.ok(s4.every((d) => d.kind === 'stopped'));
  const p4 = monitor.monthTotalParts(data, 'ol-0004', 'COD', '2026-09');
  assert.strictEqual(p4.tons, 0);
  assert.strictEqual(p4.gapDays, 0);
});

console.log('\n通过 ' + passed + ' 项。' + (process.exitCode ? '存在失败项。' : '全部通过。'));
