/** 自选看板：表格渲染与增量更新。 */

import { h, s, clear, setText, setClass } from '../dom.js';
import * as fmt from '../format.js';
import { loadPositions, derivePosition, inWatch, addToWatch, removeFromWatch } from '../store.js';

/** code -> 行节点与其中的可变引用 */
const rowIndex = new Map();

/** 区间收益率列（近 1 月 / 3 月 / 6 月 / 1 年 / 3 年）。 */
export const RETURN_COLUMNS = [
  { key: 'm1', title: '近1月' },
  { key: 'm3', title: '近3月' },
  { key: 'm6', title: '近6月' },
  { key: 'y1', title: '近1年' },
  { key: 'y3', title: '近3年' },
];

/** 三个估算列对应美股阶段；不在该阶段时显示「——」。 */
export const EST_COLUMNS = [
  { key: 'pre', title: '盘前估算', phase: '盘前' },
  { key: 'open', title: '盘中估算', phase: '盘中' },
  { key: 'after', title: '盘后估算', phase: '盘后' },
];

/** 该基金是否有录入持仓（用于决定是否显示"今日预估"列）。 */
export function hasAnyPosition() {
  return Object.keys(loadPositions()).length > 0;
}

function skeletonRows(n = 3) {
  return Array.from({ length: n }, () =>
    h('tr', { class: 'skeleton-row' }, [
      h('td', {}, h('div', { class: 'sk', style: { width: '18px' } })),
      h('td', {}, h('div', { class: 'sk', style: { width: '58%' } })),
      h('td', {}, h('div', { class: 'sk', style: { width: '64%', marginLeft: 'auto' } })),
      h('td', {}, h('div', { class: 'sk', style: { width: '70%', marginLeft: 'auto' } })),
      h('td', {}, h('div', { class: 'sk', style: { width: '70%', marginLeft: 'auto' } })),
      h('td', {}, h('div', { class: 'sk', style: { width: '70%', marginLeft: 'auto' } })),
      h('td'),
    ]),
  );
}

export function renderSkeleton(tbody, n) {
  clear(tbody);
  rowIndex.clear();
  for (const r of skeletonRows(n)) tbody.appendChild(r);
}

function flagsFor(fund) {
  const flags = [];
  const e = fund.estimate;

  if (fund.reportStale) {
    flags.push(h('span', { class: 'flag flag-warn', title: `持仓报告期 ${fund.reportDate}` }, '持仓陈旧'));
  }
  if (e && e.state === 'settled') {
    flags.push(h('span', { class: 'flag flag-muted' }, '已结算'));
  } else if (e && e.state === 'pending') {
    flags.push(h('span', { class: 'flag flag-muted' }, '待开盘'));
  } else if (e && e.state === 'partial') {
    flags.push(h('span', { class: 'flag flag-live' }, '部分'));
  }
  return flags;
}

/** 一个估算单元格：百分比在上、估算净值在下；非当前阶段显示「——」。 */
function estCell() {
  const main = h('div', { class: 'est-main num' });
  const nav = h('span', { class: 'est-nav num' });
  const td = h('td', { class: 'c-num c-est' }, h('div', { class: 'est-stack' }, [main, nav]));
  const dash = h('span', { class: 'est-dash' }, '—');
  td.appendChild(dash);
  return { td, main, nav, dash };
}

function updateEstCell(cell, active, e) {
  if (!active || !e) {
    cell.main.hidden = true;
    cell.nav.hidden = true;
    cell.dash.hidden = false;
    return;
  }
  cell.main.hidden = false;
  cell.nav.hidden = false;
  cell.dash.hidden = true;

  if (cell.main.querySelector('.est-none')) clear(cell.main);
  let sign = cell.main.querySelector('.pct-sign');
  let val = cell.main.querySelector('.pct-val');
  let unit = cell.main.querySelector('.pct-unit');
  if (!val) {
    sign = h('span', { class: 'pct-sign' });
    val = h('span', { class: 'pct-val' });
    unit = h('span', { class: 'pct-unit' }, '%');
    clear(cell.main);
    cell.main.append(sign, val, unit);
  }
  const tone = fmt.signClass(e.changePct);
  setText(sign, e.changePct > 0 ? '+' : e.changePct < 0 ? '-' : '', null);
  setText(val, Math.abs(e.changePct).toFixed(2), cell.lastTone === undefined ? null : tone);
  cell.lastTone = tone;
  cell.main.className = `est-main num ${tone}`;

  clear(cell.nav);
  cell.nav.append('净值 ', h('b', {}, fmt.nav(e.nav)));
}

function buildRow(fund, handlers) {
  const tr = h('tr', { dataset: { code: fund.code } });

  /* 星标：已自选时为实心，点击移除 */
  const star = h('button', {
    class: 'star',
    title: '已加入自选，点击移出',
    'aria-label': `移出自选 ${fund.name || fund.code}`,
    onclick: (ev) => { ev.stopPropagation(); handlers.onToggleStar(fund.code); },
  }, s('svg', { viewBox: '0 0 16 16' }, [
    s('path', { d: 'M8 2.2l1.75 3.7 3.95.53-2.9 2.77.72 3.98L8 11.28 4.48 13.2l.72-3.98-2.9-2.77 3.95-.53z' }),
  ]));
  const tdStar = h('td', { class: 'c-star' }, star);

  /* 基金 */
  const nameEl = h('div', { class: 'fund-name' }, [
    h('span', { class: 'fname' }, fund.name || fund.code),
  ]);
  const flagBox = h('span', { class: 'fund-flags' });
  nameEl.appendChild(flagBox);
  const codeEl = h('span', { class: 'fund-code' }, fund.code);
  const metaEl = h('span', { class: 'fund-sub-extra', style: { fontSize: '10px', color: 'var(--faint)' } });
  const sub = h('div', { class: 'fund-sub' }, [codeEl, metaEl]);
  const tdFund = h('td', { class: 'c-fund' },
    h('div', { class: 'fund-cell' }, h('div', { class: 'fund-main' }, [nameEl, sub])));

  /* 区间收益率 */
  const retEls = RETURN_COLUMNS.map((c) => {
    const el = h('span', { class: 'ret-val num' }, '—');
    const td = h('td', { class: 'c-num c-ret', dataset: { ret: c.key } }, el);
    return { td, el, key: c.key };
  });

  /* 最新净值 */
  const navEl = h('span', { class: 'nav-val num' }, '—');
  const navDateEl = h('span', { class: 'nav-date' }, '');
  const tdNav = h('td', { class: 'c-num c-nav' }, [navEl, navDateEl]);

  /* 盘前 / 盘中 / 盘后 */
  const cells = EST_COLUMNS.map(() => estCell());
  cells.forEach((c, i) => { c.td.dataset.col = EST_COLUMNS[i].key; });

  /* 今日预估收益（仅在有录入持仓时显示） */
  const pnlEl = h('span', { class: 'est-pnl' });
  const pnlSubEl = h('span', { class: 'pnl-sub' });
  const tdPnl = h('td', { class: 'c-num c-pnl' }, [pnlEl, pnlSubEl]);

  tr.append(tdStar, tdFund, ...retEls.map((r) => r.td), tdNav, ...cells.map((c) => c.td), tdPnl);
  tr.addEventListener('click', () => handlers.onSelect(fund.code));

  return {
    tr,
    refs: {
      star, nameEl, flagBox, metaEl, retEls, navEl, navDateEl,
      cells, tdPnl, pnlEl, pnlSubEl,
    },
    fund,
  };
}

function updateRow(row, fund, handlers) {
  const { refs } = row;
  const e = fund.estimate;

  /* 星标 */
  const starred = inWatch(fund.code);
  setClass(refs.star, 'is-on', starred);
  refs.star.title = starred ? '已加入自选，点击移出' : '点击加入自选';

  /* 名称与元信息 */
  const fullName = fund.name || fund.code;
  setText(refs.nameEl.querySelector('.fname'), fullName);
  refs.nameEl.title = `${fullName}  ${fund.code}`;
  // 报告期、重仓只数这类信息在详情里已有，表上只留代码，保持紧凑
  setText(refs.metaEl, '');

  const nextFlags = flagsFor(fund);
  const key = nextFlags.map((f) => f.textContent).join('|');
  if (refs.flagKey !== key) {
    refs.flagKey = key;
    clear(refs.flagBox);
    for (const f of nextFlags) refs.flagBox.appendChild(f);
  }

  /* 区间收益率 */
  const rets = fund.returns || {};
  for (const r of refs.retEls) {
    const v = rets[r.key];
    if (!fmt.isNum(v)) {
      setText(r.el, '—', null);
      r.el.className = 'ret-val num faint';
    } else {
      setText(r.el, fmt.ret(v), null);
      r.el.className = `ret-val num ${fmt.signClass(v)}`;
    }
  }

  /* 净值 */
  setText(refs.navEl, fmt.nav(fund.nav?.value), null);
  setText(refs.navDateEl, fund.nav?.date ? fmt.shortDate(fund.nav.date) : '', null);

  /* 三个估算列：只有当前美股阶段那一列有值 */
  const session = e?.session || 'gap';
  EST_COLUMNS.forEach((col, i) => {
    updateEstCell(refs.cells[i], session === col.key, e);
    setClass(refs.cells[i].td, 'is-active', session === col.key);
  });

  /* 今日预估收益 */
  const positions = handlers.positions || loadPositions();
  const pos = derivePosition(positions[fund.code], e);
  if (pos && pos.todayPnl !== null) {
    const pTone = fmt.signClass(pos.todayPnl);
    refs.tdPnl.hidden = false;
    clear(refs.pnlEl);
    refs.pnlEl.className = `est-pnl ${pTone}`;
    refs.pnlEl.textContent = fmt.money(pos.todayPnl, { sign: true });
    clear(refs.pnlSubEl);
    refs.pnlSubEl.textContent = Number.isFinite(pos.amount) ? `市值 ${fmt.moneyShort(pos.amount)}` : '';
  } else {
    refs.tdPnl.hidden = !handlers.showPnl;
    clear(refs.pnlEl);
    refs.pnlEl.className = 'est-pnl';
    refs.pnlEl.textContent = handlers.showPnl ? '—' : '';
    clear(refs.pnlSubEl);
  }
}

/**
 * 渲染整个看板。
 * @param {HTMLElement} tbody
 * @param {object[]} funds
 * @param {object} handlers
 */
export function renderBoard(tbody, funds, handlers) {
  const seen = new Set();

  // 清掉骨架屏等非数据行（骨架行不在 rowIndex 里，增量更新管不到它们）
  for (const child of [...tbody.children]) {
    const code = child.dataset?.code;
    if (!code || !funds.some((f) => f.code === code)) {
      if (!code) child.remove();
    }
  }

  funds.forEach((fund, i) => {
    seen.add(fund.code);
    let row = rowIndex.get(fund.code);
    if (!row) {
      row = buildRow(fund, handlers);
      rowIndex.set(fund.code, row);
    }
    updateRow(row, fund, handlers);
    const currentAt = tbody.children[i];
    if (currentAt !== row.tr) tbody.insertBefore(row.tr, currentAt || null);
    setClass(row.tr, 'is-active', fund.code === handlers.selected);
  });

  for (const [code, row] of rowIndex) {
    if (!seen.has(code)) {
      row.tr.remove();
      rowIndex.delete(code);
    }
  }
}

export function clearBoard(tbody) {
  clear(tbody);
  rowIndex.clear();
}

export function rowCount() {
  return rowIndex.size;
}
