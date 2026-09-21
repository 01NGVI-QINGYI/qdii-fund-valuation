/** 指数条与市场时段。 */

import { h, s, clear, setText } from '../dom.js';
import * as fmt from '../format.js';

const ribbonEl = () => document.getElementById('ribbon');
const clockEl = () => document.getElementById('market-clock');

export function renderRibbon(indices, markets) {
  const root = ribbonEl();
  if (!root) return;

  const today = markets?.nowDate;
  clear(root);

  for (const idx of indices || []) {
    const tone = fmt.signClass(idx.changePct);
    // 行情日期落后于今天 -> 该市场尚未开始新交易日
    const stale = idx.localDate && today && idx.localDate < today;
    root.appendChild(h('div', { class: `idx${stale ? ' is-stale' : ''}` }, [
      h('div', { class: 'idx-name' }, idx.name),
      h('div', { class: 'idx-row' }, [
        h('span', { class: 'idx-price' }, fmt.index(idx.price)),
        h('span', { class: `idx-pct ${tone}` }, fmt.pct(idx.changePct)),
      ]),
    ]));
  }
}

const PHASE_TEXT = {
  pre: '未开盘',
  open: '交易中',
  break: '午间休市',
  closed: '已收盘',
};

function clockChip(m) {
  const open = m.open;
  // 备注里只有"休市"类信息才当作状态显示，夏令时/冬令时放 tooltip
  const closedNote = m.note && /休/.test(m.note) ? m.note : '';
  const stateText = open ? (PHASE_TEXT[m.phase] || '交易中') : (closedNote || PHASE_TEXT[m.phase] || '休市');
  const pct = Math.round((m.progress || 0) * 100);

  const dot = open
    ? h('span', { class: 'live-dot' })
    : h('span', { class: 'mk-dot' });

  const title = [
    `${m.label} ${stateText}${m.note && !closedNote ? ` · ${m.note}` : ''}`,
    `交易时段 ${m.session}`,
    m.open || m.phase === 'break' || m.phase === 'closed'
      ? `已交易 ${fmt.duration(m.elapsedMin)} / 共 ${fmt.duration(m.totalMin)}`
      : `距开盘 ${fmt.duration(m.remainMin)}`,
  ].filter(Boolean).join('\n');

  return h('div', { class: `mk${open ? ' is-open' : ''}`, title }, [
    h('div', { class: 'mk-top' }, [
      dot,
      h('b', {}, m.label),
      h('span', { class: 'mk-state' }, stateText),
      m.sessionShort ? h('span', { class: 'mk-range' }, m.sessionShort) : null,
    ]),
    h('div', { class: 'mk-foot' }, [
      h('div', { class: 'mk-bar' }, h('i', { style: { width: `${pct}%` } })),
      h('span', { class: 'mk-pct' }, `${pct}%`),
    ]),
  ]);
}

/**
 * 市场时段。
 *
 * 只显示"你的自选里真正持有"的市场——本工具主打美股方向的 QDII，
 * 纯海外基金的自选不该出现 A 股这一栏；哪天自选里加了境内基金，
 * A 股会自动出现。没有自选时，默认显示三个海外市场。
 *
 * 进度条按「已交易分钟 ÷ 当日应交易分钟」推进，午休期间停住不动。
 */
export function renderClock(markets, activeGroups) {
  const root = clockEl();
  if (!root || !markets) return;
  clear(root);

  const ORDER = ['US', 'HK', 'JP', 'CN'];
  const groups = activeGroups?.length ? activeGroups : ['US', 'HK', 'JP'];
  const keys = ORDER.filter((k) => groups.includes(k));

  for (const key of keys) {
    const m = markets[key];
    if (m) root.appendChild(clockChip(m));
  }
}

/** 汇总自选基金持仓涉及的市场组。 */
export function activeGroupsOf(funds) {
  const set = new Set();
  for (const f of funds || []) {
    for (const hh of f.holdings || []) set.add(hh.sessionGroup);
    // 没有持仓明细时，用市场状态里挂着的待交易市场兜底
    for (const p of f.estimate?.pending || []) set.add(p.group);
  }
  return [...set];
}

/* ── 本地时钟 ───────────────────────────────────────────────────────── */

const tzOffsetMin = () => -new Date().getTimezoneOffset();

/** 北京相对 UTC 的偏移（分钟）。中国不实行夏令时，固定 +8。 */
const BEIJING_OFFSET_MIN = 480;

/**
 * 把服务端给的"北京时间分钟数"换算成本地时区的显示文本。
 * 估值逻辑本身必须按北京时间走（基金净值日期就是北京口径），
 * 但表头给人看的时间段应当跟用户所在时区一致。
 */
export function beijingMinutesToLocal(minutes) {
  const shift = tzOffsetMin() - BEIJING_OFFSET_MIN;
  const m = ((minutes + shift) % 1440 + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 指数条最右侧的实时时钟。 */
export function startClock() {
  const timeEl = document.getElementById('ck-time');
  const zoneEl = document.getElementById('ck-zone');
  if (!timeEl) return;

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
  const off = tzOffsetMin();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const gmt = `GMT${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
  if (zoneEl) zoneEl.textContent = `${zone} · ${gmt}`;

  const fmt = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const tick = () => { timeEl.textContent = fmt.format(new Date()); };
  tick();
  setInterval(tick, 1000);
}
