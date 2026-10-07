// 一次性种子：设备故障/送检时段 + 手工监测（替代取证）样例数据
// 用法：node scripts/seed-manual.js
const fs = require('fs');
const path = require('path');
const store = require('../server/store');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');
const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
if (!Array.isArray(data.deviceOutages)) data.deviceOutages = [];
if (!Array.isArray(data.manualRecords)) data.manualRecords = [];

const nextId = (prefix, list) => store.nextId(prefix, list);

// 1) 青岭化工总排口 COD 仪 9/16-9/21 送检定值（6 天；口径连续替代上限 5 天，第 6 天按缺口处理）
const outage1 = {
  id: nextId('ot', data.deviceOutages),
  deviceId: 'dv-0001',
  outletId: 'ol-0001',
  reason: '送检',
  startAt: '2026-09-16 00:00:00',
  endAt: '2026-09-21 23:00:00',
  registeredBy: '王工',
  registeredAt: '2026-09-16 08:10:00',
  remark: 'COD 在线分析仪周期送检校准，期间以手工监测作为替代取值依据',
};
data.deviceOutages.push(outage1);

// 2) 白河电镀总排口 COD 仪 9/16-9/22 故障（设备台账状态为校准/维修期间），无替代 → 整段缺口
data.deviceOutages.push({
  id: nextId('ot', data.deviceOutages),
  deviceId: 'dv-0005',
  outletId: 'ol-0002',
  reason: '故障',
  startAt: '2026-09-16 00:00:00',
  endAt: '2026-09-22 23:00:00',
  registeredBy: '赵工',
  registeredAt: '2026-09-16 09:00:00',
  remark: '采样泵故障待配件，期间仅 9/16 一次手工样且尚未复核',
});

// 手工监测记录：dv-0001 COD，9/16、17、18、20、21 每天 4 次；9/19 只有 3 次（样本不足 → 缺口）
const dayValues = {
  '2026-09-16': [62.4, 65.1, 63.8, 66.0],
  '2026-09-17': [68.0, 70.5, 69.2, 71.4],
  '2026-09-18': [64.7, 66.2, 65.5, 67.0],
  '2026-09-19': [72.1, 70.8, 73.4], // 仅 3 次，少于口径每日 4 次
  '2026-09-20': [69.5, 71.0, 68.6, 70.2],
  '2026-09-21': [66.8, 68.2, 67.5, 69.0], // 第 6 个连续替代日，超连续上限 → 缺口
};
const sampleTimes = ['08:30:00', '11:30:00', '14:30:00', '17:30:00'];
let seq = 0;
Object.keys(dayValues).forEach((day) => {
  dayValues[day].forEach((v, i) => {
    seq += 1;
    data.manualRecords.push({
      id: nextId('mr', data.manualRecords),
      outletId: 'ol-0001',
      deviceId: 'dv-0001',
      metric: 'COD',
      at: day + ' ' + sampleTimes[i],
      value: v,
      method: '重铬酸盐法（HJ 828-2017）',
      detectLimit: 4,
      resultUnit: 'mg/L',
      labName: '清源环境检测有限公司',
      evidenceNo: 'QY-JC-2026-' + String(1000 + seq),
      sampledBy: '孙丽',
      reviewStatus: '已复核',
      reviewedBy: '周明',
      reviewedAt: '2026-09-22 10:00:00',
      registeredBy: '王工',
      registeredAt: day + ' 18:05:00',
      remark: '',
    });
  });
});

// 3) 白河 9/16 有一次手工样，但还没人复核 → 不能作为等效值，时段仍按缺口
data.manualRecords.push({
  id: nextId('mr', data.manualRecords),
  outletId: 'ol-0002',
  deviceId: 'dv-0005',
  metric: 'COD',
  at: '2026-09-16 10:00:00',
  value: 41.2,
  method: '重铬酸盐法（HJ 828-2017）',
  detectLimit: 4,
  resultUnit: 'mg/L',
  labName: '清源环境检测有限公司',
  evidenceNo: 'QY-JC-2026-2001',
  sampledBy: '孙丽',
  reviewStatus: '待复核',
  reviewedBy: '',
  reviewedAt: '',
  registeredBy: '赵工',
  registeredAt: '2026-09-16 16:20:00',
  remark: '报告原件待归档，等周明复核',
});

fs.writeFileSync(dataFile, JSON.stringify(store.normalize(data), null, 2), 'utf8');
console.log('已写入设备时段 ' + data.deviceOutages.length + ' 段、手工监测记录 ' + data.manualRecords.length + ' 条');
