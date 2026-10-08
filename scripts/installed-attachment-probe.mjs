// SPDX-License-Identifier: Apache-2.0
/** Disposable provider and browser probe for the installed F3 attachment path. */
import { createServer } from 'node:http';

export const TEXT_MARKER = 'NND_INSTALLED_TEXT_MARKER';
export const IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a00000000', 'hex'), Buffer.from('NND_INSTALLED_IMAGE_MARKER')]);
export const REPLY = 'NND_INSTALLED_ATTACHMENT_REPLY';
export const UI_TEXT_MARKER = 'NND_INSTALLED_UI_TEXT_MARKER';
export const UI_IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a00000000', 'hex'), Buffer.from('NND_INSTALLED_UI_IMAGE_MARKER')]);

export async function startAttachmentProvider() {
  const requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('attachment provider did not bind');
  return { server, port: address.port, requests };
}

export function attachmentBrowserProbe() {
  const textData = `data:text/plain;base64,${Buffer.from(TEXT_MARKER).toString('base64')}`;
  const imageData = `data:image/png;base64,${IMAGE.toString('base64')}`;
  return `(async()=>{
    const post=async(path,body)=>fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
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
