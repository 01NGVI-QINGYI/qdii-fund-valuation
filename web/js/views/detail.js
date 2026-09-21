/** 基金详情面板。 */

import { h, s, clear, setText, setClass, toast } from '../dom.js';
import { lineChart } from '../chart.js';
import * as fmt from '../format.js';
import { getPosition, setPosition, removePosition, derivePosition } from '../store.js';

let built = null; // { code, refs }

const STATUS_TEXT = {
  fresh: '已交易',
  pending: '未开盘',
  suspended: '停牌',
  missing: '无行情',
};

function hhmm(ms) {
  const d = new Date(ms);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/* ── 我的持仓 ───────────────────────────────────────────────────────── */

function buildPositionCard(refs, code, onSaved) {
  const numInput = (id, placeholder) => h('input', {
    id, type: 'number', inputmode: 'decimal', step: '0.01',
    placeholder, autocomplete: 'off',
  });

  const amountIn = numInput('pos-amount', '如 50000');
  const profitIn = numInput('pos-profit', '如 1250.5');
  const rateIn = numInput('pos-rate', '可留空');

  const savedNote = h('span', { class: 'pos-saved' }, '');
  const saveBtn = h('button', { class: 'btn btn-primary' }, '保存');
  const clearBtn = h('button', { class: 'btn btn-ghost' }, '清除');

  const field = (label, unit, input, hint) => h('div', { class: 'pos-field', title: hint || null }, [
    h('label', { for: input.id }, [label, unit ? h('span', { class: 'unit' }, ` (${unit})`) : null]),
    input,
  ]);

  const sumAmount = h('dd', {}, '—');
  const sumProfit = h('dd', {}, '—');
  const sumToday = h('dd', {}, '—');
  const sumBox = h('dl', { class: 'pos-sum', hidden: true }, [
    h('div', {}, [h('dt', {}, '持仓金额'), sumAmount]),
    h('div', {}, [h('dt', {}, '持仓收益'), sumProfit]),
    h('div', {}, [h('dt', {}, '今日预估收益'), sumToday]),
  ]);

  const readInputs = () => ({
    amount: amountIn.value.trim() === '' ? null : Number(amountIn.value),
    profit: profitIn.value.trim() === '' ? null : Number(profitIn.value),
    rate: rateIn.value.trim() === '' ? null : Number(rateIn.value),
  });

  const dirty = () => { saveBtn.disabled = false; };

  const onSave = () => {
    const v = readInputs();
    for (const [k, val] of Object.entries(v)) {
      if (val !== null && !Number.isFinite(val)) {
        toast(k === 'amount' ? '持仓金额不是合法数字' : k === 'profit' ? '持仓收益不是合法数字' : '持仓收益率不是合法数字');
        return;
      }
    }
    const saved = setPosition(code, v);
    saveBtn.disabled = true;
    toast(saved ? '持仓已保存' : '持仓已清除');
    // 就地刷新汇总，不必等下一次轮询
    if (refs.pos._fund) updatePositionCard(refs, refs.pos._fund, refs.pos._estimate);
    onSaved?.();
  };

  saveBtn.addEventListener('click', onSave);
  clearBtn.addEventListener('click', () => {
    removePosition(code);
    amountIn.value = '';
    profitIn.value = '';
    rateIn.value = '';
    saveBtn.disabled = true;
    toast('持仓已清除');
    if (refs.pos._fund) updatePositionCard(refs, refs.pos._fund, refs.pos._estimate);
    onSaved?.();
  });
  for (const el of [amountIn, profitIn, rateIn]) {
    el.addEventListener('input', dirty);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); onSave(); }
    });
  }

  const card = h('div', { class: 'pos-card' }, [
    h('div', { class: 'pos-head' }, [
      h('h3', {}, '我的持仓'),
      savedNote,
    ]),
    h('div', { class: 'pos-body' }, [
      h('div', { class: 'pos-grid' }, [
        field('持仓金额', '元', amountIn),
        field('持仓收益', '元', profitIn),
        field('持仓收益率', '%', rateIn, '留空时按「收益 ÷ 成本」自动推算'),
      ]),
      h('div', { class: 'pos-actions' }, [saveBtn, clearBtn]),
    ]),
    h('div', { class: 'pos-foot' }, '收益率留空时按「收益 ÷ 成本」自动推算'),
    sumBox,
  ]);

  refs.pos = { amountIn, profitIn, rateIn, saveBtn, savedNote, sumBox, sumAmount, sumProfit, sumToday };
  return card;
}
function updatePositionCard(refs, fund, estimate) {
  const p = refs.pos;
  if (!p) return;
  // 记下最近一次渲染用的入参，保存后可以就地重算汇总
  p._fund = fund;
  p._estimate = estimate;

  const stored = getPosition(fund.code);
  // 只在用户没在输入时回填，避免刷新打断输入
  const active = document.activeElement;
  const inputs = [p.amountIn, p.profitIn, p.rateIn];
  if (!inputs.includes(active)) {
    p.amountIn.value = stored?.amount ?? '';
    p.profitIn.value = stored?.profit ?? '';
    p.rateIn.value = stored?.rate ?? '';
    p.saveBtn.disabled = true;
  }

  const pos = derivePosition(stored, estimate);

  if (!pos) {
    setText(p.savedNote, '未录入', null);
    p.sumBox.hidden = true;
    return;
  }

  p.sumBox.hidden = false;

  const money = (el, v, tone) => {
    clear(el);
    if (!fmt.isNum(v)) { el.appendChild(document.createTextNode('—')); return; }
    el.appendChild(h('span', { class: tone || '' }, fmt.money(v, { sign: !!tone })));
  };

  money(p.sumAmount, pos.amount, null);

  const profitTone = fmt.isNum(pos.profit) ? fmt.signClass(pos.profit) : '';
  clear(p.sumProfit);
  if (fmt.isNum(pos.profit)) {
    p.sumProfit.appendChild(h('span', { class: profitTone }, fmt.money(pos.profit, { sign: true })));
    if (fmt.isNum(pos.rate)) {
      p.sumProfit.appendChild(h('small', { class: profitTone },
        `${pos.rate > 0 ? '+' : ''}${pos.rate.toFixed(2)}%${pos.rateSource === 'derived' ? ' 推算' : ''}`));
    }
  } else {
    p.sumProfit.appendChild(document.createTextNode('—'));
  }

  money(p.sumToday, pos.todayPnl, fmt.isNum(pos.todayPnl) ? fmt.signClass(pos.todayPnl) : null);

  const bits = [];
  if (stored?.updatedAt) bits.push(`保存于 ${fmt.relTime(new Date(stored.updatedAt).toISOString())}`);
  if (Number.isFinite(pos.amount) && !fmt.isNum(estimate?.changePct)) bits.push('无估值，无法预估今日');
  setText(p.savedNote, bits.join(' · ') || '已保存', null);
}

/* ── 构建 ───────────────────────────────────────────────────────────── */

function build(root, fund, handlers) {
  clear(root);
  // 持仓卡片的输入框引用要挂在这里，返回时并入 refs
  const refs = { pos: null };

  /* 头部 */
  const mkBadges = h('span', { class: 'dt-meta-badges' });
  const dtMeta = h('div', { class: 'dt-meta' });
  const head = h('div', { class: 'dt-head' }, [
    h('div', { class: 'dt-title-row' }, [
      h('h2', { class: 'dt-name' }, fund.name || fund.code),
      h('button', {
        class: 'icon-btn dt-close', title: '关闭', 'aria-label': '关闭详情',
        onclick: () => handlers.onClose(),
      }, s('svg', { viewBox: '0 0 16 16' }, [s('path', { d: 'M4 4l8 8M12 4l-8 8' })])),
    ]),
    dtMeta,
  ]);

  /* 主数值 */
  const heroLabel = h('div', { class: 'hero-label' }, '盘中估算涨跌');
  const heroSign = h('span', { class: 'pct-sign' });
  const heroVal = h('span', { class: 'pct-val' }, '—');
  const heroUnit = h('span', { class: 'pct-unit' }, '%');
  const heroNum = h('div', { class: 'hero-val num' }, [heroSign, heroVal, heroUnit]);
  const heroSub = h('div', { class: 'hero-sub' });
  const heroLeft = h('div', {}, [heroLabel, heroNum, heroSub]);

  const gTrack = s('circle', { class: 'g-track', cx: 38, cy: 38, r: 31 });
  const gFill = s('circle', {
    class: 'g-fill', cx: 38, cy: 38, r: 31,
    'stroke-dasharray': 2 * Math.PI * 31,
    'stroke-dashoffset': 2 * Math.PI * 31,
    stroke: 'var(--accent)',
  });
  const gVal = h('b', {}, '—');
  const gCap = h('span', {}, '覆盖度');
  const gauge = h('div', { class: 'gauge' }, [
    s('svg', { viewBox: '0 0 76 76' }, [gTrack, gFill]),
    h('div', { class: 'gauge-txt' }, [gVal, gCap]),
  ]);
  const hero = h('div', { class: 'hero' }, [heroLeft, gauge]);

  /* 指标 */
  const factVals = {};
  const factDefs = [
    ['equity', '股票仓位'],
    ['held', '已知重仓'],
    ['fresh', '已交易权重'],
    ['report', '持仓报告期'],
  ];
  const facts = h('dl', { class: 'facts' },
    factDefs.map(([k, label]) => {
      const dd = h('dd', {}, '—');
      factVals[k] = dd;
      return h('div', { class: 'fact' }, [h('dt', {}, label), dd]);
    }));

  /* 图表 */
  const intradayBox = h('div', { class: 'chart-body' });
  const intradayNote = h('span', { class: 'chart-note' }, '');
  const intradayCard = h('div', { class: 'chart-card' }, [
    h('div', { class: 'chart-head' }, [
      h('h3', { class: 'chart-title' }, '今日估算走势'),
      intradayNote,
    ]),
    intradayBox,
  ]);

  const navBox = h('div', { class: 'chart-body' });
  const navNote = h('span', { class: 'chart-note' }, '');
  const navCard = h('div', { class: 'chart-card' }, [
    h('div', { class: 'chart-head' }, [
      h('h3', { class: 'chart-title' }, '净值走势'),
      navNote,
    ]),
    navBox,
  ]);

  /* 持仓 */
  const holdBody = h('tbody');
  const holdSrc = h('span', { class: 'src' }, '');
  const holdCard = h('div', { class: 'hold-card' }, [
    h('div', { class: 'hold-head' }, [h('h3', {}, '前十大重仓穿透'), holdSrc]),
    h('table', { class: 'hold-table' }, [
      // 固定列宽：面板只有 ~420px，不给 colgroup 的话「贡献」列会被挤出容器
      h('colgroup', {}, [
        h('col', { class: 'col-name' }),
        h('col', { class: 'col-w' }),
        h('col', { class: 'col-price' }),
        h('col', { class: 'col-chg' }),
        h('col', { class: 'col-contrib' }),
      ]),
      h('thead', {}, h('tr', {}, [
        h('th', { class: 't-name' }, '标的'),
        h('th', {}, '权重'),
        h('th', {}, '现价'),
        h('th', {}, '涨跌'),
        h('th', {}, '贡献'),
      ])),
      holdBody,
    ]),
  ]);

  /* 汇率 */
  const fxStrip = h('div', { class: 'fx-strip' });

  /* 提示 */
  const issuesBox = h('div', { class: 'issues' });

  const foot = h('div', { class: 'dt-foot' });

  const posCard = buildPositionCard(refs, fund.code, handlers.onPositionChange);

  // 两张走势图左右并排，省掉一整屏高度
  const chartRow = h('div', { class: 'chart-row' }, [intradayCard, navCard]);

  root.append(head, hero, facts, posCard, issuesBox, chartRow, fxStrip, holdCard, foot);

  return {
    code: fund.code,
    refs: {
      mkBadges, dtMeta, heroSign, heroVal, heroNum, heroSub, gFill, gVal, gCap,
      factVals, intradayBox, intradayNote, navBox, navNote,
      holdBody, holdSrc, fxStrip, issuesBox, foot, holdCard,
      pos: refs.pos,
    },
    CIRC: 2 * Math.PI * 31,
  };
}

/* ── 更新 ───────────────────────────────────────────────────────────── */

function updateCharts(refs, payload) {
  const { fund, intraday } = payload;

  /* 今日估算走势（本机采样） */
  const pts = (intraday?.points || []).map((p) => ({
    label: hhmm(p.t),
    value: p.pct,
    nav: p.nav,
  }));

  clear(refs.intradayBox);
  // 并排布局下宽度随面板变化，用容器实测宽度当 viewBox，避免被缩放变形
  const cw = Math.max(220, Math.round(refs.intradayBox.clientWidth || 286));
  if (pts.length >= 2) {
    const { svg } = lineChart({
      points: pts,
      width: cw, height: 96, zeroBased: true,
      // 这是百分比曲线，轴上和悬停值都要带 %
      yFormat: (v) => `${v.toFixed(1)}%`,
      xFormat: (p) => p.label,
      animate: refs.intradaySig !== pts.length,
    });
    refs.intradayBox.appendChild(svg);
    setText(refs.intradayNote, `${pts.length} 点`, null);
  } else {
    refs.intradayBox.appendChild(
      h('div', { class: 'chart-empty' },
        '正在采样，曲线由本机逐分钟记录'),
    );
    setText(refs.intradayNote, '采样中', null);
  }
  refs.intradaySig = pts.length;

  /* 净值走势（最近 90 个交易日） */
  const hist = (fund.navHistory || []).slice(-90);
  clear(refs.navBox);
  const nw = Math.max(220, Math.round(refs.navBox.clientWidth || 286));
  if (hist.length >= 2) {
    const { svg } = lineChart({
      points: hist.map((p) => ({ label: fmt.shortDate(p.date), value: p.nav })),
      width: nw, height: 96, zeroBased: false,
      yFormat: (v) => v.toFixed(2),
      xFormat: (p) => p.label,
      animate: refs.navSig !== fund.code,
    });
    refs.navBox.appendChild(svg);
    setText(refs.navNote, `${hist.length} 日`, null);
  } else {
    refs.navBox.appendChild(h('div', { class: 'chart-empty' }, '暂无净值历史'));
  }
  refs.navSig = fund.code;
}

function updateHoldings(refs, fund) {
  const rows = fund.holdings || [];
  clear(refs.holdBody);

  if (!rows.length) {
    refs.holdBody.appendChild(
      h('tr', {}, h('td', { colspan: 5, style: { textAlign: 'center', color: 'var(--faint)', padding: '16px', fontFamily: 'var(--font)' } },
        '暂无股票持仓明细')),
    );
    setText(refs.holdSrc, '', null);
    return;
  }

  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.contributionPct || 0)), 0.001);

  for (const r of rows) {
    const tone = fmt.signClass(r.changePct);
    const cAbs = Math.abs(r.contributionPct || 0);
    const barW = Math.max(1, (cAbs / maxAbs) * 14);
    const bar = h('div', { class: 'contrib-bar' });
    if (cAbs > 0.0005) {
      bar.appendChild(h('i', {
        class: (r.contributionPct || 0) >= 0 ? 'pos' : 'neg',
        style: { width: `${barW}px` },
      }));
    }

    const nameCell = h('td', {}, [
      h('div', { class: 'h-name' }, [
        h('span', { class: `h-mkt m-${r.market}` }, fmt.marketLabel(r.market)),
        h('span', { class: 'h-title' }, r.name),
        h('span', { class: `h-st ${r.status}`, title: STATUS_TEXT[r.status] || '' }),
      ]),
      h('span', { class: 'h-code' }, r.code),
    ]);

    refs.holdBody.appendChild(h('tr', {
      class: r.status !== 'fresh' ? 'is-pending' : '',
      title: r.quoteAt ? `${STATUS_TEXT[r.status]} · 行情 ${r.quoteAt}${r.provider ? ` · ${r.provider}` : ''}` : STATUS_TEXT[r.status],
    }, [
      nameCell,
      h('td', {}, `${r.weight.toFixed(2)}%`),
      h('td', {}, r.price === null ? '—' : r.price.toFixed(2)),
      h('td', { class: tone }, fmt.pct(r.changePct)),
      h('td', { class: 'c-contrib' }, h('div', { class: 'contrib' }, [
        h('span', { class: tone },
          r.contributionPct ? `${r.contributionPct > 0 ? '+' : '-'}${cAbs.toFixed(3)}%` : '0.000%'),
        bar,
      ])),
    ]));
  }

  const bits = [];
  if (fund.period) bits.push(fund.period);
  if (fund.reportDate) bits.push(`截止 ${fund.reportDate}`);
  setText(refs.holdSrc, bits.join(' · '), null);
}

function updateFx(refs, payload) {
  const { fund, fx, markets } = payload;
  clear(refs.fxStrip);
  const e = fund.estimate;
  const includeFx = e?.includeFx !== false;

  const fxItem = (code, label) => {
    const f = fx?.[code];
    if (!f || !fmt.isNum(f.price)) return null;
    const tone = fmt.signClass(f.changePct);
    return h('span', { class: 'fx-item' }, [
      h('span', { class: 'faint' }, label),
      h('b', {}, f.price.toFixed(4)),
      h('span', { class: tone }, fmt.pct(f.changePct)),
    ]);
  };

  // 用货币代码比"美元/人民币"短一半，一行放得下
  const items = [fxItem('USD', 'USD/CNY'), fxItem('HKD', 'HKD/CNY'), fxItem('JPY', 'JPY/CNY')].filter(Boolean);
  for (const it of items) refs.fxStrip.appendChild(it);

  if (items.length) refs.fxStrip.appendChild(h('span', { class: 'sep', style: { color: 'var(--line-strong)' } }, '/'));

  if (!includeFx) {
    refs.fxStrip.appendChild(h('em', { class: 'fx-off' }, '汇率影响未计入'));
  } else if (e && fmt.isNum(e.fxContributionPct)) {
    const tone = fmt.signClass(e.fxContributionPct);
    refs.fxStrip.appendChild(h('span', { class: 'fx-item' }, [
      h('span', { class: 'faint' }, '汇率贡献'),
      h('span', { class: tone }, `${e.fxContributionPct > 0 ? '+' : '-'}${Math.abs(e.fxContributionPct).toFixed(3)}%`),
    ]));
  }

  if (markets) {
    const pending = e?.pending || [];
    if (pending.length) {
      // 市场开着却没算进去，说明这一场已经含在最新净值里了；
      // 市场关着才是真的"还没开盘"。两者说法不能混。
      const open = pending.filter((p) => markets[p.group]?.open).map((p) => fmt.groupLabel(p.group));
      const closed = pending.filter((p) => !markets[p.group]?.open).map((p) => fmt.groupLabel(p.group));
      const parts = [];
      if (open.length) parts.push(`${open.join('、')} 已含在最新净值内`);
      if (closed.length) parts.push(`${closed.join('、')} 尚未开盘`);
      refs.fxStrip.appendChild(h('span', { class: 'fx-note' },
        `${parts.join('；')}，暂不计入`));
    }
  }
}

function updateIssues(refs, fund) {
  clear(refs.issuesBox);
  for (const issue of fund.issues || []) {
    if (issue.level === 'info' && /联接基金/.test(issue.message)) {
      // 联接基金的口径说明放到页脚，避免面板顶部噪音
      continue;
    }
    refs.issuesBox.appendChild(h('div', { class: `issue issue-${issue.level}` }, issue.message));
  }
}

function updateFoot(refs, fund) {
  clear(refs.foot);
  const bits = [];
  if (fund.managers?.length) bits.push(`基金经理 ${fund.managers.map((m) => m.name).join('、')}`);
  if (fund.estimate?.equityBasis === 'feeder') bits.push('股票敞口按非现金资产还原');
  refs.foot.appendChild(h('div', {}, bits.join(' · ')));
  refs.foot.appendChild(h('div', {},
    `数据：天天基金（档案 / 持仓）、腾讯财经（行情）、新浪财经（汇率）。估值由本地计算，仅供参考，不构成投资建议。`));
}

/* ── 对外 ───────────────────────────────────────────────────────────── */

export function renderPlaceholder(root) {
  built = null;
  clear(root);
  root.appendChild(h('div', { class: 'dt-placeholder' }, [
    s('svg', { viewBox: '0 0 40 40' }, [
      s('path', { d: 'M5 30l9-10 7 5.5L35 12' }),
      s('circle', { cx: 35, cy: 12, r: 3 }),
    ]),
    h('p', {}, '选择左侧任意基金查看持仓穿透'),
  ]));
}

export function renderDetail(root, payload, handlers) {
  const fund = payload.fund;
  if (!fund) {
    clear(root);
    root.appendChild(h('div', { class: 'dt-placeholder' }, h('p', {}, payload.error || '加载失败')));
    built = null;
    return;
  }

  if (!built || built.code !== fund.code) {
    built = build(root, fund, handlers);
  }
  const refs = built.refs;
  const e = fund.estimate;

  /* 头部 */
  clear(refs.dtMeta);
  const metaParts = [h('span', { class: 'num', style: { color: 'var(--accent-ink)' } }, fund.code)];
  if (fund.managers?.length) metaParts.push(h('span', {}, `基金经理 ${fund.managers.map((m) => m.name).join('、')}`));
  if (fund.holdings?.length) metaParts.push(h('span', {}, `穿透 ${fund.holdings.length} 只重仓`));
  metaParts.forEach((el, i) => {
    if (i) refs.dtMeta.appendChild(h('span', { class: 'sep' }, '/'));
    refs.dtMeta.appendChild(el);
  });
  refs.dtMeta.appendChild(refs.mkBadges);

  clear(refs.mkBadges);
  if (fund.reportStale) {
    refs.mkBadges.appendChild(h('span', { class: 'flag flag-warn' }, `持仓报告 ${fmt.reportAge(fund.reportAgeDays)}`));
  }

  /* 主数值 */
  const tone = e ? fmt.signClass(e.changePct) : 'flat';
  if (e) {
    setClass(refs.heroNum, 'up', tone === 'up');
    setClass(refs.heroNum, 'down', tone === 'down');
    setClass(refs.heroNum, 'flat', tone === 'flat');
    setText(refs.heroVal, Math.abs(e.changePct).toFixed(2), built.lastTone === undefined ? null : tone);
    setText(refs.heroSign, e.changePct > 0 ? '+' : e.changePct < 0 ? '-' : '', null);
    built.lastTone = tone;
  } else {
    setText(refs.heroVal, '—', null);
    setText(refs.heroSign, '', null);
  }

  /* 副信息 */
  clear(refs.heroSub);
  if (e) {
    refs.heroSub.append(
      h('span', {}, ['估算净值 ', h('b', {}, fmt.nav(e.nav))]),
      h('span', { class: 'sep' }, '·'),
      h('span', {}, ['最新净值 ', h('b', {}, fmt.nav(fund.nav.value)), ` (${fund.nav.date || '—'})`]),
      h('span', { class: 'sep' }, '·'),
      h('span', {}, fmt.stateText(e.state)),
    );
    if (e.state === 'settled') {
      refs.heroSub.appendChild(h('span', { class: 'flag flag-muted' }, '无待估空间'));
    }
  } else {
    refs.heroSub.appendChild(h('span', { class: 'faint' }, '该基金无股票持仓明细，无法穿透估值'));
  }

  /* 环形：覆盖度 */
  const cov = Math.max(0, Math.min(100, e?.coveragePct ?? 0));
  refs.gFill.setAttribute('stroke-dashoffset', String(built.CIRC * (1 - cov / 100)));
  refs.gFill.setAttribute('stroke', cov >= 85 ? 'var(--accent)' : cov > 0 ? 'var(--warn)' : 'var(--line-strong)');
  setText(refs.gVal, `${Math.round(cov)}%`, null);
  setText(refs.gCap, e ? `覆盖 ${fmt.confidenceLabel(e.confidence).text}` : '覆盖度', null);

  /* 指标 */
  const setFact = (k, main, sub) => {
    const dd = refs.factVals[k];
    clear(dd);
    dd.appendChild(document.createTextNode(main));
    if (sub) dd.appendChild(h('small', {}, sub));
  };
  if (e) {
    setFact('equity', fmt.pctPlain(e.equityPct, 2), e.equityBasis === 'feeder' ? '还原' : '');
    setFact('held', fmt.pctPlain(e.heldWeightPct, 2));
    setFact('fresh', fmt.pctPlain(e.freshWeightPct, 2));
    setFact('report', fund.reportDate ? fmt.shortDate(fund.reportDate) : '—', fund.period ? fund.period.replace('股票投资明细', '') : '');
  } else {
    for (const k of Object.keys(refs.factVals)) setFact(k, '—');
  }

  updateIssues(refs, fund);
  updatePositionCard(refs, fund, e);
  updateCharts(refs, payload);
  updateFx(refs, payload);
  updateHoldings(refs, fund);
  updateFoot(refs, fund);
}

export function openDrawer(root) {
  root.classList.add('is-open');
}
export function closeDrawer(root) {
  root.classList.remove('is-open');
}
