import type {Prisma, PrismaClient, ScanConnectorGrant} from "@prisma/client";
import {isAdminUser} from "./auth-policy";
import {ACCESS_SECONDS, CONNECTOR_CLIENT_ID, GRANT_SECONDS, connectorAuthorization,
  connectorResource, connectorScopes, connectorSecurityKey, credentialDigest, opaqueCredential, pkceChallenge} from "./scan-connector-policy";

type Db = Prisma.TransactionClient;
export class ConnectorAuthorizationError extends Error {
  constructor(public scopes = "scans:read") { super("Link an authorized MTG Archives account"); }
}
async function validGrant(db: Db, grant: ScanConnectorGrant | null) {
  if (!grant || grant.revokedAt || grant.expiresAt.getTime() <= Date.now()) throw new ConnectorAuthorizationError();
  const user = await db.user.findUnique({where: {id: grant.userId}, include: {player: true}});
  const admin = isAdminUser(user, user?.player);
  if (!user?.isActive || user.forcePasswordChange || (!user.player?.active && !admin) ||
    connectorSecurityKey(user, admin) !== grant.securityKey || grant.scopes.includes("scans:all-users") && !admin)
    throw new ConnectorAuthorizationError();
  return {grant, user, actor: {userId: user.id, adminMode: grant.scopes.includes("scans:all-users")}};
}
export async function connectorAccess(db: Db, token: string, required: string[] = ["scans:read"], lock = false) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ConnectorAuthorizationError(required.join(" "));
  const hash = credentialDigest(token);
  let row = await db.scanConnectorToken.findUnique({where: {hash}, include: {grant: true}});
  if (lock && row) {
    await db.$queryRaw`SELECT id FROM "ScanConnectorGrant" WHERE id=${row.grantId} FOR UPDATE`;
    await db.$queryRaw`SELECT id FROM "User" WHERE id=${row.grant.userId} FOR SHARE`;
    row = await db.scanConnectorToken.findUnique({where: {hash}, include: {grant: true}});
  }
  if (!row || row.rotatedAt || row.expiresAt.getTime() <= Date.now()) throw new ConnectorAuthorizationError(required.join(" "));
  const access = await validGrant(db, row.grant);
  if (row.scopes.some(scope => !row!.grant.scopes.includes(scope)))
    throw new ConnectorAuthorizationError(required.join(" "));
  if (required.some(scope => !row!.scopes.includes(scope)))
    throw new ConnectorAuthorizationError(connectorScopes.filter(scope => row!.scopes.includes(scope) || required.includes(scope)).join(" "));
  return {...access, grant: {...access.grant, scopes: row.scopes}, actor: {...access.actor, adminMode: row.scopes.includes("scans:all-users")}};
}
export async function createConnectorAuthorization(db: PrismaClient, userId: string, params: URLSearchParams,
  permission: {confirm: boolean; allUsers: boolean; adminMode: boolean}) {
  const request = connectorAuthorization(params);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR SHARE`;
    const user = await tx.user.findUnique({where: {id: userId}, include: {player: true}});
    const admin = isAdminUser(user, user?.player);
    if (!user?.isActive || user.forcePasswordChange || (!user.player?.active && !admin)) throw new ConnectorAuthorizationError();
    if (permission.allUsers && (!admin || !permission.adminMode || !request.scopes.includes("scans:all-users")))
      throw new ConnectorAuthorizationError("scans:read scans:all-users");
    if (permission.confirm && !request.scopes.includes("scans:confirm")) throw new ConnectorAuthorizationError("scans:read scans:confirm");
    const scopes = ["scans:read", ...(permission.confirm ? ["scans:confirm"] : []), ...(permission.allUsers ? ["scans:all-users"] : [])];
    const grant = await tx.scanConnectorGrant.create({data: {userId, scopes, securityKey: connectorSecurityKey(user, admin),
      expiresAt: new Date(Date.now() + GRANT_SECONDS * 1000)}});
    const code = opaqueCredential();
    await tx.scanConnectorCode.create({data: {hash: credentialDigest(code), grantId: grant.id, challenge: request.code_challenge,
      redirectUri: request.redirect_uri, expiresAt: new Date(Date.now() + 5 * 60_000)}});
    const callback = new URL(request.redirect_uri); callback.searchParams.set("code", code);
    callback.searchParams.set("state", request.state); callback.searchParams.set("iss", new URL(connectorResource()).origin);
    return callback.toString();
  });
}
async function tokenPair(tx: Db, grant: ScanConnectorGrant, scopes = grant.scopes) {
  const access = opaqueCredential(), refresh = opaqueCredential();
  const expiresAt = new Date(Math.min(Date.now() + ACCESS_SECONDS * 1000, grant.expiresAt.getTime()));
  await tx.scanConnectorToken.create({data: {hash: credentialDigest(access), refreshHash: credentialDigest(refresh), grantId: grant.id, scopes, expiresAt}});
  return {access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)), scope: scopes.join(" ")};
}
export async function exchangeConnectorToken(db: PrismaClient, input: URLSearchParams) {
  connectorResource();
  if (input.get("client_id") !== CONNECTOR_CLIENT_ID || input.get("resource") !== connectorResource()) return null;
  if ([...input.keys()].some(key => input.getAll(key).length !== 1)) return null;
  return db.$transaction(async tx => {
    if (input.get("grant_type") === "authorization_code") {
      const code = input.get("code") ?? "", verifier = input.get("code_verifier") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
      let row = await tx.scanConnectorCode.findUnique({where: {hash: credentialDigest(code)}});
      if (!row) return null;
      await tx.$queryRaw`SELECT id FROM "ScanConnectorGrant" WHERE id=${row.grantId} FOR UPDATE`;
      row = await tx.scanConnectorCode.findUnique({where: {hash: row.hash}});
      if (!row || row.expiresAt.getTime() <= Date.now() || row.redirectUri !== input.get("redirect_uri") || row.challenge !== pkceChallenge(verifier)) return null;
      if (row.usedAt) { await tx.scanConnectorGrant.update({where: {id: row.grantId}, data: {revokedAt: new Date()}}); return null; }
      const {grant} = await validGrant(tx, await tx.scanConnectorGrant.findUnique({where: {id: row.grantId}}));
      await tx.scanConnectorCode.update({where: {hash: row.hash}, data: {usedAt: new Date()}});
      return tokenPair(tx, grant);
    }
    if (input.get("grant_type") === "refresh_token") {
      const refresh = input.get("refresh_token") ?? "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(refresh)) return null;
      let row = await tx.scanConnectorToken.findUnique({where: {refreshHash: credentialDigest(refresh)}});
      if (!row) return null;
      await tx.$queryRaw`SELECT id FROM "ScanConnectorGrant" WHERE id=${row.grantId} FOR UPDATE`;
      row = await tx.scanConnectorToken.findUnique({where: {hash: row.hash}});
      if (!row) return null;
      if (row.rotatedAt) { await tx.scanConnectorGrant.update({where: {id: row.grantId}, data: {revokedAt: new Date()}}); return null; }
      const {grant} = await validGrant(tx, await tx.scanConnectorGrant.findUnique({where: {id: row.grantId}}));
      const requested = input.get("scope");
      const scopes = requested ? [...new Set(requested.trim().split(/\s+/))] : row.scopes;
      if (!scopes.includes("scans:read") || scopes.some(scope => !row!.scopes.includes(scope) || !grant.scopes.includes(scope))) return null;
      await tx.scanConnectorToken.update({where: {hash: row.hash}, data: {rotatedAt: new Date()}});
      return tokenPair(tx, grant, scopes);
    }
    return null;
  });
}
export async function revokeConnectorToken(db: PrismaClient, raw: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return;
  const hash = credentialDigest(raw);
  const row = await db.scanConnectorToken.findFirst({where: {OR: [{hash}, {refreshHash: hash}]}, select: {grantId: true}});
  if (row) await db.scanConnectorGrant.update({where: {id: row.grantId}, data: {revokedAt: new Date()}});
}
