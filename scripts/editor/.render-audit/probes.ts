import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { JSDOM } from 'jsdom';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { latexLanguageSupport } from '../../../src/lib/latex/codemirror/latex-language';
import { latexParser } from '../../../src/lib/latex/codemirror/latex-parser';
import { latexVisualState, latexVisualMode } from '../../../src/lib/latex/codemirror/visual';
import { structuralField, buildPendingEffect, CHUNK } from '../../../src/lib/latex/codemirror/visual/structural';
import { visualDefinitions } from '../../../src/lib/latex/codemirror/visual/model';
import { readLatexDefinitions, emptyLatexDefinitions } from '../../../src/lib/latex/macros/definitions';
import { computeLatexNumbering, EMPTY_NUMBERING } from '../../../src/lib/latex/macros/numbering';
import { EMPTY_AUX } from '../../../src/lib/latex/aux-file';
import { renderLatexFragment } from '../../../src/lib/latex/codemirror/visual/render-fragment';
import { columnSpans } from '../../../src/lib/latex/codemirror/visual/table-model';
import { chapterNumberingStart } from '../../../src/lib/latex/macros/project-numbering';

const output='/private/tmp/claude-501/-Users-thinhhoang--claude-spares-spare-VcvXMm/9ce4c92f-3cf5-4aa3-91f7-230392e2a879/scratchpad/codex-review/probes.json';
const dom=new JSDOM('<!doctype html><body></body>',{pretendToBeVisual:true});
for(const k of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','DocumentFragment','HTMLTableCellElement','DOMParser','Window','Range'] as const)Object.defineProperty(globalThis,k,{value:dom.window[k],configurable:true});
for(const k of ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'] as const)Object.defineProperty(globalThis,k,{value:dom.window[k].bind(dom.window),configurable:true});
const results:any[]=[];
function state(doc:string){const mode=new Compartment();let s=EditorState.create({doc,selection:{anchor:doc.length},extensions:[latexLanguageSupport('main.tex','tree'),latexVisualState(),mode.of([])]});ensureSyntaxTree(s,doc.length,30000);s=s.update({effects:mode.reconfigure(latexVisualMode({documentPath:'nb/main.tex'}))}).state;for(let i=0;s.field(structuralField).pending.length&&i<1000;i++){const p=s.field(structuralField).pending[0];s=s.update({effects:buildPendingEffect.of({from:p.from,to:Math.min(p.to,p.from+CHUNK)})}).state;}return s;}
function inspect(name:string,doc:string){const s=state(doc),constructs:any[]=[],widgets:any[]=[];s.field(structuralField).extents.between(0,doc.length,(from,to,m)=>constructs.push({kind:m.kind,from,to,source:doc.slice(from,to)}));s.field(structuralField).decorations.between(0,doc.length,(from,to,d)=>{if(d.spec.widget)widgets.push({from,to,type:d.spec.widget.constructor.name,spec:d.spec.widget.spec,html:d.spec.widget.html,source:d.spec.widget.source});});const n=computeLatexNumbering(syntaxTree(s),(a,b)=>doc.slice(a,b),visualDefinitions(s));const r={name,doc,tree:syntaxTree(s).toString(),constructs,widgets,numbering:n.entries,labels:Object.fromEntries(n.labels),problems:visualDefinitions(s).problems};results.push(r);return r;}
inspect('future counter format',String.raw`\documentclass{article}
\begin{document}
\section{First}\label{first}
\begin{equation}a=b\label{a}\end{equation}
\renewcommand{\thesection}{B}
\renewcommand{\theequation}{B.\arabic{equation}}
\section{Appendix}\label{app}
\begin{equation}c=d\label{b}\end{equation}
\end{document}`);
inspect('malformed definition suppresses numbering',String.raw`\documentclass{article}
\WithSuffix\newcommand\foo*{bar}
\begin{document}
\section{First}\label{first}
\begin{equation}a=b\label{a}\end{equation}
\end{document}`);
inspect('missing definition body recovery',String.raw`\documentclass{article}
\newcommand{\broken}
\begin{document}
\section{First}\label{first}
\end{document}`);
inspect('float loses code',String.raw`\begin{figure}
\begin{verbatim}
Important listing content
\end{verbatim}
\caption{Example}
\end{figure}`);
inspect('float loses listing',String.raw`\begin{figure}
\begin{lstlisting}
func main() { println(42) }
\end{lstlisting}
\caption{Example}
\end{figure}`);
inspect('theorem called algorithm',String.raw`\newtheorem{algorithm}{Algorithm}
\begin{algorithm}\label{alg}Important steps.\end{algorithm}
See \ref{alg}.`);
inspect('array missing columns',String.raw`\begin{array}{cc}a & b \\ c & d\end{array}`);
const context={defs:emptyLatexDefinitions(),numbering:EMPTY_NUMBERING,aux:EMPTY_AUX,bib:()=>null};
for(const doc of [String.raw`$x`,String.raw`\(x`,String.raw`\begin{equation}x\end{align}`,String.raw`\textbf{unfinished`,String.raw`\textcolor[RGB{255,0,0}{hello}`,String.raw`\textcolor[RGB]{255,0,0}{hello}`,String.raw`$x_{\ref{e}}$`]){const span=document.createElement('span');try{span.append(renderLatexFragment(doc,context));results.push({name:'fragment',doc,text:span.textContent,math:span.querySelectorAll('.katex').length,raw:[...span.querySelectorAll('.cm-vis-raw')].map(e=>e.textContent)});}catch(e){results.push({name:'fragment',doc,error:String(e)});}}
for(const count of [1000,1000000,10000000]){const t=performance.now();const out=columnSpans(`*{${count}}{}`);results.push({name:'empty-column-repeat',count,ms:performance.now()-t,columns:out?.length});}
// Included files share the numbering visitor; a skipped definition in the root must not skip a child's smaller positions.
for(const preamble of ['',String.raw`\newcommand{\f}{foo}`+'\n',String.raw`\newcommand{\f}{foo}`+'\n'+String.raw`\newcommand{\g}{goo}`+'\n']){
 const doc=preamble+String.raw`\begin{document}\input{child}\section{After}\end{document}`;
 const child=String.raw`\section{Child}\begin{equation}x=y\end{equation}`;const defs=readLatexDefinitions(doc);
 const n=computeLatexNumbering(latexParser.parse(doc),(a,b)=>doc.slice(a,b),defs,{includes:()=>({tree:latexParser.parse(child),read:(a,b)=>child.slice(a,b)})});results.push({name:'include position state',doc,child,entries:n.entries,counters:n.counters});
}
// Establish a real widget-toDOM path for malformed math, and escaped DOM text.
inspect('caption with unclosed inline math',String.raw`\begin{figure}\includegraphics{a.png}\caption{Broken $x}\end{figure}`);
for (const count of [1000,10000]) {
 const doc='\\begin{enumerate}\n'+'\\item Text $x$.\n'.repeat(count)+'\\end{enumerate}'; const mode=new Compartment();
 let s=EditorState.create({doc,selection:{anchor:Math.floor(doc.length/2)},extensions:[latexLanguageSupport('main.tex','tree'),latexVisualState(),mode.of([])]});ensureSyntaxTree(s,doc.length,60000);
 const t=performance.now();s=s.update({effects:mode.reconfigure(latexVisualMode({documentPath:'nb/main.tex'}))}).state;
 results.push({name:'single large list first build',chars:doc.length,count,ms:performance.now()-t,pending:s.field(structuralField).pending});
}
async function finish(){
 const mathDefs=readLatexDefinitions(String.raw`\DeclareMathOperator*{\argmin}{arg\,min}\newcommand{\p}[1]{(#1)}`);
 const refs={...EMPTY_NUMBERING,labels:new Map([['e',{number:'3',kind:'equation' as const,pos:0}]])};
 for(const doc of [String.raw`\begin{equation*}\argmin_x\p{x}\end{equation*}`,String.raw`$x_{\ref{e}}$`]){
  const span=document.createElement('span');span.append(renderLatexFragment(doc,{...context,defs:mathDefs,numbering:refs}));results.push({name:'fragment with known math macros/references',doc,text:span.textContent,math:span.querySelectorAll('.katex').length,raw:[...span.querySelectorAll('.cm-vis-raw')].map(e=>e.textContent)});
 }
 const root=String.raw`\newtheorem{thm}{Theorem}
\begin{document}
\section{First}\begin{thm}A\end{thm}
\input{chapter}
\end{document}`;const chapter=String.raw`\section{Second}\begin{thm}B\end{thm}`;
 const inherited=readLatexDefinitions(root.slice(0,root.indexOf('\\begin{document}')),undefined,{file:'nb/root.tex'});
 const start=await chapterNumberingStart('nb/chapter.tex','nb/root.tex',async p=>p==='nb/root.tex'?root:chapter,inherited);
 const defs=readLatexDefinitions(chapter,inherited);const n=computeLatexNumbering(latexParser.parse(chapter),(a,b)=>chapter.slice(a,b),defs,{start});
 results.push({name:'chapter inherited current label absent',root,chapter,start,entries:n.entries});
fs.writeFileSync(output,JSON.stringify(results,null,2));
console.log(JSON.stringify(results.map(r=>({...r,tree:undefined,widgets:r.widgets?.map((w:any)=>({...w,html:undefined}))})),null,2));dom.window.close();
}
finish();
