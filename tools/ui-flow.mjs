/**
 * 交互流程验证：模拟真实用户操作走一遍。
 *   node tools/ui-flow.mjs [baseUrl]
 *
 * 覆盖：搜索 → 添加自选 → 打开详情 → 排序 → 汇率开关 → 移除 → 主题切换。
 */

import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9600 + Math.floor(Math.random() * 300);
const BASE = process.argv[2] || 'http://127.0.0.1:5178/';
const SHOT_DIR = process.argv[3] || '/tmp/qdii-flow';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = mkdtempSync(path.join(tmpdir(), 'qdii-flow-'));
const home = path.join(root, 'home');
mkdirSync(home, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

/**
 * 清掉上一次跑剩的 Chrome。
 * SIGKILL 只杀父进程，渲染/网络等子进程会变孤儿；攒多了会让新起的
 * Chrome 网络服务起不来（表现为 http(s) 全部变成 about:blank）。
 */
function killStaleChrome() {
  try {
    execSync(
      "pkill -f 'user-data-dir=.*qdii-chrome-' 2>/dev/null; " +
      "pkill -f 'user-data-dir=.*qdii-flow-' 2>/dev/null; true",
      { stdio: 'ignore', shell: '/bin/bash' },
    );
  } catch { /* 没有可杀的进程 */ }
}
killStaleChrome();

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(root, 'p')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--no-sandbox', '--disable-breakpad', '--disable-crash-reporter',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1500,1000',
  BASE,
], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home, TMPDIR: root } });

let list;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    if (r.ok) {
      const l = await r.json();
      const p = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) { list = p; break; }
    }
  } catch { /* retry */ }
  await sleep(250);
}

const ws = new WebSocket(list.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pend = new Map();
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    pageErrors.push((m.params.args || []).map((a) => a.value ?? a.description).join(' '));
  }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
  }
  return r.result?.result?.value;
}

async function shot(name) {
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(SHOT_DIR, `${name}.png`);
  writeFileSync(p, Buffer.from(result.data, 'base64'));
  return p;
}

await send('Runtime.enable');
await send('Page.enable');
// 同 ui-check：显式导航，避免 attach 到 Chrome 自带的 about:blank
await send('Page.navigate', { url: BASE });

// 等页面就绪
for (let i = 0; i < 100; i++) {
  try {
    const s = await evaluate('JSON.stringify({s:document.readyState,o:location.origin})');
    const v = JSON.parse(s || '{}');
    if (v.s === 'complete' && v.o === new URL(BASE).origin) break;
  } catch { /* 上下文切换中 */ }
  await sleep(200);
}

const results = [];
const check = (label, condition, detail = '') => {
  results.push({ label, ok: !!condition, detail });
  console.log(`  ${condition ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
};


/** 等骨架屏消失（新增基金后要重新拉全部持仓，需要十几秒）。 */
async function waitRows(min) {
  return Number(await evaluate(`
    (async () => {
      for (let i = 0; i < 160; i++) {
        const n = document.querySelectorAll('#grid-body tr[data-code]').length;
        if (n >= ${min} && !document.querySelector('#grid-body .skeleton-row')) return n;
        await new Promise(r => setTimeout(r, 500));
      }
      return document.querySelectorAll('#grid-body tr[data-code]').length;
    })()
  `));
}

console.log('\n美股基金估值宝 · 交互流程验证\n' + '─'.repeat(56) + '\n');

/* 0. 默认自选（内置基金池） ------------------------------------------- */
// 25 只基金冷启动要拉 50 个上游接口，轮询等它渲染完
const seededRows = Number(await evaluate(`
  (async () => {
    for (let i = 0; i < 200; i++) {
      const n = document.querySelectorAll('#grid-body tr[data-code]').length;
      if (n > 0 && !document.querySelector('#grid-body .skeleton-row')) return n;
      await new Promise(r => setTimeout(r, 500));
    }
    return 0;
  })()
`));
const d0 = JSON.parse(await evaluate(`JSON.stringify({
  rows: document.querySelectorAll('#grid-body tr[data-code]').length,
  count: document.getElementById('watch-count')?.textContent,
  starsOn: document.querySelectorAll('#grid-body .star.is-on').length,
  stored: localStorage.getItem('qdii-desk.watch.v1'),
})`));
check('零收藏时显示预设基金', seededRows > 0, `${seededRows} 只 · 计数 ${d0.count}`);
check('预设未被写盘（属于回落状态）', d0.stored === null, `localStorage=${d0.stored}`);
check('预设默认已收藏（星标实心）', d0.starsOn === seededRows, `${d0.starsOn}/${seededRows}`);

/* 盘前 / 盘中 / 盘后 三列 -------------------------------------------- */
const cols = JSON.parse(await evaluate(`JSON.stringify({
  head: [...document.querySelectorAll('#grid thead th')].map(e => e.textContent.trim().replace(/\\s+/g,' ')),
  live: document.querySelector('#grid thead th.c-est.is-live')?.dataset.col ?? null,
  activeCells: document.querySelectorAll('#grid-body td.c-est.is-active').length,
  visibleDashes: [...document.querySelectorAll('#grid-body .est-dash')].filter(e => !e.hidden).length,
  covSpark: document.querySelectorAll('#grid .c-cov, #grid .c-spark').length,
  firstStarIsLeftmost: document.querySelector('#grid-body tr[data-code]')?.firstElementChild?.classList.contains('c-star') ?? false,
})`));
check('表头含盘前/盘中/盘后三列',
  ['盘前估算', '盘中估算', '盘后估算'].every((t) => cols.head.some((x) => x.includes(t))),
  cols.head.filter((x) => x.includes('估算')).join(' | '));
check('已移除覆盖与采样列', cols.covSpark === 0);
check('当前阶段列被高亮', !!cols.live, `当前 ${cols.live}`);
check('非当前阶段显示「——」', cols.visibleDashes > 0, `${cols.visibleDashes} 个占位`);
check('星标在每行最左侧', cols.firstStarIsLeftmost);

/* 选基面板与星标 ------------------------------------------------------ */
await evaluate(`document.querySelector('#btn-picker').click()`);
await sleep(800);
const pk = JSON.parse(await evaluate(`JSON.stringify({
  open: !document.getElementById('picker').hidden,
  funds: document.querySelectorAll('#picker-list .pk-fund').length,
  classes: document.querySelectorAll('#picker-list .pk-class').length,
  starsOn: document.querySelectorAll('#picker-list .star.is-on').length,
  count: document.getElementById('picker-count')?.textContent,
})`));
check('选基面板可打开', pk.open, `${pk.funds} 只基金 / ${pk.classes} 个份额`);
check('默认只收藏 A 类', pk.starsOn === pk.funds, `已收藏 ${pk.starsOn} / 共 ${pk.funds} 只 · ${pk.count}`);

const clickClassStar = (cls) => evaluate(`
  (() => {
    const el = [...document.querySelectorAll('#picker-list .pk-class')]
      .find(x => x.querySelector('.pk-cls').textContent.startsWith('${cls}'));
    el.querySelector('.star').click();
    return true;
  })()
`);

await clickClassStar('C');
await sleep(600);
const pk2 = JSON.parse(await evaluate(`JSON.parse(localStorage.getItem('qdii-desk.watch.v1') || '[]').length`));
check('点星标可收藏 C 类', pk2 === seededRows + 1, `自选 ${pk2} 条`);

await clickClassStar('C');
await sleep(600);
const pk3 = JSON.parse(await evaluate(`JSON.parse(localStorage.getItem('qdii-desk.watch.v1') || '[]').length`));
check('再点星标可取消收藏', pk3 === seededRows, `自选 ${pk3} 条`);

await evaluate(`document.getElementById('picker-close').click()`);
await sleep(300);
check('选基面板可关闭', await evaluate(`document.getElementById('picker').hidden`));

/* 清空自选 -> 预设回落 ----------------------------------------------- */
await evaluate(`
  localStorage.removeItem('qdii-desk.watch.v1');
  localStorage.removeItem('qdii-desk.positions.v1');
  history.replaceState(null, '', location.pathname);
  'cleared'
`);
await send('Page.reload', { ignoreCache: true });
await sleep(6000);
const back = JSON.parse(await evaluate(`JSON.stringify({
  rows: document.querySelectorAll('#grid-body tr[data-code]').length,
})`));
check('清空自选后预设自动回来', back.rows === seededRows, `${back.rows} 只`);

/* 1. 搜索 ------------------------------------------------------------ */
await evaluate(`document.querySelector('#search-input').focus()`);
await send('Input.insertText', { text: '纳斯达克' });
// 上游联想接口偶尔慢，轮询等待而不是固定 sleep
const srCount = await evaluate(`
  (async () => {
    for (let i = 0; i < 60; i++) {
      const n = document.querySelectorAll('#search-results .sr-item').length;
      if (n > 0) return n;
      await new Promise(r => setTimeout(r, 250));
    }
    return 0;
  })()
`);
const srFirst = await evaluate(`document.querySelector('#search-results .sr-item')?.textContent || ''`);
check('搜索联想返回结果', srCount > 0, `${srCount} 条 · 首条「${srFirst.replace(/\s+/g, ' ').trim()}」`);
await shot('01-search');

/* 2. 加入自选 -------------------------------------------------------- */
await evaluate(`document.querySelector('#search-results .sr-item')?.click()`);
let rows = await waitRows(seededRows + 1);
const toastText = await evaluate(`document.querySelector('#toast')?.textContent || ''`);
check('点击搜索结果后加入自选', rows === seededRows + 1, `表格 ${rows} 行 · 提示「${toastText}」`);
check('搜索框已清空', (await evaluate(`document.querySelector('#search-input').value`)) === '');

/* 3. 再加一只（代码直输） --------------------------------------------- */
await evaluate(`
  (async () => {
    const inp = document.querySelector('#search-input');
    inp.focus(); inp.value = '161125';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 200));
      const items = [...document.querySelectorAll('#search-results .sr-item')];
      const hit = items.find(el => el.textContent.includes('161125'));
      if (hit) { hit.click(); return 'clicked'; }
    }
    return 'no-result';
  })()
`);
rows = await waitRows(seededRows + 2);
check('可继续添加基金', rows === seededRows + 2, `表格 ${rows} 行`);

/* 4. 打开详情 -------------------------------------------------------- */
await evaluate(`document.querySelector('#grid-body tr[data-code]').click()`);
await sleep(9000);
const detail = await evaluate(`JSON.stringify({
  name: document.querySelector('#detail .dt-name')?.textContent || null,
  hero: document.querySelector('#detail .hero-val')?.textContent || null,
  holds: document.querySelectorAll('#detail .hold-table tbody tr').length,
  charts: document.querySelectorAll('#detail .chart-svg').length,
  chartCards: document.querySelectorAll('#detail .chart-card').length,
  facts: document.querySelectorAll('#detail .fact').length,
  hash: location.hash,
})`);
const d = JSON.parse(detail);
check('点击行打开详情面板', !!d.name, `${d.name} · 估算 ${d.hero}`);
check('详情含持仓穿透表', d.holds >= 5, `${d.holds} 行`);
// 盘中采样曲线需要服务运行一段时间才有 >=2 个点，所以只断言图表容器齐备
check('详情含两张图表区', d.chartCards === 2 && d.charts >= 1, `${d.chartCards} 个图表区 / ${d.charts} 张已绘制`);
check('详情含指标卡', d.facts === 4, `${d.facts} 项`);
check('深链同步到地址栏', /^#\d{6}$/.test(d.hash), d.hash);
await shot('02-detail');

/* 5. 持仓录入 -------------------------------------------------------- */
check('详情含「我的持仓」卡片', await evaluate(`!!document.querySelector('#detail .pos-card')`));

await evaluate(`
  (() => {
    const set = (sel, v) => {
      const el = document.querySelector(sel);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('#pos-amount', '50000');
    set('#pos-profit', '3200');
    return true;
  })()
`);
await sleep(400);
const bs = JSON.parse(await evaluate(`JSON.stringify({
  amount: document.querySelector('#pos-amount').value,
  profit: document.querySelector('#pos-profit').value,
  sumHidden: document.querySelector('#detail .pos-sum').hidden,
})`));
check('可输入持仓金额与收益', bs.amount === '50000' && bs.profit === '3200');
check('未保存时不显示汇总', bs.sumHidden === true);

await evaluate(`document.querySelector('#detail .pos-actions .btn-primary').click()`);
await sleep(1200);
const as = JSON.parse(await evaluate(`JSON.stringify({
  sumHidden: document.querySelector('#detail .pos-sum').hidden,
  sum: [...document.querySelectorAll('#detail .pos-sum dd')].map(e => e.textContent.trim().replace(/\\s+/g,' ')),
  byCode: Object.keys(JSON.parse(localStorage.getItem('qdii-desk.positions.v1') || '{}')).length,
  toast: document.querySelector('#toast')?.textContent,
})`));
check('保存后写入 localStorage', as.byCode === 1, `${as.byCode} 条 · 提示「${as.toast}」`);
check('保存后显示汇总', as.sumHidden === false, as.sum.join(' | '));
check('收益率按 收益÷成本 自动推算', /%/.test(as.sum[1] || ''), as.sum[1]);
check('算出今日预估收益', /¥/.test(as.sum[2] || ''), as.sum[2]);

const bp = JSON.parse(await evaluate(`JSON.stringify({
  hasPnlCol: !document.querySelector('#grid').classList.contains('no-pnl'),
  head: [...document.querySelectorAll('#grid thead th')].map(e => e.textContent.trim()),
  row: [...document.querySelectorAll('#grid-body tr[data-code]')[0].children].map(td => td.textContent.trim().replace(/\\s+/g,' ')),
  footSum: document.querySelector('#foot-sum')?.textContent.replace(/\\s+/g,' '),
})`));
check('看板出现「今日预估收益」列', bp.hasPnlCol && bp.head.some((t) => t.includes('今日预估')), bp.row[3] || '');
check('看板页脚显示组合汇总', /总市值/.test(bp.footSum || ''), bp.footSum || '');

/* 6. 刷新后持仓保留 -------------------------------------------------- */
await send('Page.reload', { ignoreCache: true });
await sleep(10000);
const pp = JSON.parse(await evaluate(`JSON.stringify({
  amount: document.querySelector('#pos-amount')?.value,
  sumHidden: document.querySelector('#detail .pos-sum')?.hidden,
})`));
check('刷新后持仓回填', pp.amount === '50000' && pp.sumHidden === false, `金额 ${pp.amount}`);

/* 7. 清除持仓 -------------------------------------------------------- */
await evaluate(`document.querySelector('#detail .pos-actions .btn-ghost').click()`);
await sleep(1800);
const cl = JSON.parse(await evaluate(`JSON.stringify({
  amount: document.querySelector('#pos-amount')?.value,
  byCode: Object.keys(JSON.parse(localStorage.getItem('qdii-desk.positions.v1') || '{}')).length,
  noPnl: document.querySelector('#grid').classList.contains('no-pnl'),
})`));
check('可清除持仓', cl.amount === '' && cl.byCode === 0);
check('清空后隐藏预估收益列', cl.noPnl === true);

/* 8. 排序 ------------------------------------------------------------ */
await evaluate(`document.querySelector('#sort-seg button[data-sort="change"]').click()`);
await sleep(1200);
const sortState = await evaluate(`JSON.stringify({
  on: document.querySelector('#sort-seg button.is-on')?.dataset.sort,
  order: [...document.querySelectorAll('#grid-body tr[data-code]')].map(r => r.dataset.code),
  stored: JSON.parse(localStorage.getItem('qdii-desk.prefs.v1')).sort,
})`);
const s2 = JSON.parse(sortState);
check('切换排序', s2.on === 'change' && s2.stored === 'change', `顺序 ${s2.order.join(' > ')}`);

/* 9. 汇率开关 -------------------------------------------------------- */
await evaluate(`(() => { const t = document.querySelector('#toggle-fx'); t.checked = false; t.dispatchEvent(new Event('change', {bubbles:true})); })()`);
await sleep(9000);
const fxOff = await evaluate(`JSON.stringify({
  pref: JSON.parse(localStorage.getItem('qdii-desk.prefs.v1')).fx,
  strip: document.querySelector('#detail .fx-strip')?.textContent || '',
})`);
const f = JSON.parse(fxOff);
check('关闭汇率后偏好持久化', f.pref === false);
check('详情提示汇率未计入', /未计入/.test(f.strip), f.strip.replace(/\s+/g, ' ').slice(0, 70));
await evaluate(`(() => { const t = document.querySelector('#toggle-fx'); t.checked = true; t.dispatchEvent(new Event('change', {bubbles:true})); })()`);
await sleep(6000);

/* 10. 主题切换 -------------------------------------------------------- */
await evaluate(`document.querySelector('#btn-theme').click()`);
await sleep(600);
const theme = await evaluate(`JSON.stringify({ dom: document.documentElement.dataset.theme, pref: JSON.parse(localStorage.getItem('qdii-desk.prefs.v1')).theme })`);
const t = JSON.parse(theme);
check('切换主题', t.dom === 'dark' && t.pref === 'dark', `theme=${t.dom}`);
await shot('03-dark');

/* 11. 关于弹层 -------------------------------------------------------- */
await evaluate(`document.querySelector('#btn-about').click()`);
await sleep(500);
check('关于弹层可打开', !(await evaluate(`document.querySelector('#about').hidden`)));
await shot('04-about');
await evaluate(`document.querySelector('#about-close').click()`);
await sleep(300);
check('关于弹层可关闭', await evaluate(`document.querySelector('#about').hidden`));

/* 12. 移除自选 -------------------------------------------------------- */
// 排序过，第一行未必是详情里那只；明确移除当前打开的那只，才能同时验证面板收起
const before = await evaluate(`document.querySelectorAll('#grid-body tr[data-code]').length`);
const openCode = await evaluate(`(location.hash || '').slice(1)`);
check('详情与地址栏一致', /^\d{6}$/.test(openCode), openCode);
await evaluate(`document.querySelector('#grid-body tr[data-code="${openCode}"] .star').click()`);
await sleep(600);
rows = await waitRows(1);
const stillOpen = await evaluate(`!!document.querySelector('#detail .dt-name')`);
check('移除自选后行数减少', rows === before - 1, `${before} → ${rows} 行`);
check('移除当前详情基金后收起面板', !stillOpen);

/* 13. 持久化 --------------------------------------------------------- */
await send('Page.reload', { ignoreCache: true });
await sleep(9000);
const after = await evaluate(`JSON.stringify({
  rows: document.querySelectorAll('#grid-body tr[data-code]').length,
  codes: [...document.querySelectorAll('#grid-body tr[data-code]')].map(r=>r.dataset.code),
  theme: document.documentElement.dataset.theme,
})`);
const a = JSON.parse(after);
check('刷新后自选与主题保留', a.rows === rows && a.theme === 'dark',
  `${a.rows} 行（刷新前 ${rows}） · 主题 ${a.theme}`);
await shot('05-reload');

/* 14. 无自选时的空状态 ----------------------------------------------- */
await evaluate(`localStorage.removeItem('qdii-desk.watch.v1'); history.replaceState(null,'',location.pathname)`);
await send('Page.reload', { ignoreCache: true });
await sleep(8000);
const empty = await evaluate(`
  (async () => {
    for (let i = 0; i < 120; i++) {
      const n = document.querySelectorAll('#grid-body tr[data-code]').length;
      if (n > 0 && !document.querySelector('#grid-body .skeleton-row')) break;
      await new Promise(r => setTimeout(r, 500));
    }
    return JSON.stringify({
      indices: document.querySelectorAll('#ribbon .idx').length,
      rows: document.querySelectorAll('#grid-body tr[data-code]').length,
    });
  })()
`);
const em = JSON.parse(empty);
check('清空自选后回落到预设基金', em.rows === seededRows, `${em.rows} 只`);
check('无自选时指数条仍加载', em.indices > 0, `${em.indices} 个指数`);
await shot('06-empty');

/* 15. 分享链接不应改动自选 ------------------------------------------- */
await evaluate(`location.hash = '160644'`);
await sleep(6000);
const shared = await evaluate(`JSON.stringify({
  stored: localStorage.getItem('qdii-desk.watch.v1'),
  detail: document.querySelector('#detail .dt-name')?.textContent || null,
})`);
const sh = JSON.parse(shared);
check('打开分享链接能看详情', !!sh.detail, sh.detail || '');
check('分享链接不会写入自选', sh.stored === null, `localStorage=${sh.stored}`);

console.log('\n' + '─'.repeat(56));
const failed = results.filter((r) => !r.ok);
console.log(`  通过 ${results.length - failed.length}   失败 ${failed.length}`);
if (pageErrors.length) {
  console.log(`\n  \x1b[31m页面报错 ${pageErrors.length} 条：\x1b[0m`);
  for (const e of [...new Set(pageErrors)].slice(0, 8)) console.log(`    ${e.split('\n')[0]}`);
}
console.log(`\n  截图目录 ${SHOT_DIR}\n`);

ws.close();
chrome.kill('SIGKILL');
process.exit(failed.length || pageErrors.length ? 1 : 0);
