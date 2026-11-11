import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { latexLanguageSupport } from '../../../src/lib/latex/codemirror/latex-language';
import { latexParser } from '../../../src/lib/latex/codemirror/latex-parser';
import { latexVisualMode, latexVisualState } from '../../../src/lib/latex/codemirror/visual';
import { buildPendingEffect, structuralField, CHUNK } from '../../../src/lib/latex/codemirror/visual/structural';
import { setMacroSources, setNumberingStart, setNumberingIncludes, setNumbering, setAuxData, visualDefinitions } from '../../../src/lib/latex/codemirror/visual/model';
import { refreshVisualWidgets } from '../../../src/lib/latex/codemirror/visual/widgets';
import { argumentInner } from '../../../src/lib/latex/codemirror/visual/render-fragment';
import { katexForEnvironment, countedRows, renderKatex } from '../../../src/lib/latex/codemirror/visual/math-render';
import { withReferenceNumbers } from '../../../src/lib/latex/codemirror/visual/references';
import { expandLatexMacros } from '../../../src/lib/latex/macros/expand';
import { bodyStartOf, readLatexInputs, collectLatexDefinitions, loadKey } from '../../../src/lib/latex/macros/definitions';
import { chapterNumberingStart } from '../../../src/lib/latex/macros/project-numbering';
import { computeLatexNumbering, environmentName } from '../../../src/lib/latex/macros/numbering';
import { collectMacroSources, collectBodyIncludes } from '../../../src/components/libera/latex/latex-dependencies';
import { readBibEntries, resolveRelativeNotebookPath } from '../../../src/lib/latex/project';
import { parseLatexAux } from '../../../src/lib/latex/aux-file';
import { latexProjectField, setLatexProject } from '../../../src/lib/latex/codemirror/editing';

const output = '/private/tmp/claude-501/-Users-thinhhoang--claude-spares-spare-VcvXMm/9ce4c92f-3cf5-4aa3-91f7-230392e2a879/scratchpad/codex-review';
const papers = path.join(path.dirname(output), 'papers');
const mains: Record<string,string> = { '1706.03762':'ms.tex', '2005.11710':'main.tex', '2203.00671':'main.tex', '1803.09015':'Callaway_SantAnna_2020.tex', '1812.09970':'main.tex' };
const errors: string[] = [];
const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(String(e)));
const dom = new JSDOM('<!doctype html><html><body></body></html>', {pretendToBeVisual:true, virtualConsole:vc});
for (const k of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','DocumentFragment','HTMLTableCellElement','DOMParser','Window','HTMLInputElement','HTMLTextAreaElement','HTMLImageElement','HTMLCanvasElement','Range'] as const) Object.defineProperty(globalThis,k,{value:dom.window[k],configurable:true});
for (const k of ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'] as const) Object.defineProperty(globalThis,k,{value:dom.window[k].bind(dom.window),configurable:true});
const oldError=console.error; console.error=(...args)=>errors.push(args.map(String).join(' '));
function inventory(dir:string):string[] { return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isSymbolicLink()?[]:e.isDirectory()?inventory(path.join(dir,e.name)):[path.join(dir,e.name)]); }
const tick=()=>new Promise(r=>setTimeout(r,0));
const tally=(values:string[])=>Object.fromEntries([...values.reduce((m,k)=>m.set(k,(m.get(k)??0)+1),new Map<string,number>())].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])));
const result:any={generatedAt:new Date().toISOString(),method:'EditorState + real EditorView + every structural widget toDOM with source-position proxy; no TeX execution or network', papers:[]};

async function main(){
for (const [id,main] of Object.entries(mains)) {
 const disk=path.join(papers,id), files=inventory(disk), known=new Set(files.map(f=>`${id}/${path.relative(disk,f)}`));
 const rootPath=`${id}/${main}`;
 const readText=async (p:string)=> { if(!known.has(p))return ''; return fs.readFileSync(path.join(papers,p),'utf8').replace(/\r\n/g,'\n'); };
 const texts=new Map<string,string>();
 const queue=[rootPath], missingInputs:any[]=[];
 while(queue.length){ const p=queue.shift()!; if(texts.has(p))continue; const text=await readText(p); texts.set(p,text);
   for(const i of readLatexInputs(text)){const p2=resolveRelativeNotebookPath(rootPath,/\.(tex|ltx|sty|bbl)$/i.test(i.path)?i.path:`${i.path}.tex`); if(p2&&known.has(p2)&&!texts.has(p2))queue.push(p2);else if(!p2||!known.has(p2)) missingInputs.push({file:p,name:i.path});}
 }
 const bib=files.filter(f=>f.endsWith('.bib')).flatMap(f=>readBibEntries(fs.readFileSync(f,'utf8')));
 const auxText=files.filter(f=>f.endsWith('.aux')).map(f=>fs.readFileSync(f,'utf8')).join('\n'), aux=parseLatexAux(auxText);
 const paper:any={id,main,missingInputs,bibEntries:bib.length,auxLabels:Object.keys(aux.labels).length,auxCitations:Object.keys(aux.citations).length,files:[]}; result.papers.push(paper);
 for (const [file,text] of texts) {
  const r:any={file:file.slice(id.length+1),chars:text.length,lines:text.split('\n').length,exceptions:[]}; paper.files.push(r); const errStart=errors.length, totalStart=performance.now(); let view:EditorView|undefined;
  try{
   const sources=await collectMacroSources({filePath:file,rootPath,ownPreamble:text.slice(0,bodyStartOf(text)||0),known,readText,version:()=> 'audit'});
   const base=collectLatexDefinitions(sources.sources);
   const start=await chapterNumberingStart(file,rootPath,readText,base);
   const includes=await collectBodyIncludes({filePath:file,rootPath,text,known,readText});
   r.macroSources=sources.sources.map(s=>s.path);r.chapterStart=start;r.numberingIncludes=[...includes.includes.keys()];
   const mode=new Compartment(); let state=EditorState.create({doc:text,selection:{anchor:text.length},extensions:[latexLanguageSupport(file,'tree'),latexVisualState(),latexProjectField,mode.of([])]});
   const parseStart=performance.now(); const parsed=ensureSyntaxTree(state,text.length,60000);r.parseMs=performance.now()-parseStart; r.parseComplete=!!parsed;
   state=state.update({effects:[setMacroSources.of(sources.sources),setNumberingStart.of(start),setNumberingIncludes.of(includes.includes),setAuxData.of(aux),setLatexProject.of({labels:[],bibEntries:bib,files:[]})]}).state;
   const config={documentPath:file,rootPath,fileUrl:(_p:string)=>null};
   const buildStart=performance.now();state=state.update({effects:mode.reconfigure(latexVisualMode(config))}).state;r.firstBuildMs=performance.now()-buildStart;
   const chunks:number[]=[];
   for(let guard=0;state.field(structuralField).pending.length && guard<10000;guard++){
    ensureSyntaxTree(state,text.length,60000);const p=state.field(structuralField).pending[0];const t=performance.now();
    state=state.update({effects:buildPendingEffect.of({from:p.from,to:Math.min(p.to,p.from+CHUNK)})}).state;chunks.push(performance.now()-t);
   }
   r.pending=state.field(structuralField).pending;r.chunkCount=chunks.length;r.maxChunkMs=Math.max(0,...chunks);r.buildMs=performance.now()-buildStart;
   const defs=visualDefinitions(state);r.definitionProblems=defs.problems;r.unsupportedDefinitions=defs.unsupported;
   const nt=performance.now();const numbering=computeLatexNumbering(syntaxTree(state),(a,b)=>text.slice(a,b),defs,{start,includes:name=>{const s=includes.includes.get(loadKey('input',name));return s===undefined?null:{tree:latexParser.parse(s),read:(a:number,b:number)=>s.slice(a,b)};}});r.numberingMs=performance.now()-nt;
   state=state.update({effects:setNumbering.of(numbering)}).state;
   r.numbering=numbering.entries.map(e=>({...e,line:state.doc.lineAt(Math.min(e.pos,text.length)).number,snippet:text.slice(e.pos,e.pos+160)}));r.labels=Object.fromEntries(numbering.labels);r.counters=numbering.counters;
   r.auxNumberMismatches=[...numbering.labels].filter(([key,target])=>aux.labels[key]&&aux.labels[key].number!==target.number).map(([key,target])=>({key,visual:target.number,aux:aux.labels[key].number}));
   const sf=state.field(structuralField), extents:any[]=[];sf.extents.between(0,text.length,(from,to,m)=>extents.push({from,to,kind:m.kind}));r.constructs=tally(extents.map(e=>e.kind));
   const replacements:any[]=[];sf.decorations.between(0,text.length,(from,to,d)=>{if(d.spec.widget||to>from)replacements.push({from,to,widget:d.spec.widget});});
   const hidden=replacements.filter(e=>e.to>e.from);
   const covered=(a:number,b:number)=>hidden.some(e=>e.from<=a&&e.to>=b);
   const skipped:any[]=[],math:any[]=[],floats:any[]=[],envs:any[]=[];
   syntaxTree(state).iterate({enter(ref){ const n=ref.node;
    if(['Comment','VerbatimEnvironment','TikzPictureEnvironment','VerbCommand','LstInlineCommand','NewCommand','RenewCommand','NewEnvironment','RenewEnvironment','Def','Let','NewTheoremCommand'].includes(n.name)){skipped.push({from:n.from,to:n.to});return false;}
    if(['DollarMath','ParenMath','BracketMath','EquationEnvironment','EquationArrayEnvironment'].includes(n.name)){ math.push(n);return false; }
    if(n.name.endsWith('Environment')){const name=environmentName(n,(a,b)=>text.slice(a,b));envs.push({name,from:n.from,to:n.to});if(/^(figure|table|algorithm|tabular|longtable|xltabular)/.test(name??''))floats.push({name,from:n.from,to:n.to,line:state.doc.lineAt(n.from).number,snippet:text.slice(n.from,Math.min(n.to,n.from+400)),rendered:covered(n.from,n.to)});}
   }});
   r.literalSourceRegions=skipped.filter(s=>!covered(s.from,s.to)).map(s=>({line:state.doc.lineAt(s.from).number,chars:s.to-s.from,type:syntaxTree(state).resolveInner(s.from,1).name,snippet:text.slice(s.from,Math.min(s.to,s.from+120))}));
   r.mathCandidates=math.length;r.mathFallbacks=[];
   for(const n of math){if(covered(n.from,n.to))continue; const sn=text.slice(n.from,n.to); let latex='',display=false;
    if(n.name.endsWith('Environment')){const env=environmentName(n,(a,b)=>text.slice(a,b));const content=n.getChild('Content');if(env&&content){const source=katexForEnvironment(env,text.slice(content.from,content.to));latex=source.latex;display=!source.inline;}}
    else {const d=n.getChild('DisplayMath');const m=d?d.getChild('Math'):n.name==='DollarMath'?n.getChild('InlineMath')?.getChild('Math'):n.getChild('Math');if(m)latex=text.slice(m.from,m.to);display=!!d||n.name==='BracketMath';}
    const expansion=expandLatexMacros(latex,defs,{mode:'math',pos:n.from});const katexInput=withReferenceNumbers(countedRows(expansion.text)?.latex??expansion.text,state);
    r.mathFallbacks.push({line:state.doc.lineAt(n.from).number,from:n.from,to:n.to,snippet:sn,expansionOk:expansion.ok,katexInput,katexFails:!!latex&&renderKatex(katexInput,display)===null});
   }
   const omitted=(a:number,b:number)=>covered(a,b)||skipped.some(s=>s.from<=a&&s.to>=b)||math.some(n=>n.from<=a&&n.to>=b);
   const rawCommands:any[]=[];
   for(const m of text.matchAll(/\\(?:[A-Za-z@]+\*?|[^\s])/g)){const a=m.index!;if(omitted(a,a+m[0].length))continue;rawCommands.push({name:m[0],line:state.doc.lineAt(a).number,snippet:text.slice(a,a+150)});}
   r.rawCommandCounts=tally(rawCommands.map(c=>c.name));r.rawCommandExamples=rawCommands.filter((c,i)=>rawCommands.findIndex(x=>x.name===c.name)===i);r.rawCommandCount=rawCommands.length;
   r.rawEnvironmentCounts=tally(envs.filter(e=>e.name&&!covered(e.from,Math.min(e.from+7,e.to))).map(e=>e.name));r.floatCandidates=floats;
   const parent=document.createElement('div');document.body.append(parent);view=new EditorView({state,parent});await tick();refreshVisualWidgets(view);await tick();
   r.initialView={widgets:view.contentDOM.querySelectorAll('[class*=cm-vis]').length,katexErrors:view.contentDOM.querySelectorAll('.katex-error').length};
   const host=document.createElement('div');document.body.append(host);let position=0;const proxy=new Proxy(view,{get(target,key){if(key==='posAtDOM')return()=>position;if(key==='contentDOM')return host;const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
   const widgetRecords:any[]=[];
   for (const d of replacements.filter(e=>e.widget)) {position=d.from;const mount=document.createElement('div');host.append(mount);
    try {const element=d.widget.toDOM(proxy);mount.append(element);await tick();refreshVisualWidgets(proxy);const nodes=(sel:string)=>[...(element.matches(sel)?[element]:[]),...element.querySelectorAll(sel)];widgetRecords.push({from:d.from,to:d.to,line:state.doc.lineAt(d.from).number,type:d.widget.constructor.name,kind:d.widget.kind??d.widget.spec?.kind,text:element.textContent,raw:nodes('.cm-vis-raw').map((e:any)=>e.textContent),math:nodes('.katex').length,katexErrors:nodes('.katex-error').length,missing:nodes('.cm-vis-missing').map((e:any)=>e.textContent),questionChips:nodes('.cm-vis-ref,.cm-vis-cite').filter((e:any)=>e.textContent.includes('?')).map((e:any)=>e.textContent),captions:nodes('.cm-vis-caption').map((e:any)=>e.textContent),images:nodes('.cm-vis-image-placeholder').map((e:any)=>e.textContent)});}
    catch(e){r.exceptions.push({phase:'toDOM',type:d.widget.constructor.name,line:state.doc.lineAt(d.from).number,error:String(e),stack:(e as Error).stack});}
    mount.remove();
   }
   r.widgetCount=widgetRecords.length;r.widgets=widgetRecords;r.domMath=widgetRecords.reduce((s,w)=>s+w.math,0);r.domKatexErrors=widgetRecords.reduce((s,w)=>s+w.katexErrors,0);
   r.fragmentRaw=tally(widgetRecords.flatMap(w=>w.raw));r.missingRefChips=widgetRecords.filter(w=>w.type==='ChipWidget'&&w.kind==='ref'&&(w.missing.length||w.text.includes('?'))).map(w=>({line:w.line,text:w.text}));r.questionChips=widgetRecords.flatMap(w=>w.questionChips.map((text:string)=>({line:w.line,text})));
   r.unresolvedCitationKeys=widgetRecords.filter(w=>w.type==='ChipWidget').flatMap(w=>{const d=replacements.find(d=>d.from===w.from&&d.widget?.kind==='cite');return d?d.widget.keys.filter((k:string)=>!bib.some(b=>b.key===k)&&!aux.citations[k]).map((key:string)=>({line:w.line,key})):[];});
   r.sourceStable=view.state.doc.toString()===text;
   const moveTo=Math.min(text.length,Math.floor(text.length/2));view.dispatch({selection:{anchor:moveTo}});view.dispatch({effects:mode.reconfigure([])});view.dispatch({effects:mode.reconfigure(latexVisualMode(config))});await tick();r.sourceStableAfterMoveAndModeSwitch=view.state.doc.toString()===text;
   host.remove();view.destroy();view=undefined;parent.remove();
  }catch(e){r.exceptions.push({phase:'file',error:String(e),stack:(e as Error).stack});view?.destroy();}
  r.exceptions.push(...errors.slice(errStart).map(error=>({phase:'console/jsdom',error})));r.totalMs=performance.now()-totalStart;
  fs.writeFileSync(path.join(output,'audit.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({id,file:r.file,chars:r.chars,constructs:r.constructs,mathFallbacks:r.mathFallbacks?.length,rawCommands:r.rawCommandCount,exceptions:r.exceptions.length,ms:r.totalMs}));
 }
}
console.error=oldError;dom.window.close();
}
main().catch(e=>{oldError(e);process.exitCode=1;dom.window.close();});
