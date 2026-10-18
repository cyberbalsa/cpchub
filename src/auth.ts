import { Buffer } from "./node-buffer";
import { z } from "zod";
import { socialUsername } from "./usernames";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import {
  App,
  Env,
  User,
  Table,
  one,
  run,
  hash,
  random,
  now,
  HttpError,
} from "./env";
export async function userById(
  env: Env,
  id: number,
  auth: User["auth"] = "session",
  scopes = ["read", "write", "keys:write"],
): Promise<User | null> {
  const u = await one<Table<"auth_user"> & { role: User["role"] }>(
    env.DB,
    `SELECT u.*, CASE WHEN u.is_superuser=1 THEN 'Admin' ELSE COALESCE((SELECT g.name FROM auth_group g JOIN auth_user_groups ug ON ug.group_id=g.id WHERE ug.user_id=u.id AND g.name IN ('Admin','Moderator','Reviewer') ORDER BY CASE g.name WHEN 'Admin' THEN 0 WHEN 'Moderator' THEN 1 ELSE 2 END LIMIT 1),'') END role FROM auth_user u WHERE u.id=? AND u.is_active=1`,
    id,
  );
  return u
    ? {
        ...u,
        id: u.id,
        username: u.username,
        role: u.role,
        is_authenticated: true,
        auth,
        scopes,
      }
    : null;
}
export async function authenticate(c: Context<App>) {
  const authorization = c.req.header("Authorization");
  if (authorization) {
    const match = /^(Bearer|Api-?Key) +([^\s]+)$/i.exec(authorization);
    if (!match) throw new HttpError(401, "Invalid Authorization header.");
    const raw = match[2]!;
    const digest = await hash(raw);
    if (raw.startsWith("cpc_")) {
      const key = await one<Table<"hub_apikey">>(
        c.env.DB,
        "SELECT * FROM hub_apikey WHERE digest=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)",
        digest,
        now(),
      );
      if (!key) throw new HttpError(401, "Invalid API key.");
      const u = await userById(
        c.env,
        key.user_id,
        "key",
        z.array(z.string()).parse(JSON.parse(key.scopes)),
      );
      if (!u) throw new HttpError(401, "Invalid API key.");
      await run(
        c.env.DB,
        "UPDATE hub_apikey SET last_used_at=? WHERE id=?",
        now(),
        key.id,
      );
      return u;
    }
    const token = await one<Table<"worker_token">>(
      c.env.DB,
      "SELECT * FROM worker_token WHERE digest=? AND kind='access' AND expires_at>?",
      digest,
      Date.now(),
    );
    if (!token) throw new HttpError(401, "Invalid access token.");
    const u = await userById(
      c.env,
      token.user_id,
      "oauth",
      token.scope.split(" "),
    );
    if (!u) throw new HttpError(401, "Invalid access token.");
    u.client_id = token.client_id;
    return u;
  }
  const sid = getCookie(c, "cpc_session");
  if (!sid) return null;
  const session = await one<Table<"worker_session">>(
    c.env.DB,
    "SELECT * FROM worker_session WHERE digest=? AND expires_at>?",
    await hash(sid),
    Date.now(),
  );
  if (!session) return null;
  const u = await userById(c.env, session.user_id);
  if (u) u.csrf = session.csrf;
  return u;
}
// Hash to equal-length buffers before constant-time comparison (Workers node:crypto).
export async function secretEqual(left: string, right: string) {
  const [a, b] = await Promise.all([hash(left), hash(right)]);
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
export async function csrf(c: Context<App>) {
  if (
    ["GET", "HEAD", "OPTIONS"].includes(c.req.method) ||
    c.req.path === "/o/token/" ||
    c.req.path === "/o/revoke_token/"
  )
    return;
  const u = c.get("user");
  if (u && u.auth !== "session") return;
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.env.PUBLIC_URL).origin)
    throw new HttpError(403, "Invalid request origin.");
  const expected = u?.csrf || getCookie(c, "cpc_csrf");
  let supplied =
    c.req.header("X-CSRFToken") || c.get("uploadBody")?.csrfmiddlewaretoken;
  if (
    !supplied &&
    !c.get("uploadBody") &&
    /^(application\/x-www-form-urlencoded|multipart\/form-data)/.test(
      c.req.header("Content-Type") || "",
    )
  )
    supplied = (await c.req.raw.clone().formData()).get("csrfmiddlewaretoken");
  if (
    !expected ||
    typeof supplied !== "string" ||
    !(await secretEqual(supplied, expected))
  )
    throw new HttpError(403, "Invalid CSRF token.");
}
export async function session(c: Context<App>, user: User, method?: "passkey") {
  const sid = random();
  await run(
    c.env.DB,
    "INSERT INTO hub_accountactivity(user_id,item_id,item_title,action,ip_address,ip_source,user_agent,accept_language,auth_method,provider_uid,request_path,cf_ray,created_at) VALUES (?,NULL,'','login',?,'proxy',?,?,?,'',?,?,?)",
    user.id,
    c.req.header("CF-Connecting-IP") || null,
    (c.req.header("User-Agent") || "").slice(0, 1024),
    (c.req.header("Accept-Language") || "").slice(0, 256),
    method ||
      (c.req.path.includes("steam")
        ? "steam"
        : c.req.path.includes("discord")
          ? "discord"
          : "staff"),
    c.req.path.slice(0, 255),
    (c.req.header("CF-Ray") || "").slice(0, 80),
    now(),
  );
  await run(
    c.env.DB,
    "INSERT INTO worker_session VALUES (?,?,?,?)",
    await hash(sid),
    user.id,
    random(),
    Date.now() + 30 * 86400000,
  );
  setCookie(c, "cpc_session", sid, {
    httpOnly: true,
    secure: c.env.PUBLIC_URL.startsWith("https:"),
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 86400,
  });
}
async function socialUser(
  c: Context<App>,
  provider: "steam" | "discord",
  uid: string,
  name: string,
  connect?: number,
) {
  const findAccount = () =>
    one<Pick<Table<"socialaccount_socialaccount">, "user_id">>(
      c.env.DB,
      "SELECT user_id FROM socialaccount_socialaccount WHERE provider=? AND uid=?",
      provider,
      uid,
    );
  const activeUser = async (id: number) => {
    const user = await userById(c.env, id);
    if (!user) throw new HttpError(403, "This account is inactive.");
    return user;
  };
  const account = await findAccount();
  const providerName = provider === "steam" ? "Steam" : "Discord";
  if (connect) {
    const linked = await activeUser(connect);
    await run(
      c.env.DB,
      "INSERT INTO socialaccount_socialaccount(provider,uid,last_login,date_joined,extra_data,user_id) VALUES (?,?,?,?,?,?) ON CONFLICT(provider,uid) DO NOTHING",
      provider,
      uid,
      now(),
      now(),
      "{}",
      connect,
    );
    if ((await findAccount())?.user_id !== connect)
      throw new HttpError(
        409,
        `That ${providerName} account is linked to a different CPC Hub account. Sign out of CPC Hub, then sign in with ${providerName}.`,
      );
    return linked;
  }
  if (account) return activeUser(account.user_id);
  const base = socialUsername(name, provider);
  for (let attempt = 0; attempt < 5; attempt++) {
    const username =
      attempt === 0 ? base : base + "_" + crypto.randomUUID().slice(0, 8);
    try {
      // Both inserts commit together. A duplicate provider identity or username
      // rolls back account creation, including concurrent first-login attempts.
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO auth_user(password,last_login,is_superuser,username,first_name,last_name,email,is_staff,is_active,date_joined) VALUES ('!',NULL,0,?,'','','',0,1,?)",
        ).bind(username, now()),
        c.env.DB.prepare(
          "INSERT INTO socialaccount_socialaccount(provider,uid,last_login,date_joined,extra_data,user_id) VALUES (?,?,?,?,?,(SELECT id FROM auth_user WHERE username=?))",
        ).bind(provider, uid, now(), now(), "{}", username),
      ]);
    } catch (error) {
      if (
        !/UNIQUE constraint failed: (auth_user.username|socialaccount_socialaccount.provider, socialaccount_socialaccount.uid)/.test(
          String(error),
        )
      )
        throw error;
      const existing = await findAccount();
      if (existing) return activeUser(existing.user_id);
      continue;
    }
    const created = await findAccount();
    if (!created) throw new Error("Created social account is missing");
    return activeUser(created.user_id);
  }
  throw new HttpError(
    409,
    "Unable to reserve a username. Please sign in again.",
  );
}
const discordToken = z.object({ access_token: z.string().min(1) });
const discordProfile = z.object({
  id: z.string().regex(/^\d{17,20}$/),
  username: z.string().min(1),
  global_name: z.string().nullable().optional(),
});
const steamProfile = z.object({
  response: z.object({
    players: z.array(
      z.object({
        steamid: z.string(),
        personaname: z.string(),
      }),
    ),
  }),
});
export const authRoutes = new Hono<App>();
authRoutes.post("/accounts/:provider/login/", async (c) => {
  const provider = c.req.param("provider");
  if (!["discord", "steam"].includes(provider))
    throw new HttpError(404, "Not found.");
  const state = random();
  await run(
    c.env.DB,
    "INSERT INTO worker_login VALUES (?,?,?,?)",
    state,
    provider,
    Date.now() + 600000,
    c.get("user") ? String(c.get("user")!.id) : "",
  );
  setCookie(c, "cpc_login", state, {
    httpOnly: true,
    secure: c.env.PUBLIC_URL.startsWith("https:"),
    sameSite: "Lax",
    maxAge: 600,
    path: "/",
  });
  const redirect =
    c.env.PUBLIC_URL + "/accounts/" + provider + "/login/callback/";
  if (provider === "discord") {
    if (!c.env.DISCORD_CLIENT_ID || !c.env.DISCORD_CLIENT_SECRET)
      throw new HttpError(503, "Discord sign-in is not configured.");
    return c.redirect(
      "https://discord.com/oauth2/authorize?" +
        new URLSearchParams({
          client_id: c.env.DISCORD_CLIENT_ID,
          redirect_uri: redirect,
          response_type: "code",
          scope: "identify",
          state,
        }),
    );
  }
  const returnTo = redirect + "?state=" + encodeURIComponent(state);
  return c.redirect(
    "https://steamcommunity.com/openid/login?" +
      new URLSearchParams({
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "checkid_setup",
        "openid.return_to": returnTo,
        "openid.realm": c.env.PUBLIC_URL + "/",
        "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
        "openid.claimed_id":
          "http://specs.openid.net/auth/2.0/identifier_select",
      }),
  );
});
authRoutes.get("/accounts/:provider/login/callback/", async (c) => {
  const provider = c.req.param("provider"),
    state = c.req.query("state");
  if (!state || !(await secretEqual(state, getCookie(c, "cpc_login") || "")))
    throw new HttpError(403, "Invalid login state.");
  const login = await c.env.DB.prepare(
    "DELETE FROM worker_login WHERE state=? AND provider=? AND expires_at>? RETURNING *",
  )
    .bind(state, provider, Date.now())
    .first<Table<"worker_login">>();
  if (!login) throw new HttpError(403, "Expired login.");
  deleteCookie(c, "cpc_login", { path: "/" });
  let uid = "",
    name = "";
  if (provider === "discord") {
    const t = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: c.env.DISCORD_CLIENT_ID,
        client_secret: c.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: c.req.query("code") || "",
        redirect_uri: c.env.PUBLIC_URL + "/accounts/discord/login/callback/",
      }),
    });
    if (!t.ok) throw new HttpError(403, "Discord login failed.");
    const token = discordToken.safeParse(await t.json());
    if (!token.success)
      throw new HttpError(403, "Invalid Discord token response.");
    const response = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: "Bearer " + token.data.access_token },
    });
    if (!response.ok) throw new HttpError(403, "Discord login failed.");
    const profile = discordProfile.safeParse(await response.json());
    if (!profile.success) throw new HttpError(403, "Invalid Discord profile.");
    uid = profile.data.id;
    name = profile.data.global_name?.trim() || profile.data.username;
  } else if (provider === "steam") {
    const p = new URL(c.req.url).searchParams;
    const claimed = p.get("openid.claimed_id") || "",
      identity = p.get("openid.identity");
    const signed = (p.get("openid.signed") || "").split(",");
    const expected =
      c.env.PUBLIC_URL +
      "/accounts/steam/login/callback/?state=" +
      encodeURIComponent(state);
    if (
      p.get("openid.ns") !== "http://specs.openid.net/auth/2.0" ||
      p.get("openid.op_endpoint") !==
        "https://steamcommunity.com/openid/login" ||
      p.get("openid.return_to") !== expected ||
      identity !== claimed ||
      !/^https:\/\/steamcommunity\.com\/openid\/id\/\d{17}$/.test(claimed) ||
      ![
        "op_endpoint",
        "claimed_id",
        "identity",
        "return_to",
        "response_nonce",
      ].every((k) => signed.includes(k))
    )
      throw new HttpError(403, "Invalid Steam assertion.");
    const nonce = p.get("openid.response_nonce") || "";
    const time = Date.parse(nonce.slice(0, 20));
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 600000)
      throw new HttpError(403, "Expired Steam assertion.");
    const verify = new URLSearchParams();
    for (const [k, v] of p) if (k.startsWith("openid.")) verify.set(k, v);
    verify.set("openid.mode", "check_authentication");
    const response = await fetch("https://steamcommunity.com/openid/login", {
      method: "POST",
      body: verify,
    });
    if (
      !response.ok ||
      !/(^|\n)is_valid:true(\r?\n|$)/.test(await response.text())
    )
      throw new HttpError(403, "Steam login failed.");
    const used = await run(
      c.env.DB,
      "INSERT OR IGNORE INTO worker_nonce VALUES (?,?)",
      nonce,
      Date.now() + 600000,
    );
    if (!used.meta.changes)
      throw new HttpError(403, "Replayed Steam assertion.");
    uid = claimed.split("/").pop()!;
    name = "Steam " + uid.slice(-6);
    if (c.env.STEAM_API_KEY) {
      const r = await fetch(
        "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?" +
          new URLSearchParams({ key: c.env.STEAM_API_KEY, steamids: uid }),
      );
      if (r.ok) {
        const d = steamProfile.safeParse(await r.json());
        if (d.success)
          name =
            d.data.response.players.find((p) => p.steamid === uid)
              ?.personaname || name;
      }
    }
  } else throw new HttpError(404, "Not found.");
  const u = await socialUser(
    c,
    provider,
    uid,
    name,
    login.nonce ? Number(login.nonce) : undefined,
  );
  await session(c, u);
  await run(
    c.env.DB,
    "UPDATE auth_user SET last_login=? WHERE id=?",
    now(),
    u.id,
  );
  return c.redirect("/");
});
authRoutes.post("/accounts/logout/", async (c) => {
  const sid = getCookie(c, "cpc_session");
  if (sid)
    await run(
      c.env.DB,
      "DELETE FROM worker_session WHERE digest=?",
      await hash(sid),
    );
  deleteCookie(c, "cpc_session", { path: "/" });
  return c.redirect("/");
});
