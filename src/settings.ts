import { Hono } from "hono";
import { App, all, one, run, now, admin, HttpError, random } from "./env";
import { body } from "./api";
import { refreshMonthlyCosts } from "./billing";
import { refreshEstimates } from "./cost-estimates";
import { render, safe, esc, input, area } from "./render";

export const settings = new Hono<App>();
settings.use("*", async (c, next) => {
  if (!admin(c.get("user")))
    throw new HttpError(403, "Admin browser session required.");
  await next();
});
settings.on(["GET", "POST"], "/", async (c) => {
  if (c.req.method === "POST") {
    const d = await body(c);
    if (d.action === "refresh-costs") {
      await run(
        c.env.DB,
        "DELETE FROM worker_task WHERE name IN ('billing','cost-estimates')",
      );
      await Promise.all([refreshMonthlyCosts(c.env), refreshEstimates(c.env)]);
    } else if (d.action === "client") {
      const name = String(d.name || "").trim(),
        uris = String(d.redirect_uris || "")
          .trim()
          .split(/\s+/);
      if (!name || name.length > 255 || !uris.length || uris.length > 10)
        throw new HttpError(400, "Enter a name and 1–10 callback URLs.");
      for (const uri of uris) {
        let u;
        try {
          u = new URL(uri);
        } catch {
          throw new HttpError(400, "Invalid callback URL.");
        }
        if (
          u.hash ||
          u.username ||
          u.password ||
          !(
            ["https:"].includes(u.protocol) ||
            (u.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
          ) ||
          uri.length > 2000
        )
          throw new HttpError(
            400,
            "Callbacks require HTTPS, or HTTP on loopback.",
          );
      }
      await run(
        c.env.DB,
        "INSERT INTO oauth2_provider_application(redirect_uris,client_type,authorization_grant_type,client_secret,name,user_id,skip_authorization,created,updated,algorithm,post_logout_redirect_uris,hash_client_secret,allowed_origins,registration_source,cimd_expires_at,client_id) VALUES (?,'public','authorization-code','',?,?,0,?,?,'','',0,'','admin',NULL,?)",
        uris.join("\n"),
        name,
        c.get("user")!.id,
        now(),
        now(),
        random(),
      );
    } else if (d.action === "revoke-client") {
      const client = await one(
        c.env.DB,
        "SELECT client_id FROM oauth2_provider_application WHERE id=?",
        Number(d.id),
      );
      if (!client) throw new HttpError(404, "Client not found.");
      await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM worker_token WHERE client_id=?").bind(
          client.client_id,
        ),
        c.env.DB.prepare(
          "DELETE FROM worker_oauth_code WHERE client_id=?",
        ).bind(client.client_id),
        c.env.DB.prepare(
          "UPDATE hub_apikey SET revoked_at=? WHERE application_id=?",
        ).bind(now(), Number(d.id)),
        c.env.DB.prepare(
          "DELETE FROM oauth2_provider_application WHERE id=?",
        ).bind(Number(d.id)),
      ]);
    } else if (d.action === "type") {
      const type = await one<{ id: number; slug: string }>(
        c.env.DB,
        "SELECT * FROM hub_contenttype WHERE id=?",
        Number(d.id),
      );
      if (!type) throw new HttpError(404, "File type not found.");
      const name = String(d.name || "").trim(),
        position = Number(d.position);
      if (
        !name ||
        name.length > 50 ||
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position > 10000
      )
        throw new HttpError(400, "Invalid file type settings.");
      if (d.uploads_enabled && !["blueprints", "scenarios"].includes(type.slug))
        throw new HttpError(400, "This file type has no native validator.");
      await run(
        c.env.DB,
        "UPDATE hub_contenttype SET name=?,description=?,position=?,uploads_enabled=? WHERE id=?",
        name,
        String(d.description || "").slice(0, 200),
        position,
        d.uploads_enabled ? 1 : 0,
        type.id,
      );
    } else throw new HttpError(400, "Unknown setting.");
    await run(
      c.env.DB,
      "INSERT INTO hub_moderationlog(action,reason,created_at,actor_id,item_id,item_title,target_user_id,username) VALUES ('site-settings',?,?,?,NULL,'',NULL,'')",
      String(d.action),
      now(),
      c.get("user")!.id,
    );
    return c.redirect("/admin/settings");
  }
  const csrf =
    '<input type="hidden" name="csrfmiddlewaretoken" value="' +
    esc(c.get("user")!.csrf) +
    '">';
  const clients = await all(
    c.env.DB,
    "SELECT id,name,client_id,redirect_uris FROM oauth2_provider_application ORDER BY name",
  );
  const types = await all(
    c.env.DB,
    "SELECT * FROM hub_contenttype ORDER BY position",
  );
  return render(c, "hub/message.html", {
    heading: "Site settings",
    content: safe(
      '<form method="post">' +
        csrf +
        '<input type="hidden" name="action" value="refresh-costs"><button>Refresh Monthly Costs</button></form>' +
        '<p><a class="win-button" href="/moderation/">Moderation</a></p><section class="paper-panel"><h2>Manager applications</h2>' +
        clients
          .map(
            (a) =>
              "<p><strong>" +
              esc(a.name) +
              "</strong><br>Client ID: <code>" +
              esc(a.client_id) +
              "</code><br>" +
              esc(a.redirect_uris) +
              '</p><form method="post">' +
              csrf +
              '<input type="hidden" name="action" value="revoke-client"><input type="hidden" name="id" value="' +
              a.id +
              '"><button>Remove application and revoke access</button></form>',
          )
          .join("") +
        '<form method="post" class="standard-form">' +
        csrf +
        '<input type="hidden" name="action" value="client">' +
        input(
          "name",
          "Application name",
          "",
          "text",
          'required maxlength="255"',
        ) +
        area("redirect_uris", "Callback URLs, one per line", "", 20000) +
        '<p>Public clients must use PKCE (S256). No client secret is needed.</p><button>Add application</button></form></section><section class="paper-panel"><h2>File types</h2>' +
        types
          .map(
            (t) =>
              '<form method="post" class="standard-form">' +
              csrf +
              '<input type="hidden" name="action" value="type"><input type="hidden" name="id" value="' +
              t.id +
              '"><h3>' +
              esc(t.slug) +
              "</h3>" +
              input("name", "Name", t.name, "text", 'required maxlength="50"') +
              input(
                "description",
                "Description",
                t.description,
                "text",
                'maxlength="200"',
              ) +
              input(
                "position",
                "Position",
                t.position,
                "number",
                'min="0" max="10000" required',
              ) +
              input(
                "uploads_enabled",
                "Allow uploads",
                1,
                "checkbox",
                t.uploads_enabled ? "checked" : "",
              ) +
              "<button>Save file type</button></form>",
          )
          .join("") +
        "</section>",
    ),
  });
});
