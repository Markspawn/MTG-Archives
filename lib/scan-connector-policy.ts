import {createHash, randomBytes} from "node:crypto";
import {z} from "zod";

export const CONNECTOR_CLIENT_ID = "mtg-archives-chatgpt";
export const connectorScopes = ["scans:read", "scans:confirm", "scans:all-users"] as const;
export const opaqueCredential = () => randomBytes(32).toString("base64url");
export const credentialDigest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const pkceChallenge = (value: string) => createHash("sha256").update(value).digest("base64url");
export const ACCESS_SECONDS = 15 * 60;
export const GRANT_SECONDS = 30 * 24 * 60 * 60;

export function connectorOrigin() {
  if (process.env.SCAN_CONNECTOR_ENABLED !== "1") throw new Error("Scan connector is disabled");
  const url = new URL(process.env.APP_BASE_URL ?? "");
  const local = process.env.NODE_ENV !== "production" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Configure the connector's HTTPS application origin");
  return url.origin;
}
export const connectorResource = () => connectorOrigin() + "/api/scan-connector/mcp";

export function parseConnectorScopes(value: string) {
  const scopes = [...new Set(value.trim().split(/\s+/).filter(Boolean))];
  if (!scopes.includes("scans:read") || scopes.some(scope => !connectorScopes.includes(scope as typeof connectorScopes[number])))
    throw new Error("Unsupported connector permissions");
  return scopes;
}
export function validConnectorRedirect(value: string) {
  try {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com" && !url.search && !url.hash &&
      (url.pathname === "/connector_platform_oauth_redirect" || /^\/connector\/oauth\/[A-Za-z0-9_-]{1,200}$/.test(url.pathname));
  } catch { return false; }
}
export const connectorAuthorizationSchema = z.object({
  response_type: z.literal("code"), client_id: z.literal(CONNECTOR_CLIENT_ID),
  redirect_uri: z.string().max(500).refine(validConnectorRedirect),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal("S256"),
  resource: z.string().max(500), scope: z.string().max(200).default("scans:read scans:confirm"),
  state: z.string().min(1).max(2000),
});
export function connectorAuthorization(params: URLSearchParams) {
  for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new Error("Duplicate authorization parameter");
  const parsed = connectorAuthorizationSchema.parse(Object.fromEntries(params));
  if (parsed.resource !== connectorResource()) throw new Error("Wrong connector resource");
  return {...parsed, scopes: parseConnectorScopes(parsed.scope)};
}
export function connectorSecurityKey(user: {passwordHash: string; role: string; playerId: string | null}, admin: boolean) {
  return credentialDigest(JSON.stringify([user.passwordHash, user.role, user.playerId, admin, connectorResource()]));
}
export function sameConnectorOrigin(request: Request) {
  if (request.headers.get("origin") !== connectorOrigin()) throw new Error("Request origin unavailable");
}
