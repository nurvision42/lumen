import { CliError } from "../errors.js";
import type { IO } from "../io.js";
import { hostsFor } from "./endpoints.js";
import { nowMs, refreshToken, sessionFromToken, fetchUser, REFRESH_SKEW_MS } from "./auth.js";
import type { ApiClient } from "./http.js";
import { loadApp, readSession, writeSession, type FeishuApp, type FeishuSession } from "./store.js";

export interface Authorized {
  app: FeishuApp;
  session: FeishuSession;
  client: ApiClient;
}

export async function authorized(io: IO): Promise<Authorized> {
  const app = await loadApp(io.env);
  const session = await readSession(io.env);
  if (session === undefined) throw new CliError("Feishu user is not logged in. Run lumen feishu login.");
  if (session.appId !== app.appId) throw new CliError("The saved Feishu login belongs to a different app. Run lumen feishu login.");
  const now = nowMs(io);
  let current = session;
  if (now + REFRESH_SKEW_MS >= session.expiresAt) {
    if (now >= session.refreshExpiresAt) throw new CliError("Feishu refresh token expired. Run lumen feishu login.");
    const token = await refreshToken(io, app, session.refreshToken);
    let user: { openId?: string; unionId?: string; name?: string } = {};
    try {
      user = await fetchUser(io, app.brand, token.accessToken);
    } catch {
      user = {
        ...(session.openId === undefined ? {} : { openId: session.openId }),
        ...(session.unionId === undefined ? {} : { unionId: session.unionId }),
        ...(session.name === undefined ? {} : { name: session.name }),
      };
    }
    current = sessionFromToken(app, token, user, now);
    await writeSession(io.env, current);
  }
  return {
    app,
    session: current,
    client: {
      io,
      openBase: hostsFor(app.brand).open,
      token: current.accessToken,
      secrets: [current.accessToken, current.refreshToken, app.appSecret],
    },
  };
}
