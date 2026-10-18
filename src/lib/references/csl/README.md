# Bundled CSL styles and locale

Libera formats citations with [citeproc-js](https://github.com/Juris-M/citeproc-js) and these Citation Style Language files:

| Bundled id | Source file | Style |
| --- | --- | --- |
| `apa` | `source/apa.csl` | APA Style 7th edition |
| `chicago-author-date` | `source/chicago-author-date.csl` | Chicago Manual of Style 18th edition (author-date) |
| `ieee` | `source/ieee.csl` | IEEE Reference Guide |
| `vancouver` | `source/nlm-citation-sequence.csl` | NLM/Vancouver: Citing Medicine 2nd edition (citation-sequence) |
| `nature` | `source/nature.csl` | Nature |
| `harvard-cite-them-right` | `source/harvard-cite-them-right.csl` | Cite Them Right 12th edition (Harvard) |

The locale is `source/locales-en-US.xml`.

All bundled styles are independent styles. The CSL repository no longer has an independent `vancouver.csl`: the classic Vancouver style is now the dependent `vancouver-nlm`, whose parent is `nlm-citation-sequence`. That parent is bundled under the `vancouver` id, so libraries that chose “Vancouver” keep working.

Sources: `https://raw.githubusercontent.com/citation-style-language/styles/master/<file>` and `https://raw.githubusercontent.com/citation-style-language/locales/master/locales-en-US.xml`, downloaded 18 October 2026.

`styles.generated.ts` and `locales.generated.ts` export the XML as strings, so the client, the citation worker and the server load them with a plain `import()`. Regenerate them after changing a source file:

```
node scripts/references/build-csl-assets.cjs
```

## License

The styles and the locale are © their authors and the Citation Style Language project (<https://citationstyles.org>), and are licensed under the [Creative Commons Attribution-ShareAlike 3.0 License](https://creativecommons.org/licenses/by-sa/3.0/). Each source file keeps its own `<rights>` and author information. The generated modules carry the same attribution in their header comment.
