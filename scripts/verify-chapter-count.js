#!/usr/bin/env node

const https = require('https');
const http = require('http');

const target = process.argv[2] || 'https://www.quanben.io/n/qingyunian/';
const threshold = Number(process.argv[3] || 30);
const debug = process.argv.includes('--debug');

function fetch(url, timeout = 15000, depth = 0, referer = 'https://www.quanben.io/') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
          Referer: referer
        }
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && depth < 5) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(fetch(next, timeout, depth + 1, referer));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status, body: data, url }));
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function abs(base, href) {
  return new URL(href, base).toString();
}

function linksFromHtml(base, html) {
  const set = new Set();
  const reg = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = reg.exec(html))) {
    const href = m[1];
    const u = abs(base, href);
    if (/\/n\/[^/]+\/\d+(?:_\d+)?\.html(?:\?.*)?$/i.test(u)) set.add(u.replace(/\?.*$/, ''));
  }
  return set;
}

function scriptSrcs(base, html) {
  const out = [];
  const reg = /<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = reg.exec(html))) {
    try { out.push(abs(base, m[1])); } catch {}
  }
  return Array.from(new Set(out));
}

function encodeQuanbenB(source = '') {
  const staticchars = 'PXhw7UT1B0a9kQDKZsjIASmOezxYG4CHo5Jyfg2b8FLpEvRr3WtVnlqMidu6cN';
  let out = '';
  const pick = () => staticchars[Math.floor(Math.random() * 62)];
  for (const ch of String(source)) {
    const i = staticchars.indexOf(ch);
    const code = i === -1 ? ch : staticchars[(i + 3) % 62];
    out += `${pick()}${code}${pick()}`;
  }
  return out;
}

function extractLoadMoreParam(html = '') {
  const text = String(html || '');
  const book_id = (text.match(/load_more\(\s*['"]?(\d{1,10})['"]?\s*\)/i) || [])[1] || '';
  const callback = (
    text.match(/\bvar\s+callback\s*=\s*['"]([a-zA-Z0-9_]+)['"]/i) ||
    text.match(/\bcallback\s*[:=]\s*['"]([a-zA-Z0-9_]+)['"]/i) ||
    []
  )[1] || '';
  if (!book_id || !callback) return null;
  return { book_id, b: encodeQuanbenB(callback), callback };
}

function extractParamsList(html) {
  const text = String(html || '');
  const out = [];
  const seen = new Set();

  const add = (book_id, b) => {
    if (!book_id || !b) return;
    const key = `${book_id}:${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ book_id, b });
  };

  const readQV = (s) => {
    const q = (String(s).split('?')[1] || String(s)).replace(/^.*?(book_id=)/i, 'book_id=');
    const p = new URLSearchParams(q);
    add(p.get('book_id') || '', p.get('b') || '');
  };

  for (const m of text.matchAll(/index\.php\?[^"'\s]*a=list\.jsonp[^"'\s]*/gi)) readQV(m[0]);
  for (const m of text.matchAll(/book_id=\d+[^"'\s<>{}]{0,220}/gi)) readQV(m[0]);

  // 常见函数写法：fn(764,'Ufy8FKE...')
  for (const m of text.matchAll(/\(\s*['"]?(\d{1,8})['"]?\s*,\s*['"]([a-zA-Z0-9._-]{6,})['"]\s*\)/g)) {
    add(m[1], m[2]);
  }

  // 常见变量写法：book_id=764; b='xxx'
  const bid = (
    text.match(/\bbook_id\s*[:=]\s*["']?(\d{1,8})/i) ||
    text.match(/\bbookId\s*[:=]\s*["']?(\d{1,8})/i) ||
    []
  )[1] || '';
  const bv = (
    text.match(/\bb\s*[:=]\s*["']([a-zA-Z0-9._-]{6,})["']/i) ||
    text.match(/[?&]b=([a-zA-Z0-9._-]{6,})/i) ||
    []
  )[1] || '';
  add(bid, bv);

  return out;
}

function parseJsonp(jsonp) {
  const m = String(jsonp).trim().match(/^[^(]+\(([\s\S]*)\)\s*;?\s*$/);
  const raw = m ? m[1] : String(jsonp);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

(async () => {
  try {
    const base = target.replace(/\/$/, '');
    const listUrl = `${base}/list.html`;
    const list = await fetch(listUrl);
    if (list.status !== 200) throw new Error(`list status ${list.status}`);

    const chapters = linksFromHtml(listUrl, list.body);

    let paramsList = extractParamsList(list.body);
    // 若目录页未直接暴露参数，继续扫描其脚本资源
    if (!paramsList.length) {
      const srcs = scriptSrcs(listUrl, list.body).slice(0, 10);
      for (const src of srcs) {
        try {
          const js = await fetch(src, 12000);
          const p = extractParamsList(js.body);
          if (p.length) {
            const keyset = new Set(paramsList.map(x => `${x.book_id}:${x.b}`));
            for (const it of p) {
              const k = `${it.book_id}:${it.b}`;
              if (!keyset.has(k)) {
                keyset.add(k);
                paramsList.push(it);
              }
            }
          }
        } catch {}
      }
    }
    for (const params of paramsList) {
      const cb = params.callback || `cb${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const b = params.b || encodeQuanbenB(cb);
      const api = `https://www.quanben.io/index.php?c=book&a=list.jsonp&callback=${cb}&book_id=${params.book_id}&b=${b}`;
      const r = await fetch(api, 15000, 0, listUrl);
      const payload = parseJsonp(r.body);
      if (debug) console.log('[debug] jsonp api', api, 'status', r.status, 'body_head', String(r.body).slice(0, 80));

      if (payload && typeof payload === 'object') {
        const html = payload.content || payload.html || payload.data || '';
        for (const u of linksFromHtml(listUrl, String(html || ''))) chapters.add(u);
      } else {
        for (const u of linksFromHtml(listUrl, r.body)) chapters.add(u);
      }
    }

    if (!paramsList.length) {
      const lm = extractLoadMoreParam(list.body);
      if (debug) console.log('[debug] load_more param', lm);
      if (lm) {
        const api = `https://www.quanben.io/index.php?c=book&a=list.jsonp&callback=${lm.callback}&book_id=${lm.book_id}&b=${lm.b}`;
        const r = await fetch(api, 15000, 0, listUrl);
        const payload = parseJsonp(r.body);
        if (debug) console.log('[debug] load_more api', api, 'status', r.status, 'body_head', String(r.body).slice(0, 120));
        if (payload && typeof payload === 'object') {
          const html = payload.content || payload.html || payload.data || '';
          for (const u of linksFromHtml(listUrl, String(html || ''))) chapters.add(u);
          paramsList.push(lm);
        }
      }
    }

    const nums = Array.from(chapters)
      .map((u) => Number((u.match(/\/(\d+)(?:_\d+)?\.html$/) || [])[1] || 0))
      .filter((n) => n > 0)
      .sort((a, b) => a - b);

    const count = nums.length;
    const max = nums.length ? nums[nums.length - 1] : 0;
    const min = nums.length ? nums[0] : 0;
    const expected = max && min ? max - min + 1 : 0;
    const diff = Math.abs(expected - count);

    const result = {
      target: base,
      params_found: paramsList.length,
      count,
      min,
      max,
      estimated_by_url_number: expected,
      diff,
      threshold,
      pass: diff <= threshold
    };

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.pass ? 0 : 2);
  } catch (e) {
    console.error('[verify-chapter-count] failed:', e.message);
    process.exit(1);
  }
})();
