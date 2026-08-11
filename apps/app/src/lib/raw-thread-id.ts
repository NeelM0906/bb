/** Exact persisted thread-id format from @bb/db's pretty-id generator. */
export const RAW_THREAD_ID_PATTERN_SOURCE =
  "thr_[23456789abcdefghijkmnpqrstuvwxyz]{10}";

export function isRawThreadId(value: string): boolean {
  return new RegExp(`^${RAW_THREAD_ID_PATTERN_SOURCE}$`, "u").test(value);
}
