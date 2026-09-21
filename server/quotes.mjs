/**
 * 统一行情解析：多源容错。
 *
 * 顺序：腾讯（实时、字段最全、支持批量）→ 新浪（备用）→ 东方财富延迟（兜底）。
 * 参考项目各自只用了其中一两个源；qdii-value 的做法是让用户手动切源，
 * 这里改成自动降级，并把最终采用的源透出到 UI，便于核对。
 */

import { cache } from './lib/cache.mjs';
import * as tencent from './sources/tencent.mjs';
import * as sina from './sources/sina.mjs';
import { fetchQuotesBySecid, resolveUnknownBySearch } from './sources/eastmoney.mjs';
import { toEastmoneySecid, EM_MKT_TO_MARKET } from './lib/symbols.mjs';

const QUOTE_TTL = 5000;

/**
 * 原始代码 -> 解析后的 {market, code}。
 *
 * 东方财富对部分日股持仓只给 ISIN，反查出的真实代码必须让估值引擎也看到，
 * 否则引擎会用 ISIN 去查行情表（键对不上）。解析发生在 resolveQuotes，
 * 而 computeValuation 在其之后调用，所以这里用一张模块级缓存传递。
 */
const codeOverrides = new Map();

/** 查询某个原始代码是否已被解析成真实标的。 */
export function getCodeOverride(code) {
  return codeOverrides.get(String(code || '').toUpperCase()) || null;
}

function keyOf(t) {
  return `${t.market}:${t.code}`;
}

/**
 * 批量取行情。
 * @param {{market:string, code:string}[]} targets
 * @returns {Promise<Map<string, object>>}
 */
export async function resolveQuotes(targets) {
  const uniq = new Map();
  for (const t of targets) if (t?.market && t?.code) uniq.set(keyOf(t), t);

  /*
   * 先把"代码不可识别"的标的（东方财富对部分日股只给 ISIN，例如
   * JP3236330001 = 铠侠）用中文名反查成真实市场与代码，再并回正常流程。
   * 不这么做的话它们会被当成美股，永远取不到行情。
   */
  const unknown = [...uniq.values()].filter((t) => t.market === 'ISIN' || t.market === 'UNKNOWN');
  if (unknown.length) {
    const resolved = await resolveUnknownBySearch(
      unknown.map((t) => ({ key: keyOf(t), name: t.name || '', country: t.country })),
    ).catch(() => new Map());
    for (const [key, hit] of resolved) {
      const market = EM_MKT_TO_MARKET[hit.marketNum];
      const t = uniq.get(key);
      if (!market || !t) continue;
      codeOverrides.set(String(t.code).toUpperCase(), { market, code: hit.code, name: hit.name });
      // 原地改写成可识别的标的，同时记下真实代码供展示
      t.market = market;
      t.code = hit.code;
      t.resolvedFrom = hit.secid;
    }
  }

  const list = [...uniq.values()];
  const out = new Map();
  if (!list.length) return out;

  // 单只标的的缓存 key，命中就跳过该标的
  const need = [];
  for (const t of list) {
    const hit = cache.get(`q:${keyOf(t)}`);
    if (hit) out.set(keyOf(t), hit);
    else need.push(t);
  }
  if (!need.length) return out;

  let fetched = await safe(() => tencent.fetchQuotes(need));

  const missing = need.filter((t) => !isUsable(fetched.get(keyOf(t))));
  if (missing.length) {
    const fb = await safe(() => sina.fetchQuotes(missing));
    for (const t of missing) {
      const q = fb.get(keyOf(t));
      if (isUsable(q)) fetched.set(keyOf(t), q);
    }
  }

  const stillMissing = need.filter((t) => !isUsable(fetched.get(keyOf(t))));
  if (stillMissing.length) {
    const items = stillMissing
      .map((t) => {
        const hint = fetched.get(keyOf(t))?.codeField
          ? /\.([A-Z]+)$/.exec(fetched.get(keyOf(t)).codeField)?.[1]
          : undefined;
        const secid = toEastmoneySecid(t, hint);
        return secid ? { secid, key: keyOf(t) } : null;
      })
      .filter(Boolean);
    if (items.length) {
      const fb2 = await safe(() => fetchQuotesBySecid(items));
      for (const [k, q] of fb2) if (isUsable(q)) fetched.set(k, q);
      // 延迟源也要让 UI 知道
    }
  }

  for (const [k, q] of fetched) {
    if (isUsable(q)) {
      out.set(k, q);
      cache.set(`q:${k}`, q, QUOTE_TTL);
    } else if (q) {
      out.set(k, q); // 保留 invalid 记录，UI 可以显示"停牌"
    }
  }

  return out;
}

function isUsable(q) {
  return !!q && q.valid !== false && Number.isFinite(q.changePct);
}

async function safe(fn) {
  try {
    const r = await fn();
    return r instanceof Map ? r : new Map();
  } catch {
    return new Map();
  }
}

/**
 * 指数列表：市场概览用。
 *
 * 只保留海外市场——本工具主打 QDII / 美股基金估值，A 股指数对判断
 * 这些基金的当日表现没有参考价值，放在那里只是噪音。
 * 顺序：美股四大 → 港股两大。
 */
export const MARKET_INDICES = [
  { key: 'IXIC', symbol: 'usIXIC', name: '纳斯达克' },
  { key: 'NDX', symbol: 'usNDX', name: '纳斯达克100' },
  { key: 'INX', symbol: 'usINX', name: '标普 500' },
  { key: 'DJI', symbol: 'usDJI', name: '道琼斯' },
  { key: 'HSI', symbol: 'hkHSI', name: '恒生指数' },
  { key: 'HSTECH', symbol: 'hkHSTECH', name: '恒生科技' },
];

/** 取市场指数行情。 */
export async function resolveIndices() {
  return cache.wrap('indices', 5000, async () => {
    try {
      const bySymbol = await tencent.fetchIndexQuotes(MARKET_INDICES.map((i) => i.symbol));
      return MARKET_INDICES.map((i) => {
        const q = bySymbol.get(i.symbol);
        return {
          key: i.key,
          name: i.name,
          symbol: i.symbol,
          price: q?.price ?? null,
          change: q?.change ?? null,
          changePct: q?.changePct ?? null,
          localDate: q?.localDate ?? null,
        };
      }).filter((x) => x.price !== null);
    } catch {
      return [];
    }
  });
}

/** 汇率（带缓存）。 */
export async function resolveFx() {
  return cache.wrap('fx', 60_000, async () => {
    try {
      return await sina.fetchFx();
    } catch {
      return { USD: null, HKD: null, updatedAt: new Date().toISOString(), error: true };
    }
  });
}
