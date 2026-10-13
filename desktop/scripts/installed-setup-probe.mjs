// SPDX-License-Identifier: Apache-2.0
export function setupBrowserProbe(workspaceRoot, providerPort, expectedSource = 'missing', extraProviders = null, withReviewerRoute = false) {
  const providerEndpoint = `http://127.0.0.1:${providerPort}/v1`;
  const primaryProvider = { id: 'smoke', endpoint: providerEndpoint, model: 'test', trust_zone: 'loopback' };
  const primary = { provider_id: 'smoke', model: 'test' };
  const routes = withReviewerRoute ? { primary, reviewer: primary } : { primary };
  const document = extraProviders || withReviewerRoute
    ? { workspace_root: workspaceRoot, providers: [primaryProvider, ...extraProviders ?? []], routes }
    : { workspace_root: workspaceRoot, provider: primaryProvider };
  return `(async()=>{    const bounded=async(promise,label)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('probe fetch hang: '+label)),60000))]);
    const note=async state=>{try{await fetch('http://127.0.0.1:${providerPort}/probe-note',{method:'POST',mode:'no-cors',headers:{'content-type':'text/plain'},body:JSON.stringify({at:new Date().toISOString(),...state})})}catch{}};
    const alerts=()=>[...document.querySelectorAll('[data-testid="settings-window"] [role="alert"]')].map(item=>item.textContent?.slice(0,200));
    const post=async(path,body)=>bounded(fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),path);
    const before=await bounded(fetch('/api/v1/nnd/setup/status'),'setup status');
    if(before.status!==200)throw Error('setup status '+before.status);
    const initial=await bounded(before.json(),'setup status body');
    if(initial.service_state!=='setup_required'||initial.execution_state!=='unavailable')
      throw Error('fresh install did not require setup '+JSON.stringify(initial));
    const denied=await post('/api/session',{});
    if(denied.status!==503)throw Error('unconfigured execution was admitted '+denied.status);
    const read=await bounded(fetch('/api/v1/nnd/configuration'),'configuration read');
    if(read.status!==200)throw Error('configuration read '+read.status+' '+await bounded(read.text(),'configuration body'));
    const view=await bounded(read.json(),'configuration body json');
        if(view.source_state!==${JSON.stringify(expectedSource)}
      || ${JSON.stringify(expectedSource)}==='missing'&&view.source_revision!=='absent'
      || ${JSON.stringify(expectedSource)}==='invalid'&&(!view.source_revision||view.source_revision==='absent'))
      throw Error('configuration source did not match expected state '+JSON.stringify({state:view.source_state,revision:view.source_revision}));
    const configurationDocument=${JSON.stringify(document)};
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
    if(repair.disabled)throw Error('native repair form stayed disabled');
    // Direct same-origin repair with the exact document: reports the raw
    // server verdict (status + error body) through the note channel even when
    // the UI surfaces only a mapped code.
    const directRepair=await bounded(fetch('/api/v1/nnd/configuration/repair',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({installation_id:view.installation_id,
        data_id:view.data_id,scope:'user',expected_revision:view.source_revision,
        operation_id:'probe_direct_repair_'+Math.random().toString(16).slice(2,12),document:configurationDocument})}),'direct repair');
    await note({phase:'direct-repair',status:directRepair.status,body:(await directRepair.text()).slice(0,500)});
    repair.click();
    let saved=false;let poll=0;
    for(;poll<600;poll++){
      const win=document.querySelector('[data-testid="settings-window"]');
      saved=/: saved;/u.test(win?.textContent??'');
      if(poll%20===0||saved||!win)await note({phase:'repair-poll',poll,saved,window:!!win,alerts:alerts(),
        body:win?win.textContent?.slice(0,300):document.body?.textContent?.slice(0,200)});
      // The window can unmount once the repair receipt lands (a routing change
      // restarts the service); activation below arbitrates the real outcome.
      if(saved||!win)break;await delay(250)}
    await note({phase:'repair-poll-done',poll,saved,window:!!document.querySelector('[data-testid="settings-window"]'),alerts:alerts()});
    await note({phase:'pre-reload-check',window:!!document.querySelector('[data-testid="settings-window"]'),saved});
    if(!document.querySelector('[data-testid="settings-window"]')){
      await note({phase:'window-missing-reload'});location.reload();
      let gear=null;for(let i=0;i<240;i++){
        gear=document.querySelector('[data-testid="settings-gear"]');if(gear)break;await delay(500)}
      if(!gear)throw Error('settings gear missing after repair reload');
      gear.click();await delay(500)}
    try{await navigate('Providers')}catch(e){throw Error('settings page missing Providers; body: '+document.body?.textContent?.slice(0,400))}
    let activate;for(let i=0;i<100;i++){
      activate=[...document.querySelectorAll('button')].find(button=>button.textContent?.trim()==='Activate NNA execution');
      if(activate&&!activate.disabled)break;await delay(100)}
    if(!activate||activate.disabled)throw Error('native GUI activation unavailable');
    activate.click();
    return {setup_before:initial.service_state,setup_receipt:'saved',ui_activation_started:true};
  })()`;
}
