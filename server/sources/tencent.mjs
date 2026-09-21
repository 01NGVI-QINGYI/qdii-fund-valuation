/**
 * 腾讯财经行情源（qt.gtimg.cn）
 *
 * 主力行情源。参考 fund-baby 用 qt.gtimg.cn 取 A 股/港股，qdii-value 用新浪；
 * 实测腾讯这一个接口就同时覆盖美股 / 港股 / A 股 / 北交所 / 指数，
 * 字段布局完全一致，一次请求可批量拉几十只，因此作为首选。
 *
 * 返回 GBK 编码，由 lib/http 处理。
 */

import { fetchText, mapSettled } from '../lib/http.mjs';
import { toTencent } from '../lib/symbols.mjs';

const REFERER = 'https://gu.qq.com/';
const CHUNK = 60;

const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * 解析腾讯的时间字段，三种格式：
 *   美股 2026-09-18 11:08:40   （美东时间）
 *   港股 2026/09/18 16:08:32   （香港时间）
 *   A股  20260918161436        （北京时间）
 * 这里保留"交易所本地"的日期与时间，因为估值引擎正是用
 * 「报价所属交易日的本地日期」去和基金净值日期做比较。
 */
function parseQuoteTime(raw) {
  const s = String(raw || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}:${m[6] ?? '00'}` };
  }
  m = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}:${m[6] ?? '00'}` };
  }
  m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (m) {
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}:${m[6]}` };
  }
  return { date: null, time: null };
}

function parseLine(line) {
  const eq = line.indexOf('=');
  if (eq < 0) return null;
  const varName = line.slice(0, eq).trim().replace(/^var\s+/, '');
  const q1 = line.indexOf('"');
  const q2 = line.lastIndexOf('"');
  if (q1 < 0 || q2 <= q1) return null;

  const symbol = varName.replace(/^v_/, '');
  const f = line.slice(q1 + 1, q2).split('~');
  if (f.length < 40) return null; // pv_none_match 之类

  const price = num(f[3]);
  const prevClose = num(f[4]);
  const change = num(f[31]);
  const changePct = num(f[32]);
  const { date, time } = parseQuoteTime(f[30]);

  // 停牌时最新价为 0，这类报价不参与估值
  const valid = price !== null && price > 0 && changePct !== null;

  return {
    symbol,
    name: f[1],
    codeField: f[2],
    price,
    prevClose,
    open: num(f[5]),
    high: num(f[33]),
    low: num(f[34]),
    change,
    changePct: valid ? changePct : null,
    volume: num(f[6]),
    turnover: num(f[37]),
    localDate: date,
    localTime: time,
    quoteAt: date && time ? `${date} ${time}` : null,
    provider: 'tencent',
    valid,
  };
}

/**
 * 批量取行情。
 * @param {{market:string, code:string}[]} targets
 * @returns {Promise<Map<string, object>>} key = `${market}:${code}`
 */
export async function fetchQuotes(targets) {
  const out = new Map();
  if (!targets.length) return out;

  const wanted = targets
    .map((t) => ({ target: t, symbol: toTencent(t) }))
    .filter((x) => x.symbol);

  const chunks = [];
  for (let i = 0; i < wanted.length; i += CHUNK) chunks.push(wanted.slice(i, i + CHUNK));

  const results = await mapSettled(
    chunks,
    async (chunk) => {
      const url = `https://qt.gtimg.cn/q=${chunk.map((c) => c.symbol).join(',')}`;
      const { text } = await fetchText(url, { encoding: 'gbk', referer: REFERER, timeout: 10000 });
      return text;
    },
    4,
  );

  results.forEach((text, ci) => {
    if (!text) return;
    const chunk = chunks[ci];
    const bySymbol = new Map();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseLine(line);
      if (parsed) bySymbol.set(parsed.symbol, parsed);
    }
    for (const { target, symbol } of chunk) {
      const q = bySymbol.get(symbol);
      if (q) out.set(`${target.market}:${target.code}`, { ...q, market: target.market, code: target.code });
    }
  });

  return out;
}

/**
 * 指数行情：直接传腾讯原始 symbol（sh000001 / hkHSI / usIXIC ...），
 * 不走标的分类流程。
 * @param {string[]} symbols
 * @returns {Promise<Map<string, object>>}
 */
export async function fetchIndexQuotes(symbols) {
  const out = new Map();
  if (!symbols.length) return out;
  const { text } = await fetchText(`https://qt.gtimg.cn/q=${symbols.join(',')}`, {
    encoding: 'gbk',
    referer: REFERER,
    timeout: 10000,
  });
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^v_([^=]+)="([\s\S]*)";?\s*$/.exec(line.trim());
    if (!m) continue;
    const f = m[2].split('~');
    if (f.length < 40) continue;
    const { date, time } = parseQuoteTime(f[30]);
    out.set(m[1], {
      symbol: m[1],
      name: f[1],
      price: num(f[3]),
      prevClose: num(f[4]),
      change: num(f[31]),
      changePct: num(f[32]),
      localDate: date,
      localTime: time,
    });
  }
  return out;
}

/**
 * 分时数据（走势图）。腾讯对 A 股 / 港股提供完整分时，
 * 美股只返回单点，调用方需自行处理。
 */
export async function fetchMinute(symbol) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(symbol)}`;
  const { text } = await fetchText(url, { referer: REFERER, timeout: 10000 });
  const json = JSON.parse(text);
  const node = json?.data?.[symbol]?.data;
  if (!node?.data?.length) return null;
  return {
    date: node.date || null,
    points: node.data.map((row) => {
      const [t, price, volume] = String(row).split(/\s+/);
      return {
        time: `${t.slice(0, 2)}:${t.slice(2)}`,
        price: Number(price),
        volume: Number(volume),
      };
    }),
  };
}
