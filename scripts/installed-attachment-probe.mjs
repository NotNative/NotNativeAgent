// SPDX-License-Identifier: Apache-2.0
/** Disposable provider and browser probe for the installed F3 attachment path. */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

export const TEXT_MARKER = 'NND_INSTALLED_TEXT_MARKER';
export const IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a00000000', 'hex'), Buffer.from('NND_INSTALLED_IMAGE_MARKER')]);
export const REPLY = 'NND_INSTALLED_ATTACHMENT_REPLY';
export const UI_TEXT_MARKER = 'NND_INSTALLED_UI_TEXT_MARKER';
export const UI_IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a00000000', 'hex'), Buffer.from('NND_INSTALLED_UI_IMAGE_MARKER')]);
export const REVIEW_ALLOWED_FILE = 'ALPHA_REVIEW_ALLOWED.txt';
export const REVIEW_DENIED_FILE = 'ALPHA_REVIEW_DENIED.txt';
export const REVIEW_ALLOWED_CONTENT = 'installed-native-review-allowed';

export function reviewProviderDelta(body, reviews) {
  if (body.messages?.[0]?.content?.includes('isolated tool-permission decision')) {
    const review = JSON.parse(body.messages.find(message => message.role === 'user')?.content ?? '{}');
    const intent = review.authenticatedIntent?.findLast(item => typeof item.content === 'string'
      && /NND_ALPHA_REVIEW_(?:ALLOW|DENY)/u.test(item.content));
    const mode = intent?.content?.includes('NND_ALPHA_REVIEW_ALLOW') ? 'allow' : 'deny';
    const approved = mode === 'allow' && review.request?.toolName === 'fs_write_text'
      && review.request.args?.path === REVIEW_ALLOWED_FILE
      && review.request.args?.content_sha256 === createHash('sha256').update(REVIEW_ALLOWED_CONTENT).digest('hex')
      && review.request.args?.content_bytes === Buffer.byteLength(REVIEW_ALLOWED_CONTENT);
    reviews.push({ mode, approved: Boolean(approved), tool: review.request?.toolName });
    return { delta: { role: 'assistant', content: JSON.stringify({
      outcome: approved ? 'approve' : 'deny_with_guidance', confidence: 1,
      reason_code: approved ? 'exact_alpha_fixture_write' : 'alpha_fixture_write_mismatch',
      authority_anchors: approved ? [intent.sequence] : [],
      ...(!approved ? { guidance: 'This fixture permits only its exact approved write.' } : {}),
    }) }, toolCall: false };
  }
  const userText = String(body.messages?.filter(message => message.role === 'user').at(-1)?.content ?? '');
  const mode = userText.includes('NND_ALPHA_REVIEW_ALLOW') ? 'allow'
    : userText.includes('NND_ALPHA_REVIEW_DENY') ? 'deny' : null;
  if (!mode) return { delta: { role: 'assistant', content: REPLY }, toolCall: false };
  const searchId = `nnd_alpha_review_search_${mode}`;
  const writeId = `nnd_alpha_review_write_${mode}`;
  const searched = body.messages?.some(message => message.role === 'tool' && message.tool_call_id === searchId);
  const result = body.messages?.find(message => message.role === 'tool' && message.tool_call_id === writeId);
  if (!searched) return { delta: { role: 'assistant', tool_calls: [{ index: 0, id: searchId, type: 'function',
    function: { name: 'tool_search', arguments: JSON.stringify({ query: 'fs_write_text' }) } }] }, toolCall: true };
  if (!result) return { delta: { role: 'assistant', tool_calls: [{ index: 0, id: writeId, type: 'function',
    function: { name: 'fs_write_text', arguments: JSON.stringify({
      path: mode === 'allow' ? REVIEW_ALLOWED_FILE : REVIEW_DENIED_FILE,
      content: REVIEW_ALLOWED_CONTENT,
    }) } }] }, toolCall: true };
  const tool = JSON.parse(result.content);
  return { delta: { role: 'assistant', content: mode === 'allow'
    ? tool.tool_lifecycle_status === 'succeeded' ? 'NND_ALPHA_REVIEW_ALLOW_PASS' : 'NND_ALPHA_REVIEW_ALLOW_FAIL'
    : tool.tool_lifecycle_status !== 'succeeded' ? 'NND_ALPHA_REVIEW_DENY_PASS' : 'NND_ALPHA_REVIEW_DENY_FAIL' }, toolCall: false };
}

export async function startAttachmentProvider() {
  const requests = [];
  const reviews = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const { delta, toolCall } = reviewProviderDelta(body, reviews);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: toolCall ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('attachment provider did not bind');
  return { server, port: address.port, requests, reviews };
}

export function attachmentBrowserProbe() {
  const textData = `data:text/plain;base64,${Buffer.from(TEXT_MARKER).toString('base64')}`;
  const imageData = `data:image/png;base64,${IMAGE.toString('base64')}`;
  return `(async()=>{
    const post=async(path,body)=>fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    for(let i=0;i<100&&!document.querySelector('[data-testid="native-alpha-notice"]');i++)
      await new Promise(resolve=>setTimeout(resolve,100));
    if(!document.querySelector('[data-testid="native-alpha-notice"]')
      || !document.querySelector('[data-testid="git-toggle"]')?.disabled
      || !document.querySelector('[data-testid="files-toggle"]')?.disabled)
      throw Error('installed native alpha controls were not marked unavailable');
    window.dispatchEvent(new Event('nnd:scheduled-tasks-open'));
    window.dispatchEvent(new CustomEvent('nnd:files-open',{detail:{directory:'C:/untrusted',path:'outside.txt'}}));
    await new Promise(resolve=>setTimeout(resolve,100));
    if(document.querySelector('[data-testid="scheduled-tasks-dialog"],[data-testid="files-view"]'))
      throw Error('installed native alpha secondary entry opened an unavailable surface');
    const terminal=await fetch('/api/terminal/shells');
    if(terminal.status!==409||(await terminal.json()).code!=='native_terminal_unavailable')
      throw Error('installed native terminal was available');
    const spawn=await post('/api/terminal/create',{cwd:'C:/unadmitted',mode:'command',command:'echo unsafe'});
    if(spawn.status!==409||(await spawn.json()).code!=='native_terminal_unavailable')
      throw Error('installed native PTY creation was available');
    for(const path of ['/api/fs/write','/api/git/commit','/api/git/worktrees',
      '/api/message-queue/sessions/untrusted/items','/api/openchamber/tunnel/start',
      '/api/notnative/update-install','/api/openchamber/update-install']){
      const refused=await post(path,{});
      if(refused.status!==409||(await refused.json()).code!=='native_alpha_surface_unavailable')
        throw Error('installed native alpha mutation was available '+path+' '+refused.status);
    }
    const made=await post('/api/session',{});if(made.status!==201)throw Error('session '+made.status);
    const session=await made.json();const id=session.id;
    for(const item of [
      {upload_id:'installed_text',filename:'notes.txt',mime_type:'text/plain',data_url:${JSON.stringify(textData)}},
      {upload_id:'installed_image',filename:'marker.png',mime_type:'image/png',data_url:${JSON.stringify(imageData)}}]){
      const uploaded=await post('/api/v1/nnd/sessions/'+encodeURIComponent(id)+'/attachments',item);
      if(uploaded.status!==201)throw Error('upload '+item.upload_id+' '+uploaded.status+' '+await uploaded.text());
    }
    const requestId='installed_attachment_prompt';
    const promptBody={
      messageID:requestId,parts:[{type:'text',text:''},{type:'file',upload_id:'installed_text'},
        {type:'file',upload_id:'installed_image'}]};
    const submitted=await post('/api/session/'+encodeURIComponent(id)+'/prompt_async',promptBody);
    if(submitted.status!==204)throw Error('prompt '+submitted.status+' '+await submitted.text());
    const deadline=Date.now()+300000;
    while(Date.now()<deadline){
      const response=await fetch('/api/session/'+encodeURIComponent(id)+'/activity');
      if(response.status!==200)throw Error('activity '+response.status);
      const activity=await response.json();const turn=activity.find(row=>row.id===id+':turn:'+requestId);
      if(turn?.status==='completed'){
        const retry=await post('/api/session/'+encodeURIComponent(id)+'/prompt_async',promptBody);
        if(retry.status!==204)throw Error('retry '+retry.status+' '+await retry.text());
        const messages=await fetch('/api/session/'+encodeURIComponent(id)+'/message');
        if(messages.status!==200)throw Error('messages '+messages.status);
        const transcript=await messages.json();
        const submittedRows=transcript.filter(row=>row.info?.id===requestId);
        if(submittedRows.length!==1)throw Error('duplicate prompt rows '+submittedRows.length);
        const ui=await ${composerBrowserProbe()};
        return {session_id:id,turn_status:turn.status,summary:turn.summary,duplicate_rows:submittedRows.length,...ui};
      }
      if(turn&&turn.status!=='started')throw Error('turn '+turn.status+' '+turn.summary);
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw Error('installed attachment turn did not settle');
  })()`;
}

export function setupBrowserProbe(workspaceRoot, providerPort) {
  return `(async()=>{
    const post=async(path,body)=>fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const before=await fetch('/api/v1/nnd/setup/status');
    if(before.status!==200)throw Error('setup status '+before.status);
    const initial=await before.json();
    if(initial.service_state!=='setup_required'||initial.execution_state!=='unavailable')
      throw Error('fresh install did not require setup '+JSON.stringify(initial));
    const denied=await post('/api/session',{});
    if(denied.status!==503)throw Error('unconfigured execution was admitted '+denied.status);
    const read=await fetch('/api/v1/nnd/configuration');
    if(read.status!==200)throw Error('configuration read '+read.status+' '+await read.text());
    const view=await read.json();
    if(view.source_state!=='missing'||view.source_revision!=='absent')
      throw Error('fresh configuration source was not missing '+JSON.stringify({state:view.source_state,revision:view.source_revision}));
    const configurationDocument={workspace_root:${JSON.stringify(workspaceRoot)},provider:{id:'smoke',
      endpoint:${JSON.stringify(`http://127.0.0.1:${providerPort}/v1`)},model:'test',trust_zone:'loopback'}};
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const gear=document.querySelector('[data-testid="settings-gear"]');
    if(!gear)throw Error('installed settings control missing');gear.click();
    const navigate=async label=>{for(let i=0;i<100;i++){
      const item=[...document.querySelectorAll('[data-testid="settings-window"] nav button')]
        .find(button=>button.textContent?.trim()===label);
      if(item){item.click();return}await delay(100)}throw Error('settings page missing '+label)};
    await navigate('NNA configuration');
    let editor,confirm,repair;
    for(let i=0;i<300;i++){
      editor=[...document.querySelectorAll('label')].find(label=>label.textContent?.includes('Repair document as JSON'))?.querySelector('textarea');
      confirm=[...document.querySelectorAll('label')].find(label=>label.textContent?.includes('I understand this replaces'))?.querySelector('input[type="checkbox"]');
      repair=[...document.querySelectorAll('button')].find(button=>button.textContent?.trim()==='Repair selected source');
      if(editor&&confirm&&repair)break;await delay(100)}
    if(!editor||!confirm||!repair)throw Error('native repair form missing '+JSON.stringify({
      labels:[...document.querySelectorAll('[data-testid="settings-window"] label')].map(label=>label.textContent?.slice(0,60)).slice(0,20),
      alerts:[...document.querySelectorAll('[data-testid="settings-window"] [role="alert"]')].map(item=>item.textContent?.slice(0,100)).slice(0,8)}));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,JSON.stringify(configurationDocument));
    editor.dispatchEvent(new Event('input',{bubbles:true}));confirm.click();
    for(let i=0;i<50&&repair.disabled;i++)await delay(100);
    if(repair.disabled)throw Error('native repair form stayed disabled');repair.click();
    let saved=false;for(let i=0;i<200;i++){
      saved=document.querySelector('[data-testid="settings-window"]')?.textContent?.includes('receipt: saved');
      if(saved)break;await delay(100)}
    if(!saved)throw Error('native GUI repair did not publish a saved receipt');
    await navigate('Providers');
    let activate;for(let i=0;i<100;i++){
      activate=[...document.querySelectorAll('button')].find(button=>button.textContent?.trim()==='Activate NNA execution');
      if(activate&&!activate.disabled)break;await delay(100)}
    if(!activate||activate.disabled)throw Error('native GUI activation unavailable');
    activate.click();
    return {setup_before:initial.service_state,setup_receipt:'saved',ui_activation_started:true};
  })()`;
}

export function desktopSetupProbe() {
  return `(async()=>{
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const response=await fetch('/api/v1/nnd/setup/status');
    if(response.status!==200)throw Error('desktop setup status '+response.status);
    const setup=await response.json();
    if(setup.service_state!=='setup_required'||setup.execution_state!=='unavailable')
      throw Error('desktop did not show setup-required authority '+JSON.stringify(setup));
    const denied=await fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    if(denied.status!==503)throw Error('desktop unconfigured execution was admitted '+denied.status);
    let gear;for(let i=0;i<100;i++){
      gear=document.querySelector('[data-testid="settings-gear"]');if(gear)break;await delay(100)}
    if(!gear)throw Error('desktop settings control missing during setup');gear.click();
    let page;for(let i=0;i<100;i++){
      page=[...document.querySelectorAll('[data-testid="settings-window"] nav button')]
        .find(button=>button.textContent?.trim()==='NNA configuration');
      if(page)break;await delay(100)}
    if(!page)throw Error('desktop NNA configuration page missing');page.click();
    let repair;for(let i=0;i<300;i++){
      repair=[...document.querySelectorAll('[data-testid="settings-window"] label')]
        .find(label=>label.textContent?.includes('Repair document as JSON'))?.querySelector('textarea');
      if(repair)break;await delay(100)}
    if(!repair){const config=await fetch('/api/v1/nnd/configuration');
      const catalog=await fetch('/api/v1/nnd/configuration/catalog');
      const settingsText=document.querySelector('[data-testid="settings-window"]')?.textContent??'';
      throw Error('desktop native repair form missing '+JSON.stringify({
        config_status:config.status,catalog_status:catalog.status,
        repair_text_present:settingsText.includes('Repair document as JSON'),
        catalog_unavailable:settingsText.includes('Configuration catalog unavailable'),
        textarea_labels:[...document.querySelectorAll('[data-testid="settings-window"] textarea')]
          .map(item=>item.closest('label')?.textContent?.slice(0,100)),
        repair_labels:[...document.querySelectorAll('[data-testid="settings-window"] label')]
          .filter(item=>item.textContent?.toLowerCase().includes('repair')).map(item=>item.textContent?.slice(0,100)).slice(0,8),
        alerts:[...document.querySelectorAll('[data-testid="settings-window"] [role="alert"]')]
          .map(item=>item.textContent?.slice(0,120)).slice(0,5)}))}
    return {service_state:setup.service_state,execution_state:setup.execution_state,
      execution_status:denied.status,repair_visible:true};
  })()`;
}

export function setupReloadComposerProbe() {
  const marker = `Installed setup text turn ${randomUUID()}`;
  return `(async()=>{
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    console.log('NND_PROBE_STEP:setup_reloaded');
    const settings=document.querySelector('[data-testid="settings-window"]');
    if(settings){const close=[...settings.querySelectorAll('header button')].find(button=>button.textContent?.trim()==='✕');
      if(!close)throw Error('settings close control missing after activation');close.click()}
    let composer;for(let i=0;i<100;i++){composer=document.querySelector('[data-testid="composer"]');if(composer)break;await delay(100)}
    if(!composer)throw Error('composer missing after native activation reload');
    const newSession=[...document.querySelectorAll('button')].find(button=>button.textContent?.trim()==='+ New session');
    if(!newSession)throw Error('new session control missing after native activation');newSession.click();
    let send;for(let i=0;i<150;i++){
      const form=document.querySelector('[data-testid="composer"]');
      const input=document.querySelector('[data-testid="composer-editor"]');
      if(form&&input&&!form.getAttribute('data-send-blocked')){
        if(input.value!==${JSON.stringify(marker)}){
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(marker)});
          input.dispatchEvent(new Event('input',{bubbles:true}))}}
      send=document.querySelector('[data-testid="composer"] button[aria-label="Send message"]');
      if(send&&!send.disabled)break;await delay(100)}
    if(!send||send.disabled){const configResponse=await fetch('/api/config');
      const configBody=await configResponse.text();
      throw Error('text send disabled after native activation reload '+JSON.stringify({
      blocked:document.querySelector('[data-testid="composer"]')?.getAttribute('data-send-blocked'),
      draft:document.querySelector('[data-testid="composer-editor"]')?.value,
      configStatus:configResponse.status,configBody:configBody.slice(0,800),
      alerts:[...document.querySelectorAll('[role="alert"]')].map(row=>row.textContent?.slice(0,100)).slice(0,5)}))}
    send.click();
    console.log('NND_PROBE_STEP:setup_text_sent');
    const deadline=Date.now()+300000;
    while(Date.now()<deadline){
      const rows=await(await fetch('/api/session?roots=true')).json();
      for(const row of rows){
        const messages=await(await fetch('/api/session/'+encodeURIComponent(row.id)+'/message')).json();
        if(!messages.some(message=>message.info?.role==='user'&&message.parts?.some(part=>part.text?.includes(${JSON.stringify(marker)}))))continue;
        const activity=await(await fetch('/api/session/'+encodeURIComponent(row.id)+'/activity')).json();
        const turn=activity.find(item=>item.kind==='turn'&&item.status==='completed');
        if(turn)return {session_id:row.id,directory:row.directory,status:turn.status};
        const failed=activity.find(item=>item.kind==='turn'&&item.status!=='started');
        if(failed)throw Error('setup text turn '+failed.status+' '+failed.summary)}
      await delay(500)}
    const rows=await(await fetch('/api/session?roots=true')).json();
    const recent=rows.slice(0,5);
    const activity=await Promise.all(recent.map(async row=>({id:row.id,
      status:(await fetch('/api/session/'+encodeURIComponent(row.id)+'/activity')).status})));
    throw Error('setup text composer turn did not settle '+JSON.stringify({
      recent:recent.map(row=>({id:row.id,title:row.title})),activity,
      workspace:document.querySelector('select[aria-label="Workspace"]')?.value??null,
      blocked:document.querySelector('[data-testid="composer"]')?.getAttribute('data-send-blocked'),
      draft:document.querySelector('[data-testid="composer-editor"]')?.value,
      alerts:[...document.querySelectorAll('[role="alert"],[data-sonner-toast]')].map(row=>row.textContent?.slice(0,100)).slice(0,8)}));
  })()`;
}

export function reviewBrowserProbe() {
  return `(async()=>{
    const post=(path,body)=>fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const outcomes=[];
    for(const mode of ['allow','deny']){
      const created=await post('/api/session',{title:'Installed native review '+mode});
      if(created.status!==201)throw Error('review session '+mode+' '+created.status+' '+await created.text());
      const session=await created.json();
      const marker=mode==='allow'?'NND_ALPHA_REVIEW_ALLOW':'NND_ALPHA_REVIEW_DENY';
      const prompt=await post('/api/session/'+encodeURIComponent(session.id)+'/prompt_async',{
        messageID:'alpha_review_'+mode+'_'+crypto.randomUUID(),parts:[{type:'text',text:marker}]});
      if(prompt.status!==204)throw Error('review prompt '+mode+' '+prompt.status+' '+await prompt.text());
      const deadline=Date.now()+300000;let activity=[];let tool;
      while(Date.now()<deadline){
        const response=await fetch('/api/session/'+encodeURIComponent(session.id)+'/activity');
        if(response.status!==200)throw Error('review activity '+mode+' '+response.status);
        activity=await response.json();
        tool=activity.find(item=>item.kind==='tool'&&item.summary?.startsWith('fs_write_text:')
          &&item.status===(mode==='allow'?'completed':'failed'));
        if(tool)break;
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      if(!tool)throw Error('native reviewer tool did not settle '+mode+' '+JSON.stringify(activity.slice(-8)));
      outcomes.push({mode,session_id:session.id,tool_status:tool.status,
        reason_code:tool.toolEvidence?.reasonCode??null});
    }
    return {reviews:outcomes};
  })()`;
}

export function desktopReviewProbe() {
  return `(async()=>{
    const marker='NND_ALPHA_REVIEW_ALLOW';
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    let newSession;for(let i=0;i<100;i++){
      newSession=[...document.querySelectorAll('button')].find(button=>button.textContent?.trim()==='+ New session');
      if(newSession)break;await delay(100)}
    if(!newSession)throw Error('desktop new session control missing');newSession.click();
    let send;for(let i=0;i<150;i++){
      const input=document.querySelector('[data-testid="composer-editor"]');
      if(input&&input.value!==marker){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,marker);
        input.dispatchEvent(new Event('input',{bubbles:true}))}
      send=document.querySelector('[data-testid="composer"] button[aria-label="Send message"]');
      if(send&&!send.disabled)break;await delay(100)}
    if(!send||send.disabled)throw Error('desktop review composer send disabled');send.click();
    const deadline=Date.now()+120000;let sessionID=null;let tool=null;
    while(Date.now()<deadline){
      const sessions=await(await fetch('/api/session?roots=true')).json();
      for(const session of sessions){
        const messages=await(await fetch('/api/session/'+encodeURIComponent(session.id)+'/message')).json();
        if(!messages.some(message=>message.info?.role==='user'&&message.parts?.some(part=>part.text?.includes(marker))))continue;
        sessionID=session.id;
        const activity=await(await fetch('/api/session/'+encodeURIComponent(session.id)+'/activity')).json();
        tool=activity.find(item=>item.kind==='tool'&&item.summary?.startsWith('fs_write_text:')&&item.status==='completed');
        if(tool)break;
      }
      if(tool)break;await delay(500);
    }
    if(!tool)throw Error('desktop reviewed write did not complete '+sessionID);
    const activityButton=document.querySelector('[data-testid="operator-rail"] button[aria-label="Activity"]');
    if(!activityButton)throw Error('desktop Activity control missing');activityButton.click();
    let visible=false;for(let i=0;i<100;i++){
      visible=[...document.querySelectorAll('[data-testid="activity-rows"] li')].some(row=>
        row.textContent?.includes('fs_write_text:')&&row.textContent?.includes('completed'));
      if(visible)break;await delay(100)}
    if(!visible)throw Error('desktop reviewed write absent from visible Activity rows');
    return {session_id:sessionID,tool_status:tool.status,activity_visible:visible};
  })()`;
}

function composerBrowserProbe() {
  return `(async()=>{
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    console.log('NND_PROBE_STEP:composer_start');
    let composer;for(let i=0;i<100;i++){composer=document.querySelector('[data-testid="composer"]');if(composer)break;await delay(100)}
    if(!composer)throw Error('installed composer did not mount');
    const newSession=[...document.querySelectorAll('button')].find(button=>button.textContent?.trim()==='+ New session');
    if(!newSession)throw Error('new session control missing');newSession.click();
    const input=document.querySelector('[data-testid="composer"] input[type="file"]');
    if(!input)throw Error('composer file input missing');
    const sessionsBeforeUnsupported=await (await fetch('/api/session?roots=true')).json();
    const priorUnsupported=new Set(sessionsBeforeUnsupported.map(row=>row.id));
    const unsupported=new DataTransfer();
    unsupported.items.add(new File(['unsupported fixture'],'unsupported.pdf',{type:'application/pdf'}));
    input.files=unsupported.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    let rejectedSend;
    for(let i=0;i<100;i++){
      rejectedSend=document.querySelector('[data-testid="composer"] button[aria-label="Send message"]');
      if(document.querySelector('[aria-label="Remove unsupported.pdf"]')&&rejectedSend&&!rejectedSend.disabled)break;
      await delay(100);
    }
    if(!rejectedSend||rejectedSend.disabled)throw Error('unsupported file-only draft did not enable');
    rejectedSend.click();
    let rejectionShown=false;
    const rejectionDeadline=Date.now()+120000;
    while(Date.now()<rejectionDeadline){
      if(document.body.textContent?.includes('Message failed to send. Attachments restored.')){rejectionShown=true;break}
      await delay(250);
    }
    const retained=Boolean(document.querySelector('[aria-label="Remove unsupported.pdf"]'));
    if(!rejectionShown||!retained)
      throw Error('unsupported upload did not reject and preserve the composer draft '+JSON.stringify({rejectionShown,retained,
        toast:[...document.querySelectorAll('[data-sonner-toast]')].map(row=>row.textContent?.slice(0,160))}));
    const afterUnsupported=await (await fetch('/api/session?roots=true')).json();
    const rejectedSession=afterUnsupported.find(row=>!priorUnsupported.has(row.id));
    if(!rejectedSession)throw Error('unsupported upload did not create an isolated native session');
    const rejectedActivity=await (await fetch('/api/session/'+encodeURIComponent(rejectedSession.id)+'/activity')).json();
    if(rejectedActivity.some(row=>row.kind==='turn'))throw Error('unsupported upload started a native turn');
    const remove=document.querySelector('[aria-label="Remove unsupported.pdf"]');
    remove.click();
    for(let i=0;i<100&&document.querySelector('[aria-label="Remove unsupported.pdf"]');i++)await delay(100);
    if(document.querySelector('[aria-label="Remove unsupported.pdf"]'))throw Error('unsupported draft could not be corrected');
    const before=await (await fetch('/api/session?roots=true')).json();
    const prior=new Set(before.map(row=>row.id));
    const bytes=value=>Uint8Array.from(atob(value),char=>char.charCodeAt(0));
    const files=new DataTransfer();
    files.items.add(new File([${JSON.stringify(UI_TEXT_MARKER)}],'ui-notes.txt',{type:'text/plain'}));
    files.items.add(new File([bytes(${JSON.stringify(UI_IMAGE.toString('base64'))})],'ui-marker.png',{type:'image/png'}));
    input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    let send;for(let i=0;i<100;i++){
      send=document.querySelector('[data-testid="composer"] button[aria-label="Send message"]');
      if(document.querySelectorAll('[data-testid="composer-attachments"] button').length===2&&send&&!send.disabled)break;
      await delay(100);
    }
    if(!send||send.disabled)throw Error('file-only composer send did not enable');send.click();
    console.log('NND_PROBE_STEP:composer_sent');
    const deadline=Date.now()+300000;let made;
    while(Date.now()<deadline){
      const rows=await (await fetch('/api/session?roots=true')).json();made=rows.find(row=>!prior.has(row.id));
      if(made){const activity=await (await fetch('/api/session/'+encodeURIComponent(made.id)+'/activity')).json();
        const turn=activity.find(row=>row.kind==='turn'&&row.status==='completed');
        if(turn){console.log('NND_PROBE_STEP:composer_completed');return {ui_session_id:made.id,ui_turn_status:turn.status}}
        const failed=activity.find(row=>row.kind==='turn'&&row.status!=='started');
        if(failed)throw Error('composer turn '+failed.status+' '+failed.summary);
      }
      await delay(500);
    }
    throw Error('installed composer file-only turn did not settle');
  })()`;
}

export function restartedAttachmentBrowserProbe(directId, composerId) {
  return `(async()=>{
    const ids=[${JSON.stringify(directId)},${JSON.stringify(composerId)}];
    const expected=[['notes.txt','marker.png'],['ui-notes.txt','ui-marker.png']];
    const counts=[];
    for(const [index,id] of ids.entries()){
      const response=await fetch('/api/session/'+encodeURIComponent(id)+'/message');
      if(response.status!==200)throw Error('restarted messages '+id+' '+response.status);
      const rows=await response.json();
      const users=rows.filter(row=>row.info?.role==='user');
      const replies=rows.filter(row=>row.info?.role==='assistant'&&row.parts?.some(part=>part.text?.includes(${JSON.stringify(REPLY)})));
      if(users.length!==1||replies.length!==1)throw Error('restarted transcript '+id+' '+users.length+' '+replies.length);
      const names=users[0].parts.filter(part=>part.type==='file').map(part=>part.filename);
      if(JSON.stringify(names)!==JSON.stringify(expected[index]))throw Error('restarted file names '+id+' '+JSON.stringify(names));
      counts.push({id,users:users.length,replies:replies.length});
    }
    const repeated=await fetch('/api/session/'+encodeURIComponent(ids[0])+'/prompt_async',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messageID:'installed_attachment_prompt',
        parts:[{type:'text',text:''},{type:'file',upload_id:'installed_text'},{type:'file',upload_id:'installed_image'}]})});
    if(repeated.status!==204)throw Error('restarted retry '+repeated.status+' '+await repeated.text());
    return {recovered:counts,retry_status:repeated.status};
  })()`;
}
