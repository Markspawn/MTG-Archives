import {connectorOrigin, connectorResource, connectorScopes, CONNECTOR_CLIENT_ID} from "./scan-connector-policy";

export function connectorJson(value: unknown, status = 200, headers: Record<string,string> = {}) {
  return Response.json(value, {status, headers: {"Cache-Control":"no-store", "Referrer-Policy":"no-referrer", ...headers}});
}
export function connectorMetadata(kind: "resource" | "authorization") {
  const origin = connectorOrigin();
  if (kind === "resource") return {resource: connectorResource(), authorization_servers: [origin],
    scopes_supported: [...connectorScopes], bearer_methods_supported: ["header"], resource_name: "MTG Archives scan review"};
  return {issuer: origin, authorization_endpoint: origin + "/settings/connections/authorize",
    token_endpoint: origin + "/api/scan-connector/token", revocation_endpoint: origin + "/api/scan-connector/revoke",
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...connectorScopes], authorization_response_iss_parameter_supported: true};
}
export function connectorChallenge(scopes: string) {
  return `Bearer resource_metadata="${connectorOrigin()}/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="Link an MTG Archives account with the required permission", scope="${scopes}"`;
}
export async function connectorForm(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) throw new Error("Invalid form");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing form");
  const chunks: Uint8Array[] = []; let length = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break;
    length += next.value.byteLength; if (length > 8192) { await reader.cancel(); throw new Error("Form too large"); }
    chunks.push(next.value);
  }} finally {reader.releaseLock();}
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new Error("Duplicate form parameter");
  return params;
}
export {CONNECTOR_CLIENT_ID};
