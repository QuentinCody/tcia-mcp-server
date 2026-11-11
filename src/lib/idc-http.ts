export function idcError(message: string, status = 400): never {
  throw Object.assign(new Error(`IDC: ${message}`), { status });
}
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Bound the whole operation, even when an upstream fetch/stream ignores abort. */
export async function idcDeadline<T>(run: (signal: AbortSignal) => Promise<T>, milliseconds = 45_000, parent?: AbortSignal | null): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let rejectDeadline: (error: Error) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const reject = () => rejectDeadline(Object.assign(new Error("IDC: request exceeded its deadline or was aborted"), { status: 502 }));
  controller.signal.addEventListener("abort", reject, { once: true });
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, milliseconds);
  try {
    if (parent?.aborted) abort();
    return await Promise.race([deadline, Promise.resolve().then(() => {
      if (controller.signal.aborted) idcError("request aborted", 502);
      return run(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", reject);
    controller.abort();
  }
}

export async function readBounded(response: Response, limit: number, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) idcError("response read aborted", 502);
      const { done, value } = await reader.read();
      if (signal?.aborted) idcError("response read aborted", 502);
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) idcError(`response exceeds ${limit} bytes`, 502);
      text += decoder.decode(value, { stream: true });
    }
  } finally { signal?.removeEventListener("abort", cancel); cancel(); }
}

export async function idcJson(url: string, init?: RequestInit, plainText = false) {
  return idcDeadline(async signal => {
    try {
      const response = await fetch(url, { ...init, redirect: "manual", signal });
      if (signal.aborted) { void response.body?.cancel().catch(() => undefined); idcError("request aborted", 502); }
      const text = await readBounded(response, 2 * 1024 * 1024, signal);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      const observation = { source_url: url, retrieved_at: new Date().toISOString(), http_status: response.status,
        etag: response.headers.get("etag"), content_type: response.headers.get("content-type"),
        response_sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("") };
      const fail = (message: string, status: number): never => {
        throw Object.assign(new Error(message), { status, data: { response: text, retry_after: response.headers.get("retry-after"), ...observation } });
      };
      if (!response.ok) fail(`IDC HTTP ${response.status}: ${text.slice(0, 500)}`, response.status);
      if (response.status !== 200 || response.headers.has("content-range")) fail("IDC: incomplete or unexpected HTTP representation", 502);
      let data: unknown = text;
      if (!plainText) {
        try { data = JSON.parse(text.replace(/^\uFEFF/, "")); }
        catch { fail("IDC: provider returned invalid JSON", 502); }
      }
      return { data, ...observation };
    } catch (error) {
      if ((error as { status?: number }).status) throw error;
      idcError("request failed or response could not be read", 502);
    }
  }, 35_000, init?.signal);
}

export function indexVersion(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d*\.\d+\.\d+$/.test(value)) idcError("index_version must be an exact index release, e.g. 24.2.2; not latest or just v24");
  return value;
}

export function integer(value: unknown, name: string, min: number, max: number): number {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") idcError(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) idcError(`${name} must be ${min}..${max}`);
  return number;
}
