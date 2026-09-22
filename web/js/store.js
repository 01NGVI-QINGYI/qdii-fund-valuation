/** 本地偏好与自选列表（localStorage）。 */

import { DEFAULT_WATCH } from './catalog.js';

const KEY_WATCH = 'qdii-desk.watch.v1';
const KEY_PREFS = 'qdii-desk.prefs.v1';
const KEY_POSITIONS = 'qdii-desk.positions.v1';
const KEY_WATCH_SNAPSHOT = 'qdii-desk.watch-snapshot.v1';
const SNAPSHOT_MAX_AGE = 2 * 3600_000;

const DEFAULT_PREFS = {
  theme: 'light',
  interval: 30,
  fx: true,
  sort: 'weight',
  top: 10,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式等场景写入会失败，忽略即可 */
  }
}

/* ── 自选 ───────────────────────────────────────────────────────────── */

/**
 * 自选列表。
 *
 * 规则：**一个都没收藏时，回落到内置基金池的预设**（紧凑版，每只基金取 A 类）。
 * 也就是说列表永远不会是空的——用户把自选清光，看到的就是默认推荐。
 * 预设不写盘，只在读取时补上；一旦用户手动加/减，就固化成真实列表。
 */

function normalize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && /^\d{6}$/.test(String(x.code)))
    .map((x) => ({ code: String(x.code), name: x.name || '', addedAt: x.addedAt || 0 }));
}

/**
 * 早期版本的内置基金池里有几个代码指向的是完全不相干的基金
 * （例如 019199 实为"华富国泰民安灵活配置混合C"）。已经存进浏览器的
 * 自选要按表迁一次，否则老用户会一直看到错的那只。
 * 映射为 null 表示该份额根本不存在，直接删掉。
 */
const LEGACY_CODE_FIX = {
  '019199': '019155', // 易方达全球配置 A
  '019200': '019156', // 易方达全球配置 C
  '016976': '501225', // 景顺长城全球半导体 A
  '016977': '016668', // 景顺长城全球半导体 C
  '018376': '501226', // 长城全球新能源车 A
  '018377': '018036', // 长城全球新能源车 C
  '018901': '018147', // 建信新兴市场 C
  '019071': '024239', // 华夏全球科技先锋 C
  '016818': '164212', // 天弘全球新能源汽车 A
  '016819': '016823', // 天弘全球新能源汽车 C
  '015210': null,     // 华夏移动互联没有 C 类
  '019078': null,     // 嘉实美国成长没有 C 类
};

function migrateCodes(list) {
  const out = [];
  const seen = new Set();
  let changed = false;
  for (const item of list) {
    const mapped = Object.prototype.hasOwnProperty.call(LEGACY_CODE_FIX, item.code)
      ? LEGACY_CODE_FIX[item.code]
      : item.code;
    if (mapped !== item.code) changed = true;
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped === item.code ? item : { ...item, code: mapped, name: '' });
  }
  return { list: out, changed };
}

function presetWatch() {
  return DEFAULT_WATCH.map((f, i) => ({ code: f.code, name: f.name, addedAt: i }));
}

/** 读磁盘上的真实列表（不含预设回落），顺带迁移历史错误代码。 */
function readStored() {
  const raw = normalize(read(KEY_WATCH, []));
  const { list, changed } = migrateCodes(raw);
  if (changed) write(KEY_WATCH, list);
  return list;
}

/** 生效的自选列表：空则返回预设。 */
export function loadWatch() {
  const stored = readStored();
  return stored.length ? stored : presetWatch();
}

/** 当前显示的是不是"预设回落"状态（一个都没收藏）。 */
export function isUsingPresets() {
  return readStored().length === 0;
}

export function saveWatch(list) {
  write(KEY_WATCH, normalize(list));
}

export function addToWatch(code, name) {
  const list = loadWatch();
  if (list.some((x) => x.code === code)) return { list, added: false };
  const next = [...list, { code: String(code), name: name || '', addedAt: Date.now() }];
  saveWatch(next);
  return { list: next, added: true };
}

export function removeFromWatch(code) {
  // 基于"生效列表"删除，这样从预设状态里去掉一只也能正确固化
  const next = loadWatch().filter((x) => x.code !== code);
  saveWatch(next); // 删空了就回到预设回落
  return next;
}

export function inWatch(code) {
  return loadWatch().some((x) => x.code === code);
}

/** 恢复默认：直接清空真实列表，让预设回落生效。 */
export function resetWatch() {
  saveWatch([]);
  return presetWatch();
}

/* ── 看板快照 ───────────────────────────────────────────────────────── */

/**
 * Render 免费实例休眠唤醒时 API 可能需要几十秒。保存最近一次精简看板数据，
 * 下次启动先显示旧值并明确标为缓存，再由实时请求渐进覆盖。
 */
export function loadWatchSnapshot() {
  const snapshot = read(KEY_WATCH_SNAPSHOT, null);
  if (!snapshot || !Array.isArray(snapshot.funds) || !Number.isFinite(snapshot.savedAt)) return null;
  if (Date.now() - snapshot.savedAt > SNAPSHOT_MAX_AGE) return null;
  return snapshot;
}

export function saveWatchSnapshot(funds) {
  const clean = (funds || []).filter((f) => f?.code && f?.estimate);
  if (clean.length) write(KEY_WATCH_SNAPSHOT, { savedAt: Date.now(), funds: clean });
}

/* ── 偏好 ───────────────────────────────────────────────────────────── */

export function loadPrefs() {
  return { ...DEFAULT_PREFS, ...read(KEY_PREFS, {}) };
}

export function savePrefs(prefs) {
  write(KEY_PREFS, prefs);
}

let prefs = loadPrefs();

export function getPrefs() {
  return prefs;
}

export function setPref(key, value) {
  prefs = { ...prefs, [key]: value };
  savePrefs(prefs);
  return prefs;
}

/* ── 我的持仓 ───────────────────────────────────────────────────────── */

/**
 * 每只基金一条记录：
 *   amount  持仓金额（元，按最新净值的市值）
 *   profit  持仓收益金额（元，累计收益，可为负）
 *   rate    持仓收益率（%，可选；不填则用 profit / (amount - profit) 推算）
 *
 * 语义按国内基金 App 的通行口径：
 *   收益率 = 收益 ÷ 成本，成本 = 市值 − 收益
 * 所以只填「金额 + 收益」也能算出收益率，第三个字段是留给
 * 那些以成本口径填写的用户的（他们填了就以填的为准）。
 */

const numOrNull = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function loadPositions() {
  const raw = read(KEY_POSITIONS, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [code, v] of Object.entries(raw)) {
    if (!/^\d{6}$/.test(code) || !v || typeof v !== 'object') continue;
    const amount = numOrNull(v.amount);
    const profit = numOrNull(v.profit);
    const rate = numOrNull(v.rate);
    if (amount === null && profit === null && rate === null) continue;
    out[code] = { amount, profit, rate, updatedAt: v.updatedAt || 0 };
  }
  return out;
}

export function savePositions(map) {
  write(KEY_POSITIONS, map);
}

export function getPosition(code) {
  return loadPositions()[code] || null;
}

/** 写入一只基金的持仓；三个字段全空则视为删除。 */
export function setPosition(code, { amount, profit, rate }) {
  const map = loadPositions();
  const a = numOrNull(amount);
  const p = numOrNull(profit);
  const r = numOrNull(rate);
  if (a === null && p === null && r === null) {
    delete map[code];
  } else {
    map[code] = { amount: a, profit: p, rate: r, updatedAt: Date.now() };
  }
  savePositions(map);
  return map[code] || null;
}

export function removePosition(code) {
  const map = loadPositions();
  delete map[code];
  savePositions(map);
  return map;
}

/**
 * 补齐收益率并计算今日预估收益。
 * @param {{amount:number,profit:number,rate:number}} pos
 * @param {{changePct:number}} estimate
 */
export function derivePosition(pos, estimate) {
  if (!pos) return null;
  const amount = pos.amount;
  const profit = pos.profit;

  // 收益率：优先用填写的；否则由 收益 / 成本 推算
  let rate = pos.rate;
  let rateSource = rate !== null ? 'input' : null;
  if (rate === null && Number.isFinite(amount) && Number.isFinite(profit)) {
    const cost = amount - profit;
    if (Math.abs(cost) > 0.005) {
      rate = (profit / cost) * 100;
      rateSource = 'derived';
    }
  }

  // 今日预估收益 = 持仓金额 × 估算涨跌%（持仓金额按最新净值计）
  let todayPnl = null;
  if (Number.isFinite(amount) && Number.isFinite(estimate?.changePct)) {
    todayPnl = (amount * estimate.changePct) / 100;
  }

  return { ...pos, rate, rateSource, todayPnl, hasAmount: Number.isFinite(amount) };
}

export { DEFAULT_PREFS };
