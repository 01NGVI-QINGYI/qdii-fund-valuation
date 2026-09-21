/**
 * 新浪财经行情源（hq.sinajs.cn）
 *
 * 参考 qdii-value 的 provider/equity/sina.py。这里是备用行情源 + 汇率源 +
 * 基金净值源。必须带 Referer，否则新浪直接拒绝。
 *
 * 字段布局（按实测校准，与 qdii-value 略有出入，以数值自洽为准）：
 *   美股 gb_xxx : 0名称 1最新 2涨跌幅 3时间(北京) 4涨跌额 5开 6高 7低 .. 26昨收
 *   港股 rt_hkxx: 0英文名 1名称 2开 3昨收 4高 5低 6最新 7涨跌 8涨跌幅 .. 17日期 18时间
 *   A股  sh/sz  : 0名称 1开 2昨收 3最新 4高 5低 .. 30日期 31时间
 *   外汇 fx_sxx : 0时间 1最新 3昨收 10涨跌幅 11涨跌额 17日期
 */

import { fetchText, mapSettled } from '../lib/http.mjs';
import { toSina } from '../lib/symbols.mjs';

const REFERER = 'https://finance.sina.com.cn/';
const CHUNK = 50;

const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

function derive(price, prevClose) {
  if (price === null || !prevClose) return { change: null, changePct: null };
  const change = price - prevClose;
  return { change, changePct: (change / prevClose) * 100 };
}

async function hq(list) {
  const url = `http://hq.sinajs.cn/?list=${list.join(',')}`;
  const { text } = await fetchText(url, { encoding: 'gbk', referer: REFERER, timeout: 10000 });
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^var hq_str_([^=]+)="([\s\S]*)";?\s*$/.exec(line.trim());
    if (!m) continue;
    out.set(m[1], m[2].split(','));
  }
  return out;
}

function parseUs(f, name) {
  const price = num(f[1]);
  const changePct = num(f[2]);
  const change = num(f[4]);
  const prevClose = num(f[26]) ?? (price !== null && change !== null ? price - change : null);
  const bjDate = String(f[3] || '').slice(0, 10);
  // 新浪美股的时间是北京时间；估值比较需要美东日期，用 ET 字符串还原
  const et = String(f[25] || '').trim();
  let localDate = bjDate;
  let localTime = String(f[3] || '').slice(11, 19);
  const etM = /^([A-Z][a-z]{2}) (\d{1,2}) (\d{1,2}):(\d{2})(AM|PM) \w+ (\d{4})$/.exec(et);
  if (etM) {
    const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    let hh = Number(etM[3]) % 12;
    if (etM[5] === 'PM') hh += 12;
    localDate = `${etM[6]}-${String(months[etM[1]]).padStart(2, '0')}-${String(etM[2]).padStart(2, '0')}`;
    localTime = `${String(hh).padStart(2, '0')}:${etM[4]}:00`;
  }
  const valid = price !== null && price > 0 && changePct !== null;
  return {
    name: name || f[0], price, prevClose, open: num(f[5]), high: num(f[6]), low: num(f[7]),
    change, changePct: valid ? changePct : null,
    volume: num(f[10]), localDate, localTime,
    quoteAt: localDate && localTime ? `${localDate} ${localTime}` : null,
    provider: 'sina', valid,
  };
}

function parseHk(f, name) {
  const price = num(f[6]);
  const prevClose = num(f[3]);
  const d = derive(price, prevClose);
  const date = String(f[17] || '').replace(/\//g, '-');
  const time = String(f[18] || '');
  const changePct = num(f[8]) ?? d.changePct;
  const valid = price !== null && price > 0 && changePct !== null;
  return {
    name: name || f[1], price, prevClose, open: num(f[2]), high: num(f[4]), low: num(f[5]),
    change: num(f[7]) ?? d.change, changePct: valid ? changePct : null,
    volume: num(f[11]), localDate: date || null, localTime: time || null,
    quoteAt: date && time ? `${date} ${time}` : null,
    provider: 'sina', valid,
  };
}

function parseCn(f, name, isIndex) {
  // 指数走 s_ 前缀时字段被裁剪，这里只处理完整格式
  const price = num(f[3]);
  const prevClose = num(f[2]);
  const d = derive(price, prevClose);
  const rawDate = String(f[30] || '');
  const date = /^\d{8}$/.test(rawDate)
    ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
    : rawDate.slice(0, 10);
  const time = String(f[31] || '');
  const valid = price !== null && price > 0;
  return {
    name: name || f[0], price, prevClose, open: num(f[1]), high: num(f[4]), low: num(f[5]),
    change: d.change, changePct: valid ? d.changePct : null,
    volume: num(f[8]), localDate: date || null, localTime: time || null,
    quoteAt: date && time ? `${date} ${time}` : null,
    provider: 'sina', valid, isIndex: !!isIndex,
  };
}

/**
 * 批量取行情（备用源）。
 * @param {{market:string, code:string}[]} targets
 */
export async function fetchQuotes(targets) {
  const out = new Map();
  if (!targets.length) return out;

  const wanted = targets.map((t) => ({ target: t, symbol: toSina(t) })).filter((x) => x.symbol);
  const chunks = [];
  for (let i = 0; i < wanted.length; i += CHUNK) chunks.push(wanted.slice(i, i + CHUNK));

  const results = await mapSettled(
    chunks,
    (chunk) => hq(chunk.map((c) => c.symbol)),
    4,
  );

  results.forEach((map, ci) => {
    if (!map) return;
    for (const { target, symbol } of chunks[ci]) {
      const f = map.get(symbol);
      if (!f || f.length < 4 || !f[0]) continue;
      const parsed =
        target.market === 'US' ? parseUs(f) : target.market === 'HK' ? parseHk(f) : parseCn(f);
      out.set(`${target.market}:${target.code}`, { ...parsed, market: target.market, code: target.code, symbol });
    }
  });

  return out;
}

/**
 * 汇率。返回 USD / HKD / JPY 对人民币的涨跌幅（百分比）。
 * 注：新浪不提供日股行情，但提供日元汇率，日股基金的汇率影响仍可计算。
 */
export async function fetchFx() {
  const map = await hq(['fx_susdcny', 'fx_susdcnh', 'fx_shkdcny', 'fx_sjpycny']);
  const pick = (key) => {
    const f = map.get(key);
    if (!f || f.length < 12) return null;
    const price = num(f[1]);
    const prevClose = num(f[3]);
    const d = derive(price, prevClose);
    return {
      price,
      prevClose,
      change: num(f[11]) ?? d.change,
      changePct: num(f[10]) ?? d.changePct,
      date: String(f[17] || ''),
      time: String(f[0] || ''),
    };
  };
  const usdCny = pick('fx_susdcny') || pick('fx_susdcnh');
  const hkdCny = pick('fx_shkdcny');
  const jpyCny = pick('fx_sjpycny');
  return {
    USD: usdCny,
    HKD: hkdCny,
    JPY: jpyCny,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 基金历史净值（新浪开放式基金接口）。
 * 参考 qdii-value 的 history_fund。
 */
export async function fetchFundNav(code, { from, to, page = 1 } = {}) {
  const qs = new URLSearchParams({
    symbol: String(code),
    datefrom: from || '',
    dateto: to || '',
    page: String(page),
  });
  const url = `https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/CaihuiFundInfoService.getNav?${qs}`;
  const { text } = await fetchText(url, { referer: REFERER, timeout: 10000 });
  const json = JSON.parse(text);
  if (json?.result?.status?.code !== 0) throw new Error(`新浪净值接口错误: ${json?.result?.status?.code}`);
  const rows = json?.result?.data?.data || [];
  return rows
    .map((r) => ({
      date: String(r.fbrq || '').slice(0, 10),
      nav: Number(r.jjjz),
      accNav: Number(r.ljjz),
    }))
    .filter((r) => r.date && Number.isFinite(r.nav))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}
