// Which voice is really being used, and why the good one is not.
export const REASON_CODES = ["local_server", "offline", "not_installed", "rejected", "network", "timeout", "empty", "other"];

/**
 * Normalises a failed attempt to reach the neural voice into one reason code.
 * `fetchFailed`: the request to our own server did not complete.
 * `status`/`body`: our server's JSON error (see server.classify_tts_error).
 */
export function classifyFailure({ fetchFailed = false, status = null, body = null, offline = false } = {}) {
  if (fetchFailed) return { code: "local_server", detail: "" };
  const reported = body && typeof body === "object" ? body : {};
  const detail = typeof reported.detail === "string" ? reported.detail : "";
  let code = REASON_CODES.includes(reported.code) ? reported.code : "other";
  if (offline && (code === "network" || code === "timeout" || code === "other")) code = "offline";
  return { code, detail, status: Number.isInteger(reported.status) ? reported.status : status };
}
