# ReadCat 书源插件：quanben.io（全本小说网）

## 文件
- `src/quanben.io.js`：稳定发布文件名（建议导入这个，用于后续点“更新”）
- `src/quanben.io.bookstore.js`：全本小说网书城插件

## 自动更新（基于 Github Raw）
1. 首次在 ReadCat 导入本地：`src/quanben.io.js`
2. 修改 `src/quanben.io.js` 里的 `PLUGIN_FILE_URL` 为你的真实 Raw 地址（必须以 `.js` 结尾）
3. 每次发版只更新同一路径文件 `src/quanben.io.js`，并递增 `VERSION_CODE`
4. 在 ReadCat 点击“更新”即可拉取最新版

书城插件更新地址：
- `https://raw.githubusercontent.com/fyxsky/readcat-booksource/main/src/quanben.io.bookstore.js`

## 功能
- `search(searchkey)`：站内搜索 + 书名模糊匹配（书名包含搜索词即可）
- `getDetail(detailPageUrl)`：提取书名/作者/封面/简介/章节目录
- `getTextContent(chapter)`：提取正文，并支持同章分页自动拼接

## 说明
- 目标站点：`https://www.quanben.io/`
- 不再依赖 Cloudflare Cookie。
- 已针对“搜索过慢、搜索为空”做优化：移除外部搜索引擎回退逻辑。
- 已进一步优化搜索速度：并发快速路径 + 快速失败，减少搜不到时长时间等待。
- 已针对“章节中间缺失”做优化：识别并抓取“展开完整列表”相关目录页 + 常见目录分页页（`list_2.html`/`index_2.html`...）。
- 目录优先使用站点完整目录接口：`index.php?c=book&a=list.jsonp&book_id=...&b=...`（可返回真实章节名）。
- 对“小范围缺章”会做定点补抓补全（例如缺 10~30 章时自动补齐）。
- 速度优化：默认仅走 `list.html + list.jsonp(load_more)` 主路径；JSONP 成功后立即返回并写缓存。
- 正文优化：保留章节段落换行，不再压成单段大文本。
- `v1.0.3` 新增目录模式开关：
  - 开启（快速目录）：先展示前 300 章，速度优先，并写入缓存，二次打开更快。
  - 关闭（完整目录）：一次返回完整目录。
- 如站点后续改版，可优先检查：
  - 详情页：`/n/<slug>/`
  - 目录页：`/n/<slug>/list.html`
  - 章节页：`/n/<slug>/<num>.html`

## 导入
在 ReadCat 的插件管理中导入：
- `src/quanben.io.js`
- `src/quanben.io.bookstore.js`

## 自动完整性校验（免手工）
提供脚本：
- `scripts/verify-chapter-count.js`

用法：
```bash
node scripts/verify-chapter-count.js "https://www.quanben.io/n/qingyunian/" 30
```

说明：
- 脚本会抓目录与 `list.jsonp`，计算：
  - 实际抓到章节数
  - 按链接数字估算章节数
  - 二者差值 `diff`
- `diff <= 阈值(默认30)` 视为通过。
