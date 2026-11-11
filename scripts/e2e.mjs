/**
 * End-to-end check against a running `wrangler dev`.
 * Starts a localhost doorbell receiver, signs in two agents, sends, and acks.
 *
 *   npm run dev
 *   node scripts/e2e.mjs
 */
const origin = process.env.CLICK_ORIGIN ?? "https://127.0.0.1:8787";
// wrangler dev presents the custom domain, so OAuth's resource is the production URL.
const resource = process.env.CLICK_RESOURCE ?? "https://clickmcp.com/mcp";
const ownerKey = process.env.CLICK_OWNER_KEY ?? "click-test-owner-key";
const hookPort = Number(process.env.CLICK_HOOK_PORT ?? 9797);

const doorbells = [];
const server = (await import("node:http")).createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    doorbells.push({
      body: Buffer.concat(chunks).toString("utf8"),
      signature: req.headers["x-click-signature"],
      timestamp: req.headers["x-click-timestamp"],
      authorization: req.headers.authorization,
    });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
});
await new Promise((resolve) => server.listen(hookPort, "127.0.0.1", resolve));

function cookies(response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).filter(Boolean).join("; ");
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function pkce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

async function signIn(label) {
  const registered = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: label,
      redirect_uris: ["http://127.0.0.1:8765/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const registration = await registered.json();
  if (!registered.ok) throw new Error(`register ${registered.status}: ${JSON.stringify(registration)}`);
  const { verifier, challenge } = await pkce();
  const authorize = new URL(`${origin}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", registration.client_id);
  authorize.searchParams.set("redirect_uri", "http://127.0.0.1:8765/callback");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", label);
  authorize.searchParams.set("scope", "click");
  authorize.searchParams.set("resource", resource);
  const page = await fetch(authorize, { redirect: "manual" });
  const html = await page.text();
  if (page.status !== 200) throw new Error(`authorize ${page.status} ${page.headers.get("location")}: ${html}`);
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  if (!handle) throw new Error("consent form missing");
  const form = new URLSearchParams();
  form.set("handle", handle);
  form.set("key", ownerKey);
  form.set("decision", "approve");
  form.set("label", label);
  form.append("scope", "click");
  const posted = await fetch(`${origin}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookies(page),
      origin,
    },
    body: form,
  });
  const location = posted.headers.get("location");
  if (posted.status !== 302 || !location) throw new Error(`consent ${posted.status}: ${await posted.text()}`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`no code: ${location}`);
  const token = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:8765/callback",
      client_id: registration.client_id,
      code_verifier: verifier,
      resource,
    }),
  });
  const issued = await token.json();
  if (!token.ok) throw new Error(`token ${token.status}: ${JSON.stringify(issued)}`);
  return issued.access_token;
}

async function mcp(token, method, params, id = 1) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  const data = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  const body = JSON.parse(data.at(-1) ?? text);
  if (!response.ok) throw new Error(`${method} ${response.status}: ${text}`);
  return body;
}

async function tool(token, name, args) {
  const body = await mcp(token, "tools/call", { name, arguments: args }, 2);
  const result = body.result;
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(text);
  return JSON.parse(text);
}

try {
  const ada = await signIn("ada");
  const grace = await signIn("grace");
  for (const token of [ada, grace]) {
    await mcp(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "click-e2e", version: "0" },
    });
    await mcp(token, "notifications/initialized");
  }
  const suffix = crypto.randomUUID().slice(0, 8);
  await tool(ada, "register", { handle: `ada-${suffix}`, name: "Ada" });
  await tool(grace, "register", {
    handle: `grace-${suffix}`,
    name: "Grace",
    webhook_url: `http://127.0.0.1:${hookPort}/hook`,
    webhook_key: "e2e-webhook-key",
  });
  const sent = await tool(ada, "send", { to: `grace-${suffix}`, text: "hello from e2e" });
  const deadline = Date.now() + 8000;
  while (doorbells.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (doorbells.length === 0) {
    const status = await tool(ada, "delivery_status", { event_id: sent.event_id });
    throw new Error(`no doorbell: ${JSON.stringify(status)}`);
  }
  const bell = doorbells[0];
  const parsed = JSON.parse(bell.body);
  if (parsed.type !== "click.doorbell" || parsed.agent !== `grace-${suffix}`) {
    throw new Error(`unexpected doorbell ${bell.body}`);
  }
  if (!bell.authorization?.includes("e2e-webhook-key") || !String(bell.signature).startsWith("v1=")) {
    throw new Error(`doorbell was not signed: ${JSON.stringify(bell)}`);
  }
  const inbox = await tool(grace, "inbox");
  const message = inbox.messages.find((item) => item.text === "hello from e2e");
  if (!message) throw new Error(`inbox missing message: ${JSON.stringify(inbox)}`);
  const acked = await tool(grace, "ack", { ids: [message.id] });
  if (!acked.acked.includes(message.id)) throw new Error(`ack failed: ${JSON.stringify(acked)}`);
  const after = await tool(grace, "inbox");
  if (after.messages.some((item) => item.id === message.id)) throw new Error("message still in inbox");
  console.log(JSON.stringify({ ok: true, event_id: sent.event_id, doorbells: doorbells.length }));
} finally {
  server.close();
}
