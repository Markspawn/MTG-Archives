import {test} from "node:test";
import assert from "node:assert/strict";
import {CONNECTOR_CLIENT_ID,connectorAuthorization,connectorOrigin,connectorResource,parseConnectorScopes,pkceChallenge,validConnectorRedirect} from "../lib/scan-connector-policy";
import {assertConnectorReference,assertConnectorScan,connectorEvidenceTicket,readConnectorEvidence} from "../lib/scan-connector-evidence";
import {credentialDigest} from "../lib/scan-connector-policy";
import {classifyCorrection} from "../lib/acquisition-correction-policy";
import {correctionHistoryEntry} from "../lib/acquisition-correction-history-dto";

process.env.SCAN_CONNECTOR_ENABLED="1";process.env.APP_BASE_URL="https://cards.example.test";
const grant={id:"grant-a",securityKey:"server-private-key"};
const scan={kind:"scan" as const,sessionId:"batch-a",photoId:"10000000-0000-4000-8000-000000000001",digest:"a".repeat(64),generation:2,revision:7};
test("connector redirects stay on the actual ChatGPT callbacks",()=>{
  assert(validConnectorRedirect("https://chatgpt.com/connector_platform_oauth_redirect"));assert(validConnectorRedirect("https://chatgpt.com/connector/oauth/callback_123"));
  for(const url of ["https://chatgpt.com.evil.test/connector/oauth/x","https://chatgpt.com@evil.test/connector/oauth/x","http://chatgpt.com/connector/oauth/x","https://chatgpt.com/connector/oauth/x?next=https://evil.test","https://chatgpt.com/connector/oauth/x#leak","https://chatgpt.com/elsewhere"])assert.equal(validConnectorRedirect(url),false);
});
test("authorization uses an explicit canonical origin, PKCE and scopes",()=>{
  const params=new URLSearchParams({response_type:"code",client_id:CONNECTOR_CLIENT_ID,redirect_uri:"https://chatgpt.com/connector_platform_oauth_redirect",code_challenge:pkceChallenge("x".repeat(43)),code_challenge_method:"S256",resource:connectorResource(),scope:"scans:read scans:confirm",state:"opaque-state"});
  assert.deepEqual(connectorAuthorization(params).scopes,["scans:read","scans:confirm"]);
  for(const[key,value]of[["client_id","attacker"],["resource","https://other.test/mcp"],["code_challenge_method","plain"],["scope","scans:all-users"],["scope","scans:read inventory:write"]]){const bad=new URLSearchParams(params);bad.set(key,value);assert.throws(()=>connectorAuthorization(bad));}
  params.append("state","another");assert.throws(()=>connectorAuthorization(params));
  assert.throws(()=>parseConnectorScopes("scans:confirm"));assert.deepEqual(parseConnectorScopes("scans:read scans:read"),["scans:read"]);
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});
test("connector is optional and rejects unsafe configured origins",()=>{
  process.env.SCAN_CONNECTOR_ENABLED="0";assert.throws(()=>connectorOrigin());process.env.SCAN_CONNECTOR_ENABLED="1";
  const before=process.env.NODE_ENV;Object.assign(process.env,{NODE_ENV:"production"});
  for(const value of ["http://127.0.0.1:3000","https://cards.test/path","https://user:pass@cards.test","https://cards.test/?token=x"]){process.env.APP_BASE_URL=value;assert.throws(()=>connectorOrigin());}
  process.env.APP_BASE_URL="https://cards.example.test";assert.equal(connectorOrigin(),"https://cards.example.test");
  if(before===undefined)Reflect.deleteProperty(process.env,"NODE_ENV");else Object.assign(process.env,{NODE_ENV:before});
});
test("image tickets bind the connection, exact original, generation, revision and printing",()=>{
  const raw=connectorEvidenceTicket(grant,scan);assert.deepEqual(readConnectorEvidence(grant,raw),scan);assertConnectorScan(grant,raw,scan);
  for(const changed of [{...scan,sessionId:"other"},{...scan,digest:"b".repeat(64)},{...scan,generation:3},{...scan,revision:8}])assert.throws(()=>assertConnectorScan(grant,raw,changed));
  assert.throws(()=>readConnectorEvidence({...grant,id:"grant-b"},raw));assert.throws(()=>readConnectorEvidence({...grant,securityKey:"another"},raw));
  assert.throws(()=>readConnectorEvidence(grant,raw+"x"));
  const imageUri="https://cards.scryfall.io/normal/front/a/b/test.jpg";
  const reference=connectorEvidenceTicket(grant,{kind:"reference",cardId:"paper-a",imageUriHash:credentialDigest(imageUri),imageDigest:"c".repeat(64)});
  assertConnectorReference(grant,reference,{id:"paper-a",imageUri});assert.throws(()=>assertConnectorReference(grant,reference,{id:"paper-b",imageUri}));
  assert.throws(()=>assertConnectorReference(grant,reference,{id:"paper-a",imageUri:imageUri+"?changed"}));assert.throws(()=>assertConnectorReference(grant,raw,{id:"paper-a",imageUri}));
});
test("expired tickets and changed installation origins refuse confirmation",()=>{
  const raw=connectorEvidenceTicket(grant,scan),now=Date.now;try{Date.now=()=>now()+16*60_000;assert.throws(()=>readConnectorEvidence(grant,raw));}finally{Date.now=now;}
  process.env.APP_BASE_URL="https://another.example.test";assert.throws(()=>readConnectorEvidence(grant,raw));process.env.APP_BASE_URL="https://cards.example.test";
});
test("assistant reviews retain distinct unverified provenance",()=>{
  assert.equal(classifyCorrection({afterId:"paper-a",beforeId:null,offeredIds:["paper-a"],displayKnown:true,origin:"ASSISTANT"}),"ASSISTANT_SELECTION");
  const entry=correctionHistoryEntry({id:"event",candidateRevision:1,createdAt:new Date(0),origin:"ASSISTANT",classification:"ASSISTANT_SELECTION",payload:{version:1,independentVerification:"UNVERIFIED"}});
  assert.equal(entry.origin,"ChatGPT review");assert.equal(entry.kind,"AI review");assert.equal(entry.verification,"UNVERIFIED");
});
