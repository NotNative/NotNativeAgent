// SPDX-License-Identifier: Apache-2.0
/**
 * Shared in-page probe builders for the installed acceptance journeys and the
 * acceptance-matrix runner. Plain string concatenation only: the quality-gate
 * brace counter mis-lexes template literals with interpolation. Every probe
 * runs inside the installed shell's authenticated browser/desktop window and
 * judges behavior through the installed shell's own /api connection.
 */

export const V2_TITLE = 'V2 browser first turn';
export const TIMELINE_TITLE = 'Installed timeline journey';

export function browserFirstProbe() {
  return '(async()=>{'
    + "const post=async(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});"
    + "const delay=ms=>new Promise(r=>setTimeout(r,ms));"
    + "const getMessages=async id=>{const r=await fetch('/api/session/'+id+'/message');"
    + "if(r.status!==200)throw Error('message read '+r.status);return r.json();};"
    + "const made=await post('/api/session',{title:" + JSON.stringify(V2_TITLE) + '});'
    + 'if(made.status!==201)throw Error(\'create \'+made.status+\': \'+await made.text());'
    + 'const id=(await made.json()).id;'
    + "const sent=await post('/api/session/'+id+'/prompt_async',{messageID:'v2t1',agent:'nna',"
    + "parts:[{type:'text',text:'V2 browser-first governed turn.'}]});"
    + 'if(sent.status!==204)throw Error(\'submit \'+sent.status+\': \'+await sent.text());'
    + 'let list=[];for(let i=0;i<300;i++){list=await getMessages(id);if(list.length>=2)break;await delay(200);}'
    + 'if(list.length<2)throw Error(\'browser-first turn did not settle: \'+list.length);'
    + 'let rows=[];for(let i=0;i<100;i++){'
    + 'rows=[...document.querySelectorAll(\'[data-testid="session-row"]\')].map(r=>r.textContent);'
    + 'if(rows.some(t=>t.includes(' + JSON.stringify(V2_TITLE) + ')))break;await delay(100);}'
    + 'if(!rows.some(t=>t.includes(' + JSON.stringify(V2_TITLE) + ')))'
    + 'throw Error(\'browser session row missing: \'+JSON.stringify(rows));'
    + 'return {session:id,messages:list.length};'
    + '})()';
}

export function desktopObserveProbe() {
  return '(async()=>{'
    + 'const delay=ms=>new Promise(r=>setTimeout(r,ms));'
    + 'let rows=[];for(let i=0;i<150;i++){'
    + 'rows=[...document.querySelectorAll(\'[data-testid="session-row"]\')].map(r=>r.textContent);'
    + 'if(rows.some(t=>t.includes(' + JSON.stringify(V2_TITLE) + ')))break;await delay(100);}'
    + 'if(!rows.some(t=>t.includes(' + JSON.stringify(V2_TITLE) + ')))'
    + 'throw Error(\'desktop window did not show the browser-created session: \'+JSON.stringify(rows));'
    + 'const pill=document.querySelector(\'[data-testid="connection-pill"]\');'
    + 'if(!pill)throw Error(\'desktop connection pill missing\');'
    + 'return {sawSession:true,pill:pill.textContent};'
    + '})()';
}

export function serviceStopProbe() {
  return '(async()=>{/*STOP_OBSERVE*/'
    + "const delay=ms=>new Promise(r=>setTimeout(r,ms));"
    // The tab loaded while the service was alive; wait for the driver's
    // delayed explicit stop to take effect, then judge the offline state.
    + 'let live=true;const deadline=Date.now()+180000;'
    + 'while(Date.now()<deadline){try{const r=await fetch(\'/api/v1/nnd/setup/status\');live=r.status===200;}'
    + 'catch(error){live=false;}if(!live)break;await delay(500);}'
    + 'if(live)throw Error(\'service never stopped under the loaded browser tab\');'
    + 'const pill=document.querySelector(\'[data-testid="connection-pill"]\');'
    + 'if(!pill)throw Error(\'browser connection pill missing while stopped\');'
    + 'let outcome;try{const r=await fetch(\'/api/v1/nnd/setup/status\');outcome={status:r.status};}'
    + 'catch(error){outcome={status:\'unreachable\'};}'
    + 'if(outcome.status===200)throw Error(\'stopped service still served status 200\');'
    + 'return {outcome,pill:pill.textContent,stillRendered:document.body.textContent.length>0};'
    + '})()';
}

export function afterRestartProbe(sessionId) {
  return '(async()=>{'
    + "const delay=ms=>new Promise(r=>setTimeout(r,ms));"
    + "const getMessages=async id=>{const r=await fetch('/api/session/'+id+'/message');"
    + "if(r.status!==200)throw Error('message read '+r.status);return r.json();};"
    + 'const listed=await fetch(\'/api/session\');'
    + 'if(listed.status!==200)throw Error(\'session list \'+listed.status);'
    + 'const delay2=ms=>new Promise(r=>setTimeout(r,ms));'
    + 'let view=await listed.json();'
    + 'const findSession=()=>(view.recent??[]).some(item=>item.id===' + JSON.stringify(sessionId) + ');'
    + 'for(let i=0;i<120&&!findSession();i++){await delay2(500);'
    + 'const again=await fetch(\'/api/session\');if(again.status!==200)throw Error(\'session list \'+again.status);'
    + 'view=await again.json();}'
    + 'let list=[];for(let i=0;i<300;i++){list=await getMessages(' + JSON.stringify(sessionId) + ');'
    + 'if(list.length>=2)break;await delay(200);}'
    + 'if(list.length!==2)throw Error(\'restart duplicated or lost turn history: \'+list.length);'
    + 'return {recent:(view.recent??[]).length,messages:list.length};'
    + '})()';
}

export function timelineForkRevertProbe() {
  return '(async()=>{'
    + "const post=async(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});"
    + "const delay=ms=>new Promise(r=>setTimeout(r,ms));"
    + "const getMessages=async id=>{const r=await fetch('/api/session/'+id+'/message');"
    + "if(r.status!==200)throw Error('message read '+r.status);return r.json();};"
    + "const waitCount=async(id,n)=>{for(let i=0;i<300;i++){const list=await getMessages(id);"
    + 'if(list.length>=n)return list;await delay(200);}'
    + "throw Error('timeline did not settle: '+id);};"
    + "const submit=async(id,promptId)=>{const r=await post('/api/session/'+id+'/prompt_async',"
    + "{messageID:promptId,agent:'nna',parts:[{type:'text',text:'Installed timeline journey turn.'}]});"
    + "if(r.status!==204)throw Error('submit '+r.status+' '+await r.text());};"
    + "const created=await post('/api/session',{title:" + JSON.stringify(TIMELINE_TITLE) + '});'
    + "if(created.status!==201)throw Error('create '+created.status+' '+await created.text());"
    + 'const parent=(await created.json()).id;'
    + "await submit(parent,'t1');await waitCount(parent,2);"
    + "await submit(parent,'t2');await waitCount(parent,4);"
    + "const fork=await post('/api/session/'+parent+'/fork',{messageID:'t2'});"
    + "if(fork.status!==201)throw Error('fork '+fork.status+' '+await fork.text());"
    + 'const child=(await fork.json()).id;'
    + "if(typeof child!=='string')throw Error('fork lacked a child id');"
    + 'const childInherited=await getMessages(child);'
    + 'if(childInherited.length!==4)throw Error(\'child history \'+JSON.stringify(childInherited.map(m=>m.info.id)));'
    + "await submit(child,'t3');await waitCount(child,6);"
    + "const revert=await post('/api/session/'+child+'/revert',{messageID:'t3'});"
    + "if(revert.status!==200)throw Error('revert '+revert.status+' '+await revert.text());"
    + 'const afterRevert=await getMessages(child);'
    + 'if(afterRevert.length!==4)throw Error(\'revert did not hide the turn: \'+afterRevert.length);'
    + "const unrevert=await post('/api/session/'+child+'/unrevert',{});"
    + "if(unrevert.status!==200)throw Error('unrevert '+unrevert.status+' '+await unrevert.text());"
    + 'const restored=await getMessages(child);'
    + 'if(!(restored.length>=6&&restored.some(m=>m.info.id===\'t3\')))'
    + 'throw Error(\'unrevert did not restore: \'+restored.length);'
    + 'const parentNow=await getMessages(parent);'
    + 'if(parentNow.length!==4)throw Error(\'parent moved: \'+parentNow.length);'
    + 'let rowText=[];'
    + 'for(let i=0;i<100;i++){'
    + 'rowText=[...document.querySelectorAll(\'[data-testid="session-row"]\')].map(r=>r.textContent);'
    + 'if(rowText.length>=2)break;await delay(100);}'
    + 'if(rowText.length<2)throw Error(\'session rows did not render: \'+rowText.length);'
    + 'if(!rowText.some(t=>t.includes(' + JSON.stringify(TIMELINE_TITLE) + ')))'
    + 'throw Error(\'parent row missing: \'+JSON.stringify(rowText));'
    + 'return {parent,child,inherited:childInherited.length,restored:restored.length,rows:rowText.length};'
    + '})()';
}

export function multirunProfileProbe(providerEndpoint) {
  return '(async()=>{'
    + "const post=async(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});"
    + "const profile=await post('/api/v1/provider-profiles',{profile_id:'secondary',display_name:'F9 secondary',"
    + 'endpoint:' + JSON.stringify(providerEndpoint) + ",model:'test-alt'});"
    + 'if(profile.status!==201)throw Error(\'profile create \'+profile.status+\': \'+await profile.text());'
    + 'const made=(await profile.json()).profile;'
    + 'if(!made||made.profile_id!==\'secondary\'||made.model!==\'test-alt\')'
    + 'throw Error(\'profile receipt \'+JSON.stringify(made));'
    + 'return {created:\'secondary\'};'
    + '})()';
}

export function timelineMultirunProbe() {
  return '(async()=>{'
    + "const post=async(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});"
    + "const delay=ms=>new Promise(r=>setTimeout(r,ms));"
    + "const getMessages=async id=>{const r=await fetch('/api/session/'+id+'/message');"
    + "if(r.status!==200)throw Error('message read '+r.status);return r.json();};"
    + "const waitCount=async(id,n)=>{for(let i=0;i<300;i++){const list=await getMessages(id);"
    + 'if(list.length>=n)return list;await delay(200);}'
    + "throw Error('timeline did not settle: '+id);};"
    + "const submit=async(id,promptId,body)=>{const r=await post('/api/session/'+id+'/prompt_async',"
    + "Object.assign({messageID:promptId,agent:'nna',parts:[{type:'text',text:'F9 route observation prompt.'}]},body||{}));"
    + "if(r.status!==204)throw Error('submit '+promptId+' '+r.status+' '+await r.text());};"
    + "const madeA=await post('/api/session',{title:'F9 installed route A'});if(madeA.status!==201)throw Error('A '+madeA.status);"
    + 'const madeB=await post(\'/api/session\',{title:\'F9 installed route B\',providerID:\'secondary\',model:\'test-alt\'});'
    + "if(madeB.status!==201)throw Error('B '+madeB.status+' '+await madeB.text());"
    + 'const recordA=await madeA.json();const recordB=await madeB.json();'
    + 'const a=recordA.id;const b=recordB.id;'
    + 'const configuredB=recordB.metadata.nnd.configuredModel;'
    + 'if(JSON.stringify(configuredB)!==JSON.stringify({providerID:\'secondary\',modelID:\'test-alt\'}))'
    + 'throw Error(\'session B route \'+JSON.stringify(configuredB));'
    + "await submit(a,'f9a',{});await submit(b,'f9b',{});"
    + 'await waitCount(a,2);await waitCount(b,2);'
    + 'const override=await post(\'/api/session/\'+a+\'/prompt_async\',{messageID:\'f9x\',agent:\'nna\','
    + "parts:[{type:'text',text:'F9 route observation prompt.'}],model:{providerID:'secondary',modelID:'test-alt'}});"
    + 'if(override.status!==400)throw Error(\'override not refused: \'+override.status);'
    + 'const overrideBody=await override.json();'
    + 'if(overrideBody.error.code!==\'nnd_model_override_unsupported\')'
    + 'throw Error(\'override code \'+overrideBody.error.code);'
    + 'return {sessionA:a,sessionB:b,configuredB};'
    + '})()';
}
