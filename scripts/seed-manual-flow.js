// 一次性种子补充：送检期间在线流量仍在测（演示替代日流量按在线实测配对）
const fs = require('fs');
const path = require('path');
const store = require('../server/store');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');
const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

// dv-0005 9/16 起采样泵故障，台账状态与登记时段保持一致
const dv5 = data.devices.find((d) => d.id === 'dv-0005');
if (dv5) dv5.status = '故障';

// ol-0001 的流量计 dv-0003 在 COD 仪送检期间继续出数（9/16-9/21，逐日 24 小时）
const existed = new Set(data.readings.map((r) => r.outletId + '|' + r.metric + '|' + r.at));
let added = 0;
for (let day = 16; day <= 21; day += 1) {
  for (let h = 0; h < 24; h += 1) {
    const at = '2026-09-' + String(day).padStart(2, '0') + ' ' + String(h).padStart(2, '0') + ':00:00';
    const key = 'ol-0001|流量|' + at;
    if (existed.has(key)) continue;
    const value = 760 + ((h * 37 + day * 13) % 180); // 760-939 m³/h，确定性伪波动
    data.readings.push({
      id: store.nextId('rd', data.readings),
      outletId: 'ol-0001',
      deviceId: 'dv-0003',
      metric: '流量',
      at,
      value,
      flag: '有效',
      source: '自动',
      operator: '',
      remark: '',
    });
    added += 1;
  }
}

fs.writeFileSync(dataFile, JSON.stringify(store.normalize(data), null, 2), 'utf8');
console.log('补入在线流量 ' + added + ' 条；dv-0005 状态改为故障');
