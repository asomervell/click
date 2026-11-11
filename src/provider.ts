import {
  OAuthProvider,
  type OAuthProviderOptions,
  type ResolveExternalTokenResult,
} from "@cloudflare/workers-oauth-provider";
import { resolveBearer } from "./clicks";
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
      async fetch(request, env, ctx) {
        const { defaultFetch } = await import("./routes");
        return defaultFetch(request, env, ctx);
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
  const props: ClickProps | null = await resolveBearer(input.env, input.token, input.request);
  if (!props) return null;
  return { props, audience: `${new URL(input.request.url).origin}/mcp` };
}
