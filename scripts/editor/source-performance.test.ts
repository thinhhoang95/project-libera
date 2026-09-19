import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement, Profiler, StrictMode, useRef, useState } from 'react';

// Import ReactDOM only after installing the DOM so native input events use the
// real React change-event path rather than the server capability fallback.
const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {url:'http://localhost',pretendToBeVisual:true});
for (const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Element','Node','MouseEvent','KeyboardEvent'] as const) {
  Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
}
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)});
Object.assign(dom.window.Range.prototype,{getClientRects:()=>[],getBoundingClientRect:()=>new dom.window.DOMRect()});
let createRoot: typeof import('react-dom/client')['createRoot'];
let MarkdownEditor: typeof import('../../src/components/libera/markdown-editor')['MarkdownEditor'];
let SOURCE_DRAFT_DELAY_MS: number;
before(async()=>{({createRoot}=await import('react-dom/client'));({MarkdownEditor,SOURCE_DRAFT_DELAY_MS}=await import('../../src/components/libera/markdown-editor'));});
const setNativeValue=Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!;
async function settle(ms=SOURCE_DRAFT_DELAY_MS+40){await act(async()=>{await new Promise(r=>setTimeout(r,ms));});}

test('source typing updates only the changed highlight line, skips React/workspace commits and preserves exact snapshots',async()=>{
  const source=Array.from({length:500},(_,i)=>`## Heading ${i}\nParagraph ${i}\n`).join('');
  const root=createRoot(document.getElementById('root')!);
  let commits=0, changes:string[]=[], read!:()=>string, external!:(text:string)=>void, switchTab!:(key:string)=>void;
  let echo=true;
  const register=(reader:()=>string)=>{read=reader;return()=>{};};
  function Harness(){
    const [value,setValue]=useState(source),[tab,setTab]=useState('first');
    external=setValue;switchTab=setTab;
    const textareaRef=useRef<HTMLTextAreaElement>(null);
    return createElement(MarkdownEditor,{key:tab,activeFilePath:tab,value,textareaRef,onRegisterDraft:register,
      files:[],openTabs:[],recentFiles:[],formatting:false,imageConverting:false,fontFamily:'monospace',fontSizePx:16,lineHeightPx:24,
      onChange:(text)=>{changes.push(text);if(echo)setValue(text);},onAiFormatSelection:async()=>{},onAiRewriteSelection:async()=>{},onAiImageToMarkdown:async()=>{},onInsertFileLink:()=>{},onInsertImageFile:async()=>{}});
  }
  const type=async(text:string)=>{const input=document.querySelector('textarea')!;await act(async()=>{setNativeValue.call(input,text);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});};
  try{
    await act(async()=>root.render(createElement(StrictMode,null,createElement(Profiler,{id:'source',onRender:()=>commits++},createElement(Harness)))));
    const input=document.querySelector('textarea')!;
    await act(async()=>input.focus());
    await settle(30);
    const layer=document.querySelector('.markdown-editor-highlight-layer')!;
    const firstLine=layer.firstElementChild!;
    const records:MutationRecord[]=[];
    const observer=new dom.window.MutationObserver(list=>records.push(...list));
    observer.observe(layer,{childList:true,characterData:true,subtree:true});
    commits=0;changes=[];
    for(let i=1;i<=20;i++)await type(source+'x'.repeat(i));
    assert.equal(input.value,source+'x'.repeat(20));
    assert.equal(layer.textContent!.replaceAll('\u200b',''),input.value);
    assert.equal(firstLine,layer.firstElementChild);
    assert.ok(records.length>0);
    assert.ok(records.every(r=>r.target===layer.lastElementChild || layer.lastElementChild!.contains(r.target)),'Unchanged lines must not be rewritten');
    assert.equal(commits,0,'Ordinary typing must not render React');
    assert.equal(changes.length,0,'Do not publish each keystroke to the workspace');
    observer.disconnect();
    const retained = Array.from(layer.children);
    await type('Inserted line\n' + input.value);
    retained.forEach((line, i) => assert.equal(layer.children[i + 1], line, 'Newlines retain downstream DOM nodes'));
    await type(input.value.slice('Inserted line\n'.length));
    retained.forEach((line, i) => assert.equal(layer.children[i], line));
    let snapshot='';await act(async()=>{snapshot=read();});
    assert.equal(snapshot,input.value,'Save/export/tab-close reader sees the latest keystroke immediately');
    assert.equal(changes.at(-1),snapshot);
    await type(snapshot+' next');await settle();
    assert.equal(changes.at(-1),input.value);
    // Parent echo can arrive after further typing; it must not reset live text.
    echo=false;
    await type(input.value+' delayed');await settle();
    const delayed=changes.at(-1)!;
    await type(delayed+' newer');
    await act(async()=>external(delayed));
    assert.equal(input.value,delayed+' newer');
    await settle(1100);
    assert.equal(input.value,delayed+' newer','Never roll back to a stale prop after a timeout');
    await act(async()=>external('External replacement\n'));
    assert.equal(input.value,'External replacement\n');
    assert.equal(layer.textContent!.replaceAll('\u200b',''),input.value);
    // Do not publish partially composed IME text after a pause.
    changes=[];
    await act(async()=>input.dispatchEvent(new dom.window.CompositionEvent('compositionstart',{bubbles:true})));
    await type('Tiếng Việt');await settle();
    assert.equal(changes.length,0);
    await act(async()=>input.dispatchEvent(new dom.window.CompositionEvent('compositionend',{bubbles:true})));
    await settle();assert.equal(changes.at(-1),'Tiếng Việt');
    // Cleanup saves the old tab's pending draft before the next editor mounts.
    await type('Last unsaved character');
    await act(async()=>{external('Second tab');switchTab('second');});
    assert.equal(changes.at(-1),'Last unsaved character');
    assert.equal(document.querySelector('textarea')!.value,'Second tab');
  }finally{await act(async()=>root.unmount());}
});

test('source highlight updates propagate through fences and keep find matches current',async()=>{
  const root=createRoot(document.getElementById('root')!);
  const ref={current:null as HTMLTextAreaElement|null};
  await act(async()=>root.render(createElement(MarkdownEditor,{value:'```\n## Hidden\n```\n## Visible\n',textareaRef:ref,files:[],openTabs:[],recentFiles:[],formatting:false,imageConverting:false,fontFamily:'monospace',fontSizePx:16,lineHeightPx:24,onChange:()=>{},onAiFormatSelection:async()=>{},onAiRewriteSelection:async()=>{},onAiImageToMarkdown:async()=>{},onInsertFileLink:()=>{},onInsertImageFile:async()=>{}})));
  try{
    const layer=document.querySelector('.markdown-editor-highlight-layer')!;
    assert.equal(layer.querySelectorAll('.markdown-editor-highlight-tone-heading-2').length,1);
    await act(async()=>{setNativeValue.call(ref.current,'text\n## Hidden\ntext\n## Visible\n');ref.current!.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
    assert.equal(layer.querySelectorAll('.markdown-editor-highlight-tone-heading-2').length,2);
    await act(async()=>ref.current!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true})));
    const find=document.querySelector<HTMLInputElement>('input[placeholder]')!;
    const setInput=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!;
    await act(async()=>{setInput.call(find,'Hidden');find.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
    assert.equal(layer.querySelectorAll('.markdown-editor-find-match').length,1);
  }finally{await act(async()=>root.unmount());}
});
