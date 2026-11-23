import {createHmac,timingSafeEqual} from "node:crypto";
import {z} from "zod";
import type {ScanConnectorGrant} from "@prisma/client";
import {connectorResource,credentialDigest} from "./scan-connector-policy";

const identity=z.string().min(1).max(200),hash=z.string().regex(/^[a-f0-9]{64}$/);
const source=z.object({kind:z.literal("scan"),sessionId:identity,photoId:z.string().uuid(),digest:hash,
  generation:z.number().int().positive(),revision:z.number().int().nonnegative()}).strict();
const reference=z.object({kind:z.literal("reference"),cardId:identity,imageUriHash:hash,imageDigest:hash}).strict();
const ticket=z.object({version:z.literal(1),grantId:identity,resource:z.string(),expiresAt:z.number().int(),
  evidence:z.discriminatedUnion("kind",[source,reference])}).strict();
type Evidence=z.infer<typeof source>|z.infer<typeof reference>;
export function connectorEvidenceTicket(grant:Pick<ScanConnectorGrant,"id"|"securityKey">,evidence:Evidence){
  const body=Buffer.from(JSON.stringify({version:1,grantId:grant.id,resource:connectorResource(),expiresAt:Date.now()+15*60_000,evidence})).toString("base64url");
  return body+"."+createHmac("sha256",grant.securityKey).update(body).digest("base64url");
}
export function readConnectorEvidence(grant:Pick<ScanConnectorGrant,"id"|"securityKey">,raw:string){
  if(raw.length>4096)throw new Error("Reopen the card images before confirming");
  const parts=raw.split(".");if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0])||!/^[A-Za-z0-9_-]{43}$/.test(parts[1]))throw new Error("Reopen the card images before confirming");
  const expected=createHmac("sha256",grant.securityKey).update(parts[0]).digest();
  if(!timingSafeEqual(expected,Buffer.from(parts[1],"base64url")))throw new Error("Reopen the card images before confirming");
  const parsed=ticket.parse(JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8")));
  if(parsed.grantId!==grant.id||parsed.resource!==connectorResource()||parsed.expiresAt<=Date.now())throw new Error("Reopen the card images before confirming");
  return parsed.evidence;
}
export function assertConnectorScan(grant:Pick<ScanConnectorGrant,"id"|"securityKey">,raw:string,expected:z.infer<typeof source>){
  const seen=readConnectorEvidence(grant,raw);
  if(seen.kind!=="scan"||JSON.stringify(seen)!==JSON.stringify(source.parse(expected)))throw new Error("The scan changed; reopen its images before confirming");
}
export function assertConnectorReference(grant:Pick<ScanConnectorGrant,"id"|"securityKey">,raw:string,card:{id:string;imageUri:string|null}){
  const seen=readConnectorEvidence(grant,raw);
  if(seen.kind!=="reference"||seen.cardId!==card.id||!card.imageUri||seen.imageUriHash!==credentialDigest(card.imageUri))throw new Error("Reopen the selected printing image before confirming");
}
