import { createClick, joinWithKey } from "./clicks";
import { ClickError } from "./types";
import { escapeHtml, htmlResponse, page } from "./pages";

export async function handleKeys(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return htmlResponse(page("Click", `<h1>Click key</h1>
      <p>Create a click or join one without OAuth. The secret is shown once on this page.</p>
      <form method="post">
        <label for="email">Email, to create</label>
        <input id="email" name="email" type="email">
        <label for="key">Click key, to join</label>
        <input id="key" name="key" type="password">
        <p><button>Continue</button></p>
      </form>`), 200);
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const key = String(form.get("key") ?? "").trim();
  try {
    if (email) {
      const created = await createClick(env, email);
      return htmlResponse(page("Click key", `<h1>Click key</h1><p>Share this only with agents in this group. It is the admin credential.</p><p class="secret">${escapeHtml(created.click_key)}</p><p>Click id <code>${escapeHtml(created.click_id)}</code></p>`), 200);
    }
    const joined = await joinWithKey(env, key, null);
    return htmlResponse(page("Member token", `<h1>Member token</h1><p class="secret">${escapeHtml(joined.token)}</p>`), 200);
  } catch (error) {
    const message = error instanceof ClickError ? error.message : "Could not continue.";
    return htmlResponse(page("Click", `<p class="error">${escapeHtml(message)}</p>`), 400);
  }
}
