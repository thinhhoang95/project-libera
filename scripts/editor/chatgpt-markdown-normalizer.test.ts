import assert from "node:assert/strict";
import { test } from "node:test";
import katex from "katex";
import { normalizeChatGptCopiedMarkdown as normalize } from "../../src/lib/chatgpt-markdown-normalizer";

test("converts the exact ChatGPT source example to Markdown math", () => {
  const input = String.raw`The decomposition reformulates the original problem by creating one private TV subproblem per traffic volume \(v\).

A TV plan is an integral configuration:

\[
(w^v,h^v,y^v,z^v)\in P_v
\]

and Dantzig-Wolfe represents the convex hull of these plans:

\[
(w^v,h^v,y^v,z^v)\in \operatorname{conv}(P_v).
\]`;
  const expected = String.raw`The decomposition reformulates the original problem by creating one private TV subproblem per traffic volume $v$.

A TV plan is an integral configuration:

\[
(w^v,h^v,y^v,z^v)\in P_v
\]

and Dantzig-Wolfe represents the convex hull of these plans:

\[
(w^v,h^v,y^v,z^v)\in \operatorname{conv}(P_v).
\]`;
  assert.equal(normalize(input), expected);
  assert.equal(normalize(expected), expected);
  for (const match of expected.matchAll(/\\\[\n([\s\S]*?)\n\\\]/g)) {
    assert.doesNotThrow(() => katex.renderToString(match[1], { displayMode: true, throwOnError: true }));
  }
});

test("changes only delimiters, preserving LaTeX contents and nested parentheses", () => {
  assert.equal(normalize(String.raw`Use \(P(u_A,u_B)\) and \(x = y\).`),
    String.raw`Use $P(u_A,u_B)$ and $x = y$.`);
  assert.equal(normalize(String.raw`\[\operatorname*{argmax}_x f(x) \tag*{A}\]`),
    '\\[\n' + String.raw`\operatorname*{argmax}_x f(x) \tag*{A}` + '\n\\]');
  assert.equal(normalize(String.raw`\(\text{literal\_underscore}\)`),
    String.raw`$\text{literal\_underscore}$`);
});

test("preserves prose, code, links, and existing dollar math", () => {
  const input = String.raw`# Heading

A TV (v) and (ordinary prose).

[
plain brackets
]

[link](x) and ![image](v) and [reference][k]

https://example.com/(v)

Inline $P_v$ and $\text{\(example\)}$.

$$
\text{\[example\]}
$$

` + '`\\(v\\)`\n\n```csharp\n\\[\nP_v\n\\]\n\\(v\\)\n```';
  assert.equal(normalize(input), input);
});

test("leaves unmatched delimiters alone and supports CRLF display blocks", () => {
  assert.equal(normalize(String.raw`Unmatched \(x and \[y`), String.raw`Unmatched \(x and \[y`);
  assert.equal(normalize('\\[\r\nx = y\r\n\\]'), '\\[\nx = y\n\\]');
});

test("converts ChatGPT delimiters to custom editor markers", () => {
  const markers = { inlineMathMarkers: "@@ @@", blockMathMarkers: "%% %%" };
  assert.equal(
    normalize(String.raw`Inline \(x^2\). Display: \[E=mc^2\]`, markers),
    "Inline @@x^2@@. Display: \n\n%%\nE=mc^2\n%%",
  );
});
