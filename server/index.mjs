/**
 * 美股基金估值宝 —— HTTP 服务
 *
 * 零依赖：只用 node:http。静态资源直接读 web/ 目录，API 走 /api/*。
 * 之所以要一个后端，是因为三个参考项目用到的接口里，
 *   新浪 hq.sinajs.cn 必须带 Referer（浏览器发不了）
 *   东方财富 f10 系列没有 CORS 头
 * 纯前端方案（像 fund-baby 那样）只能覆盖 JSONP 那部分，拿不到这些数据。
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  searchFunds,
  getValuations,
  getFundDetail,
  getOverview,
  cacheStats,
  invalidate,
} from './service.mjs';
import { samplingWindowOpen, SAMPLE_INTERVAL } from './intraday.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '..', 'web');

const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || '127.0.0.1';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    Vary: 'Origin',
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

function parseCodes(raw) {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{6}$/.test(s) || /^[A-Za-z]{2,6}$/.test(s))
    .slice(0, 60);
}

const bool = (v, dflt = true) => (v === undefined || v === '' ? dflt : v !== '0' && v !== 'false');

/* ------------------------------------------------------------------ */
/* 后台采样                                                            */
/* ------------------------------------------------------------------ */

/** 最近被请求过的基金代码，用于后台持续采样盘中曲线。 */
const tracked = new Set();
let samplerTimer = null;

function startSampler() {
  if (samplerTimer) return;
  samplerTimer = setInterval(async () => {
    if (!tracked.size || !samplingWindowOpen()) return;
    const codes = [...tracked].slice(0, 30);
    try {
      await getValuations(codes, { topline: 10, includeFx: true, sample: true });
    } catch {
      /* 采样失败无需打扰用户 */
    }
  }, Math.max(SAMPLE_INTERVAL, 60_000));
  samplerTimer.unref?.();
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      cache: cacheStats(),
      tracked: tracked.size,
      sampling: samplingWindowOpen(),
      node: process.version,
    });
  }

  if (pathname === '/api/overview') {
    const data = await getOverview();
    return sendJson(res, 200, data);
  }

  if (pathname === '/api/search') {
    const q = searchParams.get('q') || '';
    const data = await searchFunds(q);
    return sendJson(res, 200, data);
  }

  if (pathname === '/api/watch') {
    const codes = parseCodes(searchParams.get('codes'));
    if (!codes.length) return sendJson(res, 200, { funds: [], errors: [] });
    codes.forEach((c) => tracked.add(c));
    startSampler();
    const data = await getValuations(codes, {
      topline: Number(searchParams.get('top')) || 10,
      includeFx: bool(searchParams.get('fx')),
      sample: true,
    });
    return sendJson(res, 200, data);
  }

  const detail = /^\/api\/fund\/([^/]+)$/.exec(pathname);
  if (detail) {
    const code = decodeURIComponent(detail[1]);
    if (!/^\d{6}$/.test(code)) return sendError(res, 400, '基金代码格式不正确');
    tracked.add(code);
    startSampler();
    const data = await getFundDetail(code, {
      topline: Number(searchParams.get('top')) || 10,
      includeFx: bool(searchParams.get('fx')),
      sample: true,
    });
    if (!data.fund) return sendError(res, 404, data.error || '未找到该基金', data);
    return sendJson(res, 200, data);
  }

  if (pathname === '/api/refresh') {
    invalidate('q:');
    invalidate('indices');
    invalidate('fx');
    return sendJson(res, 200, { ok: true, at: new Date().toISOString() });
  }

  return sendError(res, 404, '接口不存在');
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 阻止路径穿越
  const target = path.resolve(WEB_DIR, '.' + rel);
  if (!target.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return serveStatic(req, res, { pathname: rel + '/index.html' });
    const ext = path.extname(target).toLowerCase();
    const body = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Accept, Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (err) {
    if (!res.headersSent) {
      sendError(res, 500, err?.message || '服务器内部错误');
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  美股基金估值宝');
  console.log(`  ─────────────────────────────────`);
  console.log(`  地址   ${base}`);
  console.log(`  数据   天天基金 · 腾讯财经 · 新浪财经`);
  console.log(`  说明   估值由持仓穿透自算，仅供参考`);
  console.log('');
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
