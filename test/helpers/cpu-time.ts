/**
 * CPU time of a synchronous call on the calling thread, in milliseconds. A bound or scaling ratio over CPU time
 * measures the work rather than how long the scheduler made it wait, so load on a shared CI VM does not move it.
 * `process.threadCpuUsage` (as in test/entity-card-perf.slow.test.ts and src/core/progress.ts) leaves out the
 * engine's GC and JIT threads and any other concurrent work in the process. It does not see time spent waiting on
 * I/O, a subprocess, a timer or another thread: a test that bounds those keeps the wall clock.
 */
export function cpuMs(fn: () => unknown): number {
  const start = process.threadCpuUsage();
  fn();
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
}
