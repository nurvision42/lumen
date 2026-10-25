import path from "node:path";

/** `~/.cache/lumen` or `$XDG_CACHE_HOME/lumen`. Binaries and sharp live here, not in the project. */
export function lumenCacheDir(env: NodeJS.ProcessEnv): string | undefined {
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg !== undefined && xdg.length > 0) return path.join(xdg, "lumen");
  const home = env.HOME?.trim();
  if (home === undefined || home.length === 0) return undefined;
  return path.join(home, ".cache", "lumen");
}
