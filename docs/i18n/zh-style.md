# Simplified Chinese style for Libera's interface

Used for `messages/zh.json`. Check every change with `node scripts/i18n/check-messages.mjs zh`.

## Voice
- Simplified Chinese UI, as in Apple and Microsoft zh-CN products: concise, sentence-style labels with no final
  full stop on short labels, and a full stop on sentences.
- Prefer imperative phrasing (“保存”, “请选择…”). Use 您 only when addressing the user directly and a pronoun
  is unavoidable (“您的笔记”, “您可以在下方撤销”). Avoid 你.
- Keep Libera's own terms as they are (Libera, Libera AI, Libera Editor).

## Typography
- Full-width punctuation inside Chinese text: ，。：；！？、（）「」“ ” ‘ ’ and the ellipsis “…”.
- A half-width space between Chinese text and Latin words, numbers, or placeholders: “打开 PDF 文件”,
  “共 {count} 项”, “Libera 已是最新版本”.
- Do not put a space inside Chinese words or before full-width punctuation.
- The ICU apostrophe `'` is only used where the English already had it (`'<'`, `'{'`, `'#'`). No other ASCII
  apostrophes are introduced; quotes around names are full-width “ ”.
- Keyboard shortcuts keep their key names: Ctrl/⌘+S, Shift, Esc, Enter, Del, Space, ⌘/Ctrl+Shift+B.
- Dates, numbers, currency and percentages come from code. Write `{count}`, `{percent}%`, `{size} MB`; never type
  formatted numbers into a message. Units such as MB, GB, px, pt, KB and B keep their Latin form.

## ICU
- Keep every `{argument}` name and kind. Translate only the text inside branches.
- Chinese has no plural forms. Every `plural` keeps both `one` and `other`; the two branches carry the same
  wording unless the English branch differs, and `#` stays inside the branch where a count is shown:
  `{count, plural, one {# 个文件} other {# 个文件}}`.
- Where the English selects a word by value (`{kind, select, folder {folder} other {notebook}}`), the
  translation selects the Chinese word (`{kind, select, folder {文件夹} other {笔记本}}`).
- Argument names that appear both as a plain `{x}` and as `{x, plural, …}` in the English keep both forms in the
  translation (the checker compares argument kinds). Where a count is needed in a sentence and as a plural, use
  the plural branch to carry the word and the plain argument for the number.
- Rich-text tags keep their names and sit around the translated text: `<link>…</link>`, `<strong>`, `<code>`,
  `<kbd>`, `<mono>`, `<line>`, `<delta>`, `<chip>`, `<muted>`, `<sub>`. Tags such as `<line>` are used for
  headline pairs.
- Literal `\n` inside a value (for example in `aboutDetail`) is kept, as is a `\\` for a LaTeX command.

## Glossary
| English | Chinese | Notes |
|---|---|---|
| notebook | 笔记本 | |
| note | 笔记 | |
| workspace | 工作区 | |
| tab | 标签页 | |
| folder | 文件夹 | |
| reference(s) | 参考文献 | the sidebar panel and the library entries |
| citation | 引用 | |
| bibliography | 参考文献列表 | the rendered list |
| highlight (noun / verb) | 高亮 | |
| comment | 评论 | |
| annotation (PDF) | 批注 | PDF marks: highlight, note, ink |
| review (noun) | 审阅 | “请求审阅”, “审阅模式” |
| collaborator | 协作者 | |
| share | 共享 | |
| album / gallery | 相册 / 图库 | |
| voice memo | 语音备忘录 | |
| transcript | 转录稿 | verb: 转录 |
| read aloud | 朗读 | |
| compile | 编译 | |
| preview | 预览 | |
| settings / preferences | 偏好设置 | |
| undo / redo | 撤销 / 重做 | |
| dismiss | 忽略 | toasts and notices |
| cancel | 取消 | |
| save | 保存 | |
| delete | 删除 | |
| rename | 重命名 | |
| close | 关闭 | |
| try again | 重试 | |
| loading… | 加载中… | |
| search (verb / noun) | 搜索 | |
| ink / pen | 墨迹 / 笔 | |
| outline | 大纲 | |
| snippet | 片段 | LaTeX snippets |
| spending | 费用 | |
| model (AI) | 模型 | “模型池” for Model Pool |
| token (AI) | Token | kept in Latin |
| request (API) | 请求 | |
| cache read / write | 缓存读取 / 缓存写入 | |
| agent | 智能体 | |
| Detection and Segmentation | 检测与分割 | |
| Where Was I | 上次读到哪里 | feature name |
| Quick Prompts | 快捷提示词 | |
| Model Pool | 模型池 | |

Brand and format names stay in Latin: Libera, OpenRouter, Crossref, PubMed, arXiv, OpenAlex, DataCite, MiKTeX,
TeX Live, Kokoro, YOLOE-26, Parakeet, EmbeddingGemma, Ultralytics, PDF, BibTeX, RIS, CSL-JSON, Markdown, LaTeX,
biblatex, ISBN, DOI, IEEE, ACM, APA, Nature, and so on.

## Left as English on purpose
Only brand, format, unit and short technical labels are identical to the English (127 values). Examples: `PDF`,
`CPU`, `NVIDIA GPU`, `IoU`, `CV`, `{size} MB`, `name@example.com`, `2020-05-12`.

## Open points for the second pass
- Changed English keys will need a fresh translation; keep this glossary for them.
- “Read Out Loud” and “Read Aloud” both map to 朗读; the verb form (“朗读”) reads correctly in both places.
