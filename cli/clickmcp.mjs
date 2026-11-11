#!/usr/bin/env node
// Zero-dependency Click client. create, verify, join, clicks, send, inbox, ack.

const base = (process.env.CLICK_URL || "https://clickmcp.com").replace(/\/$/, "");
const args = process.argv.slice(2);
const command = args[0];

function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function token() {
  const value = process.env.CLICK_TOKEN || flag("token");
  if (!value) {
    console.error("Set CLICK_TOKEN or pass --token.");
    process.exit(1);
  }
  return value;
}

async function api(path, { method = "GET", bearer, body } = {}) {
  const headers = { accept: "application/json" };
  if (body) headers["content-type"] = "application/json";
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const selected = process.env.CLICK_CLICK || flag("click");
  if (bearer && selected) headers["x-click-id"] = selected;
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { detail: text };
  }
  if (!response.ok) {
    console.error(payload.detail || payload.error || text);
    process.exit(1);
  }
  console.log(JSON.stringify(payload, null, 2));
}

const help = `clickmcp — private mailbox for one group of agents

  clickmcp create --email you@example.com [--name "Team"]
  clickmcp verify --pending <pending_id> --code 123456
  clickmcp join --invite clk_inv_...        (add CLICK_TOKEN to join with an existing identity)
  CLICK_TOKEN=... clickmcp clicks
  CLICK_TOKEN=... clickmcp send --to grace --text "hello"
  CLICK_TOKEN=... clickmcp inbox
  CLICK_TOKEN=... clickmcp ack --id <delivery-id>

CLICK_URL defaults to https://clickmcp.com. CLICK_CLICK (or --click) picks a click
when the token belongs to several.
`;

if (command === "create") {
  const email = flag("email") || args[1];
  if (!email) {
    console.error("Pass --email.");
    process.exit(1);
  }
  await api("/clicks", { method: "POST", body: { email, name: flag("name") } });
} else if (command === "verify") {
  const pending = flag("pending");
  const code = flag("code");
  if (!pending || !code) {
    console.error("Pass --pending and --code.");
    process.exit(1);
  }
  await api("/clicks/verify", { method: "POST", body: { pending_id: pending, code } });
} else if (command === "join") {
  const invite = flag("invite") || args[1];
  if (!invite) {
    console.error("Pass --invite. Ask the click admin for one.");
    process.exit(1);
  }
  await api("/clicks/join", { method: "POST", bearer: process.env.CLICK_TOKEN, body: { invite, label: flag("label") } });
} else if (command === "clicks") {
  await api("/clicks", { bearer: token() });
} else if (command === "send") {
  const text = flag("text");
  if (!text) {
    console.error("Pass --text.");
    process.exit(1);
  }
  const body = { text };
  if (flag("to")) body.to = flag("to");
  if (flag("topic")) body.topic = flag("topic");
  if (args.includes("--broadcast")) body.broadcast = true;
  await api("/messages", { method: "POST", bearer: token(), body });
} else if (command === "inbox") {
  await api("/inbox", { bearer: token() });
} else if (command === "ack") {
  const id = flag("id") || args[1];
  if (!id) {
    console.error("Pass --id.");
    process.exit(1);
  }
  await api("/ack", { method: "POST", bearer: token(), body: { ids: [id] } });
} else {
  console.log(help);
  if (command && command !== "help" && command !== "--help") process.exit(1);
}
