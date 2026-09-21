/**
 * 手写 SVG 图表。
 * 不引图表库：需要的只是折线 + 面积 + 零轴，自己画能完全控制
 * 线宽、留白和入场动画，也不会带进来一堆用不上的样式。
 */

import { s, clear } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';

/** 单调三次插值的平滑路径（比 Catmull-Rom 更不容易过冲）。 */
function smoothPath(pts) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0][0]},${pts[0][1]}L${pts[1][0]},${pts[1][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const t = 0.2;
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    const c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

function niceTicks(min, max, count = 3) {
  if (min === max) return [min];
  const span = max - min;
  const step = span / (count - 1);
  return Array.from({ length: count }, (_, i) => min + step * i);
}

/**
 * 折线图。
 * @param {object} opts
 * @param {{label:string, value:number}[]} opts.points
 * @param {number} opts.width   viewBox 宽
 * @param {number} opts.height  viewBox 高
 * @param {boolean} opts.zeroBased 以 0 为基准着色（涨跌幅曲线用）
 * @param {(v:number)=>string} opts.yFormat
 * @param {(p:object)=>string} opts.xFormat
 * @param {boolean} opts.showAxis
 */
export function lineChart(opts) {
  const {
    points,
    width = 380,
    height = 112,
    zeroBased = false,
    yFormat = (v) => v.toFixed(2),
    xFormat = (p) => p.label,
    showAxis = true,
    animate = true,
  } = opts;

  const padR = 4;
  const padT = 8;
  const padB = showAxis ? 15 : 2;

  const svg = s('svg', {
    class: 'chart-svg',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
  });

  if (!points || points.length < 2) {
    svg.appendChild(
      s('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'lbl' }, '数据不足'),
    );
    return { svg, update: () => {} };
  }

  const values = points.map((p) => p.value);
  const dataLo = Math.min(...values);
  const dataHi = Math.max(...values);
  const dataRange = dataHi - dataLo;

  /*
   * 是否以 0 为基准。
   * 涨跌幅曲线通常该以 0 为基准，但当整段数据都在 0 的一侧且离 0 很远时
   * （例如全天都在 +2.5% 附近微动），以 0 为基准会把曲线压成贴着边缘的
   * 一条直线加一大块填充，什么都看不出来。这时改用数据自身的范围，
   * 让"形状"可见——分时图的意义本来就在于看形状。
   */
  const useZero =
    zeroBased &&
    (dataRange === 0 || (dataLo - dataRange * 0.2 <= 0 && dataHi + dataRange * 0.2 >= 0));

  let lo = dataLo;
  let hi = dataHi;
  if (useZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (lo === hi) {
    lo -= 0.5;
    hi += 0.5;
  }
  const pad = (hi - lo) * 0.14;
  lo -= pad;
  hi += pad;

  // 左侧留白按实际标签宽度算：加了 "%" 之后固定 34px 会截断 "-1.27%"
  const ticks = niceTicks(lo, hi, 3);
  const labelW = showAxis
    ? Math.max(...ticks.map((t) => yFormat(t).length), useZero ? 1 : 0) * 5.2
    : 0;
  const padL = showAxis ? Math.max(26, Math.min(58, Math.ceil(labelW) + 9)) : 2;

  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const X = (i) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const Y = (v) => padT + innerH - ((v - lo) / (hi - lo)) * innerH;

  const last = values.at(-1);
  const tone = last > 0 ? 'up' : last < 0 ? 'down' : 'flat';
  const stroke = tone === 'up' ? 'var(--up)' : tone === 'down' ? 'var(--down)' : 'var(--accent)';

  /* ── 网格与坐标轴 ── */
  if (showAxis) {
    for (const t of ticks) {
      const y = Y(t);
      const isZero = useZero && Math.abs(t) < 1e-9;
      if (isZero) continue;
      svg.appendChild(s('line', { x1: padL, y1: y, x2: width - padR, y2: y, class: 'gridline' }));
      svg.appendChild(
        s('text', { x: padL - 5, y: y + 2.8, 'text-anchor': 'end', class: 'lbl' }, yFormat(t)),
      );
    }
    if (useZero && 0 >= lo && 0 <= hi) {
      const zeroY = Y(0);
      svg.appendChild(
        s('line', { x1: padL, y1: zeroY, x2: width - padR, y2: zeroY, class: 'axis' }),
      );
      svg.appendChild(
        s('text', { x: padL - 5, y: zeroY + 2.8, 'text-anchor': 'end', class: 'lbl' }, '0'),
      );
    }
    // x 轴首尾标签
    svg.appendChild(
      s('text', { x: padL, y: height - 3, 'text-anchor': 'start', class: 'lbl' }, xFormat(points[0])),
    );
    svg.appendChild(
      s(
        'text',
        { x: width - padR, y: height - 3, 'text-anchor': 'end', class: 'lbl' },
        xFormat(points.at(-1)),
      ),
    );
  }

  const coords = points.map((p, i) => [X(i), Y(p.value)]);
  const d = smoothPath(coords);

  /* ── 渐变填充 ── */
  const gid = `g${Math.random().toString(36).slice(2, 9)}`;
  const defs = s('defs');
  const grad = s('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.appendChild(s('stop', { offset: '0%', 'stop-color': stroke, 'stop-opacity': '0.30' }));
  grad.appendChild(s('stop', { offset: '100%', 'stop-color': stroke, 'stop-opacity': '0' }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  const baseY = useZero && 0 >= lo && 0 <= hi ? Y(0) : padT + innerH;
  const areaPath = `${d}L${coords.at(-1)[0].toFixed(2)},${baseY.toFixed(2)}L${coords[0][0].toFixed(2)},${baseY.toFixed(2)}Z`;
  svg.appendChild(s('path', { d: areaPath, fill: `url(#${gid})`, stroke: 'none', class: 'area' }));

  /* ── 折线 ── */
  const line = s('path', { d, class: 'series', stroke });
  if (animate) {
    const approxLen = innerW * 1.6;
    line.setAttribute('style', `--len:${approxLen};stroke-dasharray:${approxLen};stroke-dashoffset:${approxLen}`);
    line.classList.add('draw-in');
    line.addEventListener('animationend', () => {
      line.removeAttribute('style');
      line.classList.remove('draw-in');
    }, { once: true });
  }
  svg.appendChild(line);

  // 末端点
  svg.appendChild(
    s('circle', { cx: coords.at(-1)[0], cy: coords.at(-1)[1], r: 2.6, fill: stroke, stroke: 'none' }),
  );

  /* ── 悬停 ── */
  const hoverG = s('g', { opacity: 0 });
  const hoverLine = s('line', { y1: padT, y2: padT + innerH, class: 'hover-line' });
  const hoverDot = s('circle', { r: 3.2, fill: stroke, stroke: 'var(--surface)', 'stroke-width': 1.6 });
  const hoverLabel = s('text', { class: 'lbl', 'text-anchor': 'middle', fill: 'var(--ink-2)' });
  hoverG.appendChild(hoverLine);
  hoverG.appendChild(hoverDot);
  hoverG.appendChild(hoverLabel);
  svg.appendChild(hoverG);

  const hit = s('rect', {
    x: padL, y: padT, width: innerW, height: innerH,
    fill: 'transparent', style: 'cursor:crosshair',
  });

  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const rel = ((ev.clientX - rect.left) / rect.width) * width;
    let best = 0;
    let bestD = Infinity;
    coords.forEach((c, i) => {
      const dist = Math.abs(c[0] - rel);
      if (dist < bestD) { bestD = dist; best = i; }
    });
    const [cx, cy] = coords[best];
    hoverLine.setAttribute('x1', cx);
    hoverLine.setAttribute('x2', cx);
    hoverDot.setAttribute('cx', cx);
    hoverDot.setAttribute('cy', cy);
    const labelY = cy < padT + 16 ? cy + 15 : cy - 8;
    hoverLabel.setAttribute('x', Math.min(Math.max(cx, padL + 22), width - padR - 22));
    hoverLabel.setAttribute('y', labelY);
    hoverLabel.textContent = `${xFormat(points[best])}  ${yFormat(points[best].value)}`;
    hoverG.setAttribute('opacity', 1);
  };

  hit.addEventListener('pointermove', onMove);
  hit.addEventListener('pointerleave', () => hoverG.setAttribute('opacity', 0));
  svg.appendChild(hit);

  return { svg, update: () => {} };
}

/**
 * 迷你走势线（表格里用）。
 */
export function sparkline(values, { width = 74, height = 22, zeroBased = true } = {}) {
  const svg = s('svg', { class: 'spark', viewBox: `0 0 ${width} ${height}` });
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length < 2) return svg;

  const dataLo = Math.min(...valid);
  const dataHi = Math.max(...valid);
  const dataRange = dataHi - dataLo;
  // 与主图同样的策略：离 0 太远就不以 0 为基准，否则只剩一块色块
  const useZero =
    zeroBased && (dataRange === 0 || (dataLo - dataRange * 0.2 <= 0 && dataHi + dataRange * 0.2 >= 0));

  let lo = dataLo;
  let hi = dataHi;
  if (useZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (lo === hi) { lo -= 0.1; hi += 0.1; }
  const padY = 2.5;
  const innerH = height - padY * 2;
  const X = (i) => (i / (valid.length - 1)) * width;
  const Y = (v) => padY + innerH - ((v - lo) / (hi - lo)) * innerH;

  if (useZero && lo <= 0 && hi >= 0) {
    const zy = Y(0);
    svg.appendChild(s('line', { x1: 0, y1: zy, x2: width, y2: zy, class: 'zero' }));
  }

  const coords = valid.map((v, i) => [X(i), Y(v)]);
  const d = smoothPath(coords);
  const last = valid.at(-1);
  const tone = last > 0 ? 'up' : last < 0 ? 'down' : 'flat';
  const stroke = tone === 'up' ? 'var(--up)' : tone === 'down' ? 'var(--down)' : 'var(--accent)';

  const baseY = useZero && lo <= 0 && hi >= 0 ? Y(0) : height;
  svg.appendChild(
    s('path', { d: `${d}L${width},${baseY}L0,${baseY}Z`, fill: stroke, class: 'area' }),
  );
  svg.appendChild(s('path', { d, class: 'line', stroke }));
  svg.appendChild(s('circle', { cx: coords.at(-1)[0], cy: coords.at(-1)[1], r: 1.9, fill: stroke }));
  return svg;
}

export { NS };
