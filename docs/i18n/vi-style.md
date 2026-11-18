# Vietnamese style for Libera's interface

Used for `messages/vi.json`. Check every change with `node scripts/i18n/check-messages.mjs vi`.

## Voice
- Concise, natural Vietnamese software UI, in the style of Microsoft or Google products in Vietnamese.
- Prefer impersonal phrasing ("Chưa có ghi chú nào.", "Không thể lưu tệp."). Use "bạn" only where a pronoun is
  unavoidable (for example "Bạn có thể hoàn tác bên dưới.").
- Sentence case. Full diacritics always (no unaccented fallbacks).
- Vietnamese has no plural forms: every `plural` keeps its `one` and `other` branches, and both carry the same
  text (`{count, plural, one {# nhận xét} other {# nhận xét}}`).

## Typography
- ASCII apostrophe `'` is used only where the English has an ICU escape (`'{'`, `'}'`, `'<'`, `'>'`, `'#'`,
  `'['`) or where the English keyboard hint has it (`'<' '>'`). Quotations use the curly “ ” pairs.
- Ellipsis `…` (one character) for loading and "more" states.
- Numbers, dates and currency come from `Intl` at run time; never write them into messages. Decimal commas
  appear only in fixed technical text (for example "37,8/36,3" in a model table).
- Vietnamese uses a space before units ("12 px", "34 MB"); those spaces are in the message text.
- Keyboard shortcuts keep their English form: `⌘/Ctrl+Shift+B`, `Esc`, `Enter`, `Shift+Enter`.

## ICU
- Keep every `{argument}` name, `plural` / `select` keyword and branch key (`one`, `other`, `=0`, `yes`, `none`,
  and each select case such as `folder`, `component`, `cost`). Translate only the text inside branches.
- Empty branches (`other {}`) stay empty when the English is empty.
- `#` stays as is inside plural branches.
- Rich-text tags keep their names: `<link>`, `<strong>`, `<code>`, `<kbd>`, `<mono>`, `<line>`, `<delta>`,
  `<chip>`, `<muted>`, `<sub>`.
- LaTeX commands in messages keep their backslash and English name (`\usepackage`, `\section`, `\parencite`,
  `\includegraphics`, `\hline`). Their escaped braces (`'{'`, `'}'`) are copied from the English exactly.
- `\n` in a JSON string is a real line break; it stays as `\n`.

## Glossary
| English | Vietnamese |
|---|---|
| notebook | sổ tay |
| note | ghi chú |
| workspace | không gian làm việc |
| tab (editor tab) | thẻ |
| tag (file tag) | thẻ |
| folder | thư mục |
| reference(s) | tài liệu tham khảo |
| citation | trích dẫn |
| bibliography | danh mục tài liệu |
| highlight (noun / verb) | vùng tô sáng / tô sáng |
| comment | nhận xét |
| review (request a review) | rà soát (yêu cầu rà soát) |
| reviewer | người rà soát |
| collaborator | cộng tác viên |
| share | chia sẻ |
| album / gallery | album / thư viện ảnh |
| photos (gallery) | ảnh |
| voice memo | ghi âm giọng nói |
| transcript | bản chép lời |
| transcribe | chép lời |
| speaker | người nói |
| read aloud | đọc to |
| compile | biên dịch |
| preview | xem trước |
| Preferences / settings | Tùy chọn / Cài đặt (dialog title: Tùy chọn) |
| undo / redo | hoàn tác / làm lại |
| dismiss | bỏ qua |
| cancel | hủy |
| save | lưu |
| delete | xóa |
| rename | đổi tên |
| close | đóng |
| try again / retry | thử lại |
| loading… | đang tải… |
| search (verb / noun) | tìm kiếm |
| ink / pen | nét mực / bút |
| outline | dàn ý |
| snippet | đoạn mã |
| spending | chi tiêu |
| model (AI) | mô hình |
| token (AI) | mã thông báo |
| request (API) | yêu cầu |
| cache read / write | đọc / ghi bộ nhớ đệm |
| agent | tác nhân |
| suggestion (collab edit) | đề xuất |
| checkpoint | điểm kiểm tra |
| card (definition card) | thẻ ghi nhớ |
| draft | bản nháp |
| embedding | nhúng (vectơ nhúng) |
| index (search) | chỉ mục |
| Where Was I | Where Was I (feature name, kept) |
| Protected Archive | Kho lưu trữ được bảo vệ |

Shared messages in the `common` namespace use the same words (Hủy, Đóng, Lưu, Xóa, Đổi tên, Sao chép, Mở,
Hoàn tác, Làm lại, Dừng, Thử lại, Đang tải…, Làm mới, Thêm, Gỡ bỏ, Chỉnh sửa, Áp dụng, Đặt lại, Quay lại,
Tiếp theo, Trước, Tìm kiếm, Cài đặt, Xem thêm, Tên, Không có tiêu đề, Có, Không, Lỗi).

## Kept in English on purpose
- Product and brand names: Libera, OpenRouter, Crossref, PubMed, arXiv, OpenAlex, DataCite, MiKTeX, TeX Live,
  Kokoro, Parakeet TDT v3, YOLOE-26, EmbeddingGemma 2, Ultralytics, LM Studio, Ollama, llama-server.
- File formats and identifiers: PDF, BibTeX, BibLaTeX, RIS, CSL-JSON, Markdown, LaTeX, DOI, ISBN, PMID, PMCID,
  ISSN, URL, JSON, SRT, WebVTT, CSV, TSV.
- Units and symbols: px, pt, MB, GB, KB, B, kHz, IoU, mAP, χ², CV, IQR, SD.
- Search operators and examples: `tags:name`, `speaker:Name`, `/name` snippets.
- Citation style names (IEEE, APA, Nature, Vancouver, Harvard) and LaTeX engines (pdfLaTeX, XeLaTeX, LuaLaTeX).
- Latin "sub verbo" is kept. "et al." is written as "và cộng sự".
- Feature name "Where Was I" (kept as the feature's own name in every message).

## Checks run
- `node scripts/i18n/check-messages.mjs vi --en <snapshot>`: 7,234 keys, 0 missing, 0 problem(s).
- Values left identical to English: 168. All are brands, file formats, units, ICU-only messages or loanwords
  accepted in Vietnamese UI (Email, Album, Markdown, LaTeX, PDF, OK).
