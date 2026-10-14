/**
 * Preload for test/sync-convergence.serial.test.ts: SIGKILLs this process at
 * the nth hit of one named persistence fault point (`fault-points.ts`), after
 * writing a marker that records where it died. Configured by
 * GBRAIN_TEST_CONVERGENCE_FAULT = {"point","nth","marker"[,"operation"]}.
 */
import { writeFileSync } from 'node:fs';
import { installFaultHook, type FaultPoint } from '../../src/core/persistence/fault-points.ts';

const raw = process.env.GBRAIN_TEST_CONVERGENCE_FAULT;
if (!raw) throw new Error('convergence-fault-kill needs GBRAIN_TEST_CONVERGENCE_FAULT.');
const fault = JSON.parse(raw) as { point: FaultPoint; nth: number; marker: string; operation?: string };
let seen = 0;
installFaultHook((point, detail) => {
  if (point !== fault.point || (fault.operation && detail.operation !== fault.operation)) return;
  if (++seen !== fault.nth) return;
  writeFileSync(fault.marker, JSON.stringify({ point, nth: seen, pid: process.pid, requestId: detail.requestId, operation: detail.operation ?? null }), { mode: 0o600 });
  process.kill(process.pid, 'SIGKILL');
});
