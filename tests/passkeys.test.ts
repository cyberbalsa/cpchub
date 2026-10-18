import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/app";
import { authenticator } from "./helpers/passkeys";
import { hash } from "../src/env";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";

type Fixture = Awaited<ReturnType<typeof fixture>>;
function browser(f: Fixture, signedIn = false) {
  const cookies = new Map<string, string>(
    signedIn
      ? [["cpc_session", "test-session"]]
      : [["cpc_csrf", "anonymous-csrf"]],
  );
  let csrf = signedIn ? "test-csrf" : "anonymous-csrf";
  return {
    cookies,
    async post(path: string, data: unknown = {}) {
      const response = await f.rawRequest("/accounts/passkeys/" + path + "/", {
        method: "POST",
        headers: {
          Cookie: [...cookies]
            .map(([key, value]) => key + "=" + value)
            .join("; "),
          "X-CSRFToken": csrf,
          Origin: f.env.PUBLIC_URL,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(data),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [key, value] = cookie.split(";")[0]!.split("=");
        if (value) cookies.set(key!, value);
        else cookies.delete(key!);
      }
      if (cookies.has("cpc_session"))
        csrf = String(
          f.sqlite
            .prepare("SELECT csrf FROM worker_session WHERE digest=?")
            .get(await hash(cookies.get("cpc_session")!))?.csrf || csrf,
        );
      return response;
    },
  };
}
async function register(
  f: Fixture,
  client = browser(f),
  device = authenticator(),
  username = "Passkey user",
) {
  const options = await client.post("register/options", {
    username,
    create_account: true,
  });
  assert.equal(options.status, 200, await options.clone().text());
  const credential = device.register(
    await options.json<PublicKeyCredentialCreationOptionsJSON>(),
  );
  const response = await client.post("register/verify", { credential });
  assert.equal(response.status, 200, await response.clone().text());
  return { client, device, response };
}
const count = (f: Fixture, table: string) =>
  Number(f.sqlite.prepare("SELECT COUNT(*) n FROM " + table).get()!.n);

void test("a filtered display name does not prevent passkey registration or subsequent sign-in", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const { device } = await register(
    f,
    browser(f),
    authenticator(),
    "𝓯𝓾𝓬𝓴 Passkey",
  );
  const user = f.sqlite
    .prepare("SELECT id,username FROM auth_user WHERE username='fuck Passkey'")
    .get()!;
  assert(user);
  const page = await f.request(
    "/creators/" + String(user.id) + "/",
    "GET",
    undefined,
    "anonymous",
  );
  assert.equal(page.status, 200);
  assert((await page.text()).includes("♥♥♥♥ Passkey"));
  const client = browser(f);
  const options = await client.post("login/options");
  assert.equal(options.status, 200);
  const credential = device.authenticate(
    await options.json<PublicKeyCredentialRequestOptionsJSON>(),
  );
  assert.equal((await client.post("login/verify", { credential })).status, 200);
});

void test("a named passkey-only account registers, signs out and signs in without a username", async () => {
  const f = await fixture();
  try {
    const client = browser(f),
      device = authenticator();
    const options = await client.post("register/options", {
      username: "  Cafe\u0301 停車  ",
      create_account: true,
    });
    assert.equal(options.status, 200);
    assert.equal(
      count(f, "auth_user"),
      2,
      "options must not create an account",
    );
    assert.match(options.headers.get("Set-Cookie")!, /HttpOnly/);
    assert.match(options.headers.get("Set-Cookie")!, /Secure/);
    assert.match(options.headers.get("Set-Cookie")!, /SameSite=Strict/);
    const creation =
      await options.json<PublicKeyCredentialCreationOptionsJSON>();
    assert.equal(creation.rp.id, "cpchub.net");
    assert.equal(creation.authenticatorSelection!.residentKey, "required");
    assert.equal(creation.authenticatorSelection!.userVerification, "required");
    const response = await client.post("register/verify", {
      credential: device.register(creation),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const user = f.sqlite
      .prepare("SELECT * FROM auth_user WHERE username=?")
      .get("Cafe Ting Che")!;
    assert.equal(user.password, "!");
    assert.equal(user.email, "");
    assert.equal(user.is_staff, 0);
    assert.equal(user.is_superuser, 0);
    assert.equal(user.username_changed_at, null);
    assert.equal(count(f, "socialaccount_socialaccount"), 0);
    assert.equal(count(f, "worker_passkey_challenge"), 0);
    assert.equal(count(f, "worker_passkey"), 1);
    assert.equal(count(f, "worker_session"), 2);
    assert.equal(
      f.sqlite
        .prepare(
          "SELECT auth_method FROM hub_accountactivity ORDER BY id DESC LIMIT 1",
        )
        .get()!.auth_method,
      "passkey",
    );
    const sid = client.cookies.get("cpc_session")!,
      session = f.sqlite
        .prepare("SELECT csrf FROM worker_session WHERE digest=?")
        .get(await hash(sid))!;
    const logout = await f.rawRequest("/accounts/logout/", {
      method: "POST",
      headers: {
        Cookie: "cpc_session=" + sid,
        "X-CSRFToken": String(session.csrf),
      },
    });
    assert.equal(logout.status, 302);
    assert.equal(count(f, "worker_session"), 1);
    const returning = browser(f),
      login = await returning.post("login/options"),
      request = await login.json<PublicKeyCredentialRequestOptionsJSON>();
    assert.equal(request.userVerification, "required");
    assert(!request.allowCredentials?.length);
    const signedIn = await returning.post("login/verify", {
      credential: device.authenticate(request),
    });
    assert.equal(signedIn.status, 200, await signedIn.clone().text());
    assert.deepEqual(await signedIn.json<unknown>(), { redirect_url: "/" });
    const me = await f.rawRequest("/api/v1/me/", {
      headers: {
        Cookie: "cpc_session=" + returning.cookies.get("cpc_session"),
      },
    });
    assert.deepEqual(await me.json<unknown>(), {
      id: user.id,
      username: "Cafe Ting Che",
    });
    assert.equal(count(f, "auth_user"), 3);
    assert.equal(
      f.sqlite.prepare("SELECT counter FROM worker_passkey").get()!.counter,
      1,
    );
  } finally {
    f.close();
  }
});

void test("existing users add passkeys to their own account and cannot switch accounts mid-enrollment", async () => {
  const f = await fixture();
  try {
    const { device } = await register(f, browser(f, true));
    assert.equal(count(f, "auth_user"), 2);
    assert.equal(
      f.sqlite.prepare("SELECT user_id FROM worker_passkey").get()!.user_id,
      1,
    );
    const client = browser(f, true),
      options = await client.post("register/options", { user_id: 2 });
    const data = await options.json<PublicKeyCredentialCreationOptionsJSON>();
    assert.equal(data.user.name, "Author");
    assert.equal(data.excludeCredentials![0]!.id, device.id);
    await f.db
      .prepare("INSERT INTO worker_session VALUES (?,?,?,?)")
      .bind(await hash("other-session"), 2, "test-csrf", Date.now() + 3600000)
      .run();
    client.cookies.set("cpc_session", "other-session");
    const verify = await client.post("register/verify", {
      credential: authenticator().register(data),
    });
    assert.equal(verify.status, 403);
    assert.match(await verify.text(), /Your sign-in changed/);
    assert.equal(count(f, "worker_passkey"), 1);
    const html = await (await f.request("/account/profile/")).text();
    assert.match(html, /Passkey 1/);
    assert.match(html, /Add a passkey/);
  } finally {
    f.close();
  }
});

void test("unknown passkeys offer registration without creating accounts or sessions", async () => {
  const f = await fixture();
  try {
    const client = browser(f),
      options = await (
        await client.post("login/options")
      ).json<PublicKeyCredentialRequestOptionsJSON>();
    const response = await client.post("login/verify", {
      credential: authenticator().authenticate(options),
    });
    assert.equal(response.status, 404);
    assert.equal(
      (await response.json<{ registration_required: boolean }>())
        .registration_required,
      true,
    );
    assert.equal(count(f, "auth_user"), 2);
    assert.equal(count(f, "worker_session"), 1);
    assert.equal(count(f, "worker_passkey_challenge"), 0);
  } finally {
    f.close();
  }
});

void test("account creation requires confirmation, a valid available name, CSRF and same origin", async () => {
  const f = await fixture();
  try {
    const client = browser(f);
    assert.equal(
      (await client.post("register/options", { username: "New user" })).status,
      400,
    );
    for (const username of [
      "",
      null,
      12,
      ["Name"],
      "a".repeat(151),
      "name\nname",
      "<script>",
    ])
      assert.equal(
        (
          await client.post("register/options", {
            username,
            create_account: true,
          })
        ).status,
        400,
      );
    const taken = await client.post("register/options", {
      username: "Author",
      create_account: true,
    });
    assert.equal(taken.status, 409);
    for (const headers of [
      {},
      {
        Cookie: "cpc_csrf=csrf",
        "X-CSRFToken": "csrf",
        Origin: "https://evil.example",
      },
    ] as Record<string, string>[]) {
      assert.equal(
        (
          await f.rawRequest("/accounts/passkeys/register/options/", {
            method: "POST",
            headers: {
              ...headers,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: '{"username":"Name","create_account":true}',
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await f.request(
          "/accounts/passkeys/register/options/",
          "POST",
          {},
          "key",
        )
      ).status,
      403,
    );
    assert.equal((await browser(f, true).post("login/options")).status, 409);
    assert.equal(count(f, "auth_user"), 2);
    assert.equal(count(f, "worker_passkey_challenge"), 0);
  } finally {
    f.close();
  }
});

void test("registration rejects wrong challenges, origins, RP IDs, missing verification and credential substitution", async () => {
  const f = await fixture();
  try {
    const cases = [
      { origin: "https://evil.example" },
      { rpID: "evil.example" },
      { challenge: "wrong" },
      { flags: 0x41 },
      { crossOrigin: true },
      { flags: 0x44 },
    ];
    for (const overrides of cases) {
      const client = browser(f),
        device = authenticator();
      const options = await (
        await client.post("register/options", {
          username: "New user",
          create_account: true,
        })
      ).json<PublicKeyCredentialCreationOptionsJSON>();
      const invalid = await client.post("register/verify", {
        credential: device.register(options, overrides),
      });
      assert.equal(invalid.status, 400, JSON.stringify(overrides));
      assert.equal(
        (
          await client.post("register/verify", {
            credential: device.register(options),
          })
        ).status,
        400,
        "failed challenges cannot be retried",
      );
    }
    const client = browser(f),
      options = await (
        await client.post("register/options", {
          username: "New user",
          create_account: true,
        })
      ).json<PublicKeyCredentialCreationOptionsJSON>();
    const response = authenticator().register(options);
    response.id = response.rawId = "substituted-id";
    assert.equal(
      (await client.post("register/verify", { credential: response })).status,
      400,
    );
    assert.equal(count(f, "auth_user"), 2);
    assert.equal(count(f, "worker_passkey"), 0);
  } finally {
    f.close();
  }
});

void test("authentication verifies signatures, origin, challenge, RP ID, user verification, handle and counters", async () => {
  const f = await fixture();
  try {
    const { device } = await register(f);
    for (const overrides of [
      { origin: "https://evil.example" },
      { rpID: "evil.example" },
      { challenge: "wrong" },
      { flags: 1 },
      { userHandle: "wrong" },
      { crossOrigin: true },
    ]) {
      const client = browser(f),
        options = await (
          await client.post("login/options")
        ).json<PublicKeyCredentialRequestOptionsJSON>();
      const response = await client.post("login/verify", {
        credential: device.authenticate(options, overrides),
      });
      assert.equal(response.status, 400, JSON.stringify(overrides));
    }
    const client = browser(f),
      options = await (
        await client.post("login/options")
      ).json<PublicKeyCredentialRequestOptionsJSON>();
    const invalid = device.authenticate(options);
    invalid.response.signature = "AAAA";
    assert.equal(
      (await client.post("login/verify", { credential: invalid })).status,
      400,
    );
    assert.equal(count(f, "worker_session"), 2);
    const success = browser(f),
      challenge = await (
        await success.post("login/options")
      ).json<PublicKeyCredentialRequestOptionsJSON>();
    const savedCookie = success.cookies.get("cpc_passkey")!;
    const assertion = device.authenticate(challenge);
    assert.equal(
      (await success.post("login/verify", { credential: assertion })).status,
      200,
    );
    const replay = browser(f);
    replay.cookies.set("cpc_passkey", savedCookie);
    assert.equal(
      (await replay.post("login/verify", { credential: assertion })).status,
      400,
    );
    const next = await (
      await replay.post("login/options")
    ).json<PublicKeyCredentialRequestOptionsJSON>();
    assert.equal(
      (
        await replay.post("login/verify", {
          credential: device.authenticate(next),
        })
      ).status,
      400,
      "nonzero counter must increase",
    );
    f.sqlite
      .prepare(
        "UPDATE auth_user SET is_active=0 WHERE id=(SELECT user_id FROM worker_passkey)",
      )
      .run();
    const inactive = await (
      await replay.post("login/options")
    ).json<PublicKeyCredentialRequestOptionsJSON>();
    assert.equal(
      (
        await replay.post("login/verify", {
          credential: device.authenticate(inactive, { counter: 2 }),
        })
      ).status,
      403,
    );
  } finally {
    f.close();
  }
});

void test("expired challenges and missing browser cookies cannot register an account", async () => {
  const f = await fixture();
  try {
    const client = browser(f),
      device = authenticator(),
      options = await (
        await client.post("register/options", {
          username: "New user",
          create_account: true,
        })
      ).json<PublicKeyCredentialCreationOptionsJSON>();
    assert.equal(
      (
        await browser(f).post("register/verify", {
          credential: device.register(options),
        })
      ).status,
      400,
    );
    f.sqlite.prepare("UPDATE worker_passkey_challenge SET expires_at=0").run();
    assert.equal(
      (
        await client.post("register/verify", {
          credential: device.register(options),
        })
      ).status,
      400,
    );
    assert.equal(count(f, "auth_user"), 2);
  } finally {
    f.close();
  }
});

void test("synced passkeys that keep a zero counter can sign in repeatedly", async () => {
  const f = await fixture();
  try {
    const client = browser(f),
      device = authenticator();
    const options = await (
      await client.post("register/options", {
        username: "Synced passkey",
        create_account: true,
      })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    assert.equal(
      (
        await client.post("register/verify", {
          credential: device.register(options, { flags: 0x5d }),
        })
      ).status,
      200,
    );
    for (let i = 0; i < 2; i++) {
      const returning = browser(f),
        options = await (
          await returning.post("login/options")
        ).json<PublicKeyCredentialRequestOptionsJSON>();
      assert.equal(
        (
          await returning.post("login/verify", {
            credential: device.authenticate(options, {
              flags: 0x1d,
              counter: 0,
            }),
          })
        ).status,
        200,
      );
    }
    const key = f.sqlite
      .prepare("SELECT counter,backed_up,last_used_at FROM worker_passkey")
      .get()!;
    assert.equal(key.counter, 0);
    assert.equal(key.backed_up, 1);
    assert(key.last_used_at);
  } finally {
    f.close();
  }
});

void test("competing registrations and duplicate credentials cannot create orphan accounts or take over a name", async () => {
  const f = await fixture();
  try {
    const a = browser(f),
      b = browser(f),
      device = authenticator();
    const first = await (
      await a.post("register/options", {
        username: "Same name",
        create_account: true,
      })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    const second = await (
      await b.post("register/options", {
        username: "Same name",
        create_account: true,
      })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    assert.equal(
      (await a.post("register/verify", { credential: device.register(first) }))
        .status,
      200,
    );
    assert.equal(
      (
        await b.post("register/verify", {
          credential: authenticator().register(second),
        })
      ).status,
      409,
    );
    const duplicate = await (
      await b.post("register/options", {
        username: "Different name",
        create_account: true,
      })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    assert.equal(
      (
        await b.post("register/verify", {
          credential: device.register(duplicate),
        })
      ).status,
      409,
    );
    assert.equal(count(f, "auth_user"), 3);
    assert.equal(count(f, "worker_passkey"), 1);
  } finally {
    f.close();
  }
});

void test("passkeys and social accounts share last-sign-in protection and removals enforce ownership", async () => {
  const f = await fixture();
  try {
    const { device } = await register(f, browser(f, true));
    assert.equal(
      (
        await f.request("/account/profile/", "POST", {
          action: "remove-passkey",
          passkey: device.id,
        })
      ).status,
      409,
    );
    f.insert("socialaccount_socialaccount", {
      provider: "steam",
      uid: "steam-id",
      user_id: 1,
      extra_data: "{}",
    });
    const linked = f.sqlite
      .prepare("SELECT id FROM socialaccount_socialaccount")
      .get()!.id;
    assert.equal(
      (
        await f.request("/account/profile/", "POST", {
          action: "unlink",
          account: linked,
        })
      ).status,
      302,
    );
    assert.equal(count(f, "socialaccount_socialaccount"), 0);
    assert.equal(count(f, "worker_passkey"), 1);
    const second = await register(f, browser(f, true));
    assert.equal(
      (
        await f.request("/account/profile/", "POST", {
          action: "remove-passkey",
          passkey: device.id,
        })
      ).status,
      303,
    );
    assert.equal(
      (
        await f.request("/account/profile/", "POST", {
          action: "remove-passkey",
          passkey: second.device.id,
        })
      ).status,
      409,
    );
    f.sqlite.prepare("UPDATE worker_passkey SET user_id=2").run();
    assert.equal(
      (
        await f.request("/account/profile/", "POST", {
          action: "remove-passkey",
          passkey: second.device.id,
        })
      ).status,
      409,
    );
    assert.equal(count(f, "worker_passkey"), 1);
  } finally {
    f.close();
  }
});

void test("malformed JSON and credentials are rejected without allocating accounts", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const client = browser(f);
  for (const value of [null, [], "string"])
    assert.equal((await client.post("register/options", value)).status, 400);
  const malformed = await f.rawRequest("/accounts/passkeys/register/options/", {
    method: "POST",
    headers: {
      Cookie: "cpc_csrf=csrf",
      "X-CSRFToken": "csrf",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: "invalid",
  });
  assert.equal(malformed.status, 400);
  for (const credential of [null, {}, { id: 1 }, { id: "invalid/" }]) {
    await client.post("login/options");
    assert.equal(
      (await client.post("login/verify", { credential })).status,
      400,
    );
  }
  const options = await (
    await client.post("register/options", {
      username: "New",
      create_account: true,
    })
  ).json<PublicKeyCredentialCreationOptionsJSON>();
  const credential = authenticator().register(options);
  credential.clientExtensionResults = { credProps: { rk: false } };
  assert.equal(
    (await client.post("register/verify", { credential })).status,
    400,
  );
  assert.equal(count(f, "auth_user"), 2);
});

void test("validly encoded but incorrect authentication and attestation signatures never establish sessions", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const { device } = await register(f);
  const client = browser(f);
  const options = await (
    await client.post("login/options")
  ).json<PublicKeyCredentialRequestOptionsJSON>();
  const credential = device.authenticate(options);
  credential.response.signature =
    authenticator().authenticate(options).response.signature;
  assert.equal((await client.post("login/verify", { credential })).status, 400);
  const registration = await (
    await client.post("register/options", {
      username: "New",
      create_account: true,
    })
  ).json<PublicKeyCredentialCreationOptionsJSON>();
  assert.equal(
    (
      await client.post("register/verify", {
        credential: authenticator().register(registration, {
          invalidAttestation: true,
        }),
      })
    ).status,
    400,
  );
  assert.equal(count(f, "worker_session"), 2);
});

void test("passkey limits apply both before options and atomically at enrollment commit", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const client = browser(f, true);
  const options = await (
    await client.post("register/options")
  ).json<PublicKeyCredentialCreationOptionsJSON>();
  for (let n = 0; n < 10; n++)
    f.insert("worker_passkey", {
      id: "key" + n,
      user_id: 1,
      public_key: "test",
      counter: 0,
      transports: "[]",
      device_type: "singleDevice",
      backed_up: 0,
    });
  assert.equal(
    (
      await client.post("register/verify", {
        credential: authenticator().register(options),
      })
    ).status,
    409,
  );
  assert.equal((await client.post("register/options")).status, 409);
  assert.equal(count(f, "worker_passkey"), 10);
});

void test("concurrent key changes and account deactivation fail closed", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const { device } = await register(f);
  const client = browser(f),
    options = await (
      await client.post("login/options")
    ).json<PublicKeyCredentialRequestOptionsJSON>();
  const prepare = f.db.prepare.bind(f.db);
  const changed = t.mock.method(f.db, "prepare", (sql: string) => {
    if (sql.startsWith("UPDATE worker_passkey SET counter="))
      f.sqlite.exec("UPDATE worker_passkey SET counter=2");
    return prepare(sql);
  });
  assert.equal(
    (
      await client.post("login/verify", {
        credential: device.authenticate(options),
      })
    ).status,
    400,
  );
  changed.mock.restore();
  const fresh = browser(f),
    registrationOptions = await (
      await fresh.post("register/options", {
        username: "Deactivated",
        create_account: true,
      })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
  const batch = f.db.batch.bind(f.db);
  t.mock.method(f.db, "batch", async (statements: D1PreparedStatement[]) => {
    const result = await batch(statements);
    f.sqlite.exec(
      "UPDATE auth_user SET is_active=0 WHERE username='Deactivated'",
    );
    return result;
  });
  assert.equal(
    (
      await fresh.post("register/verify", {
        credential: authenticator().register(registrationOptions),
      })
    ).status,
    403,
  );
});

void test("registration transaction errors distinguish duplicate credentials from storage failures", async (t) => {
  for (const mode of ["duplicate", "storage"] as const) {
    const f = await fixture();
    t.after(f.close);
    const client = browser(f),
      device = authenticator();
    const options = await (
      await client.post("register/options", {
        username: "New",
        create_account: true,
      })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    const credential = device.register(options);
    delete credential.response.transports;
    const batch = f.db.batch.bind(f.db);
    t.mock.method(f.db, "batch", async (statements: D1PreparedStatement[]) => {
      if (mode === "storage") throw Error("storage offline");
      f.insert("worker_passkey", {
        id: device.id,
        user_id: 1,
        public_key: "test",
        counter: 0,
        transports: "[]",
        device_type: "singleDevice",
        backed_up: 0,
      });
      return batch(statements);
    });
    t.mock.method(console, "error", () => {});
    assert.equal(
      (await client.post("register/verify", { credential })).status,
      mode === "duplicate" ? 409 : 500,
    );
    assert.equal(count(f, "auth_user"), 2);
  }
});
