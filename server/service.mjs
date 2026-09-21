/**
 * 业务编排层：把数据源、行情、估值引擎拼起来。
 *
 * 关键设计：批量估值时先并行取回所有基金的档案与持仓，再把这些持仓
 * 涉及的标的**合并成一次行情请求**。10 只基金通常是同一批美股/港股，
 * 合并后上游请求数从 O(基金数) 降到 O(1)。
 */

import { fetchFundProfile, fetchHoldings, searchFunds as emSearch, searchFundsLocal } from './sources/eastmoney.mjs';
import { classifyCode } from './lib/symbols.mjs';
import { resolveQuotes, resolveIndices, resolveFx } from './quotes.mjs';
import { computeValuation } from './valuation.mjs';
import { marketOverview } from './valuation.mjs';
import { recordSample, getSeries } from './intraday.mjs';
import { cache } from './lib/cache.mjs';
import { mapSettled } from './lib/http.mjs';

export const DEFAULT_TOP_COUNT = 10;

/**
 * 同时打给东方财富的基金数上限。
 * 每只基金要拉档案 + 持仓两个接口，一次请求 28 只基金就是 56 个并发，
 * 上游会偶发失败（实测 000834 这种就会返回空持仓）。限制并发后稳定很多。
 */
const FUND_CONCURRENCY = 5;

/**
 * 搜索基金：先用联想接口，无结果再退回本地全量表。
 */
export async function searchFunds(keyword) {
  const key = String(keyword || '').trim();
  if (!key) return { keyword: key, results: [] };

  let results = [];
  try {
    results = await emSearch(key);
  } catch {
    results = [];
  }

  if (!results.length) {
    try {
      results = await searchFundsLocal(key, 15);
    } catch {
      results = [];
    }
  }

  // 纯 6 位数字且没搜到联想结果时，直接把代码本身当候选，避免用户白等
  if (!results.length && /^\d{6}$/.test(key)) {
    results = [{ code: key, name: key, shortName: key, type: '', company: '', manager: '', nav: null, navDate: null }];
  }

  return { keyword: key, results: results.slice(0, 12) };
}

/** 单只基金的完整档案（带缓存）。 */
async function loadFundInputs(code, topline) {
  const [profile, holdings] = await Promise.all([
    fetchFundProfile(code),
    fetchHoldings(code, topline),
  ]);
  return { profile, holdings };
}

/**
 * 批量估值。
 * @param {string[]} codes
 * @param {{topline?:number, includeFx?:boolean, sample?:boolean}} opts
 */
export async function getValuations(codes, opts = {}) {
  const { topline = DEFAULT_TOP_COUNT, includeFx = true, sample = true } = opts;
  const unique = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
  if (!unique.length) return { funds: [], markets: marketOverview().markets, fx: null, errors: [] };

  const fx = await resolveFx().catch(() => null);

  const inputs = await mapSettled(
    unique,
    async (code) => {
      try {
        return { code, ...(await loadFundInputs(code, topline)) };
      } catch (err) {
        return { code, error: err?.message || '加载失败' };
      }
    },
    FUND_CONCURRENCY,
  );

  // 合并所有标的，一次批量取行情
  const targets = [];
  for (const inp of inputs) {
    if (!inp.holdings?.holdings) continue;
    for (const h of inp.holdings.holdings) {
      const t = classifyCode(h.code);
      // 带上名称：ISIN 之类无法识别的代码要靠名称去反查
      if (t) targets.push({ ...t, name: h.name });
    }
  }
  const quoteMap = await resolveQuotes(targets).catch(() => new Map());

  const funds = [];
  const errors = [];

  for (const inp of inputs) {
    if (!inp) continue;
    if (inp.error) {
      errors.push({ code: inp.code, message: inp.error });
      continue;
    }
    try {
      const valuation = computeValuation({
        profile: inp.profile,
        holdings: inp.holdings,
        quoteMap,
        fx,
        includeFx,
      });
      valuation.topCount = topline;
      if (sample && valuation.estimate) {
        await recordSample(valuation.code, valuation.estimate.changePct, valuation.estimate.nav).catch(() => {});
      }
      // 表格里的迷你走势要用到今天已采样的序列（内存里，很便宜）
      valuation.intraday = await getSeries(valuation.code).catch(() => ({ date: null, points: [] }));
      funds.push(valuation);
    } catch (err) {
      errors.push({ code: inp.code, message: err?.message || '估值失败' });
    }
  }

  return { funds, markets: marketOverview().markets, fx, errors, updatedAt: new Date().toISOString() };
}

/** 单只基金（含历史曲线与盘中采样）。 */
export async function getFundDetail(code, opts = {}) {
  const { topline = DEFAULT_TOP_COUNT, includeFx = true, sample = true } = opts;
  const result = await getValuations([code], { topline, includeFx, sample });
  const fund = result.funds[0] || null;
  if (!fund) {
    return { fund: null, error: result.errors[0]?.message || '未找到该基金', markets: result.markets, fx: result.fx };
  }
  const intraday = await getSeries(code).catch(() => ({ date: null, points: [] }));
  return { fund, intraday, markets: result.markets, fx: result.fx, updatedAt: result.updatedAt };
}

/** 首屏概览：指数 + 市场状态 + 汇率。 */
export async function getOverview() {
  const [indices, fx] = await Promise.all([
    resolveIndices().catch(() => []),
    resolveFx().catch(() => null),
  ]);
  return { indices, fx, ...marketOverview() };
}

/** 强制刷新：清掉短周期缓存。 */
export function invalidate(prefix) {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const k of [...cache.entries.keys()]) {
    if (k.includes(prefix)) cache.entries.delete(k);
  }
}

export function cacheStats() {
  return cache.stats();
}
