// 前端冒烟：用 jsdom 加载真实页面与 app.js，fetch 走本地在跑的服务，逐视图渲染
// 用法：node scripts/smoke-ui.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const dom = new JSDOM(html.replace(/<script src="app.js"><\/script>/, ''), {
  url: 'http://localhost:5260/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
});

const errors = [];
dom.window.addEventListener('error', (e) => errors.push(e.message));
dom.window.fetch = (url, opts) => globalThis.fetch(new URL(url, 'http://localhost:5260/').href, opts);

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  dom.window.eval(appJs);
  await wait(2200); // init() 的 loadAll（请求数较多，等所有视图切换回 overview 完成）

  const doc = dom.window.document;
  const views = ['overview', 'plants', 'devices', 'readings', 'evidence', 'accounting'];
  for (const v of views) {
    doc.querySelector('.tab[data-view="' + v + '"]').click();
    await wait(700);
    const active = doc.querySelector('.view.is-active');
    const cards = active.querySelectorAll('.card').length;
    const rows = active.querySelectorAll('tbody tr').length;
    const empties = active.querySelectorAll('.empty').length;
    console.log(v + ': cards=' + cards + ' rows=' + rows + (empties ? ' empties=' + empties : ''));
    if (active.dataset.view !== v) throw new Error(v + ' 视图没有保持激活（被异步渲染切回）');
  }
  if (doc.querySelector('.view[data-view="evidence"]').querySelectorAll('tbody tr').length < 10) {
    throw new Error('替代取证页时段/手工记录行数异常');
  }

  // 打开核算页缺口横幅
  doc.querySelector('.tab[data-view="accounting"]').click();
  await wait(900);
  const danger = doc.querySelectorAll('.card-danger').length;
  console.log('核算页缺口卡片数=' + danger);
  if (!danger) errors.push('核算页没有显示缺口卡片');

  // 逐日表第一行可展开（手工/缺口行样式）
  const manualRows = doc.querySelectorAll('tr.row-manual').length;
  const gapRows = doc.querySelectorAll('tr.row-danger').length;
  console.log('行样式：手工替代 ' + manualRows + ' 行，缺口 ' + gapRows + ' 行');

  // 关键文案存在性（在核算页渲染完成后）
  const all = doc.body.textContent;
  for (const kw of ['缺口', '手工替代', '流量口径', '待复核', '替代取证']) {
    if (!all.includes(kw)) errors.push('页面缺少关键文案：' + kw);
  }
  // 月总量自动/替代拆分数字
  const accText = (doc.querySelector('#content-accounting') || {}).textContent || '';
  if (!accText.includes('17.1732') || !accText.includes('5.504')) errors.push('核算页缺少自动/替代吨数拆分');

  if (errors.length) {
    console.error('\n前端冒烟失败：');
    errors.forEach((e) => console.error(' - ' + e));
    process.exit(1);
  }
  console.log('\n前端冒烟全部通过。');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
