import { expect, it, vi } from 'vitest';
import { admitExport } from './exportAdmission';
import type { ExportResourceBlock } from '../shared/export-resources';
const request={id:'test',options:[1080,890],nativeEncoder:true};
const blocked: ExportResourceBlock={kind:'blocked',reason:'busy',requestedMiB:890,availableMiB:600,workMiB:921,revision:4};
function setup() { return {tryPlan:vi.fn().mockReturnValue(blocked),wait:vi.fn(),waiting:vi.fn(),release:vi.fn()}; }
it('waits on the rejection revision and acquires only after a release', async () => {
  const deps=setup(); deps.tryPlan.mockReturnValueOnce(blocked).mockReturnValue({kind:'admitted',id:12,index:1});
  deps.wait.mockResolvedValue(undefined);
  expect(await admitExport(request,deps,new AbortController().signal)).toMatchObject({id:12,index:1});
  expect(deps.wait).toHaveBeenCalledExactlyOnceWith(4);
});
it('a permanently unfit plan fails immediately without waiting', async () => {
  const deps=setup(); deps.tryPlan.mockReturnValue({...blocked,reason:'budget-too-small'});
  await expect(admitExport(request,deps,new AbortController().signal)).rejects.toThrow('budget-too-small');
  expect(deps.wait).not.toHaveBeenCalled();
});
it('cancel interrupts an outstanding native wait without starting more work', async () => {
  const deps=setup(); deps.wait.mockReturnValue(new Promise(()=>{})); const controller=new AbortController();
  const pending=admitExport(request,deps,controller.signal); controller.abort();
  await expect(pending).rejects.toThrow(); expect(deps.tryPlan).toHaveBeenCalledTimes(1);
});
it('cancellation racing admission returns the newly acquired reservation', async () => {
  const deps=setup(), controller=new AbortController();
  deps.tryPlan.mockImplementation(()=>{controller.abort(); return {kind:'admitted',id:12,index:0};});
  await expect(admitExport(request,deps,controller.signal)).rejects.toThrow();
  expect(deps.release).toHaveBeenCalledExactlyOnceWith(12);
});
it('the deadline retains the actual reason and resource evidence', async () => {
  const deps=setup(); deps.wait.mockReturnValue(new Promise(()=>{}));
  await expect(admitExport(request,deps,new AbortController().signal,5)).rejects.toThrow('"requestedMiB":890');
});
