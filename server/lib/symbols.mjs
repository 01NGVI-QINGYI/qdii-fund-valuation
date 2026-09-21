/**
 * 标的知识：把东方财富持仓表里的"股票代码"翻译成各行情源要的 symbol。
 *
 * 东方财富的持仓明细里，代码是不带市场前缀的裸码：
 *   美股  -> NVDA / AAPL / BRK.B      （字母）
 *   港股  -> 00700 / 09988            （5 位数字）
 *   A 股  -> 600519 / 000001 / 430047 （6 位数字）
 *   日股  -> 8035 / 7203 / 285A       （4 位数字，或 3 位数字 + 字母）
 * 位数不同，所以数字码之间没有歧义。
 */

export const MARKET_CURRENCY = {
  US: 'USD',
  HK: 'HKD',
  JP: 'JPY',
  SH: 'CNY',
  SZ: 'CNY',
  BJ: 'CNY',
};

export const CURRENCY_LABEL = {
  USD: '美元',
  HKD: '港币',
  JPY: '日元',
  CNY: '人民币',
};

/** 行情所属的"交易时段组"，用于判断开闭市。 */
export function sessionGroup(market) {
  if (market === 'US') return 'US';
  if (market === 'HK') return 'HK';
  if (market === 'JP') return 'JP';
  return 'CN';
}

/**
 * 从裸代码推断市场。
 * @param {string} raw
 * @returns {{market: string, code: string} | null}
 */
export function classifyCode(raw) {
  const c = String(raw ?? '').trim().toUpperCase();
  if (!c) return null;

  if (/^\d{5}$/.test(c)) return { market: 'HK', code: c };

  if (/^\d{6}$/.test(c)) {
    const h = c[0];
    // 6/9 -> 沪市（9 为 B 股）；5 -> 沪市基金/ETF
    if (h === '6' || h === '5' || h === '9') return { market: 'SH', code: c };
    // 4/8 -> 北交所
    if (h === '4' || h === '8') return { market: 'BJ', code: c };
    // 0/1/2/3 -> 深市
    return { market: 'SZ', code: c };
  }

  // 东京证交所：4 位数字（8035），或 2024 年起的 3 位数字 + 字母（285A）
  if (/^\d{4}$/.test(c)) return { market: 'JP', code: c };
  if (/^\d{3}[A-Z]$/.test(c)) return { market: 'JP', code: c };

  // ISIN：2 位国家码 + 9 位字母数字 + 1 位校验位，共 12 位。
  // 东方财富对部分日股持仓只给 ISIN（如 JP3236330001 = 铠侠），
  // 必须单独识别——否则会被当成美股代码，永远取不到行情。
  if (isIsin(c)) return { market: 'ISIN', code: c, country: c.slice(0, 2) };

  // 字母开头的当美股（BRK.B、BF.B 之类保留点号），限 1–6 位避免误吞
  if (/^[A-Z][A-Z0-9.\-]{0,5}$/.test(c)) return { market: 'US', code: c };

  // 其余一律标记为待解析，由名称去东方财富反查
  return { market: 'UNKNOWN', code: c };
}

/** ISIN 判定：2 位国家码 + 9 位字母数字 + 1 位校验位。 */
export function isIsin(code) {
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(String(code || '').toUpperCase());
}

/** 东方财富 secid 前缀 -> 市场。用于把反查结果翻译回来。 */
export const EM_MKT_TO_MARKET = {
  0: 'SZ',
  1: 'SH',
  105: 'US',
  106: 'US',
  107: 'US',
  116: 'HK',
  176: 'JP',
};

export function keyOf(target) {
  return `${target.market}:${target.code}`;
}

/** 腾讯行情 symbol。 */
export function toTencent(target) {
  const { market, code } = target;
  const prefix = { US: 'us', HK: 'hk', JP: 'jp', SH: 'sh', SZ: 'sz', BJ: 'bj' }[market];
  return prefix ? `${prefix}${code}` : null;
}

export function fromTencentSymbol(sym) {
  const m = /^(us|hk|jp|sh|sz|bj)(.+)$/i.exec(sym);
  if (!m) return null;
  return { market: m[1].toUpperCase(), code: m[2] };
}

/** 新浪行情 symbol。新浪不提供日股，返回 null 让调用方跳过。 */
export function toSina(target) {
  const { market, code } = target;
  if (market === 'US') return `gb_${code.toLowerCase().replace(/\./g, '$')}`;
  if (market === 'HK') return `rt_hk${code}`;
  if (market === 'SH') return `sh${code}`;
  if (market === 'SZ') return `sz${code}`;
  if (market === 'BJ') return `bj${code}`;
  return null;
}

/**
 * 东方财富 secid。美股需要交易所号，
 * 由腾讯返回的代码后缀（.OQ / .N / .A）推断，默认按纳斯达克。
 */
export function toEastmoneySecid(target, exchangeHint) {
  const { market, code } = target;
  if (market === 'US') {
    const map = { OQ: 105, N: 106, A: 107, AM: 107, P: 106 };
    return `${map[exchangeHint] ?? 105}.${code}`;
  }
  if (market === 'HK') return `116.${code}`;
  if (market === 'JP') return `176.${code}`;
  if (market === 'SH') return `1.${code}`;
  if (market === 'SZ') return `0.${code}`;
  if (market === 'BJ') return `0.${code}`;
  return null;
}

/** 腾讯美股代码后缀 -> 交易所号。 */
export function exchangeFromTencentCode(codeField) {
  const m = /\.([A-Z]+)$/.exec(String(codeField || ''));
  return m ? m[1] : undefined;
}
