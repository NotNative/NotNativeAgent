// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { runtimeFetch } from '../../runtime-fetch.ts';
import { parseNativeSetupStatus, requestNativeSetup } from '../setup.ts';
vi.mock('../../runtime-fetch.ts',()=>({runtimeFetch:vi.fn()}));
const status={service_state:'setup_required',configuration_state:'invalid',execution_state:'unavailable',
  provider_state:'unknown',failure_code:'nnd_setup_configuration_invalid'};
it('validates known states and rejects contradictory or falsely checked provider readiness',()=>{
  expect(parseNativeSetupStatus(status)).toEqual(status);
  for(const value of [{...status,service_state:'ready'},{...status,provider_state:'ready'},
    {...status,failure_code:'secret value'},null]) expect(parseNativeSetupStatus(value)).toBeNull();
});
it('preserves native 503 activation status while rejecting error-message substitution',async()=>{
  vi.mocked(runtimeFetch).mockResolvedValueOnce(Response.json(status,{status:503}));
  expect(await requestNativeSetup(true,new AbortController().signal)).toEqual({status,error:true});
  expect(runtimeFetch).toHaveBeenLastCalledWith('/api/v1/nnd/setup/activate',expect.objectContaining({method:'POST',body:'{}'}));
  vi.mocked(runtimeFetch).mockResolvedValueOnce(Response.json({error:{message:'private-path'}},{status:403}));
  expect(await requestNativeSetup(false,new AbortController().signal)).toEqual({status:null,error:true});
});
it('bounds payload and connects caller cancellation to transport',async()=>{
  const controller=new AbortController();
  vi.mocked(runtimeFetch).mockResolvedValueOnce(new Response('x'.repeat(4097)));
  await expect(requestNativeSetup(false,controller.signal)).rejects.toThrow('native-setup-invalid');
  const signal=vi.mocked(runtimeFetch).mock.calls.at(-1)![1]!.signal!;
  controller.abort();expect(signal.aborted).toBe(true);
});
