plugin.exports = class QuanbenBookStorePlugin {
  static ID = 'quanben-io-bookstore-v1';
  static TYPE = plugin.type.BOOK_STORE;
  static GROUP = '🧩自定义';
  static NAME = '全本小说网书城';
  static VERSION = '1.0.0';
  static VERSION_CODE = 1;
  static PLUGIN_FILE_URL = 'https://raw.githubusercontent.com/fyxsky/readcat-booksource/main/src/quanben.io.bookstore.js';
  static BASE_URL = 'https://www.quanben.io';

  request;
  cheerio;

  constructor(params) {
    const { request, cheerio } = params;
    this.request = request;
    this.cheerio = cheerio;
  }

  headers() {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      Referer: `${QuanbenBookStorePlugin.BASE_URL}/`
    };
  }

  absUrl(url = '') {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    return new URL(url, QuanbenBookStorePlugin.BASE_URL).toString();
  }

  cleanText(text = '') {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async fetchPage(url) {
    const { body } = await this.request.get(url, {
      headers: this.headers()
    });
    return String(body || '');
  }

  parseBookList(html) {
    const $ = this.cheerio(String(html || ''));
    const list = [];
    const seen = new Set();

    $('.list2').each((_, el) => {
      const node = $(el);
      const titleA = node.find('h3 a').first();
      const bookname = this.cleanText(titleA.text() || node.find('h3').first().text());
      if (!bookname) return;

      const detailPageUrl = this.absUrl(titleA.attr('href') || '');
      if (seen.has(bookname)) return;
      seen.add(bookname);

      const authorText = this.cleanText(node.find('p').filter((__, p) => /作者[:：]/.test($(p).text())).first().text());
      const author = this.cleanText(authorText.replace(/^.*作者[:：]/, ''));
      const intro = this.cleanText(node.find('p').last().text());
      const coverImageUrl = this.absUrl(node.find('img').first().attr('src') || '');

      list.push({
        bookname,
        author,
        intro,
        coverImageUrl,
        detailPageUrl
      });
    });

    return list;
  }

  async getCategory(slug, pages = 2) {
    const out = [];
    const seen = new Set();
    const maxPages = Math.max(1, Math.min(3, Number(pages) || 1));

    for (let page = 1; page <= maxPages; page++) {
      const url = page === 1
        ? `${QuanbenBookStorePlugin.BASE_URL}/c/${slug}.html`
        : `${QuanbenBookStorePlugin.BASE_URL}/c/${slug}_${page}.html`;
      try {
        const html = await this.fetchPage(url);
        const items = this.parseBookList(html);
        for (const item of items) {
          const key = `${item.bookname}@@${item.author || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(item);
        }
      } catch (_) {}
    }
    return out;
  }

  async getHomeRecommend() {
    const html = await this.fetchPage(`${QuanbenBookStorePlugin.BASE_URL}/`);
    return this.parseBookList(html);
  }

  get config() {
    return {
      首页推荐: async () => this.getHomeRecommend(),
      玄幻: async () => this.getCategory('xuanhuan'),
      都市: async () => this.getCategory('dushi'),
      言情: async () => this.getCategory('yanqing'),
      穿越: async () => this.getCategory('chuanyue'),
      青春: async () => this.getCategory('qingchun'),
      仙侠: async () => this.getCategory('xianxia'),
      灵异: async () => this.getCategory('lingyi'),
      悬疑: async () => this.getCategory('xuanyi'),
      历史: async () => this.getCategory('lishi'),
      军事: async () => this.getCategory('junshi'),
      游戏: async () => this.getCategory('youxi'),
      竞技: async () => this.getCategory('jingji'),
      科幻: async () => this.getCategory('kehuan'),
      职场: async () => this.getCategory('zhichang'),
      官场: async () => this.getCategory('guanchang'),
      现言: async () => this.getCategory('xianyan'),
      耽美: async () => this.getCategory('danmei'),
      其他: async () => this.getCategory('qita')
    };
  }
};
