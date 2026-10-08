// SPDX-License-Identifier: Apache-2.0
/** Disposable provider and browser probe for the installed F3 attachment path. */
import { createServer } from 'node:http';

export const TEXT_MARKER = 'NND_INSTALLED_TEXT_MARKER';
export const IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a00000000', 'hex'), Buffer.from('NND_INSTALLED_IMAGE_MARKER')]);
export const REPLY = 'NND_INSTALLED_ATTACHMENT_REPLY';

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
        return {session_id:id,turn_status:turn.status,summary:turn.summary,duplicate_rows:submittedRows.length};
      }
      if(turn&&turn.status!=='started')throw Error('turn '+turn.status+' '+turn.summary);
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw Error('installed attachment turn did not settle');
  })()`;
}
