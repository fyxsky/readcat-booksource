plugin.exports = class QuanbenBookSource {
  static ID = 'quanben-io-book-source-v1';
  static TYPE = plugin.type.BOOK_SOURCE;
  static GROUP = '🧩自定义';
  static NAME = '全本小说网';
  static VERSION = '1.0.5';
  static VERSION_CODE = 6;
  static PLUGIN_FILE_URL = 'https://raw.githubusercontent.com/fyxsky/readcat-booksource/main/src/quanben.io.js';
  static BASE_URL = 'https://www.quanben.io';
  static REQUIRE = {
    fastCatalog: {
      label: '目录模式（快速目录）',
      type: 'boolean',
      default: false,
      description: '默认不要开启。目录模式：开启=快速目录（先展示前300章，速度优先）；关闭=完整目录（一次展示全量目录）。'
    },
    deepCatalog: {
      label: '深度目录补全',
      type: 'boolean',
      default: false,
      description: '默认不要开启。仅在你确认目录明显缺失时再开启；开启后会自动补抓章节标题，首次加载会更慢（后续走缓存）。'
    },
    backfillConcurrency: {
      label: '补抓并发数',
      type: 'number',
      default: 10,
      description: '仅在“深度目录补全”开启时生效。表示补抓时的并发请求数，建议 6~16。'
    }
  };

  request;
  store;
  cheerio;
  nanoid;

  constructor(params) {
    const { request, store, cheerio, nanoid } = params;
    this.request = request;
    this.store = store;
    this.cheerio = cheerio;
    this.nanoid = nanoid;
  }

  headers() {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Referer': `${QuanbenBookSource.BASE_URL}/`
    };
  }

  async safeGet(url, options = {}, timeoutMs = 5000) {
    try {
      return await this.request.get(url, {
        ...options,
        timeout: timeoutMs
      });
    } catch (_) {
      return null;
    }
  }

  absUrl(url = '') {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    return new URL(url, QuanbenBookSource.BASE_URL).toString();
  }

  cleanText(text = '') {
    return String(text)
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  normalizeForMatch(text = '') {
    return this.cleanText(text)
      .toLowerCase()
      .replace(/[\s\-_.·•,，。!！?？:：;；"'“”‘’()（）\[\]【】]/g, '');
  }

  isQuanbenDetailUrl(url = '') {
    return /^https?:\/\/(?:www\.)?quanben\.io\/n\/[^/]+\/?$/i.test(url);
  }

  isQuanbenChapterUrl(url = '') {
    return /^https?:\/\/(?:www\.)?quanben\.io\/n\/[^/]+\/\d+(?:_\d+)?\.html(?:\?.*)?$/i.test(url);
  }

  parseSearchPage(html, searchkey) {
    const $ = this.cheerio(html);
    const key = this.normalizeForMatch(searchkey);
    const map = new Map();

    $('a[href]').each((_, a) => {
      const href = this.absUrl($(a).attr('href') || '');
      if (!this.isQuanbenDetailUrl(href)) return;

      const bookname = this.cleanText($(a).text()).replace(/(全文阅读|最新章节|txt下载)$/i, '');
      if (!bookname) return;
      if (key && !this.normalizeForMatch(bookname).includes(key)) return;

      const rowText = this.cleanText($(a).closest('li,dl,dd,div,tr,p').text());
      const author = this.cleanText((rowText.match(/作者[:：]?\s*([^\s/|]+)/i) || [])[1] || '');

      if (!map.has(href)) {
        map.set(href, {
          bookname,
          author,
          detailPageUrl: href,
          latestChapterTitle: ''
        });
      }
    });

    return Array.from(map.values()).slice(0, 30);
  }

  async getDetailBrief(detailPageUrl) {
    const res = await this.safeGet(detailPageUrl, { headers: this.headers() }, 5000);
    const body = String(res?.body || '');
    if (!body) {
      return {
        bookname: '',
        author: '',
        coverImageUrl: '',
        latestChapterTitle: '',
        intro: ''
      };
    }
    const $ = this.cheerio(body);

    const bookname = this.cleanText(
      $('h1').first().text() ||
      $('h3').first().text() ||
      $('meta[property="og:novel:book_name"]').attr('content') ||
      $('title').text().split(/[-_]/)[0]
    );

    let author = this.cleanText(
      $('meta[property="og:novel:author"]').attr('content') ||
      $('*:contains("作者:")').first().text().replace(/^.*作者[:：]/, '')
    );
    if (!author) {
      const text = this.cleanText($.text());
      const m = text.match(/作者[:：]\s*([^\s]+)/);
      author = this.cleanText(m?.[1] || '');
    }

    const coverImageUrl = this.absUrl(
      $('meta[property="og:image"]').attr('content') ||
      $('img[alt]').first().attr('src') ||
      $('img').first().attr('src')
    );

    const intro = this.cleanText(
      $('meta[property="og:description"]').attr('content') ||
      $('*:contains("书籍简介")').next().text() ||
      $('p').slice(0, 8).text()
    );

    return {
      bookname,
      author,
      coverImageUrl,
      latestChapterTitle: '',
      intro
    };
  }

  async search(searchkey) {
    try {
      const key = this.cleanText(searchkey);
      if (!key) return [];

      const mergeList = (arr) => {
        const map = new Map();
        for (const item of arr) {
          if (!item?.detailPageUrl) continue;
          if (!map.has(item.detailPageUrl)) {
            map.set(item.detailPageUrl, item);
          }
        }
        return Array.from(map.values());
      };

      const runBatch = async (batch, timeoutMs) => {
        const tasks = batch.map(async (item) => {
          const res = await this.safeGet(item.url, {
            params: item.params,
            headers: this.headers()
          }, timeoutMs);
          if (!res?.body) return [];
          return this.parseSearchPage(res.body, key);
        });
        const parts = await Promise.all(tasks);
        return mergeList(parts.flat());
      };

      // 批次1：并发快速路径（命中快，优先真实搜索接口）
      const batch1 = [
        { url: `${QuanbenBookSource.BASE_URL}/index.php`, params: { c: 'book', a: 'search', keywords: key } },
        { url: `${QuanbenBookSource.BASE_URL}/index.php`, params: { c: 'book', a: 'search', keyWord: key } },
        { url: `${QuanbenBookSource.BASE_URL}/`, params: { searchkey: key } }
      ];
      let list = await runBatch(batch1, 3500);

      // 批次2：仅在批次1没命中时执行（尽量快失败）
      if (!list.length) {
        const batch2 = [
          { url: `${QuanbenBookSource.BASE_URL}/index.php`, params: { c: 'book', a: 'search', keyword: key } },
          { url: `${QuanbenBookSource.BASE_URL}/index.php`, params: { c: 'book', a: 'search', searchkey: key } },
          { url: `${QuanbenBookSource.BASE_URL}/search`, params: { keyword: key } }
        ];
        list = await runBatch(batch2, 3000);
      }

      // 最后兜底：首页一次
      if (!list.length) {
        const home = await this.safeGet(`${QuanbenBookSource.BASE_URL}/`, {
          headers: this.headers()
        }, 2500);
        if (home?.body) {
          list = this.parseSearchPage(home.body, key);
        }
      }

      return list.slice(0, 20);
    } catch (_) {
      return [];
    }
  }

  extractChapterNum(url = '') {
    const m = String(url).match(/\/(\d+)(?:_\d+)?\.html(?:\?.*)?$/);
    return m ? Number(m[1]) : 0;
  }

  getDetailSlug(detailPageUrl = '') {
    return (String(detailPageUrl).match(/\/n\/([^/]+)\/?$/i) || [])[1] || '';
  }

  getDeepCatalogEnabled() {
    const v = QuanbenBookSource.REQUIRE?.deepCatalog?.value;
    if (typeof v === 'boolean') return v;
    return !!QuanbenBookSource.REQUIRE?.deepCatalog?.default;
  }

  getBackfillConcurrency() {
    const raw = Number(QuanbenBookSource.REQUIRE?.backfillConcurrency?.value ?? QuanbenBookSource.REQUIRE?.backfillConcurrency?.default ?? 10);
    return Math.max(2, Math.min(20, Number.isFinite(raw) ? Math.floor(raw) : 10));
  }

  isFastCatalogEnabled() {
    const v = QuanbenBookSource.REQUIRE?.fastCatalog?.value;
    if (typeof v === 'boolean') return v;
    return !!QuanbenBookSource.REQUIRE?.fastCatalog?.default;
  }

  toFastChapterList(fullList = []) {
    const maxCount = 300;
    if (!Array.isArray(fullList)) return [];
    if (fullList.length <= maxCount) return fullList.map((c, i) => ({ ...c, index: i }));
    return fullList.slice(0, maxCount).map((c, i) => ({ ...c, index: i }));
  }

  getCacheKey(slug, mode = 'full') {
    return `chapter-cache:${mode}:${slug}`;
  }

  async getCachedChapterList(slug) {
    if (!slug) return null;
    try {
      const data = await this.store.getStoreValue(this.getCacheKey(slug, 'full'));
      if (Array.isArray(data) && data.length) return data;
    } catch (_) {}
    return null;
  }

  async setCachedChapterList(slug, chapterList) {
    if (!slug || !Array.isArray(chapterList) || !chapterList.length) return;
    try {
      await this.store.setStoreValue(this.getCacheKey(slug, 'full'), chapterList);
    } catch (_) {}
  }

  async getCachedFastChapterList(slug) {
    if (!slug) return null;
    try {
      const data = await this.store.getStoreValue(this.getCacheKey(slug, 'fast'));
      if (Array.isArray(data) && data.length) return data;
    } catch (_) {}
    return null;
  }

  async setCachedFastChapterList(slug, chapterList) {
    if (!slug || !Array.isArray(chapterList) || !chapterList.length) return;
    try {
      await this.store.setStoreValue(this.getCacheKey(slug, 'fast'), chapterList);
    } catch (_) {}
  }

  extractTitleFromChapterHtml(html = '', fallback = '') {
    const text = String(html || '');
    const title = this.cleanText((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    if (!title) return fallback;
    const t = title.split('_')[0] || title.split('-')[0] || title;
    return this.cleanText(t) || fallback;
  }

  async backfillMissingChapterTitles(base, chapterList) {
    const nums = chapterList.map((c) => this.extractChapterNum(c.url)).filter((n) => n > 0);
    if (!nums.length) return chapterList;
    const minNum = Math.min(...nums);
    const maxNum = Math.max(...nums);
    if (maxNum < 50) return chapterList;

    const map = new Map(chapterList.map((c) => [this.extractChapterNum(c.url), c]).filter(([n]) => n > 0));
    const missingNums = [];
    for (let n = minNum; n <= maxNum; n++) {
      if (!map.has(n)) missingNums.push(n);
    }
    if (!missingNums.length) return chapterList;

    const concurrency = this.getBackfillConcurrency();
    let idx = 0;
    const workers = Array.from({ length: concurrency }).map(async () => {
      while (idx < missingNums.length) {
        const i = idx++;
        const n = missingNums[i];
        const url = `${base}/${n}.html`;
        try {
          const { body } = await this.request.get(url, { headers: this.headers() });
          const title = this.extractTitleFromChapterHtml(body, `第${n}章`);
          map.set(n, { title, url, index: 0 });
        } catch (_) {}
      }
    });
    await Promise.all(workers);

    const out = Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, c], i) => ({ ...c, index: i }));
    return out;
  }

  parseQueryFromUrl(url = '') {
    const out = {};
    const q = String(url).split('?')[1] || '';
    for (const pair of q.split('&')) {
      if (!pair) continue;
      const [k, v = ''] = pair.split('=');
      if (!k) continue;
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    }
    return out;
  }

  encodeQuanbenB(source = '') {
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

  extractLoadMoreJsonpParam(html = '') {
    const text = String(html || '');
    const book_id = (text.match(/load_more\(\s*['"]?(\d{1,10})['"]?\s*\)/i) || [])[1] || '';
    const callback = (
      text.match(/\bvar\s+callback\s*=\s*['"]([a-zA-Z0-9_]+)['"]/i) ||
      text.match(/\bcallback\s*[:=]\s*['"]([a-zA-Z0-9_]+)['"]/i) ||
      []
    )[1] || '';
    if (!book_id || !callback) return null;
    return { book_id, callback, b: this.encodeQuanbenB(callback) };
  }

  extractJsonpParamsFromHtml(html = '') {
    const text = String(html);
    const readQV = (u) => {
      const q = this.parseQueryFromUrl(u);
      const book_id = String(q.book_id || '').trim();
      const b = String(q.b || '').trim();
      return book_id && b ? { book_id, b } : null;
    };

    const direct = text.match(/index\.php\?[^"'\\s]*a=list\.jsonp[^"'\\s]*/i)?.[0] || '';
    if (direct) {
      const v = readQV(direct);
      if (v) return v;
    }

    const bookId = (
      text.match(/[?&]book_id=(\d+)/i) ||
      text.match(/\bbook_id\s*[:=]\s*["']?(\d+)/i) ||
      text.match(/\bbookId\s*[:=]\s*["']?(\d+)/i) ||
      text.match(/\bbookid\s*[:=]\s*["']?(\d+)/i) ||
      []
    )[1] || '';

    const b = (
      text.match(/[?&]b=([a-zA-Z0-9._-]+)/i) ||
      text.match(/\bb\s*[:=]\s*["']([a-zA-Z0-9._-]+)["']/i) ||
      text.match(/\(['"]?\d+['"]?\s*,\s*['"]([a-zA-Z0-9._-]+)['"]\)/i) || // 如 fn(764,'xxx')
      []
    )[1] || '';

    if (bookId && b) return { book_id: String(bookId), b: String(b) };

    // 兜底：有些页面把 URL 做成字符串拼接，直接扫 query 片段
    const chunks = text.match(/book_id=\d+[^"'\\s<>{}]{0,200}/gi) || [];
    for (const c of chunks) {
      const v = readQV(`https://www.quanben.io/index.php?${c}`);
      if (v) return v;
    }

    return null;
  }

  extractScriptSrcs(baseUrl, html = '') {
    const out = new Set();
    const reg = /<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = reg.exec(String(html)))) {
      try {
        out.add(this.absUrl(m[1]));
      } catch {}
    }
    return Array.from(out);
  }

  parseJsonpPayload(body = '') {
    const text = String(body).trim();
    const m = text.match(/^[^(]+\(([\s\S]*)\)\s*;?\s*$/);
    const raw = m ? m[1] : text;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  collectChaptersFromHtml(html, pushChapter) {
    const $ = this.cheerio(String(html || ''));
    let count = 0;
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const title = this.cleanText($(a).text());
      if (!title) return;
      const before = this._chapterCounter || 0;
      pushChapter(title, href);
      if ((this._chapterCounter || 0) > before) count += 1;
    });
    return count;
  }

  tryParseJsonpHtmlString(body = '') {
    const text = String(body).trim();
    const m = text.match(/^[^(]+\(([\s\S]*)\)\s*;?\s*$/);
    if (!m) return '';
    const inner = m[1].trim();
    // callback("...html...")
    if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith('\'') && inner.endsWith('\''))) {
      try {
        const normalized = inner.startsWith('\'')
          ? `"${inner.slice(1, -1).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
          : inner;
        return JSON.parse(normalized);
      } catch (_) {
        return inner.slice(1, -1);
      }
    }
    return '';
  }

  collectChaptersFromPayload(payload, pushChapter) {
    const parseHtmlInString = (s) => {
      if (typeof s !== 'string') return;
      if (!/<a\s+[^>]*href=/i.test(s)) return;
      this.collectChaptersFromHtml(s, pushChapter);
    };

    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node === 'string') {
        parseHtmlInString(node);
        return;
      }
      if (typeof node !== 'object') return;

      const href = node.url || node.href || node.link || node.chapter_url || '';
      const title = node.title || node.name || node.chaptername || node.chapter_name || node.n || '';
      if (href && title) pushChapter(title, href);

      // 关键兼容：list.jsonp 常见结构 { id, content: "<ul>...</ul>" }
      parseHtmlInString(node.content);
      parseHtmlInString(node.html);
      parseHtmlInString(node.data);

      for (const k of Object.keys(node)) walk(node[k]);
    };
    walk(payload);
  }

  async fetchChaptersByJsonpParams(params, pushChapter, refererUrl = `${QuanbenBookSource.BASE_URL}/`) {
    const callback = String(params?.callback || `cb${Date.now()}${Math.floor(Math.random() * 1000)}`);
    const b = String(params?.b || this.encodeQuanbenB(callback));
    let payload = null;
    let rawBody = '';

    try {
      const { body } = await this.request.get(`${QuanbenBookSource.BASE_URL}/index.php`, {
        params: {
          c: 'book',
          a: 'list.jsonp',
          callback,
          book_id: params.book_id,
          b
        },
        headers: {
          ...this.headers(),
          Referer: refererUrl
        },
        timeout: 6000
      });
      rawBody = String(body || '');
      payload = this.parseJsonpPayload(body);
    } catch (_) {}

    const before = this._chapterCounter || 0;
    if (payload) {
      this.collectChaptersFromPayload(payload, pushChapter);
    }
    let after = this._chapterCounter || before;
    if (after > before) return Math.max(0, after - before);

    // 兼容非标准 JSONP：直接返回 HTML / callback("html字符串") / 纯 HTML
    let htmlCount = this.collectChaptersFromHtml(rawBody, pushChapter);
    if (!htmlCount) {
      const htmlInString = this.tryParseJsonpHtmlString(rawBody);
      if (htmlInString) htmlCount = this.collectChaptersFromHtml(htmlInString, pushChapter);
    }

    after = this._chapterCounter || before;
    return Math.max(htmlCount, Math.max(0, after - before));
  }

  extractExpandListUrls($, detailPageUrl) {
    const urls = new Set();
    const add = (u) => {
      const abs = this.absUrl(u || '');
      if (!abs || abs === detailPageUrl) return;
      if (/\/n\/[^/]+\/(?:list|index)_\d+\.html(?:\?.*)?$/i.test(abs) || /full|all|list/i.test(abs)) {
        urls.add(abs);
      }
    };

    $('a, button, span, div').each((_, el) => {
      const node = $(el);
      const text = this.cleanText(node.text());
      if (!text.includes('展开完整列表')) return;
      add(node.attr('href'));
      add(node.attr('data-url'));
      add(node.attr('data-href'));
      const onclick = node.attr('onclick') || '';
      const m = onclick.match(/['"]([^'"]+\.(?:html|php)[^'"]*)['"]/i);
      if (m) add(m[1]);
    });

    return Array.from(urls);
  }

  async getDetail(detailPageUrl) {
    const info = await this.getDetailBrief(detailPageUrl);
    const base = detailPageUrl.replace(/\/$/, '');
    const slug = this.getDetailSlug(detailPageUrl);
    const fastMode = this.isFastCatalogEnabled();

    // 快速目录：优先命中 fast 缓存（秒开）
    if (fastMode) {
      const fastCached = await this.getCachedFastChapterList(slug);
      if (fastCached && fastCached.length) {
        return {
          ...info,
          latestChapterTitle: fastCached[fastCached.length - 1]?.title || '',
          chapterList: fastCached
        };
      }
    }

    // 命中 full 缓存则直接返回；快速目录模式下只返回前300
    const fullCached = await this.getCachedChapterList(slug);
    if (fullCached && fullCached.length) {
      const cachedList = fastMode ? this.toFastChapterList(fullCached) : fullCached;
      if (fastMode) this.setCachedFastChapterList(slug, cachedList);
      return {
        ...info,
        latestChapterTitle: cachedList[cachedList.length - 1]?.title || '',
        chapterList: cachedList
      };
    }
    const listUrl = `${base}/list.html`;

    const chapterList = [];
    const seen = new Set();
    this._chapterCounter = 0;

    const pushChapter = (title, href) => {
      const url = this.absUrl(href);
      if (!this.isQuanbenChapterUrl(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      chapterList.push({ title: this.cleanText(title), url, index: chapterList.length });
      this._chapterCounter += 1;
    };

    const jsonpSeen = new Set();
    let jsonpCaptured = 0;
    // 快速主路径：仅抓 list.html，并模拟页面 load_more 调用 list.jsonp
    try {
      const listRes = await this.safeGet(listUrl, { headers: this.headers() }, 6000);
      const body = String(listRes?.body || '');
      if (!body) throw new Error('empty list');
      const $ = this.cheerio(body);
      $('a[href]').each((_, a) => pushChapter($(a).text(), $(a).attr('href')));

      // 优先走页面原生 load_more 参数（最稳定）
      const loadMoreParam = this.extractLoadMoreJsonpParam(body);
      if (loadMoreParam?.book_id && loadMoreParam?.callback) {
        const lk = `${loadMoreParam.book_id}:${loadMoreParam.callback}`;
        if (!jsonpSeen.has(lk)) {
          jsonpSeen.add(lk);
          jsonpCaptured += await this.fetchChaptersByJsonpParams(loadMoreParam, pushChapter, listUrl);
        }
      }

      // 再尝试直接提取 jsonp 参数
      const jsonpParams = this.extractJsonpParamsFromHtml(body);
      if (!jsonpCaptured && jsonpParams?.book_id && jsonpParams?.b) {
        const key = `${jsonpParams.book_id}:${jsonpParams.b}`;
        if (!jsonpSeen.has(key)) {
          jsonpSeen.add(key);
          jsonpCaptured += await this.fetchChaptersByJsonpParams(jsonpParams, pushChapter, listUrl);
        }
      }

      if (!jsonpCaptured) {
        // 目录页未暴露参数时，尝试从引用脚本中提取
        const srcs = this.extractScriptSrcs(listUrl, body).slice(0, 2);
        const jsTasks = srcs.map(async (src) => {
          const r = await this.safeGet(src, { headers: this.headers() }, 2000);
          return String(r?.body || '');
        });
        const jsBodies = await Promise.all(jsTasks);
        for (const js of jsBodies) {
          if (!js) continue;
          try {
            const p2 = this.extractJsonpParamsFromHtml(js) || this.extractLoadMoreJsonpParam(js);
            if (p2?.book_id) {
              const k2 = `${p2.book_id}:${p2.b || p2.callback || ''}`;
              if (!jsonpSeen.has(k2)) {
                jsonpSeen.add(k2);
                jsonpCaptured += await this.fetchChaptersByJsonpParams(p2, pushChapter, listUrl);
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    // JSONP 成功后立即返回（完整目录优先 + 速度优先）
    if (jsonpCaptured > 0) {
      chapterList.sort((a, b) => this.extractChapterNum(a.url) - this.extractChapterNum(b.url));
      chapterList.forEach((c, i) => (c.index = i));
      delete this._chapterCounter;
      this.setCachedChapterList(slug, chapterList);
      const returnList = fastMode ? this.toFastChapterList(chapterList) : chapterList;
      if (fastMode) this.setCachedFastChapterList(slug, returnList);
      return {
        ...info,
        latestChapterTitle: returnList.length ? returnList[returnList.length - 1].title : '',
        chapterList: returnList
      };
    }

    // JSONP 失败时，回退到 HTML 目录（可能不完整，但保证可用）
    const sortByNum = () => chapterList.sort((a, b) => {
      const na = this.extractChapterNum(a.url);
      const nb = this.extractChapterNum(b.url);
      if (na && nb) return na - nb;
      return a.index - b.index;
    });
    sortByNum();

    delete this._chapterCounter;

    chapterList.forEach((c, i) => (c.index = i));

    // 若目录明显稀疏，启用深度补全（抓缺失章节标题）
    if (this.getDeepCatalogEnabled()) {
      const nums = chapterList.map((c) => this.extractChapterNum(c.url)).filter((n) => n > 0);
      if (nums.length) {
        const maxNum = Math.max(...nums);
        const minNum = Math.min(...nums);
        const unique = new Set(nums);
        const missingCount = maxNum >= minNum ? (maxNum - minNum + 1 - unique.size) : 0;
        const sparse = maxNum >= 100 && chapterList.length < Math.floor(maxNum * 0.7);
        if (sparse) {
          const filled = await this.backfillMissingChapterTitles(base, chapterList);
          if (filled.length > chapterList.length) {
            chapterList.length = 0;
            chapterList.push(...filled);
          }
        } else if (missingCount > 0 && missingCount <= 80) {
          // 小范围缺口（例如 751 里缺 10~30 章）做定点补全
          const filled = await this.backfillMissingChapterTitles(base, chapterList);
          if (filled.length > chapterList.length) {
            chapterList.length = 0;
            chapterList.push(...filled);
          }
        }
      }
    }

    this.setCachedChapterList(slug, chapterList);
    const returnList = fastMode ? this.toFastChapterList(chapterList) : chapterList;
    if (fastMode) this.setCachedFastChapterList(slug, returnList);
    const latestChapterTitle = returnList.length ? returnList[returnList.length - 1].title : '';

    return {
      ...info,
      latestChapterTitle,
      chapterList: returnList
    };
  }

  getTextFromDoc($) {
    const cleanLine = (text = '') => String(text)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\r]+/g, ' ')
      .trim();

    const htmlToLines = (html = '') => {
      if (!html) return [];
      let txt = String(html);
      txt = txt
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|section|article|blockquote|tr)>/gi, '\n')
        .replace(/<(p|div|li|h[1-6]|section|article|blockquote|tr|td|ul|ol|dl|dd|dt)[^>]*>/gi, '')
        .replace(/<[^>]+>/g, '');
      txt = this.cheerio(`<div>${txt}</div>`).text();
      return txt
        .split(/\n+/)
        .map(cleanLine)
        .filter(Boolean)
        .filter((x) => !/^(上一页|下一页|目录|返回目录|加入书签|章节报错)/.test(x))
        .filter((x) => !/^当前位置[:：]/.test(x));
    };

    const blocks = [
      '#content',
      '.content',
      '.articlebody',
      '.article-content',
      '.post-content',
      '.yd_text2',
      'article'
    ];

    let best = [];
    let bestLen = 0;
    for (const s of blocks) {
      const node = $(s).first();
      if (!node.length) continue;
      const lines = htmlToLines(node.html() || '');
      const size = lines.join('').length;
      if (size > bestLen) {
        best = lines;
        bestLen = size;
      }
    }

    if (best.length) return best;
    return htmlToLines($('body').html() || '');
  }

  getNextPageUrl($, currentUrl) {
    const curr = currentUrl.replace(/\?.*$/, '');
    const currNum = Number((curr.match(/\/(\d+)(?:_\d+)?\.html$/) || [])[1] || 0);

    const next = $('a[href]').filter((_, a) => this.cleanText($(a).text()) === '下一页').first();
    if (!next.length) return '';

    const href = this.absUrl(next.attr('href'));
    if (!this.isQuanbenChapterUrl(href)) return '';

    // 仅允许同章分页（例如 12_2.html），避免跳到下一章
    const baseCurr = curr.replace(/\/(\d+)(?:_\d+)?\.html$/, '/$1');
    const baseNext = href.replace(/\/(\d+)(?:_\d+)?\.html(?:\?.*)?$/, '/$1');
    if (baseCurr !== baseNext) return '';

    const nextNum = Number((href.match(/\/(\d+)(?:_\d+)?\.html$/) || [])[1] || 0);
    if (currNum && nextNum && currNum !== nextNum) return '';

    return href;
  }

  async getTextContent(chapter) {
    const lines = [];
    const visited = new Set();
    let url = chapter.url;

    while (url && !visited.has(url)) {
      visited.add(url);
      const { body } = await this.request.get(url, { headers: this.headers() });
      const $ = this.cheerio(body);
      lines.push(...this.getTextFromDoc($));
      url = this.getNextPageUrl($, url);
    }

    // 去重连续重复行
    const output = [];
    for (const line of lines) {
      if (!line) continue;
      if (output[output.length - 1] === line) continue;
      output.push(line);
    }

    return output;
  }
};
