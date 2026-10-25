export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function findString(value: unknown, key: string, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const direct = record[key];
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const nest of ["result", "data"]) {
    const found = findString(record[nest], key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function findBase64(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const key of ["b64_json", "audio_base64"]) {
    const item = record[key];
    if (typeof item === "string" && item.length > 0) return item;
  }
  if (Array.isArray(record.data)) {
    for (const item of record.data) {
      const found = findBase64(item, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function findHttpUrl(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const key of ["url", "video_url", "image_url"]) {
    const item = record[key];
    if (typeof item === "string" && /^https?:\/\//i.test(item)) return item;
  }
  if (Array.isArray(record.data)) {
    for (const item of record.data) {
      const found = findHttpUrl(item, depth + 1);
      if (found !== undefined) return found;
    }
  }
  for (const nest of ["result", "data"]) {
    if (Array.isArray(record[nest])) continue;
    const found = findHttpUrl(record[nest], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** First `shots` array, including a JSON string in `contents`. */
export function findShots(value: unknown, depth = 0): unknown {
  if (depth > 5) return undefined;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (Array.isArray(record.shots)) return record.shots;
  for (const key of ["result", "data"]) {
    const found = findShots(record[key], depth + 1);
    if (found !== undefined) return found;
  }
  const contents = record.contents;
  if (typeof contents === "string") {
    try {
      return findShots(JSON.parse(contents) as unknown, depth + 1);
    } catch {
      return undefined;
    }
  }
  return findShots(contents, depth + 1);
}
