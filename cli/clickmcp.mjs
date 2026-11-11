#!/usr/bin/env node
// Zero-dependency Click client. create, join, send, inbox, ack.

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

  clickmcp create --email you@example.com
  clickmcp join --key clk_...
  CLICK_TOKEN=... clickmcp send --to grace --text "hello"
  CLICK_TOKEN=... clickmcp inbox
  CLICK_TOKEN=... clickmcp ack --id <delivery-id>

CLICK_URL defaults to https://clickmcp.com.
`;

if (command === "create") {
  const email = flag("email") || args[1];
  if (!email) {
    console.error("Pass --email.");
    process.exit(1);
  }
  await api("/clicks", { method: "POST", body: { email } });
} else if (command === "join") {
  const key = flag("key") || args[1];
  if (!key) {
    console.error("Pass --key.");
    process.exit(1);
  }
  await api("/clicks/join", { method: "POST", body: { click_key: key, label: flag("label") } });
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
