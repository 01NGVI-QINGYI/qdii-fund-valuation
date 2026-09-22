/** 应用入口：状态编排、刷新循环、交互。 */

import { $, toast, setText, h, clear } from './dom.js';
import { api } from './api.js';
import * as store from './store.js';
import { renderBoard, clearBoard } from './views/board.js';
import { renderDetail, renderPlaceholder, openDrawer, closeDrawer } from './views/detail.js';
import { renderRibbon, startClock, beijingMinutesToLocal } from './views/ribbon.js';
import { createSearch } from './views/search.js';
import { createPicker } from './views/picker.js';
import * as fmt from './format.js';
const SUGGESTIONS = [
  { code: '161125', name: '易方达标普500指数人民币A' },
  { code: '513500', name: '标普500ETF博时' },
  { code: '164906', name: '交银中证海外中国互联网' },
  { code: '160644', name: '鹏华港美互联股票' },
  { code: '000834', name: '大成纳斯达克100ETF联接' },
  { code: '161725', name: '招商中证白酒指数A' },
];

// 冷启动时 25 只基金需要约 50 个上游请求。分成小批后，首批通常 3 秒左右
// 即可显示，余下数据继续渐进填充，不再让最慢的一只阻塞整张表。
const WATCH_BATCH_SIZE = 5;

const state = {
  funds: [],
  markets: null,
  fx: null,
  phase: null,
  selected: null,
  detail: null,
  loading: false,
  lastUpdated: null,
  timer: null,
  error: null,
};

const el = {
  gridBody: $('#grid-body'),
  empty: $('#empty'),
  emptyChips: $('#empty-chips'),
  count: $('#watch-count'),
  foot: $('#foot-status'),
  detail: $('#detail'),
  refresh: $('#btn-refresh'),
};

/** 选基面板实例（init 里创建，供星标回调刷新）。 */
let picker = null;
let refreshRun = 0;

/* ── 主题 ───────────────────────────────────────────────────────────── */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.setPref('theme', theme);
}

/* ── 空状态 ─────────────────────────────────────────────────────────── */

function renderEmptyChips() {
  clear(el.emptyChips);
  for (const s of SUGGESTIONS) {
    el.emptyChips.appendChild(h('button', {
      class: 'chip',
      onclick: () => {
        store.addToWatch(s.code, s.name);
        syncWatchList();
      },
    }, [s.name, h('small', {}, s.code)]));
  }
}

/* ── 数据刷新 ───────────────────────────────────────────────────────── */

function sortedFunds(funds) {
  const prefs = store.getPrefs();
  const list = [...funds];
  if (prefs.sort === 'change') {
    list.sort((a, b) => (b.estimate?.changePct ?? -Infinity) - (a.estimate?.changePct ?? -Infinity));
  } else if (prefs.sort === 'coverage') {
    list.sort((a, b) => (b.estimate?.coveragePct ?? -1) - (a.estimate?.coveragePct ?? -1));
  } else if (prefs.sort === 'name') {
    list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
  }
  // 'weight' = 用户添加顺序
  return list;
}

function paintBoard() {
  const watch = store.loadWatch();
  const order = new Map(watch.map((w, i) => [w.code, i]));
  if (store.getPrefs().sort === 'weight') {
    state.funds.sort((a, b) => (order.get(a.code) ?? 999) - (order.get(b.code) ?? 999));
  }
  const funds = sortedFunds(state.funds);

  const hasWatch = watch.length > 0;
  el.empty.hidden = hasWatch;
  $('#grid').style.display = hasWatch ? '' : 'none';

  const positions = store.loadPositions();
  const showPnl = Object.keys(positions).length > 0;
  $('#grid').classList.toggle('no-pnl', !showPnl);

  if (hasWatch) renderBoard(el.gridBody, funds, {
    selected: state.selected,
    showPnl,
    positions,
    onSelect: selectFund,
    onRemove: (code) => {
      store.removeFromWatch(code);
      if (state.selected === code) {
        state.selected = null;
        renderPlaceholder(el.detail);
        closeDrawer(el.detail);
      }
      syncWatchList();
    },
    onToggleStar: (code) => {
      if (store.inWatch(code)) {
        store.removeFromWatch(code);
        if (state.selected === code) {
          state.selected = null;
          renderPlaceholder(el.detail);
          closeDrawer(el.detail);
        }
        toast('已移出自选');
        syncWatchList();
      } else {
        store.addToWatch(code, '');
        toast('已加入自选');
        syncWatchList();
      }
      picker?.refresh();
    },
  });

  setText(el.count, String(watch.length), null);
  renderFootSum(funds, positions, showPnl);
  paintPhaseHeaders();
}

/** 把服务端的盘前/盘中/盘后时间段写到表头，并高亮当前阶段。 */
function paintPhaseHeaders() {
  const phase = state.phase;
  if (!phase) return;
  const b = phase.bounds || {};
  // 服务端给的是北京时间，这里换算成用户本地时区再显示
  const mm = (v) => beijingMinutesToLocal(v);
  const win = {
    pre: `${mm(b.preStart)} – ${mm(b.openStart)}`,
    open: `${mm(b.openStart)} – ${mm(b.afterStart)}`,
    after: `${mm(b.afterStart)} – ${mm(b.afterEnd)}`,
  };
  for (const el2 of document.querySelectorAll('#grid thead th .th-sub')) {
    const k = el2.dataset.win;
    if (win[k]) setText(el2, win[k], null);
  }
  for (const th of document.querySelectorAll('#grid thead th.c-est')) {
    th.classList.toggle('is-live', th.dataset.col === phase.phase);
  }
}

/** 组合汇总：总市值 + 今日预估收益。 */
function renderFootSum(funds, positions, showPnl) {
  const box = $('#foot-sum');
  if (!box) return;
  clear(box);
  if (!showPnl) {
    box.hidden = true;
    return;
  }

  let totalAmount = 0;
  let totalToday = 0;
  let totalProfit = 0;
  let hasAmount = false;
  let hasProfit = false;
  let hasToday = false;

  for (const f of funds) {
    const pos = store.derivePosition(positions[f.code], f.estimate);
    if (!pos) continue;
    if (fmt.isNum(pos.amount)) { totalAmount += pos.amount; hasAmount = true; }
    if (fmt.isNum(pos.profit)) { totalProfit += pos.profit; hasProfit = true; }
    if (fmt.isNum(pos.todayPnl)) { totalToday += pos.todayPnl; hasToday = true; }
  }

  if (!hasAmount && !hasToday && !hasProfit) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  if (hasAmount) {
    box.appendChild(h('span', {}, ['总市值 ', h('b', {}, fmt.money(totalAmount))]));
  }
  if (hasProfit) {
    box.appendChild(h('span', { class: fmt.signClass(totalProfit) },
      ['持仓收益 ', h('b', {}, fmt.money(totalProfit, { sign: true }))]));
  }
  if (hasToday) {
    box.appendChild(h('span', { class: fmt.signClass(totalToday) },
      ['今日预估 ', h('b', {}, fmt.money(totalToday, { sign: true }))]));
  }
}

async function loadOverview() {
  try {
    const o = await api.overview();
    state.markets = o.markets;
    state.fx = o.fx;
    state.phase = o.phase || null;
    renderRibbon(o.indices, o.markets);
    paintPhaseHeaders();
    return o;
  } catch {
    return null;
  }
}

async function refresh({ silent = false, restart = false } = {}) {
  if (state.loading && !restart) return;
  const run = ++refreshRun;
  const watch = store.loadWatch();
  const codes = watch.map((w) => w.code);

  state.loading = true;
  el.refresh.classList.add('is-busy');
  if (!silent || !state.funds.some((f) => f.estimate)) {
    setText(el.foot, `正在加载估值… 0/${codes.length}`, null);
  }

  try {
    const prefs = store.getPrefs();
    const overviewPromise = loadOverview();
    const batches = [];
    for (let i = 0; i < codes.length; i += WATCH_BATCH_SIZE) {
      batches.push(codes.slice(i, i + WATCH_BATCH_SIZE));
    }

    const loaded = new Map(
      state.funds
        .filter((f) => f?.code && f.estimate)
        .map((f) => [f.code, f]),
    );
    const errors = [];
    let loadedCount = 0;

    for (const batch of batches) {
      let data;
      try {
        data = await api.watch(batch, { top: prefs.top, fx: prefs.fx });
      } catch (err) {
        data = {
          funds: [],
          errors: batch.map((code) => ({ code, message: err?.message || '加载失败' })),
          markets: null,
        };
      }
      if (run !== refreshRun) return;
      for (const fund of data.funds || []) loaded.set(fund.code, fund);
      errors.push(...(data.errors || []));
      if (data.markets) state.markets = data.markets;
      loadedCount += batch.length;

      // 始终按自选顺序合并；尚未完成的基金保留启动时的名称占位行。
      state.funds = watch.map((w) => loaded.get(w.code) || { code: w.code, name: w.name || w.code });
      paintBoard();
      setText(el.foot, `正在加载估值… ${Math.min(loadedCount, codes.length)}/${codes.length}`, null);
    }

    const overview = await overviewPromise;
    const data = { funds: [...loaded.values()], errors, markets: state.markets };
    if (overview?.markets) state.markets = overview.markets;

    // 名称回填：自选里存的名字为空时用接口结果补上。
    // 处于"预设回落"状态时不写盘——那时列表本来就没被收藏，
    // 一旦写盘就变成"收藏了 25 只"，回落语义就没了。
    if (!store.isUsingPresets()) {
      const nameByCode = new Map(data.funds.map((f) => [f.code, f.name]));
      // 请求期间用户仍可能继续增删自选。不能用请求开始时捕获的 watch
      // 回写名称，否则较慢的旧请求会把刚刚移除的基金重新写回列表。
      const currentWatch = store.loadWatch();
      let changed = false;
      const nextWatch = currentWatch.map((w) => {
        const n = nameByCode.get(w.code);
        if (n && w.name !== n) { changed = true; return { ...w, name: n }; }
        return w;
      });
      if (changed) store.saveWatch(nextWatch);
    }

    state.funds = watch.map((w) => loaded.get(w.code) || { code: w.code, name: w.name || w.code });
    state.error = data.errors?.length ? data.errors : null;
    state.lastUpdated = Date.now();
    paintBoard();

    // 详情同步刷新
    if (state.selected && data.funds.some((f) => f.code === state.selected)) {
      await loadDetail(state.selected, { silent: true });
    }

    const bits = [`更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`];
    bits.push(`${data.funds.length} 只基金`);
    if (state.error?.length) bits.push(`${state.error.length} 只失败`);
    setText(el.foot, bits.join(' · '), null);
  } catch (err) {
    setText(el.foot, `获取失败：${err.message}`, null);
    if (!silent) toast(`获取失败：${err.message}`);
  } finally {
    if (run === refreshRun) {
      state.loading = false;
      el.refresh.classList.remove('is-busy');
    }
  }
}

async function loadDetail(code, { silent = false } = {}) {
  const prefs = store.getPrefs();
  if (!silent) {
    clear(el.detail);
    el.detail.appendChild(h('div', { class: 'dt-placeholder' }, h('p', {}, '加载中…')));
  }
  try {
    const data = await api.fund(code, { top: prefs.top, fx: prefs.fx });
    if (state.selected !== code) return;
    state.detail = data;
    renderDetail(el.detail, data, {
      onClose: closeDetail,
      // 持仓保存后：详情卡片自己已更新，这里同步看板与页脚汇总
      onPositionChange: () => paintBoard(),
    });
    if (window.matchMedia('(max-width: 1020px)').matches) openDrawer(el.detail);
  } catch (err) {
    if (!silent) {
      clear(el.detail);
      el.detail.appendChild(h('div', { class: 'dt-placeholder' }, h('p', {}, err.message)));
    }
  }
}

function selectFund(code, { push = true } = {}) {
  state.selected = code;
  paintBoard();
  loadDetail(code);
  if (push && location.hash.slice(1) !== code) {
    history.replaceState(null, '', `#${code}`);
  }
}

function closeDetail() {
  state.selected = null;
  closeDrawer(el.detail);
  renderPlaceholder(el.detail);
  paintBoard();
  history.replaceState(null, '', location.pathname + location.search);
}

/**
 * 支持 #161125 这样的深链，便于分享和刷新后保持选中。
 * 注意：打开链接**不会**自动把基金塞进自选——分享出去的是"看这只基金"，
 * 而不是"替我改自选列表"。
 */
function applyHash() {
  const code = location.hash.slice(1).trim();
  if (/^\d{6}$/.test(code)) {
    state.selected = code;
    paintBoard();
    loadDetail(code);
  } else if (state.selected) {
    state.selected = null;
    renderPlaceholder(el.detail);
    paintBoard();
  }
}

/* ── 自选变更 ───────────────────────────────────────────────────────── */

function syncWatchList() {
  const watch = store.loadWatch();
  if (!watch.length) {
    clearBoard(el.gridBody);
    state.funds = [];
    renderEmptyChips();
    paintBoard();
    setText(el.foot, '—', null);
    // 没有自选时也要拉指数，否则顶部行情条会是空的
    loadOverview();
    return;
  }
  // 基金名称与代码无需等待网络：先把完整名单画出来，再渐进填充数据。
  const previous = new Map(state.funds.map((f) => [f.code, f]));
  state.funds = watch.map((w) => previous.get(w.code) || { code: w.code, name: w.name || w.code });
  paintBoard();
  refresh({ silent: true, restart: true });
}

/* ── 定时刷新 ───────────────────────────────────────────────────────── */

function startTimer() {
  stopTimer();
  const secs = store.getPrefs().interval;
  if (!secs) return;
  state.timer = setInterval(() => {
    if (document.hidden) return;
    refresh({ silent: true });
  }, secs * 1000);
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/* ── 导出 ───────────────────────────────────────────────────────────── */

function exportCsv() {
  const funds = sortedFunds(state.funds);
  if (!funds.length) return toast('没有可导出的数据');
  const head = [
    '基金代码', '基金名称', '最新净值', '净值日期', '估算涨跌%', '估算净值',
    '股票仓位%', '已知重仓%', '覆盖度%', '价格贡献pt', '汇率贡献pt',
    '状态', '置信度', '持仓报告期',
  ];
  const lines = [head.join(',')];
  for (const f of funds) {
    const e = f.estimate || {};
    lines.push([
      f.code, `"${String(f.name).replace(/"/g, '""')}"`,
      f.nav?.value ?? '', f.nav?.date ?? '',
      fmt.isNum(e.changePct) ? e.changePct.toFixed(4) : '',
      fmt.isNum(e.nav) ? e.nav.toFixed(4) : '',
      e.equityPct ?? '', fmt.isNum(e.heldWeightPct) ? e.heldWeightPct.toFixed(2) : '',
      fmt.isNum(e.coveragePct) ? e.coveragePct.toFixed(1) : '',
      fmt.isNum(e.priceContributionPct) ? e.priceContributionPct.toFixed(4) : '',
      fmt.isNum(e.fxContributionPct) ? e.fxContributionPct.toFixed(4) : '',
      e.state ?? '', e.confidence ?? '', f.reportDate ?? '',
    ].join(','));
  }
  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `qdii-估值-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出 CSV');
}

/* ── 快捷键 ─────────────────────────────────────────────────────────── */

function bindKeys(search) {
  document.addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

    if (ev.key === '/' && !typing) {
      ev.preventDefault();
      search.focus();
      return;
    }
    if (typing) return;

    if (ev.key === 'r' || ev.key === 'R') {
      ev.preventDefault();
      refresh();
    } else if (ev.key === 'Escape') {
      if (state.selected) closeDetail();
    } else if (ev.key === 'j' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveSelection(1);
    } else if (ev.key === 'k' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveSelection(-1);
    } else if (ev.key === 'Enter' && !state.selected && state.funds.length) {
      selectFund(sortedFunds(state.funds)[0].code);
    }
  });
}

function moveSelection(delta) {
  const funds = sortedFunds(state.funds);
  if (!funds.length) return;
  const i = funds.findIndex((f) => f.code === state.selected);
  const next = i < 0 ? (delta > 0 ? 0 : funds.length - 1) : Math.min(Math.max(i + delta, 0), funds.length - 1);
  selectFund(funds[next].code);
  const row = el.gridBody.querySelector(`tr[data-code="${funds[next].code}"]`);
  row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ── 启动 ───────────────────────────────────────────────────────────── */

function bindControls() {
  el.refresh.addEventListener('click', () => refresh());

  $('#btn-theme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  const about = $('#about');
  $('#btn-about').addEventListener('click', () => { about.hidden = false; });
  $('#about-close').addEventListener('click', () => { about.hidden = true; });
  about.addEventListener('click', (ev) => { if (ev.target === about) about.hidden = true; });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !about.hidden) about.hidden = true;
  });

  const fxToggle = $('#toggle-fx');
  fxToggle.addEventListener('change', () => {
    store.setPref('fx', fxToggle.checked);
    refresh({ silent: true });
    if (state.selected) loadDetail(state.selected, { silent: true });
  });

  const intervalSel = $('#interval-select');
  intervalSel.addEventListener('change', () => {
    store.setPref('interval', Number(intervalSel.value));
    startTimer();
    toast(Number(intervalSel.value) ? `每 ${intervalSel.value} 秒自动刷新` : '已关闭自动刷新');
  });

  $('#sort-seg').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-sort]');
    if (!btn) return;
    store.setPref('sort', btn.dataset.sort);
    for (const b of $('#sort-seg').children) b.classList.toggle('is-on', b === btn);
    paintBoard();
  });

  $('#btn-export').addEventListener('click', exportCsv);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh({ silent: true });
  });
}

function init() {
  const prefs = store.getPrefs();
  document.documentElement.dataset.theme = prefs.theme || 'light';
  const fxToggle = $('#toggle-fx');
  fxToggle.checked = prefs.fx !== false;
  $('#interval-select').value = String(prefs.interval ?? 30);
  for (const b of $('#sort-seg').children) b.classList.toggle('is-on', b.dataset.sort === prefs.sort);

  renderEmptyChips();

  const search = createSearch({
    onAdd: (msg) => {
      toast(msg);
      syncWatchList();
    },
  });

  picker = createPicker({
    onChanged: () => syncWatchList(),
  });
  $('#btn-picker').addEventListener('click', () => picker.open());

  bindControls();
  bindKeys(search);

  renderPlaceholder(el.detail);
  startClock();
  syncWatchList();
  startTimer();
  applyHash();
  window.addEventListener('hashchange', applyHash);

  // 指数条独立走一个更快的节奏（10 秒），不受基金刷新间隔影响
  setInterval(() => {
    if (document.hidden) return;
    loadOverview();
  }, 10000);
}

init();
