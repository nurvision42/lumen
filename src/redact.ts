const SECRET_HEADERS = new Set(["authorization", "x-api-key", "api-key", "x-api-token"]);

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    const hadQuery = url.search.length > 0;
    const hadUser = url.username.length > 0 || url.password.length > 0;
    if (!hadQuery && !hadUser) return value;
    url.username = "";
    url.password = "";
    url.search = "";
    const clean = url.toString();
    return hadQuery ? `${clean}?[redacted]` : clean;
  } catch {
    return value;
  }
}

export function redactText(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/gi, (match) => {
    const trimmed = match.replace(/[),.;]+$/, "");
    return redactUrl(trimmed) + match.slice(trimmed.length);
  });
}

export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_HEADERS.has(key.toLowerCase())) {
        out[key] = "[redacted]";
        continue;
      }
      if ((key === "audio_base64" || key === "b64_json") && typeof item === "string") {
        out[key] = `[redacted base64 ${item.length} chars]`;
        continue;
      }
      out[key] = redactValue(item, secrets);
    }
    return out;
  }
  return value;
}
