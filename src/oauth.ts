import type { Context } from "hono";
import type { Table } from "./env";
import { Hono } from "hono";
import {
  App,
  Row,
  one,
  run,
  hash,
  random,
  requireUser,
  HttpError,
} from "./env";
import { render, safe, esc } from "./render";
import { body } from "./api";
import { censorText } from "./text-filter";
export const oauth = new Hono<App>();
const textParam = (d: Row, key: string) =>
  typeof d[key] === "string" ? d[key] : "";
async function requestClient(c: Context<App>, d: Row) {
  const app = await one<Table<"oauth2_provider_application">>(
    c.env.DB,
    "SELECT * FROM oauth2_provider_application WHERE client_id=? AND client_type='public' AND authorization_grant_type='authorization-code'",
    textParam(d, "client_id"),
  );
  if (
    !app ||
    !app.redirect_uris.split(/\s+/).includes(textParam(d, "redirect_uri"))
  )
    throw new HttpError(400, "Invalid client or redirect URI.");
  return app;
}
function scopes(raw: unknown) {
  if (raw !== undefined && typeof raw !== "string")
    throw new HttpError(400, "Invalid scope.");
  const a = (raw || "read").split(" ").filter(Boolean);
  if (a.some((s) => !["read", "write", "keys:write"].includes(s)))
    throw new HttpError(400, "Invalid scope.");
  return [...new Set(a)].join(" ");
}
oauth.get("/authorize/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  const d = c.req.query();
  const app = await requestClient(c, d);
  if (
    d.response_type !== "code" ||
    d.code_challenge_method !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(textParam(d, "code_challenge"))
  )
    throw new HttpError(400, "S256 PKCE is required.");
  const scope = scopes(d.scope);
  return render(c, "hub/message.html", {
    heading: "Connect " + censorText(app.name),
    content: safe(
      `<p>This manager requests: ${esc(scope)}.</p><form method="post">${Object.entries(
        d,
      )
        .map(
          ([k, v]) =>
            `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`,
        )
        .join(
          "",
        )}<input type="hidden" name="csrfmiddlewaretoken" value="${esc(u.csrf)}"><button name="approve" value="yes">Authorize</button><button name="approve" value="no">Cancel</button></form>`,
    ),
  });
});
oauth.post("/authorize/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  if (u.auth !== "session")
    throw new HttpError(403, "Browser session required.");
  const d = await body(c);
  await requestClient(c, d);
  if (
    d.response_type !== "code" ||
    d.code_challenge_method !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(textParam(d, "code_challenge"))
  )
    throw new HttpError(400, "S256 PKCE is required.");
  const target = new URL(textParam(d, "redirect_uri"));
  if (typeof d.state === "string" && d.state)
    target.searchParams.set("state", d.state);
  if (d.approve !== "yes") {
    target.searchParams.set("error", "access_denied");
    return c.redirect(target.href);
  }
  const code = random();
  await run(
    c.env.DB,
    "INSERT INTO worker_oauth_code VALUES (?,?,?,?,?,?,?)",
    await hash(code),
    u.id,
    textParam(d, "client_id"),
    textParam(d, "redirect_uri"),
    d.code_challenge,
    scopes(d.scope),
    Date.now() + 60000,
  );
  target.searchParams.set("code", code);
  return c.redirect(target.href);
});
oauth.post("/token/", async (c) => {
  const d = await body(c);
  type Grant = Pick<
    Table<"worker_token">,
    "user_id" | "client_id" | "scope"
  > & { family?: string };
  let grant: Grant | null = null;
  if (d.grant_type === "authorization_code") {
    await requestClient(c, d);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(textParam(d, "code_verifier")))
      throw new HttpError(400, "Invalid verifier.");
    const digest = await hash(textParam(d, "code_verifier"));
    const challenge = btoa(
      String.fromCharCode(...digest.match(/../g)!.map((x) => parseInt(x, 16))),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    grant = await c.env.DB.prepare(
      "DELETE FROM worker_oauth_code WHERE digest=? AND client_id=? AND redirect_uri=? AND challenge=? AND expires_at>? RETURNING *",
    )
      .bind(
        await hash(textParam(d, "code")),
        textParam(d, "client_id"),
        textParam(d, "redirect_uri"),
        challenge,
        Date.now(),
      )
      .first<Grant>();
  } else if (d.grant_type === "refresh_token")
    grant = await c.env.DB.prepare(
      "DELETE FROM worker_token WHERE digest=? AND client_id=? AND kind='refresh' AND expires_at>? RETURNING *",
    )
      .bind(
        await hash(textParam(d, "refresh_token")),
        textParam(d, "client_id"),
        Date.now(),
      )
      .first<Grant>();
  if (!grant) throw new HttpError(400, "Invalid or expired grant.");
  const user = await one(
    c.env.DB,
    "SELECT id FROM auth_user WHERE id=? AND is_active=1",
    grant.user_id,
  );
  if (!user) throw new HttpError(400, "Invalid grant.");
  const access = random(),
    refresh = random(),
    family = grant.family || random();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM worker_token WHERE family=?").bind(family),
    c.env.DB.prepare("INSERT INTO worker_token VALUES (?,?,?,?,?,?,?)").bind(
      await hash(access),
      grant.user_id,
      grant.client_id,
      grant.scope,
      "access",
      family,
      Date.now() + 3600000,
    ),
    c.env.DB.prepare("INSERT INTO worker_token VALUES (?,?,?,?,?,?,?)").bind(
      await hash(refresh),
      grant.user_id,
      grant.client_id,
      grant.scope,
      "refresh",
      family,
      Date.now() + 30 * 86400000,
    ),
  ]);
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.json({
    access_token: access,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refresh,
    scope: grant.scope,
  });
});
oauth.post("/revoke_token/", async (c) => {
  const d = await body(c);
  const token = await one<{ family: string }>(
    c.env.DB,
    "SELECT family FROM worker_token WHERE digest=? AND client_id=?",
    await hash(textParam(d, "token")),
    textParam(d, "client_id"),
  );
  if (token)
    await run(
      c.env.DB,
      "DELETE FROM worker_token WHERE family=?",
      token.family,
    );
  return c.body(null, 200);
});

oauth.onError((e) => {
  const status = e instanceof HttpError ? e.status : 500;
  const description =
    e instanceof HttpError ? e.message : "Authorization service unavailable.";
  const error =
    status >= 500
      ? "server_error"
      : /scope/i.test(description)
        ? "invalid_scope"
        : /grant|verifier/i.test(description)
          ? "invalid_grant"
          : status === 403
            ? "access_denied"
            : "invalid_request";
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
});
