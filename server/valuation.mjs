/**
 * ============================================================================
 * QDII 估值引擎
 * ============================================================================
 *
 * 天天基金自 2023 年起陆续下线了 `fundgz.1234567.com.cn` 的官方盘中估值接口
 * （实测该域名现在对任意基金代码都返回"页面未找到"）。所以本项目的估值
 * 完全自算：用最新定期报告的持仓穿透 + 各市场实时行情，反推基金当日涨跌。
 *
 * 三个参考项目的做法：
 *   - qdii-value：最严谨。Σ(w·p)/Σw × 股票仓位，并用"当日 08:00"作为交易日分界。
 *   - fund-baby：直接用官方估值接口 gsz/gszzl（该接口现已失效）。
 *   - 海外估值系统：调第三方聚合接口，再和另一路做 0.6/0.4 加权。
 *
 * 本项目在 qdii-value 的基础上补了三个它明确没做的点：
 *
 * 1) 汇率（qdii-value README 首条即"未考虑汇率"）
 *    QDII 基金的净值以人民币计价，美元/港币资产的涨跌要叠加汇率变动：
 *        p_CNY = (1 + p_price)(1 + p_fx) − 1
 *    对美元资产，人民币贬值 0.3% + 标的涨 1%，实际贡献约 1.3%，不可忽略。
 *
 * 2) 交易日分界
 *    qdii-value 用固定的"北京时间 08:00"切分交易日，跨周末 / 长假 / 美股
 *    冬夏令时切换时会错。这里改成用「报价所属交易日的交易所本地日期」
 *    与「基金最新净值日期」直接比较：
 *        新鲜(fresh) ⟺ quote.localDate > fund.navDate
 *    含义清晰：这只标的在基金上次公布净值之后又交易过，它的涨跌才会
 *    体现在下一次净值里。没有交易过的（比如美股尚未开盘）贡献 0。
 *
 * 3) 部分已交易时的稀释
 *    qdii-value 直接把"已交易部分的平均涨跌"放大到全部股票仓位，
 *    在盘中早期（例如只有港股开盘、美股还没开）会严重高估。
 *    这里按实际参与比例缩放：
 *
 *        estimate% = P_fresh × (W_fresh / W_known) × equityPct / 100
 *                  = Σ_fresh(wᵢ·pᵢ) × equityPct / (W_known × 100)
 *
 *    其中 W_known = 已知重仓股权重合计（占净值 %），W_fresh = 其中已在
 *    本窗口内交易过的权重，P_fresh = 这部分按权重的平均涨跌。
 *    全部持仓都已交易时，W_fresh = W_known，公式退化为 qdii-value 的形式。
 *    直观解释：持仓未知的那部分股票，按"已交易部分的参与度"同步外推。
 *
 * 免责：估算基于公开的定期报告持仓，与基金实际持仓必然存在偏差（调仓、
 * 衍生品、打新、现金拖累等），结果仅供参考，不构成投资建议。
 */

import { classifyCode, sessionGroup, MARKET_CURRENCY } from './lib/symbols.mjs';
import { allMarketStatus, daysBetween, todayCn, usPhase } from './lib/time.mjs';
import { resolveQuotes, getCodeOverride } from './quotes.mjs';

/** 默认是否计入汇率影响。 */
export const DEFAULT_INCLUDE_FX = true;

/**
 * 把持仓明细变成带行情、带贡献度的行。
 */
function buildRows(holdings, quoteMap, navDate) {
  const rows = [];
  const issues = [];

  for (const h of holdings) {
    let target = classifyCode(h.code);
    // ISIN 这类代码在 resolveQuotes 里已按名称反查成真实标的（如 285A → 日股），
    // 这里取同一个结果，否则键对不上会永远显示"无行情"
    const override = target ? getCodeOverride(h.code) : null;
    if (override) target = { ...target, market: override.market, code: override.code };
    if (!target) {
      issues.push({ level: 'warn', scope: h.code, message: `无法识别市场：${h.code} ${h.name}` });
      continue;
    }
    const q = quoteMap.get(`${target.market}:${target.code}`);
    const group = sessionGroup(target.market);
    const currency = MARKET_CURRENCY[target.market];

    const fresh = !!(q?.localDate && navDate && q.localDate > navDate);
    const stale = !!(q?.localDate && navDate && q.localDate <= navDate);

    let status;
    if (!q) status = 'missing';
    else if (q.valid === false || !Number.isFinite(q.changePct)) status = 'suspended';
    else if (fresh) status = 'fresh';
    else status = 'pending';

    rows.push({
      // 展示解析后的真实代码（ISIN 反查成 285A 之类），原始代码留一份备查
      code: override ? target.code : h.code,
      codeRaw: h.code,
      name: h.name,
      weight: h.weight,
      shares: h.shares,
      value: h.value,
      market: target.market,
      sessionGroup: group,
      currency,
      price: q?.price ?? null,
      prevClose: q?.prevClose ?? null,
      change: q?.change ?? null,
      changePct: Number.isFinite(q?.changePct) ? q.changePct : null,
      quoteAt: q?.quoteAt ?? null,
      localDate: q?.localDate ?? null,
      provider: q?.provider ?? null,
      delayed: !!q?.delayed,
      suspended: status === 'suspended',
      fresh,
      stale,
      status,
      missing: !q,
    });
  }

  return { rows, issues };
}

/**
 * 计算基金估值。
 *
 * @param {object} input
 * @param {{code:string,name:string,navHistory:Array,latestNav:object,equityPct:number}} input.profile
 * @param {{available:boolean,period:string,reportDate:string,holdings:Array}} input.holdings
 * @param {Map<string,object>} input.quoteMap
 * @param {{USD:object,HKD:object}} input.fx
 * @param {boolean} input.includeFx
 */
export function computeValuation({ profile, holdings, quoteMap, fx, includeFx = DEFAULT_INCLUDE_FX }) {
  const navDate = profile.latestNav?.date ?? null;
  const navValue = profile.latestNav?.nav ?? null;
  const { rows, issues } = buildRows(holdings?.holdings || [], quoteMap, navDate);

  const markets = allMarketStatus();
  const phase = usPhase();

  if (!rows.length) {
    // 分辨两种"没有持仓"：真的不投股票 vs 通过基金/ETF 间接持有但未披露穿透
    const alloc0 = profile.assetAllocation?.at(-1) || null;
    const stock0 = Number(profile.equityPct) || 0;
    const nonCash0 = alloc0 ? Math.max(0, 100 - (alloc0.bond || 0) - (alloc0.cash || 0)) : 0;
    const viaFund = stock0 < 5 && nonCash0 > 50;

    return {
      code: profile.code,
      name: profile.name,
      nav: { value: navValue, date: navDate, changePct: profile.latestNav?.changePct ?? null },
      estimate: null,
      holdings: [],
      markets,
      fx,
      reportDate: holdings?.reportDate ?? null,
      reportAgeDays: holdings?.reportDate ? daysBetween(todayCn(), holdings.reportDate) : null,
      reportStale: false,
      period: holdings?.period ?? null,
      equityPct: profile.equityPct ?? null,
      session: phase.phase,
      sessionLabel: phase.label,
      sessionWindow: phase.window,
      managers: profile.managers || [],
      navHistory: profile.navHistory || [],
      returns: profile.returns || null,
      issues: [
        ...issues,
        {
          level: 'info',
          scope: 'holdings',
          message: viaFund
            ? '该基金主要通过目标基金 / ETF 间接持有资产，且上游未披露穿透后的股票明细，无法做持仓穿透估值'
            : holdings?.reason === 'empty'
              ? '该基金暂无股票持仓明细（可能是债券 / 货币基金，或新成立尚未披露）'
              : '未能获取持仓明细，请稍后重试',
        },
      ],
      updatedAt: new Date().toISOString(),
    };
  }

  // ---- 权重口径 ----------------------------------------------------------
  const W_known = rows.reduce((s, r) => s + r.weight, 0);

  // 股票敞口比例（% of NAV）。三种来源，按可靠性排序：
  //   1. 定期报告的"股票占净比"        —— 普通股票/指数基金
  //   2. 联接基金：直接持股≈0，敞口其实来自目标 ETF，
  //      此时"股票占净比"为 0，需用 100−债券−现金 还原
  //   3. 兜底：已知重仓合计
  const alloc = profile.assetAllocation?.at(-1) || null;
  const reportStock = Number.isFinite(profile.equityPct) ? profile.equityPct : null;
  const bondPct = Number.isFinite(alloc?.bond) ? alloc.bond : 0;
  const cashPct = Number.isFinite(alloc?.cash) ? alloc.cash : 0;
  const nonCashPct = Math.max(0, 100 - bondPct - cashPct);

  let equityPct;
  let equityBasis;
  if (reportStock !== null && reportStock >= 5) {
    equityPct = reportStock;
    equityBasis = 'report';
  } else if (nonCashPct > 50) {
    equityPct = Number(nonCashPct.toFixed(2));
    equityBasis = 'feeder';
    issues.push({
      level: 'info',
      scope: 'equityPct',
      message: `联接基金：直接持股约 ${reportStock ?? 0}%，已按非现金资产 ${nonCashPct.toFixed(1)}% 还原股票敞口`,
    });
  } else if (W_known > 0) {
    equityPct = Math.min(W_known, 100);
    equityBasis = 'holdings';
    issues.push({
      level: 'warn',
      scope: 'equityPct',
      message: '未取到股票占净比，已按已知重仓合计权重估算，结果可能偏保守',
    });
  } else {
    equityPct = 0;
    equityBasis = 'none';
  }

  if (reportStock !== null && reportStock >= 5 && W_known > reportStock + 1) {
    issues.push({
      level: 'warn',
      scope: 'equityPct',
      message: `重仓合计 ${W_known.toFixed(1)}% 超过股票占净比 ${reportStock}%，可能存在跨报告期错配`,
    });
  }

  // ---- 报告期新鲜度 ------------------------------------------------------
  const reportAgeDays = holdings?.reportDate ? daysBetween(todayCn(), holdings.reportDate) : null;
  const reportStale = reportAgeDays !== null && reportAgeDays > 120;
  if (reportStale) {
    issues.push({
      level: 'error',
      scope: 'report',
      message: `持仓报告停留在 ${holdings.reportDate}（${reportAgeDays} 天前），穿透结果可能已明显偏离实际持仓`,
    });
  }

  // ---- 逐行贡献 ----------------------------------------------------------
  const fxPct = (currency) => {
    if (!includeFx) return 0;
    if (currency === 'CNY') return 0;
    const f = fx?.[currency];
    return Number.isFinite(f?.changePct) ? f.changePct : 0;
  };

  const scale = W_known > 0 ? equityPct / (W_known * 100) : 0; // 权重 -> 净值百分点

  let W_fresh = 0;
  let sumPrice = 0; // Σ wᵢ·pᵢ  (仅已交易)
  let sumFx = 0; // Σ wᵢ·(p_CNY − p_price)
  let sumConfirmed = 0; // 已确认的净值贡献（百分点）

  for (const r of rows) {
    if (!r.fresh || !Number.isFinite(r.changePct)) {
      r.contributionPct = 0;
      r.fxContributionPct = 0;
      r.adjustedChangePct = null;
      continue;
    }
    const f = fxPct(r.currency);
    const adjusted = ((1 + r.changePct / 100) * (1 + f / 100) - 1) * 100;

    r.adjustedChangePct = adjusted;
    r.fxContributionPct = (adjusted - r.changePct) * r.weight * scale;
    r.contributionPct = adjusted * r.weight * scale;

    W_fresh += r.weight;
    sumPrice += r.changePct * r.weight;
    sumFx += (adjusted - r.changePct) * r.weight;
    sumConfirmed += r.contributionPct;
  }

  const coverage = W_known > 0 ? W_fresh / W_known : 0;
  const estimatePct = sumConfirmed;
  const priceContributionPct = sumPrice * scale;
  const fxContributionPct = sumFx * scale;

  // 已交易部分的加权平均涨跌
  const freshAvgPct = W_fresh > 0 ? sumPrice / W_fresh : 0;

  // ---- 待交易的市场 ------------------------------------------------------
  // （要在整体状态之前算出来，状态判定依赖它）
  const pendingByGroup = new Map();
  for (const r of rows) {
    if (r.fresh) continue;
    const g = r.sessionGroup;
    const cur = pendingByGroup.get(g) || { group: g, weight: 0, count: 0, quoted: 0 };
    cur.weight += r.weight;
    cur.count += 1;
    if (r.status === 'pending') cur.quoted += 1;
    pendingByGroup.set(g, cur);
  }

  // ---- 整体状态 ----------------------------------------------------------
  // settled：净值已经是今天的，所有持仓都已包含在净值里，今日没有可估空间
  // closed ：待交易的持仓市场全都休市（周末 / 节假日），今天不会再有变化
  // pending：确实还没开盘，稍后会有数据
  const navIsToday = navDate === todayCn();
  const isWeekend = markets.weekday === 0 || markets.weekday === 6;
  const allPendingClosed =
    pendingByGroup.size === 0 ||
    [...pendingByGroup.keys()].every((g) => !markets[g]?.open);

  let state;
  if (rows.every((r) => r.status === 'missing' || r.status === 'suspended')) state = 'nodata';
  else if (coverage > 0) state = coverage < 0.999 ? 'partial' : 'full';
  else if (navIsToday || (isWeekend && allPendingClosed)) state = 'settled';
  else state = 'pending';

  // ---- 置信度 ------------------------------------------------------------
  let confidence = 'low';
  if (state === 'settled' || state === 'nodata') confidence = 'none';
  else if (reportStale) confidence = 'low';
  else if (coverage >= 0.85 && W_known >= 15) confidence = 'high';
  else if (coverage >= 0.45 && W_known >= 8) confidence = 'medium';

  // ---- 数据质量提示 ------------------------------------------------------
  const noQuote = rows.filter((r) => r.missing);
  if (noQuote.length) {
    issues.push({
      level: 'warn',
      scope: 'quotes',
      message: `${noQuote.length} 只重仓未取到行情（${noQuote
        .slice(0, 3)
        .map((r) => r.name)
        .join('、')}${noQuote.length > 3 ? ' 等' : ''}）`,
    });
  }
  if (navDate && daysBetween(todayCn(), navDate) > 7) {
    issues.push({
      level: 'warn',
      scope: 'nav',
      message: `最新净值日期为 ${navDate}，距今较久，估算基准可能已过时`,
    });
  }

  const rowsSorted = [...rows].sort((a, b) => b.weight - a.weight);

  return {
    code: profile.code,
    name: profile.name,
    nav: {
      value: navValue,
      date: navDate,
      changePct: profile.latestNav?.changePct ?? null,
    },
    estimate: {
      changePct: estimatePct,
      nav: Number.isFinite(navValue) ? navValue * (1 + estimatePct / 100) : null,
      confirmedPct: estimatePct,
      priceContributionPct,
      fxContributionPct,
      freshAvgPct,
      coveragePct: coverage * 100,
      heldWeightPct: W_known,
      freshWeightPct: W_fresh,
      equityPct,
      equityBasis,
      confidence,
      state,
      includeFx,
      // 当前处于美股哪个阶段（盘前 / 盘中 / 盘后 / 休市）。
      // 前端据此决定把估算值放进哪一列，其余列显示「——」。
      session: phase.phase,
      sessionLabel: phase.label,
      sessionWindow: phase.window,
      pending: [...pendingByGroup.values()],
    },
    holdings: rowsSorted,
    markets,
    fx,
    period: holdings?.period ?? null,
    reportDate: holdings?.reportDate ?? null,
    reportAgeDays,
    reportStale,
    managers: profile.managers || [],
    assetAllocation: profile.assetAllocation?.at(-1) || null,
    navHistory: profile.navHistory || [],
    returns: profile.returns || null,
    updatedAt: new Date().toISOString(),
    issues,
  };
}

/**
 * 市场状态概览。
 * 把 now / nowDate / weekday 一并放进 markets 里，让 /api/overview 与
 * /api/watch 返回的结构完全一致——前端不用记两套形状。
 */
export function marketOverview() {
  const markets = allMarketStatus();
  return {
    markets,
    phase: usPhase(),
    now: new Date().toISOString(),
    nowDate: markets.nowDate,
    nowText: markets.now,
  };
}
