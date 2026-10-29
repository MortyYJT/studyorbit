// Exit codes of the collectors (design §9, decision #348): `75` (EX_TEMPFAIL) when the final request failed with
// HTTP 429, HTTP 5xx or a network error, so the sync's collector limiter retries it; `1` for every other failure,
// which the sync turns into an `unavailable` placeholder as before. Collectors need Edge or the Ed CLI and are never
// run in tests; these helpers are tested with synthetic responses instead.

export const EX_TEMPFAIL = 75;

/** HTTP 429 or 5xx. */
export function isTemporaryStatus(status) {
  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

/** An error for an HTTP failure; temporary when the status is 429 or 5xx, or 0 (a browser request that got no response). */
export function httpFailure(label, status) {
  const error = new Error(status === 0 ? `${label} 网络请求失败` : `${label} HTTP ${status}`);
  error.status = status;
  error.temporary = status === 0 || isTemporaryStatus(status);
  return error;
}

const NETWORK_CODES = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE)\b|socket hang up/i;
const HTTP_STATUS = /\b(?:HTTP|status(?:\s*code)?)\D{0,3}(\d{3})\b/gi;

/**
 * Whether a failed command-line call (the Ed CLI) failed temporarily: its output names HTTP 429 or 5xx or a network
 * error. A call killed by our own timeout is not temporary (timeouts are not retried).
 */
export function cliFailureIsTemporary(error) {
  if (!error || error.killed) return false;
  const text = `${error.stderr ?? ''}\n${error.stdout ?? ''}\n${error.message ?? ''}`;
  if (NETWORK_CODES.test(text) || NETWORK_CODES.test(String(error.code ?? ''))) return true;
  for (const match of text.matchAll(HTTP_STATUS)) if (isTemporaryStatus(Number(match[1]))) return true;
  return false;
}

/** The exit code for a collector that failed with `error`. */
export function collectorExitCode(error) {
  return error?.temporary === true ? EX_TEMPFAIL : 1;
}
