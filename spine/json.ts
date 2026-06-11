// spine/json.ts — JSON that round-trips bigint (ns timestamps are bigint).
export function jstr(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? { __big: val.toString() } : val));
}
export function jparse<T>(s: string): T {
  return JSON.parse(s, (_k, val) =>
    val && typeof val === 'object' && '__big' in val && Object.keys(val).length === 1 ? BigInt((val as { __big: string }).__big) : val,
  ) as T;
}
