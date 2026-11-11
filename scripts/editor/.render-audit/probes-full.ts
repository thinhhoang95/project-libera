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
import { htmlToLatex } from '../../../src/lib/latex/codemirror/visual/html2latex';
import { toggleLatexFormat } from '../../../src/lib/latex/codemirror/visual/keys';
import { canonicalTokens, texDiff } from '../../../src/lib/latex/codemirror/visual/tex-tokens';
import { expandLatexMacros } from '../../../src/lib/latex/macros/expand';
import { disabledRegions, discardingMacros } from '../../../src/lib/latex/macros/structure';
import { referenceText } from '../../../src/lib/latex/macros/numbering';
import { columnSpans } from '../../../src/lib/latex/codemirror/visual/table-model';
import { chapterNumberingStart } from '../../../src/lib/latex/macros/project-numbering';

const output='/private/tmp/claude-501/-Users-thinhhoang--claude-spares-spare-VcvXMm/9ce4c92f-3cf5-4aa3-91f7-230392e2a879/scratchpad/codex-review/probes-full.json';
const dom=new JSDOM('<!doctype html><body></body>',{pretendToBeVisual:true});
for(const k of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','DocumentFragment','HTMLTableCellElement','DOMParser','Window','Range'] as const)Object.defineProperty(globalThis,k,{value:dom.window[k],configurable:true});
for(const k of ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'] as const)Object.defineProperty(globalThis,k,{value:dom.window[k].bind(dom.window),configurable:true});
const results:any[]=[];
function state(doc:string){const mode=new Compartment();let s=EditorState.create({doc,selection:{anchor:doc.length},extensions:[latexLanguageSupport('main.tex','tree'),latexVisualState(),mode.of([])]});ensureSyntaxTree(s,doc.length,30000);s=s.update({effects:mode.reconfigure(latexVisualMode({documentPath:'nb/main.tex'}))}).state;for(let i=0;s.field(structuralField).pending.length&&i<1000;i++){const p=s.field(structuralField).pending[0];s=s.update({effects:buildPendingEffect.of({from:p.from,to:Math.min(p.to,p.from+CHUNK)})}).state;}return s;}
function inspect(name:string,doc:string){const s=state(doc),constructs:any[]=[],widgets:any[]=[];s.field(structuralField).extents.between(0,doc.length,(from,to,m)=>constructs.push({kind:m.kind,from,to,source:doc.slice(from,to)}));s.field(structuralField).decorations.between(0,doc.length,(from,to,d)=>{if(d.spec.widget)widgets.push({from,to,type:d.spec.widget.constructor.name,spec:d.spec.widget.spec,html:d.spec.widget.html,source:d.spec.widget.source});});const n=computeLatexNumbering(syntaxTree(s),(a,b)=>doc.slice(a,b),visualDefinitions(s));const r={name,doc,tree:syntaxTree(s).toString(),constructs,widgets,numbering:n.entries,labels:Object.fromEntries(n.labels),problems:visualDefinitions(s).problems};results.push(r);return r;}

const context={defs:emptyLatexDefinitions(),numbering:EMPTY_NUMBERING,aux:EMPTY_AUX,bib:()=>null};
function fragment(name:string,doc:string,defs=context.defs){const span=document.createElement('span');try{span.append(renderLatexFragment(doc,{...context,defs}));results.push({name,doc,text:span.textContent,html:span.innerHTML,math:span.querySelectorAll('.katex').length});}catch(e){results.push({name,doc,error:String(e)});}}
for(const doc of [String.raw`\ifbool{x}{a}{b}\newcommand{\foo}{hello}`,String.raw`\iftex\newcommand{\foo}{hello}\fi`,String.raw`\begin{abstract}\global\long\def\foo#1{(#1)}\end{abstract}\foo{x}`,String.raw`\begin{abstract}\global\def\foo#1{(#1)}\end{abstract}\foo{x}`,String.raw`\AtBeginDocument{\let\ref\Cref}\begin{document}\section{S}\label{s}\ref{s}\end{document}`,String.raw`\def\1{\mathbf{1}}$\1$`,String.raw`\newcommand{\take}[1]{Hello}\take{world}`,String.raw`\newcommand{\cut}[1]{}\verb|\cut{x}|`,String.raw`\newcommand{\cut}[1]{}\begin{verbatim}\cut{x}\end{verbatim}`]){
 const defs=readLatexDefinitions(doc);results.push({name:'definition/disabled',doc,macros:Object.fromEntries(defs.macros),unsupported:defs.unsupported,expansion:expandLatexMacros(doc.slice(doc.lastIndexOf('}')+1),defs,{mode:'math'}),disabled:disabledRegions(doc,discardingMacros(defs))});inspect('constructs '+doc.slice(0,35),doc);
}
for(const doc of [String.raw`\iftrue A\else B\fi`,String.raw`\iffalse A\else B\fi`,String.raw`\ifnum 1=1 A\else B\fi`,String.raw`\vskip1ex plus .2ex minus .1ex Hello`,String.raw`\parbox[b][0.25\textwidth][c]{0.1\textwidth}{$$\cdots$$}`,String.raw`\href{https://example.com}{Link}`,String.raw`\textcolor[rgb]{1,0,0}{red}`,String.raw`\textcolor[HTML]{FF0000}{red}`,String.raw`\footnote{kept?}`])fragment('fragment exact',doc);
const nd=readLatexDefinitions(String.raw`\newcommand{\theoremname}{testing}`);fragment('definition target expansion',String.raw`\renewcommand{\theoremname}{Poincare Inequality}`,nd);
inspect('authors last',String.raw`\documentclass{acmart}\title{T}\author{Alice}\author{Bob}\begin{abstract}Hidden abstract\end{abstract}\begin{document}\maketitle\end{document}`);
inspect('custom chapter class',String.raw`\documentclass{custom}\begin{document}\chapter{C1}\section{S1}\chapter{C2}\section{S1}\end{document}`);
inspect('scoped theorem leaks',String.raw`\begin{document}{\newtheorem{temp}{Temporary}}\begin{temp}X\end{temp}\end{document}`);
inspect('future theorem leaks',String.raw`\begin{document}\begin{temp}X\end{temp}\newtheorem{temp}{Temporary}\end{document}`);
inspect('broken equation still numbered',String.raw`\begin{document}\begin{equation}x\end{align}\begin{equation}y\label{good}\end{equation}\end{document}`);
inspect('counter formatted with future arithmetic',String.raw`\newcounter{a}\newcommand{\t}{\refstepcounter{a}}\begin{document}\t\label{x}\end{document}`);
for(const doc of [String.raw`\newcommand{\f}[1]{#1 #1}\f{x}`,String.raw`\newcommand{\f}[1]{#1#1}\f{x}`,String.raw`\newcommand{\f}[1]{#1}\f{x}`,String.raw`\newcommand{\f}{\iftrue A\else B\fi}\f`])inspect('macro rendering',doc);
for(const [a,b] of [[String.raw`\alpha{+}b`,String.raw`\alpha+b`],[String.raw`\foo{a}`,String.raw`\foo a`]])results.push({name:'canonical nonarguments',a,b,ca:canonicalTokens(a).map(t=>t.text),cb:canonicalTokens(b).map(t=>t.text),diff:texDiff(a,b)});
try{results.push({name:'html infinite colspan',output:htmlToLatex('<table><tr><td colspan="Infinity">x</td></tr></table>')});}catch(e){results.push({name:'html infinite colspan',error:String(e)});}
const defs=emptyLatexDefinitions();for(const command of ['\\cref','\\nameref'])results.push({name:'reference kinds/title',command,text:referenceText(command,[{kind:'figure',number:'1',pos:0},{kind:'table',number:'2',pos:1}],defs,['f','t'])});
for(const [doc,ranges] of [[String.raw`\textbf{one} plain`,[{anchor:9},{anchor:17}]],[String.raw`\textbf{one two}`, [{anchor:9},{anchor:13}]] ] as const){let v:EditorView|undefined;try{let s=state(doc);s=s.update({selection:{ranges:ranges as any},filter:false}).state;const parent=document.createElement('div');document.body.append(parent);v=new EditorView({state:s,parent});const before=v.state.doc.toString();toggleLatexFormat('textbf')(v);results.push({name:'multi-cursor format',doc,before,after:v.state.doc.toString()});}catch(e){results.push({name:'multi-cursor format',doc,error:String(e)});}finally{v?.destroy();}}
fs.writeFileSync(output,JSON.stringify(results,null,2));console.log('saved',results.length,'probes');dom.window.close();
