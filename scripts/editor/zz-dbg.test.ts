import "./setup.cjs";
import { test } from "node:test";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
test("x", () => {
  const doc = String.raw`\twocolumn[%
  \begin{center}
    {\LARGE\bfseries A swarm\par}
  \end{center}
  \begin{quotation}\noindent
    {\small\textbf{Abstract.} \input{abstract}}
  \end{quotation}
]
Text.
`;
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  const tree = ensureSyntaxTree(base, doc.length, 5000)!;
  let out = ""; let depth = 0;
  tree.iterate({ enter: (n) => { out += `${"  ".repeat(depth++)}${n.name} ${n.from}-${n.to}${n.type.isError ? " ERROR" : ""}\n`; }, leave: () => { depth--; } });
  console.log(out);
});
