import {
  OAuthProvider,
  type OAuthProviderOptions,
  type ResolveExternalTokenResult,
} from "@cloudflare/workers-oauth-provider";
import { ownerKeyMatches, sha256Hex } from "./crypto";
import { getHub } from "./hub";
import type { ClickProps } from "./types";

const SCOPES = ["click", "offline_access"];

export function providerOptions(origin: string): OAuthProviderOptions<Env> {
  return {
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, env, ctx) {
        const { apiFetch } = await import("./routes");
        return apiFetch(request, env, ctx);
      },
    },
    defaultHandler: {
      async fetch(request, env) {
        const { defaultFetch } = await import("./routes");
        return defaultFetch(request, env);
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: SCOPES,
    requiredScopes: ["click"],
    allowPrivateUseRedirectUris: true,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      resource_name: "Click",
    },
    resolveExternalToken,
    onError({ code, status, internal }) {
      console.error(JSON.stringify({ message: "oauth_error", code, status, reason: internal.reason }));
    },
  };
}

export function createProvider(origin: string): OAuthProvider<Env> {
  return new OAuthProvider(providerOptions(origin));
}

async function resolveExternalToken(input: {
  token: string;
  request: Request;
  env: Env;
}): Promise<ResolveExternalTokenResult | null> {
  const token = input.token.trim();
  if (token.length === 0 || token.length > 512) return null;
  const audience = `${new URL(input.request.url).origin}/mcp`;
  let props: ClickProps | null = null;
  if (await ownerKeyMatches(token, input.env.OWNER_KEY_HASH)) {
    props = { principalId: "owner", role: "owner" };
  } else if (token.startsWith("clk_") && !token.startsWith("clk_inv_")) {
    props = await getHub(input.env).resolveTokenHash(await sha256Hex(token));
  }
  return props ? { props, audience } : null;
}
