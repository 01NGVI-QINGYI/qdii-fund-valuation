/** 数值与时间格式化。 */

const DASH = '—';

export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 带正负号的百分比，例如 +1.23% / -1.23% */
export function pct(v, digits = 2) {
  if (!isNum(v)) return DASH;
  const s = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${s}${Math.abs(v).toFixed(digits)}%`;
}

/** 不带符号的百分比 */
export function pctPlain(v, digits = 2) {
  if (!isNum(v)) return DASH;
  return `${v.toFixed(digits)}%`;
}

export function num(v, digits = 2) {
  if (!isNum(v)) return DASH;
  return v.toFixed(digits);
}

/** 基金净值习惯保留 4 位 */
export function nav(v) {
  if (!isNum(v)) return DASH;
  const digits = Math.abs(v) >= 100 ? 2 : 4;
  return v.toFixed(digits);
}

export function signClass(v) {
  if (!isNum(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

export function signOf(v) {
  if (!isNum(v) || v === 0) return 0;
  return v > 0 ? 1 : -1;
}

/** 大数字加千分位 */
export function group(v, digits = 2) {
  if (!isNum(v)) return DASH;
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 指数点位：按量级决定小数位 */
export function index(v) {
  if (!isNum(v)) return DASH;
  const digits = Math.abs(v) >= 10000 ? 0 : Math.abs(v) >= 1000 ? 1 : 2;
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const MARKET_LABEL = { US: '美', HK: '港', JP: '日', SH: '沪', SZ: '深', BJ: '京', CN: 'A' };
export function marketLabel(m) {
  return MARKET_LABEL[m] || m || '';
}

const GROUP_LABEL = { US: '美股', HK: '港股', JP: '日股', CN: 'A 股' };
export function groupLabel(g) {
  return GROUP_LABEL[g] || g;
}

const CONFIDENCE = {
  high: { text: '高', cls: 'up' },
  medium: { text: '中', cls: 'flat' },
  low: { text: '低', cls: 'warn' },
  none: { text: '—', cls: 'flat' },
};
export function confidenceLabel(c) {
  return CONFIDENCE[c] || CONFIDENCE.none;
}

const CURRENCY_NAME = { USD: '美元', HKD: '港币', JPY: '日元', CNY: '人民币' };
export function currencyName(c) {
  return CURRENCY_NAME[c] || c;
}

const STATE_TEXT = {
  full: '全部持仓已交易',
  partial: '部分市场已交易',
  pending: '等待市场开盘',
  settled: '净值已是最新',
  nodata: '无持仓数据',
};
export function stateText(s) {
  return STATE_TEXT[s] || '';
}

/** '2026-09-18' -> '09-18' */
export function shortDate(d) {
  if (!d) return DASH;
  return String(d).slice(5);
}

/** ISO -> 相对时间 */
export function relTime(iso, now = Date.now()) {
  if (!iso) return DASH;
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  const diff = Math.max(0, Math.round((now - t) / 1000));
  if (diff < 5) return '刚刚';
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

/** 报告期新鲜度描述 */
export function reportAge(days) {
  if (!isNum(days)) return DASH;
  if (days < 0) return '—';
  if (days < 150) return `${days} 天前`;
  if (days < 365) return `${Math.round(days / 30)} 个月前`;
  return `${(days / 365).toFixed(1)} 年前`;
}

/** 把 2026-09-18 12:30:00 形式的时间转成 时:分 */
export function clockOf(s) {
  if (!s) return '';
  const m = /(\d{2}):(\d{2})/.exec(String(s));
  return m ? `${m[1]}:${m[2]}` : '';
}

/** 分钟数 -> "3 小时 30 分" / "45 分" */
export function duration(minutes) {
  if (!isNum(minutes)) return '—';
  const v = Math.max(0, Math.round(minutes));
  const hh = Math.floor(v / 60);
  const mm = v % 60;
  if (hh && mm) return `${hh} 小时 ${mm} 分`;
  if (hh) return `${hh} 小时`;
  return `${mm} 分`;
}

/**
 * 区间收益率：数值大时自动减少小数位，保证窄列里放得下。
 *   +3.42% / +68.4% / +201%
 */
export function ret(v) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  const digits = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}${a.toFixed(digits)}%`;
}

/** 金额：¥12,345.67；带正负号时用于盈亏 */
export function money(v, { sign = false, digits = 2 } = {}) {
  if (!isNum(v)) return '—';
  const abs = Math.abs(v).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const s = v < 0 ? '-' : sign && v > 0 ? '+' : '';
  return `${s}¥${abs}`;
}

/** 金额缩写：1.2 万 / 3,456 */
export function moneyShort(v) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)} 亿`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(2)} 万`;
  return `${sign}${a.toFixed(0)}`;
}
