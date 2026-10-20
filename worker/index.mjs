import {
  cacheStats,
  getFundDetail,
  getOverview,
  getValuations,
  invalidate,
  searchFunds,
} from '../server/service.mjs';
import { samplingWindowOpen } from '../server/intraday.mjs';
import { configureJsonStore } from '../server/lib/store.mjs';

const PAGE_ORIGIN = 'https://01ngvi-qingyi.github.io';

function parseCodes(raw) {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((value) => value.trim())
    .filter((value) => /^\d{6}$/.test(value) || /^[A-Za-z]{2,6}$/.test(value))
    .slice(0, 60);
}

function bool(value, fallback = true) {
  return value === undefined || value === '' ? fallback : value !== '0' && value !== 'false';
}

function corsHeaders(request, env) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  });
  const origin = request.headers.get('Origin');
  const allowedOrigin = env.ALLOWED_ORIGIN || PAGE_ORIGIN;
  const localOrigin = /^http:\/\/localhost(?::\d+)?$/.test(origin || '') ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin || '');
  if (origin && (origin === allowedOrigin || localOrigin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return headers;
}

function json(request, env, status, payload) {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), { status, headers });
}

function toWatchFund(fund) {
  const {
    code, name, nav, estimate, period, reportDate, reportAgeDays, reportStale,
    returns, updatedAt, topCount, intraday,
  } = fund;
  return {
    code, name, nav, estimate, period, reportDate, reportAgeDays, reportStale,
    returns, updatedAt, topCount, intraday,
  };
}

function bindD1(db) {
  configureJsonStore({
    immediate: true,
    async readJson(key, fallback) {
      const row = await db.prepare('SELECT value FROM app_store WHERE key = ?1').bind(key).first();
      if (!row) return fallback;
      try {
        return JSON.parse(row.value);
      } catch {
        return fallback;
      }
    },
    async writeJson(key, value) {
      await db.prepare(
        'INSERT INTO app_store (key, value, updated_at) VALUES (?1, ?2, ?3) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).bind(key, JSON.stringify(value), Date.now()).run();
      return key;
    },
  });
}

export default {
  async fetch(request, env) {
    if (env.DB) bindD1(env.DB);

    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (request.method !== 'GET') return json(request, env, 405, { error: '仅支持 GET 请求' });

    try {
      if (pathname === '/api/health') {
        return json(request, env, 200, {
          ok: true,
          runtime: 'cloudflare-workers',
          cache: cacheStats(),
          sampling: samplingWindowOpen(),
        });
      }

      if (pathname === '/api/overview') {
        return json(request, env, 200, await getOverview());
      }

      if (pathname === '/api/search') {
        return json(request, env, 200, await searchFunds(searchParams.get('q') || ''));
      }

      if (pathname === '/api/watch') {
        const codes = parseCodes(searchParams.get('codes'));
        if (!codes.length) return json(request, env, 200, { funds: [], errors: [] });
        const data = await getValuations(codes, {
          topline: Number(searchParams.get('top')) || 10,
          includeFx: bool(searchParams.get('fx')),
          sample: true,
          fundConcurrency: 3,
          fxFirst: true,
        });
        return json(request, env, 200, { ...data, funds: data.funds.map(toWatchFund) });
      }

      const detail = /^\/api\/fund\/([^/]+)$/.exec(pathname);
      if (detail) {
        const code = decodeURIComponent(detail[1]);
        if (!/^\d{6}$/.test(code)) return json(request, env, 400, { error: '基金代码格式不正确' });
        const data = await getFundDetail(code, {
          topline: Number(searchParams.get('top')) || 10,
          includeFx: bool(searchParams.get('fx')),
          sample: true,
          fundConcurrency: 3,
          fxFirst: true,
        });
        if (!data.fund) {
          return json(request, env, 404, { error: data.error || '未找到该基金', ...data });
        }
        return json(request, env, 200, data);
      }

      if (pathname === '/api/refresh') {
        invalidate('q:');
        invalidate('indices');
        invalidate('fx');
        return json(request, env, 200, { ok: true, at: new Date().toISOString() });
      }

      return json(request, env, 404, { error: '接口不存在' });
    } catch (error) {
      console.error('API request failed', pathname, error?.message || error);
      return json(request, env, 500, { error: error?.message || '服务器内部错误' });
    }
  },
};
