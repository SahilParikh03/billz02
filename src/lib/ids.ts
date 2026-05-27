/** Generate a short unique id, optionally prefixed (e.g. "trace", "sess"). */
export function newId(prefix = ""): string {
  const id =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return prefix ? `${prefix}_${id}` : id;
}
