/**
 * 天天基金 / 东方财富数据源
 *
 * 三个参考项目在这家用的接口基本一致：
 *   - qdii-value  抓 FundArchivesDatas.aspx(type=jjcc) 拿重仓股 + zcpz 拿股票仓位
 *   - fund-baby   抓同样的 jjcc 拿重仓，抓 pingzhongdata 拿净值走势
 *   - 海外估值系统 用第三方聚合接口
 *
 * 这里把上面可靠的部分合并，并补上 qdii-value 漏掉的：直接从
 * pingzhongdata 的 Data_assetAllocation 取"股票占净比"，比解析
 * zcpz 页面稳得多（该页面结构已变，class="tzxq" 不再存在）。
 */

import { fetchText, fetchJson, mapSettled } from '../lib/http.mjs';
import { cache } from '../lib/cache.mjs';

const REFERER = 'https://fund.eastmoney.com/';
const F10_REFERER = 'https://fundf10.eastmoney.com/';

/** 内存化的全量基金列表（3MB，只在冷启动/搜索无结果时用）。 */
let fundListPromise = null;

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

export async function searchFunds(keyword) {
  const key = String(keyword || '').trim();
  if (!key) return [];

  const url =
    'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx' +
    `?m=1&key=${encodeURIComponent(key)}&_=${Date.now()}`;

  const json = await cache.wrap(`em:search:${key}`, 60_000, () =>
    fetchJson(url, { referer: REFERER, timeout: 10000 }),
  );

  return (json?.Datas || [])
    .filter((d) => d.CODE)
    .map((d) => ({
      code: String(d.CODE),
      name: d.NAME || d.SHORTNAME || '',
      shortName: d.FundBaseInfo?.SHORTNAME || d.NAME || '',
      type: d.FundBaseInfo?.FTYPE || d.CATEGORYDESC || '',
      company: d.FundBaseInfo?.JJGS || '',
      manager: d.FundBaseInfo?.JJJL || '',
      nav: Number(d.FundBaseInfo?.DWJZ) || null,
      navDate: d.FundBaseInfo?.FSRQ || null,
    }));
}

/** 全量基金代码表，用于本地兜底搜索。 */
export async function fetchAllFunds() {
  if (!fundListPromise) {
    fundListPromise = cache
      .wrap('em:fundcodes', 12 * 3600_000, async () => {
        const { text } = await fetchText('https://fund.eastmoney.com/js/fundcode_search.js', {
          referer: REFERER,
          timeout: 20000,
        });
        const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
        return arr.map((r) => ({ code: r[0], pinyinAbbr: r[1], name: r[2], type: r[3] }));
      })
      .catch(() => []);
  }
  return fundListPromise;
}

export async function searchFundsLocal(keyword, limit = 20) {
  const list = await fetchAllFunds();
  const k = String(keyword || '').trim().toUpperCase();
  if (!k) return [];
  const scored = [];
  for (const f of list) {
    let score = -1;
    if (f.code === k) score = 100;
    else if (f.code.startsWith(k)) score = 80;
    else if (f.name.includes(keyword)) score = 60;
    else if (f.pinyinAbbr?.includes(k)) score = 40;
    if (score > 0) scored.push({ ...f, score });
    if (scored.length > 4000) break;
  }
  return scored
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code))
    .slice(0, limit)
    .map((f) => ({
      code: f.code,
      name: f.name,
      shortName: f.name,
      type: f.type,
      company: '',
      manager: '',
      nav: null,
      navDate: null,
      local: true,
    }));
}

/* ------------------------------------------------------------------ */
/* 基金档案：pingzhongdata                                             */
/* ------------------------------------------------------------------ */

/** 从 pingzhongdata 的 JS 源码里抠出 var 变量。 */
function extractVars(js) {
  const out = {};
  const re = /var\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);(?=\s*(?:var\s|\/\*|$))/g;
  let m;
  while ((m = re.exec(js))) out[m[1]] = m[2].trim();
  return out;
}

function parseJsonVar(raw, fallback = null) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 时间戳 -> 北京时间的 YYYY-MM-DD。 */
function tsToCnDate(ts) {
  const d = new Date(Number(ts));
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return p;
}

/**
 * 拉取基金档案。
 * @param {string} code
 */
export async function fetchFundProfile(code) {
  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
  return cache.wrap(`em:profile:${code}`, 6 * 3600_000, async () => {
    const { text } = await fetchText(url, { referer: REFERER, timeout: 15000 });
    const v = extractVars(text);

    const name = (v.fS_name || '').replace(/^"|"$/g, '') || null;
    if (!name) throw new Error(`未找到基金 ${code} 的档案`);

    const trend = parseJsonVar(v.Data_netWorthTrend, []);
    const navHistory = trend
      .filter((p) => Number.isFinite(p?.y))
      .map((p) => ({
        date: tsToCnDate(p.x),
        nav: Number(p.y),
        changePct: Number.isFinite(p.equityReturn) ? Number(p.equityReturn) : null,
        dividend: p.unitMoney || '',
      }));

    const alloc = parseJsonVar(v.Data_assetAllocation, null);
    let equityPct = null;
    let assetAllocation = [];
    if (alloc?.series?.length) {
      const pick = (n) => alloc.series.find((s) => s.name?.includes(n))?.data || [];
      const stock = pick('股票');
      const bond = pick('债券');
      const cash = pick('现金');
      const net = alloc.series.find((s) => s.name?.includes('净资产'))?.data || [];
      const n = stock.length;
      assetAllocation = stock.map((s, i) => ({
        stock: Number(s),
        bond: Number(bond[i] ?? 0),
        cash: Number(cash[i] ?? 0),
        netAssets: Number(net[i] ?? 0),
      }));
      // 取最近一期有值的股票占净比
      const last = [...stock].reverse().find((x) => Number.isFinite(Number(x)));
      equityPct = Number.isFinite(Number(last)) ? Number(last) : null;
    }

    const posRaw = parseJsonVar(v.Data_fundSharesPositions, []);
    const positionEstimate = posRaw
      .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[1])))
      .map((p) => ({ date: tsToCnDate(p[0]), pct: Number(p[1]) }));

    const managers = parseJsonVar(v.Data_currentFundManager, []);

    return {
      code: String(code),
      name,
      navHistory,
      returns: trailingReturns(navHistory),
      latestNav: navHistory.at(-1) || null,
      equityPct,
      assetAllocation,
      positionEstimate,
      latestPosition: positionEstimate.at(-1) || null,
      managers: managers.map((m) => ({
        name: m.name,
        star: m.star,
        workTime: m.workTime,
        fundSize: m.fundSize,
      })),
      rate: v.fund_Rate ? String(v.fund_Rate).replace(/"/g, '') : null,
      source: 'eastmoney/pingzhongdata',
    };
  });
}

/* ------------------------------------------------------------------ */
/* 重仓股                                                              */
/* ------------------------------------------------------------------ */

function unescapeJs(html) {
  return html
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\r/g, '')
    .replace(/\\n/g, '')
    .replace(/\\\//g, '/');
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析一行持仓。列顺序（2026 年实测）：
 *   0 序号 | 1 代码 | 2 名称 | 3 最新价(占位) | 4 涨跌幅(占位) | 5 相关链接
 *   6 占净值比例 | 7 持股数(万股) | 8 持仓市值(万元)
 */
function parseHoldingRow(rowHtml) {
  const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  if (tds.length < 7) return null;

  const code = stripTags(tds[1]);
  const name = stripTags(tds[2]);
  const weightRaw = stripTags(tds[6]);
  if (!code || !weightRaw) return null;

  const weight = Number(weightRaw.replace('%', ''));
  if (!Number.isFinite(weight)) return null;

  const num = (s) => {
    const n = Number(stripTags(s).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  return {
    code,
    name,
    weight,
    shares: tds[7] ? num(tds[7]) : null, // 万股
    value: tds[8] ? num(tds[8]) : null, // 万元
  };
}

/**
 * 拉取基金重仓股。
 * @param {string} code 基金代码
 * @param {number} topline 取前 N 大重仓
 */
export async function fetchHoldings(code, topline = 10) {
  const top = Math.min(Math.max(Number(topline) || 10, 5), 50);
  const key = `em:holdings:${code}:${top}`;

  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const result = await (async () => {
    const url =
      'https://fundf10.eastmoney.com/FundArchivesDatas.aspx' +
      `?type=jjcc&code=${code}&topline=${top}&year=&month=&rt=${Math.random()}`;

    let text;
    try {
      ({ text } = await fetchText(url, { referer: F10_REFERER, timeout: 15000 }));
    } catch (err) {
      return { code: String(code), available: false, reason: 'network', message: err?.message, holdings: [] };
    }

    const contentMatch = /content:"([\s\S]*?)",arryear/.exec(text);
    if (!contentMatch || !contentMatch[1]) {
      return { code: String(code), available: false, reason: 'empty', holdings: [] };
    }

    const html = unescapeJs(contentMatch[1]);

    // 只取最近一期的 boxitem
    const blocks = html.split(/<div class='boxitem/).slice(1);
    const block = blocks[0] || html;

    const header = /<h4[^>]*>([\s\S]*?)<\/h4>/.exec(block)?.[1] || '';
    const fundName = stripTags(/<a[^>]*title='([^']*)'/.exec(header)?.[1] || '');
    const period = /(\d{4}年[^<]*?季度)/.exec(header)?.[1] || '';
    const reportDate = /截止至：[^0-9]*(\d{4}-\d{2}-\d{2})/.exec(stripTags(header))?.[1] || null;

    const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(block)?.[1] || block;
    const rows = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map((m) => parseHoldingRow(m[1]))
      .filter(Boolean);

    // 同一代码可能重复出现（多期/多地上市），按权重取最大
    const dedup = new Map();
    for (const h of rows) {
      const prev = dedup.get(h.code);
      if (!prev || h.weight > prev.weight) dedup.set(h.code, h);
    }
    const holdings = [...dedup.values()].sort((a, b) => b.weight - a.weight);

    return {
      code: String(code),
      available: holdings.length > 0,
      fundName: fundName || null,
      period,
      reportDate,
      holdings,
      source: 'eastmoney/FundArchivesDatas',
    };
  })();

  // 只有真正拿到数据才长缓存。上游偶发失败导致的空结果只留 60 秒，
  // 否则一次抖动会让这只基金在 6 小时内一直显示"无持仓"。
  cache.set(key, result, result.available ? 6 * 3600_000 : 60_000);
  return result;
}

/**
 * 基金资产配置（股票占净比），备用：直接读 f10 的行业/资产接口。
 * 主要路径在 fetchFundProfile 里，这里是兜底。
 */
export async function fetchEquityRatio(code) {
  return cache.wrap(`em:eqratio:${code}`, 12 * 3600_000, async () => {
    try {
      const profile = await fetchFundProfile(code);
      if (Number.isFinite(profile.equityPct)) return profile.equityPct;
    } catch {
      /* ignore */
    }
    return null;
  });
}

/* ------------------------------------------------------------------ */
/* 行情备用源：push2delay                                              */
/* ------------------------------------------------------------------ */

/**
 * 东方财富延迟行情，作为腾讯/新浪都失败时的第三道保险。
 * @param {{secid:string, key:string}[]} items
 */
export async function fetchQuotesBySecid(items) {
  const out = new Map();
  if (!items.length) return out;
  const chunks = [];
  for (let i = 0; i < items.length; i += 50) chunks.push(items.slice(i, i + 50));

  await mapSettled(
    chunks,
    async (chunk) => {
      const url =
        'https://push2delay.eastmoney.com/api/qt/ulist.np/get' +
        `?secids=${chunk.map((c) => c.secid).join(',')}&fields=f2,f3,f4,f12,f13,f14,f124&fltt=2`;
      const json = await fetchJson(url, { referer: 'https://quote.eastmoney.com/', timeout: 10000 });
      const diff = json?.data?.diff;
      if (!diff) return;
      const arr = Array.isArray(diff) ? diff : Object.values(diff);
      const byCode = new Map(arr.map((d) => [String(d.f12), d]));
      for (const item of chunk) {
        const code = item.secid.split('.')[1];
        const d = byCode.get(code);
        if (!d || !Number.isFinite(Number(d.f2))) continue;
        const ts = Number(d.f124);
        const dt = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null;
        out.set(item.key, {
          price: Number(d.f2),
          changePct: Number.isFinite(Number(d.f3)) ? Number(d.f3) : null,
          change: Number.isFinite(Number(d.f4)) ? Number(d.f4) : null,
          name: d.f14,
          provider: 'eastmoney-delay',
          valid: Number(d.f2) > 0,
          localDate: dt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(dt) : null,
          localTime: dt
            ? new Intl.DateTimeFormat('en-GB', {
                timeZone: 'Asia/Shanghai',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              }).format(dt)
            : null,
          delayed: true,
        });
      }
    },
    4,
  );

  return out;
}

/* ------------------------------------------------------------------ */
/* 东方财富行情检索：把 ISIN / 名称反查成 secid                          */
/* ------------------------------------------------------------------ */

const SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

/**
 * 用关键词（代码或名称）在东方财富行情库里查证券。
 * 主要用于东方财富自己的持仓表里只给了 ISIN 的情况——
 * 比如日股 "JP3236330001"，只能拿中文名"铠侠"再反查回 176.285A。
 *
 * @param {string} keyword
 * @returns {Promise<{secid:string, marketNum:number, code:string, name:string}|null>}
 */
export async function searchQuote(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return null;

  return cache.wrap(`em:qsearch:${kw}`, 24 * 3600_000, async () => {
    const url =
      'https://searchapi.eastmoney.com/api/suggest/get' +
      `?input=${encodeURIComponent(kw)}&type=14&token=${SEARCH_TOKEN}&count=8`;
    let json;
    try {
      json = await fetchJson(url, { referer: 'https://www.eastmoney.com/', timeout: 10000 });
    } catch {
      return null;
    }
    const rows = json?.QuotationCodeTable?.Data || [];
    // 优先股票 / 基金，排除板块、债券之类
    const pick =
      rows.find((d) => /股票|基金|ETF/.test(d.SecurityTypeName || '')) || rows[0];
    if (!pick?.QuoteID) return null;
    const [mkt, code] = String(pick.QuoteID).split('.');
    return {
      secid: pick.QuoteID,
      marketNum: Number(mkt),
      code,
      name: pick.Name,
      type: pick.SecurityTypeName,
    };
  });
}

/**
 * 把一批"代码不可识别"的持仓（ISIN / 其他）按名称反查成真实标的。
 * @param {{key:string, name:string, country?:string}[]} items
 * @returns {Promise<Map<string, {market:string, code:string, secid:string}>>}
 */
export async function resolveUnknownBySearch(items) {
  const out = new Map();
  if (!items.length) return out;

  await mapSettled(
    items,
    async (item) => {
      // 名称里常带"株式会社/Inc."之类后缀，先用前几个字试一次全名，再退化
      const candidates = [];
      const raw = String(item.name || '').trim();
      if (raw) {
        candidates.push(raw);
        const short = raw.replace(/[（(].*?[）)]/g, '').replace(/株式会社|股份有限公司|有限公司|集团|控股/g, '').trim();
        if (short && short !== raw) candidates.push(short);
        if (short.length > 3) candidates.push(short.slice(0, 4));
        if (short.length > 2) candidates.push(short.slice(0, 3));
      }
      for (const kw of candidates) {
        const hit = await searchQuote(kw);
        if (hit) {
          out.set(item.key, hit);
          return;
        }
      }
    },
    4,
  );

  return out;
}

/**
 * 区间收益率：近 1 月 / 3 月 / 6 月 / 1 年 / 3 年。
 *
 * 用完整净值序列自己算，而不是取 pingzhongdata 里的 syl_1y / syl_3y 等变量：
 * 那些变量缺"近 3 年"，且口径不透明；自己算能保证五个区间完全一致，
 * 也能顺带判断这只基金成立够不够久（不够就返回 null，而不是拿首日凑数）。
 */
function trailingReturns(navHistory) {
  if (!navHistory || navHistory.length < 2) return null;
  const last = navHistory.at(-1);
  const dates = navHistory.map((p) => p.date);

  const pick = (months) => {
    const d = new Date(`${last.date}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - months);
    const target = d.toISOString().slice(0, 10);

    // 找 <= target 的最后一个交易日
    let lo = 0;
    let hi = dates.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= target) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx < 0) return null;

    // 历史不够长：找到的基准日离目标日太远就不给数，避免用成立首日充数
    const gapDays = (Date.parse(`${target}T00:00:00Z`) - Date.parse(`${dates[idx]}T00:00:00Z`)) / 86400000;
    if (gapDays > 20) return null;

    const base = navHistory[idx].nav;
    if (!base) return null;
    return (last.nav / base - 1) * 100;
  };

  const out = { m1: pick(1), m3: pick(3), m6: pick(6), y1: pick(12), y3: pick(36) };
  return Object.values(out).some((v) => v !== null) ? out : null;
}
