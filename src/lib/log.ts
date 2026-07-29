/** Timestamped logging so you can watch realtime events flow in real time. */
export function log(...args: unknown[]): void {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}]`, ...args);
}
