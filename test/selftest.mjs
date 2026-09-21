/**
 * 数据源自检。
 *   node test/selftest.mjs
 *
 * 逐个验证各上游接口是否可用、解析是否正常。上游接口经常变动，
 * 出问题时先跑这个，能快速定位是哪一层坏了。
 */

import { fetchFundProfile, fetchHoldings, searchFunds, fetchAllFunds } from '../server/sources/eastmoney.mjs';
import * as tencent from '../server/sources/tencent.mjs';
import * as sina from '../server/sources/sina.mjs';
import { resolveQuotes, resolveIndices, resolveFx } from '../server/quotes.mjs';
import { computeValuation } from '../server/valuation.mjs';
import { classifyCode } from '../server/lib/symbols.mjs';
import { allMarketStatus, usPhase } from '../server/lib/time.mjs';
import { FUND_CATALOG } from '../web/js/catalog.js';
import { mapSettled } from '../server/lib/http.mjs';

const CASES = [
  { code: '161125', name: '易方达标普500（美股指数）' },
  { code: '164906', name: '交银海外中国互联网（港美混合）' },
  { code: '161725', name: '招商中证白酒（A 股）' },
  { code: '006479', name: '广发纳斯达克100ETF联接（联接基金）' },
];

let pass = 0;
let fail = 0;

function ok(label, detail = '') {
  pass++;
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
}
function bad(label, err) {
  fail++;
  console.log(`  \x1b[31m✗\x1b[0m ${label}  \x1b[31m${err}\x1b[0m`);
}

async function step(label, fn) {
  try {
    const detail = await fn();
    ok(label, detail ?? '');
  } catch (err) {
    bad(label, err?.message || String(err));
  }
}

console.log('\n美股基金估值宝 · 数据源自检\n' + '─'.repeat(56));

console.log('\n[1] 市场时钟');
{
  const m = allMarketStatus();
  ok('交易时段计算', `A股 ${m.CN.open ? '开' : '休'} · 港股 ${m.HK.open ? '开' : '休'} · 美股 ${m.US.open ? '开' : '休'} · 北京时间 ${m.now}`);
}

console.log('\n[2] 天天基金 / 东方财富');
await step('基金搜索', async () => {
  const r = await searchFunds('纳斯达克');
  if (!r.length) throw new Error('无结果');
  return `${r.length} 条，首条 ${r[0].code} ${r[0].name}`;
});
await step('全量基金列表', async () => {
  const l = await fetchAllFunds();
  if (l.length < 1000) throw new Error(`只有 ${l.length} 条`);
  return `${l.length} 只`;
});
for (const c of CASES) {
  await step(`档案 ${c.code} ${c.name}`, async () => {
    const p = await fetchFundProfile(c.code);
    if (!p.navHistory?.length) throw new Error('无净值历史');
    return `${p.name} · 净值 ${p.latestNav.nav} @ ${p.latestNav.date} · 股票仓位 ${p.equityPct}% · ${p.navHistory.length} 个净值点`;
  });
  await step(`持仓 ${c.code}`, async () => {
    const h = await fetchHoldings(c.code, 10);
    if (!h.available) throw new Error(`无持仓 (${h.reason || '空'})`);
    const sum = h.holdings.reduce((s, x) => s + x.weight, 0);
    const markets = [...new Set(h.holdings.map((x) => classifyCode(x.code)?.market).filter(Boolean))];
    return `${h.period || '?'} 截止 ${h.reportDate} · ${h.holdings.length} 只 · 合计 ${sum.toFixed(2)}% · ${markets.join('/')}`;
  });
}

console.log('\n[3] 行情源');
await step('腾讯行情（多市场）', async () => {
  const targets = [
    { market: 'US', code: 'AAPL' },
    { market: 'HK', code: '00700' },
    { market: 'SH', code: '600519' },
    { market: 'SZ', code: '000001' },
  ];
  const m = await tencent.fetchQuotes(targets);
  if (m.size < 3) throw new Error(`只返回 ${m.size} 条`);
  return [...m.values()].map((q) => `${q.code} ${q.price} ${q.changePct?.toFixed(2)}%`).join(' | ');
});
await step('腾讯指数', async () => {
  const m = await tencent.fetchIndexQuotes(['sh000001', 'hkHSI', 'usIXIC']);
  if (m.size < 3) throw new Error(`只返回 ${m.size} 条`);
  return [...m.values()].map((q) => `${q.name} ${q.price}`).join(' | ');
});
await step('腾讯分时（A 股）', async () => {
  const r = await tencent.fetchMinute('sh000001');
  if (!r?.points?.length) throw new Error('无分时数据');
  return `${r.points.length} 个点 @ ${r.date}`;
});
await step('新浪行情（美股 / 港股 / 外汇）', async () => {
  const m = await sina.fetchQuotes([
    { market: 'US', code: 'AAPL' },
    { market: 'HK', code: '00700' },
  ]);
  const fx = await sina.fetchFx();
  if (!m.size) throw new Error('行情为空');
  if (!fx.USD?.price) throw new Error('汇率为空');
  return `${[...m.values()].map((q) => `${q.code} ${q.price}`).join(' | ')} · USD/CNY ${fx.USD.price} ${fx.USD.changePct?.toFixed(3)}%`;
});
await step('新浪基金净值', async () => {
  const from = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  const rows = await sina.fetchFundNav('161725', { from, to: '' });
  if (!rows.length) throw new Error('无净值记录');
  return `${rows.length} 条，最新 ${rows.at(-1).date} ${rows.at(-1).nav}`;
});

console.log('\n[4] 聚合层');
await step('多源行情降级', async () => {
  const m = await resolveQuotes([
    { market: 'US', code: 'NVDA' },
    { market: 'US', code: 'SNDK' },
    { market: 'HK', code: '09988' },
    { market: 'SH', code: '600519' },
  ]);
  if (m.size < 4) throw new Error(`只返回 ${m.size}/4`);
  return [...m.values()].map((q) => `${q.code}:${q.provider}`).join(' ');
});
await step('指数概览', async () => {
  const list = await resolveIndices();
  if (list.length < 5) throw new Error(`只有 ${list.length} 个指数`);
  return `${list.length} 个指数`;
});
await step('汇率', async () => {
  const fx = await resolveFx();
  if (!fx.USD?.price) throw new Error('USD 汇率为空');
  return `USD/CNY ${fx.USD.price} (${fx.USD.changePct?.toFixed(3)}%) · HKD/CNY ${fx.HKD?.price}`;
});

console.log('\n[5] 美股阶段（盘前 / 盘中 / 盘后）');
{
  const p = usPhase();
  ok('当前阶段', `${p.label} · ${p.window} · ${p.dst ? '夏令时' : '冬令时'}`);
  const at = (h, mi) => usPhase(new Date(Date.UTC(2026, 8, 21, h - 8, mi)));
  const seq = [[9, 0], [18, 0], [23, 0], [1, 0]].map(([h, mi]) => `${h}:00 ${at(h, mi).label}`);
  ok('周一全天阶段顺序', seq.join(' → '));
}

console.log('\n[6] 内置基金池代码核对');
{
  const items = [];
  for (const f of FUND_CATALOG) {
    for (const c of f.classes) items.push({ ...c, short: f.short });
  }
  const res = await mapSettled(items, async (it) => {
    try { return { ...it, real: (await fetchFundProfile(it.code)).name }; }
    catch { return { ...it, real: null }; }
  }, 6);

  const norm = (x) => String(x || '').replace(/[（）()\s\-—·]/g, '')
    .replace(/人民币|发起式|股票|混合|指数|QDII|LOF/g, '');
  const bad = [];
  for (const r of res) {
    if (!r) continue;
    if (!r.real) { bad.push(`${r.code} 取不到档案`); continue; }
    const scope = Math.min(2, norm(r.short).length);
    if (!norm(r.real).includes(norm(r.short).slice(0, scope))) {
      bad.push(`${r.code} 期望「${r.short}」实际「${r.real}」`);
    }
  }
  if (bad.length) bad(`内置基金池 ${items.length} 个代码`, bad.join(' / '));
  else ok(`内置基金池 ${items.length} 个代码`, `${FUND_CATALOG.length} 只基金，全部与交易所名称一致`);
}

console.log('\n[7] 估值引擎');
{
  const fx = await resolveFx();
  for (const c of CASES) {
    await step(`估值 ${c.code} ${c.name}`, async () => {
      const [profile, holdings] = await Promise.all([
        fetchFundProfile(c.code),
        fetchHoldings(c.code, 10),
      ]);
      const quoteMap = await resolveQuotes(
        holdings.holdings.map((h) => classifyCode(h.code)).filter(Boolean),
      );
      const v = computeValuation({ profile, holdings, quoteMap, fx, includeFx: true });
      const e = v.estimate;
      if (!e) throw new Error(`无估值：${v.issues.map((i) => i.message).join('；')}`);
      if (!Number.isFinite(e.changePct)) throw new Error('估算涨跌不是数字');
      const warn = e.confidence === 'low' ? ' \x1b[33m(低置信)\x1b[0m' : '';
      return `${e.changePct >= 0 ? '+' : ''}${e.changePct.toFixed(3)}% → 估算净值 ${e.nav?.toFixed(4)} · 状态 ${e.state} · 覆盖 ${e.coveragePct.toFixed(0)}% · 仓位 ${e.equityPct}% (${e.equityBasis}) · 价 ${e.priceContributionPct.toFixed(3)} / 汇 ${e.fxContributionPct.toFixed(3)}${warn}`;
    });
  }
}

console.log('\n' + '─'.repeat(56));
console.log(`  \x1b[32m通过 ${pass}\x1b[0m   \x1b[31m失败 ${fail}\x1b[0m\n`);
process.exit(fail ? 1 : 0);
