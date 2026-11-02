import { afterEach, expect, it, vi } from 'vitest';
import { admitExport } from './exportAdmission';
import type { ExportResourceBlock } from '../shared/export-resources';
const request={id:'test',options:[1080,890],nativeEncoder:true};
const blocked: ExportResourceBlock={kind:'blocked',reason:'busy',requestedMiB:890,availableMiB:600,workMiB:921,revision:4,holders:[{kind:'proxy',media_id:'m-1',mib:900,threads:1}]};
function setup() { const leave=vi.fn(); return {tryPlan:vi.fn().mockReturnValue(blocked),wait:vi.fn(),waiting:vi.fn(),release:vi.fn(),leave,queue:vi.fn(()=>leave)}; }
afterEach(() => { vi.useRealTimers(); });
it('waits on the rejection revision and acquires only after a release', async () => {
  const deps=setup(); deps.tryPlan.mockReturnValueOnce(blocked).mockReturnValue({kind:'admitted',id:12,index:1});
  deps.wait.mockResolvedValue(undefined);
  expect(await admitExport(request,deps,new AbortController().signal)).toMatchObject({id:12,index:1});
  expect(deps.wait).toHaveBeenCalledExactlyOnceWith(4);
  expect(deps.waiting).toHaveBeenCalledExactlyOnceWith(blocked);
  expect(deps.queue).toHaveBeenCalledOnce(); expect(deps.leave).toHaveBeenCalledOnce();
});
it('an immediate admission never enters the queue', async () => {
  const deps=setup(); deps.tryPlan.mockReturnValue({kind:'admitted',id:3,index:0});
  await admitExport(request,deps,new AbortController().signal);
  expect(deps.queue).not.toHaveBeenCalled();
});
it('has no deadline: a block that clears after a long wait admits, queued once throughout', async () => {
  vi.useFakeTimers();
  const deps=setup(); let rounds=0;
  // Each native wait is bounded (15 s) and resolves without a change; the
  // proxy build holding the budget takes ten minutes.
  deps.wait.mockImplementation(() => new Promise<void>(resolve => setTimeout(resolve, 15_000)));
  deps.tryPlan.mockImplementation(() => ++rounds > 40 ? {kind:'admitted',id:7,index:0} : blocked);
  let settled=false;
  const pending=admitExport(request,deps,new AbortController().signal).finally(() => { settled=true; });
  await vi.advanceTimersByTimeAsync(9 * 60_000);
  expect(settled).toBe(false); expect(deps.leave).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await pending).toMatchObject({id:7,index:0});
  expect(deps.queue).toHaveBeenCalledOnce(); expect(deps.leave).toHaveBeenCalledOnce();
});
it('a permanently unfit plan fails immediately without waiting or queueing', async () => {
  const deps=setup(); deps.tryPlan.mockReturnValue({...blocked,reason:'budget-too-small'});
  await expect(admitExport(request,deps,new AbortController().signal)).rejects.toThrow('budget-too-small');
  expect(deps.wait).not.toHaveBeenCalled(); expect(deps.queue).not.toHaveBeenCalled();
});
it('a plan that becomes unfit while queued refuses and leaves the queue', async () => {
  const deps=setup(); deps.wait.mockResolvedValue(undefined);
  deps.tryPlan.mockReturnValueOnce(blocked).mockReturnValue({...blocked,reason:'budget-too-small'});
  await expect(admitExport(request,deps,new AbortController().signal)).rejects.toThrow('budget-too-small');
  expect(deps.leave).toHaveBeenCalledOnce();
});
it('cancel interrupts an outstanding native wait without starting more work and leaves the queue', async () => {
  vi.useFakeTimers();
  const deps=setup(); deps.wait.mockReturnValue(new Promise(()=>{})); const controller=new AbortController();
  const pending=admitExport(request,deps,controller.signal); const rejected=expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(deps.leave).not.toHaveBeenCalled();
  controller.abort();
  await rejected; expect(deps.tryPlan).toHaveBeenCalledTimes(1);
  expect(deps.queue).toHaveBeenCalledOnce(); expect(deps.leave).toHaveBeenCalledOnce();
});
it('a throwing wait leaves the queue', async () => {
  const deps=setup(); deps.wait.mockRejectedValue(new Error('native gone'));
  await expect(admitExport(request,deps,new AbortController().signal)).rejects.toThrow('native gone');
  expect(deps.leave).toHaveBeenCalledOnce();
});
it('cancellation racing admission returns the newly acquired reservation', async () => {
  const deps=setup(), controller=new AbortController();
  deps.tryPlan.mockImplementation(()=>{controller.abort(); return {kind:'admitted',id:12,index:0};});
  await expect(admitExport(request,deps,controller.signal)).rejects.toThrow();
  expect(deps.release).toHaveBeenCalledExactlyOnceWith(12);
});
