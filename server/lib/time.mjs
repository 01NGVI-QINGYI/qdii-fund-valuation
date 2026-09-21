/**
 * 时间与交易时段。
 *
 * 全部以北京时间（Asia/Shanghai）为准。服务器可能跑在任意时区，
 * 所以这里不依赖本机 TZ，统一用 Intl 把瞬时转成北京时间的各个字段。
 */

const CN_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  weekday: 'short',
});

/** 把瞬时拆成北京时间各字段。 */
export function cnParts(date = new Date()) {
  const parts = Object.fromEntries(
    CN_FMT.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour) % 24;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayMap[parts.weekday] ?? 0,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + Number(parts.minute),
  };
}

export function cnNow(date = new Date()) {
  const p = cnParts(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.date} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** 美国夏令时：3 月第二个周日 02:00 → 11 月第一个周日 02:00（当地）。 */
export function isUsDst(date = new Date()) {
  const y = date.getUTCFullYear();
  const nthSunday = (month, n) => {
    // month 0-based；返回该月第 n 个周日的 UTC 日号
    const first = new Date(Date.UTC(y, month, 1));
    const offset = (7 - first.getUTCDay()) % 7;
    return 1 + offset + (n - 1) * 7;
  };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7); // 02:00 EST = 07:00 UTC
  const end = Date.UTC(y, 10, nthSunday(10, 1), 6); // 02:00 EDT = 06:00 UTC
  return date.getTime() >= start && date.getTime() < end;
}

/**
 * 交易时段（北京时间，分钟数）。
 * 美股用美东 09:30–16:00 换算：夏令时 +12h，冬令时 +13h。
 */
export function sessions(date = new Date()) {
  const dst = isUsDst(date);
  const usOpen = (9 * 60 + 30) + (dst ? 12 : 13) * 60;
  const usClose = (16 * 60) + (dst ? 12 : 13) * 60;
  return {
    CN: [
      [9 * 60 + 30, 11 * 60 + 30],
      [13 * 60, 15 * 60],
    ],
    HK: [
      [9 * 60 + 30, 12 * 60],
      [13 * 60, 16 * 60],
    ],
    // 东京 09:00–11:30 / 12:30–15:00 JST，日本比北京早 1 小时
    JP: [
      [8 * 60, 10 * 60 + 30],
      [11 * 60 + 30, 14 * 60],
    ],
    US: [[usOpen % 1440, usClose % 1440]],
    usDst: dst,
  };
}

const MARKET_LABEL = {
  CN: 'A 股',
  HK: '港股',
  JP: '日股',
  US: '美股',
};

export const MARKET_NAME = MARKET_LABEL;

/**
 * 交易进度：当前处在当日交易时段的哪个位置。
 *
 * 按「已交易的分钟数 ÷ 当日应交易的分钟数」算，所以午休期间进度会停住不动
 * ——这比按自然时间线性推进更符合直觉（午休本来就不产生行情）。
 *
 * 美股跨零点，单独处理：交易日起点是 21:30（夏令时），终点落在次日凌晨。
 *
 * @returns {{phase:'pre'|'open'|'break'|'closed', progress:number,
 *            elapsedMin:number, totalMin:number, remainMin:number}}
 */
export function sessionProgress(market, date = new Date()) {
  const ranges = sessions(date)[market] || [];
  const mins = cnParts(date).minutes;
  if (!ranges.length) {
    return { phase: 'closed', progress: 0, elapsedMin: 0, totalMin: 0, remainMin: 0 };
  }

  const totalMin = ranges.reduce((s, [a, b]) => s + (b > a ? b - a : b + 1440 - a), 0);

  /* 单段且跨零点（美股） */
  if (ranges.length === 1 && ranges[0][1] < ranges[0][0]) {
    const [a, b] = ranges[0];
    const end = b + 1440;
    if (mins >= a) {
      const elapsed = mins - a;
      return {
        phase: 'open', progress: Math.min(1, elapsed / totalMin),
        elapsedMin: elapsed, totalMin, remainMin: Math.max(0, end - mins),
      };
    }
    if (mins < b) {
      const elapsed = mins + 1440 - a;
      return {
        phase: 'open', progress: Math.min(1, elapsed / totalMin),
        elapsedMin: elapsed, totalMin, remainMin: Math.max(0, end - (mins + 1440)),
      };
    }
    // 开盘前 / 收盘后：判断离哪一端更近
    const beforeOpen = a - mins;
    if (beforeOpen <= 12 * 60) {
      return { phase: 'pre', progress: 0, elapsedMin: 0, totalMin, remainMin: totalMin };
    }
    return { phase: 'closed', progress: 1, elapsedMin: totalMin, totalMin, remainMin: 0 };
  }

  /* 两段（A 股 / 港股 / 日股），含午休 */
  let elapsed = 0;
  for (let i = 0; i < ranges.length; i++) {
    const [a, b] = ranges[i];
    if (mins < a) {
      return {
        phase: i === 0 ? 'pre' : 'break',
        progress: elapsed / totalMin,
        elapsedMin: elapsed, totalMin, remainMin: totalMin - elapsed,
      };
    }
    if (mins < b) {
      const done = elapsed + (mins - a);
      return {
        phase: 'open', progress: done / totalMin,
        elapsedMin: done, totalMin, remainMin: totalMin - done,
      };
    }
    elapsed += b - a;
  }
  return { phase: 'closed', progress: 1, elapsedMin: totalMin, totalMin, remainMin: 0 };
}

/** 分钟数 -> "1 小时 25 分" */
export function humanMinutes(m) {
  const v = Math.max(0, Math.round(m));
  const h = Math.floor(v / 60);
  const mm = v % 60;
  if (h && mm) return `${h} 小时 ${mm} 分`;
  if (h) return `${h} 小时`;
  return `${mm} 分`;
}

/**
 * 美股当日所处阶段（北京时间）。
 *
 * 本工具主打美股方向的 QDII，所以「盘前 / 盘中 / 盘后」按美股时段划分
 * （夏令时；冬令时整体后移 1 小时）：
 *
 *   盘前  16:00 – 21:30   美股盘前交易
 *   盘中  21:30 – 次日 04:00  常规交易时段
 *   盘后  04:00 – 08:00   盘后交易时段
 *   gap   08:00 – 16:00   美股完全休市 —— 三个估算列都显示「——」
 *
 * 之所以按阶段区分，是因为三个阶段的行情性质完全不同：盘前时美股还没
 * 交易过，估算基本只反映港股 / 日股持仓；盘中是实时变动的；盘后拿到的是
 * 刚收盘那一场的最终结果。
 *
 * 周末按"对应的美股交易日是否存在"判断：周六凌晨属于周五那一场，仍然有效；
 * 周一凌晨对应周日，没有交易，算休市。美股假期未单独处理。
 */
export function usPhase(date = new Date()) {
  const p = cnParts(date);
  const dst = isUsDst(date);

  // 四个分界点（北京时间，分钟）
  const afterStart = dst ? 4 * 60 : 5 * 60; // 盘后开始
  const afterEnd = dst ? 8 * 60 : 9 * 60; // 盘后结束
  const preStart = dst ? 16 * 60 : 17 * 60; // 盘前开始
  const openStart = dst ? 21 * 60 + 30 : 22 * 60 + 30; // 常规时段开始

  const m = p.minutes;
  const prevWeekday = cnParts(new Date(date.getTime() - 86400000)).weekday;
  const isSessionDay = (wd) => wd >= 1 && wd <= 5;

  let phase;
  if (m < afterStart) {
    // 还在前一天的常规时段里
    phase = isSessionDay(prevWeekday) ? 'open' : 'gap';
  } else if (m < afterEnd) {
    phase = isSessionDay(prevWeekday) ? 'after' : 'gap';
  } else if (m < preStart) {
    phase = 'gap';
  } else if (m < openStart) {
    phase = isSessionDay(p.weekday) ? 'pre' : 'gap';
  } else {
    phase = isSessionDay(p.weekday) ? 'open' : 'gap';
  }

  const LABEL = { pre: '盘前', open: '盘中', after: '盘后', gap: '休市' };
  const win = (a, b) => `${fmtMin(a)} – ${fmtMin(b)}`;
  const WINDOW = {
    pre: win(preStart, openStart),
    open: win(openStart, afterStart),
    after: win(afterStart, afterEnd),
    gap: `盘前 ${fmtMin(preStart)} 开始`,
  };

  return {
    phase,
    label: LABEL[phase],
    window: WINDOW[phase],
    // 四个分界点透出给前端，用于标注各列的时间段
    bounds: { preStart, openStart, afterStart, afterEnd },
    dst,
  };
}

function fmtMin(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * 判断某个市场此刻的状态。
 * 注意美股跨零点，需要看"昨天开的盘"。
 */
export function marketStatus(market, date = new Date()) {
  const p = cnParts(date);
  const s = sessions(date);
  const ranges = s[market] || [];
  const weekend = p.weekday === 0 || p.weekday === 6;

  const inRange = (m, [a, b]) => (a <= b ? m >= a && m < b : m >= a || m < b);

  if (market === 'US') {
    const [a, b] = ranges[0];
    const openNow = inRange(p.minutes, [a, b]);
    // 美股"今天"这个交易日的本地日期：零点前属于前一自然日
    const tradingDayCn = p.minutes < b && (a > b) ? shiftDate(p.date, -1) : p.date;
    const prog = sessionProgress(market, date);
    const usShort = s.usDst ? '21:30–04:00' : '22:30–05:00';
    return {
      market,
      label: MARKET_LABEL[market],
      open: openNow,
      // 北京时间的交易时段描述，用于 UI 展示
      session: s.usDst ? '21:30 – 04:00' : '22:30 – 05:00',
      sessionShort: usShort,
      tradingDayCn,
      note: s.usDst ? '夏令时' : '冬令时',
      ...prog,
    };
  }

  const openNow = !weekend && ranges.some((r) => inRange(p.minutes, r));
  const SESSION_TEXT = {
    CN: '09:30 – 11:30 / 13:00 – 15:00',
    HK: '09:30 – 12:00 / 13:00 – 16:00',
    JP: '08:00 – 10:30 / 11:30 – 14:00',
  };
  // 只有两段时给一个"首开 – 末收"的紧凑描述，方便放进窄条
  const SHORT = { CN: '09:30–15:00', HK: '09:30–16:00', JP: '08:00–14:00' };
  const prog = sessionProgress(market, date);
  return {
    market,
    label: MARKET_LABEL[market],
    open: openNow,
    session: SESSION_TEXT[market] || '',
    sessionShort: SHORT[market] || SESSION_TEXT[market] || '',
    tradingDayCn: p.date,
    note: weekend ? '周末休市' : '',
    ...prog,
    // 周末没有当日交易时段，进度条不该显示成"已走完"
    ...(weekend ? { phase: 'closed', progress: 0, elapsedMin: 0, remainMin: prog.totalMin } : {}),
  };
}

export function allMarketStatus(date = new Date()) {
  return {
    CN: marketStatus('CN', date),
    HK: marketStatus('HK', date),
    JP: marketStatus('JP', date),
    US: marketStatus('US', date),
    now: cnNow(date),
    nowDate: cnParts(date).date,
    nowMinutes: cnParts(date).minutes,
    weekday: cnParts(date).weekday,
  };
}

/** 'YYYY-MM-DD' + n 天。 */
export function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** 北京时间今天（YYYY-MM-DD）。 */
export function todayCn(date = new Date()) {
  return cnParts(date).date;
}

/**
 * 两个日期字符串相差的自然日数（a - b）。
 */
export function daysBetween(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  const ta = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const tb = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((ta - tb) / 86400000);
}
