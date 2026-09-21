/**
 * 盘中估值采样。
 *
 * 天天基金下线官方估值曲线后，网上已经没有现成的"某基金今日估算走势"数据。
 * 所以这条曲线由本机自己采样生成：服务运行期间，每隔一段时间把当前估算
 * 涨跌幅记一个点，落到 data/intraday/<code>.json。
 *
 * 这样得到的曲线是真实采样而非拟合，服务没开的时间段会自然留空——
 * 前端会明确标注采样区间，不做插值伪装。
 */

import { readJson, writeJson } from './lib/store.mjs';
import { todayCn } from './lib/time.mjs';

const SAMPLE_INTERVAL_MS = 60_000;
const MAX_POINTS = 720; // 一天 12 小时
const WRITE_DEBOUNCE_MS = 15_000;

/** code -> { date, points: [{ t, pct, nav }] } */
const memo = new Map();
const dirty = new Set();
let flushTimer = null;

/** 采样窗口：只要有市场在交易就值得采样。 */
function withinSamplingWindow(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  const [h, m] = p.split(':').map(Number);
  const mins = h * 60 + m;
  // 北京时间 09:00 – 次日 05:30 覆盖 A股/港股/美股
  return mins >= 9 * 60 || mins <= 5 * 60 + 30;
}

async function load(code) {
  const date = todayCn();
  const cached = memo.get(code);
  if (cached && cached.date === date) return cached;

  const stored = await readJson(`intraday/${code}.json`, null);
  const fresh =
    stored && stored.date === date && Array.isArray(stored.points)
      ? stored
      : { date, points: [] };
  memo.set(code, fresh);
  return fresh;
}

function scheduleFlush(code) {
  dirty.add(code);
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const codes = [...dirty];
    dirty.clear();
    for (const c of codes) {
      const data = memo.get(c);
      if (data) {
        try {
          await writeJson(`intraday/${c}.json`, data);
        } catch {
          /* 磁盘问题不该影响估值主流程 */
        }
      }
    }
  }, WRITE_DEBOUNCE_MS);
  flushTimer.unref?.();
}

/**
 * 记录一个采样点。同一分钟内重复调用会被忽略。
 */
export async function recordSample(code, pct, nav) {
  if (!Number.isFinite(pct)) return;
  const data = await load(code);
  const last = data.points.at(-1);
  const now = Date.now();
  if (last && now - last.t < SAMPLE_INTERVAL_MS * 0.8) return;

  data.points.push({ t: now, pct: Number(pct.toFixed(4)), nav: Number.isFinite(nav) ? Number(nav.toFixed(4)) : null });
  if (data.points.length > MAX_POINTS) data.points.splice(0, data.points.length - MAX_POINTS);
  memo.set(code, data);
  scheduleFlush(code);
}

/** 读取今日采样序列。 */
export async function getSeries(code) {
  const data = await load(code);
  return { date: data.date, points: data.points };
}

export function samplingWindowOpen() {
  return withinSamplingWindow();
}

export const SAMPLE_INTERVAL = SAMPLE_INTERVAL_MS;
