import {test,expect} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {randomUUID,createHash} from "node:crypto";
import {writeFileSync} from "node:fs";

function database<T>(body:string):T{
  const app=process.env.MTG_CONNECTOR_CONTAINER??"";
  if(process.env.MTG_CONNECTOR_TEST!=="1"||!/^[a-f0-9]{64}$/.test(app))throw Error("Explicit task-owned connector review required");
  const state=JSON.parse(execFileSync("docker",["inspect",app],{encoding:"utf8",windowsHide:true}))[0];
  if(state.Config.Labels["mtg.archive.owner"]!=="chatgpt-batch-review-20261122")throw Error("Wrong review owner");
  return JSON.parse(execFileSync("docker",["exec","-i",app,"node","-r","tsx/cjs"],{encoding:"utf8",windowsHide:true,timeout:30000,
    input:`const{PrismaClient}=require('@prisma/client'),fs=require('fs'),crypto=require('crypto');const p=new PrismaClient();(async()=>{const u=new URL(process.env.DATABASE_URL);if(u.hostname!=='mtg-connector-db'||u.pathname!=='/review_connector')throw Error('Wrong review database');${body}})().then(value=>console.log(JSON.stringify(value))).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());`}));
}
test("per-user OAuth, admin opt-in, private MCP images and revocation work through the real app",async({page,context,baseURL},testInfo)=>{
  test.skip(process.env.MTG_CONNECTOR_TEST!=="1","Requires this task's isolated local HTTPS review");
  expect(baseURL).toBe("https://localhost:13385");test.setTimeout(180000);
  const tag="connector-ui-"+randomUUID(),password=randomUUID();
  const fixture=database<any>(`const seed=require('./scripts/verify-scan-connector.ts').seedScanConnectorFixture;const f=await seed(p,${JSON.stringify(tag)});for(const id of f.ids)await p.user.update({where:{id},data:{passwordHash:await require('bcryptjs').hash(${JSON.stringify(password)},10)}});const bytes=await require('sharp')(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" fill="white"/><rect x="12" y="12" width="276" height="396" fill="#52734d"/><text x="22" y="45" font-size="18" fill="white">Controlled test scan</text><rect x="25" y="65" width="250" height="170" fill="#d8bc86"/><text x="25" y="380" font-size="18">TST 001 EN</text></svg>')).png().toBuffer();const dir=process.env.UPLOADS_DATA_PATH+'/acquisition-v1/';fs.mkdirSync(dir,{recursive:true});const digest=crypto.createHash('sha256').update(bytes).digest('hex');for(const photo of await p.acquisitionPhoto.findMany({where:{runId:{in:f.captures.map(c=>c.runId)}}})){fs.writeFileSync(dir+photo.id+'.original',bytes);await p.acquisitionPhoto.update({where:{id:photo.id},data:{digest,bytes:bytes.length,mediaType:'image/png',width:300,height:420}});await p.acquisitionArtifact.updateMany({where:{runId:photo.runId,sourceId:photo.id},data:{digest}});for(const job of await p.acquisitionProcessingJob.findMany({where:{runId:photo.runId,artifact:{sourceId:photo.id}}}))await p.acquisitionProcessingJob.update({where:{id:job.id},data:{input:{photoId:photo.id,digest}}});}await p.card.update({where:{id:f.cardId},data:{imageUri:'https://cards.scryfall.io/normal/front/a/b/connector-fixture.jpg'}});fs.writeFileSync('/tmp/connector-ui-fixture.json',JSON.stringify({user:f.ids[0],admin:f.ids[2],batch:f.captures[0].sessionId}));return f;`);
  const snapshot=()=>database<any>(`const result={};for(const table of ['InventoryItem','Card','AcquisitionPhoto','AcquisitionCaptureSlot','AcquisitionObservation','AcquisitionArtifact'])result[table]=await p.$queryRawUnsafe('SELECT count(*)::text AS count,md5(COALESCE(string_agg(row_to_json(t)::text,chr(31) ORDER BY row_to_json(t)::text),repeat(chr(32),0))) AS hash FROM "'+table+'" t');const originals=[];for(const photo of await p.acquisitionPhoto.findMany({where:{ready:true,purgedAt:null},orderBy:{id:'asc'}})){const bytes=fs.readFileSync(process.env.UPLOADS_DATA_PATH+'/acquisition-v1/'+photo.id+'.original'),digest=crypto.createHash('sha256').update(bytes).digest('hex');if(digest!==photo.digest||bytes.length!==photo.bytes)throw Error('Original changed');originals.push({id:photo.id,digest,bytes:bytes.length});}return{tables:result,originals};`);
  const before=snapshot();
  const rpc=async(name:string,args:Record<string,unknown>,token?:string)=>{
    const response=await context.request.post(baseURL+'/api/scan-connector/mcp',{headers:{Accept:'application/json, text/event-stream',Origin:baseURL!,...(token?{Authorization:'Bearer '+token}:{})},data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}});
    expect(response.status()).toBe(200);const body=await response.json();expect(body.error).toBeUndefined();return body.result;
  };
  const payload=(result:any)=>JSON.parse(result.content.find((x:any)=>x.type==='text').text);
  const anonymous=await rpc('list_open_batches',{});expect(anonymous.isError).toBe(true);expect(anonymous._meta['mcp/www_authenticate'][0]).toContain('oauth-protected-resource');
  const metadata=await context.request.get(baseURL+'/.well-known/oauth-authorization-server');expect((await metadata.json()).code_challenge_methods_supported).toEqual(['S256']);
  let callback:URL|undefined;
  // Capture the real authorization response before following its external
  // redirect. Browser routing does not reliably intercept a redirected URL.
  await context.route('**/api/scan-connector/authorize',async route=>{
    const response=await route.fetch({maxRedirects:0});expect(response.status()).toBe(303);
    callback=new URL(response.headers().location);expect(callback.origin).toBe('https://chatgpt.com');
    expect(callback.pathname).toBe('/connector_platform_oauth_redirect');
    await route.fulfill({status:200,contentType:'text/html',body:'Controlled OAuth callback received'});
  });
  const authorize=async(allUsers=false,scope='scans:read scans:confirm scans:all-users')=>{
    callback=undefined;const verifier=randomUUID()+randomUUID(),state=randomUUID();
    const params=new URLSearchParams({response_type:'code',client_id:'mtg-archives-chatgpt',redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:baseURL+'/api/scan-connector/mcp',scope,state});
    await page.goto('/settings/connections/authorize?'+params);
    return {verifier,state,params,allUsers};
  };
  const exchange=async(request:Awaited<ReturnType<typeof authorize>>)=>{
    await expect(page.getByRole('heading',{name:'Connect ChatGPT to MTG Archives'})).toBeVisible();
    if(request.allUsers)await page.getByRole('checkbox',{name:/Administrator: allow/}).check();
    await page.getByRole('button',{name:'Connect account',exact:true}).click();await expect.poll(()=>callback?.searchParams.get('state')).toBe(request.state);
    expect(callback!.searchParams.get('iss')).toBe(baseURL);
    const response=await context.request.post(baseURL+'/api/scan-connector/token',{form:{grant_type:'authorization_code',client_id:'mtg-archives-chatgpt',resource:baseURL+'/api/scan-connector/mcp',redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect',code:callback!.searchParams.get('code')!,code_verifier:request.verifier}});
    expect(response.status()).toBe(200);const token=await response.json();expect(typeof token.access_token).toBe('string');return token;
  };
  const ownRequest=await authorize();await expect(page.getByRole('heading',{name:'Log in to MTG Inventory'})).toBeVisible();
  await page.getByLabel(/username or email/i).fill(fixture.ids[0]);await page.getByLabel(/^password$/i).fill(password);await page.getByRole('button',{name:'Log in',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:/Administrator: allow/})).toBeDisabled();
  await expect(page.getByRole('checkbox',{name:/Allow ChatGPT to confirm/})).toBeChecked();
  const consentResponse=await context.request.get(baseURL+'/settings/connections/authorize?'+ownRequest.params);expect(consentResponse.headers()['x-frame-options']).toBe('DENY');
  for(const width of [1366,390]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('consent-'+width+'.png'),fullPage:true});}
  await page.setViewportSize({width:1366,height:900});const own=await exchange(ownRequest);expect(own.scope).toBe('scans:read scans:confirm');
  const listing=payload(await rpc('list_open_batches',{},own.access_token));expect(listing.batches.map((x:any)=>x.sessionId)).toEqual([fixture.captures[0].sessionId]);
  expect((await rpc('list_open_batches',{allUsers:true},own.access_token)).isError).toBe(true);
  const foreign=await rpc('list_batch_cards',{sessionId:fixture.captures[1].sessionId},own.access_token);expect(foreign.isError).toBe(true);
  const cards=payload(await rpc('list_batch_cards',{sessionId:fixture.captures[0].sessionId},own.access_token));expect(cards.cards[0].position).toBe(0);
  const review=await rpc('get_card_review',{sessionId:fixture.captures[0].sessionId,photoId:fixture.entries[0].photoId},own.access_token);expect(review.isError).not.toBe(true);expect(review.content.some((x:any)=>x.type==='image'&&x.mimeType==='image/jpeg'&&x.data.length>500)).toBe(true);
  const viewed=payload(review);
  // Exercise the actual reference tool/SDK using a controlled public-image
  // response, without depending on an external catalog/network in this fixture.
  const reference=database<any>(`const{createScanConnectorServer}=require('./lib/scan-connector-tools.ts'),{Client}=require('@modelcontextprotocol/sdk/client/index.js'),{InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');const original=global.fetch,bytes=fs.readFileSync(process.env.UPLOADS_DATA_PATH+'/acquisition-v1/'+${JSON.stringify(fixture.entries[0].photoId)}+'.original');global.fetch=async()=>new Response(bytes,{headers:{'Content-Type':'image/png'}});const server=createScanConnectorServer(p,${JSON.stringify(own.access_token)}),client=new Client({name:'controlled-reference-review',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();try{await server.connect(a);await client.connect(b);const result=await client.callTool({name:'get_printing_reference',arguments:{cardId:${JSON.stringify(fixture.cardId)}}});if(result.isError)throw Error('Reference tool failed');return{imageDelivered:result.content.some(x=>x.type==='image'&&x.data.length>500),data:JSON.parse(result.content.find(x=>x.type==='text').text)};}finally{global.fetch=original;await client.close();await server.close();}`);
  expect(reference.imageDelivered).toBe(true);
  const save={sessionId:fixture.captures[0].sessionId,photoId:fixture.entries[0].photoId,scanTicket:viewed.scanTicket,referenceTicket:reference.data.referenceTicket,decision:{cardId:fixture.cardId,language:'en',finish:viewed.defaults.finish,condition:viewed.defaults.condition},reason:'Controlled comparison: printed fixture identity, language and reference agree.'};
  expect(payload(await rpc('confirm_card',save,own.access_token))).toEqual({replay:false});expect(payload(await rpc('confirm_card',save,own.access_token))).toEqual({replay:true});
  const saved=database<any>(`const candidate=await p.acquisitionCandidate.findUniqueOrThrow({where:{id:${JSON.stringify(fixture.entries[0].candidateId)}}});const history=await p.correctionReviewEvent.findFirstOrThrow({where:{sourceCandidateId:candidate.id}});return{source:candidate.review.source,actor:candidate.review.actorId,origin:history.origin,stock:(await p.inventoryItem.aggregate({_sum:{quantity:true}}))._sum.quantity};`);
  expect(saved).toEqual({source:'CHATGPT_CONNECTOR',actor:fixture.ids[0],origin:'ASSISTANT',stock:23});
  await page.goto('/settings/connections');await expect(page.getByLabel('Server URL')).toHaveValue(baseURL+'/api/scan-connector/mcp');await expect(page.getByRole('article')).toContainText('Your open batches');
  await page.screenshot({path:testInfo.outputPath('connections-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Revoke access',exact:true}).click();await expect(page.getByRole('article')).toContainText('Revoked');expect((await rpc('list_open_batches',{},own.access_token)).isError).toBe(true);
  await context.clearCookies();await page.goto('/login');await page.getByLabel(/username or email/i).fill(fixture.ids[2]);await page.getByLabel(/^password$/i).fill(password);await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForURL(/\/dashboard/);
  await page.getByLabel(fixture.ids[2]+' account options',{exact:true}).click();await page.getByRole('button',{name:'Enter Admin Mode',exact:true}).click();await expect(page.getByText('Admin mode is active.',{exact:false})).toBeVisible();
  const adminOwn=await exchange(await authorize());expect(adminOwn.scope).toBe('scans:read scans:confirm');
  const upgrade=await rpc('list_open_batches',{allUsers:true},adminOwn.access_token);expect(upgrade.isError).toBe(true);
  const requestedScopes=/\bscope="([^"]+)"/.exec(upgrade._meta['mcp/www_authenticate'][0])?.[1];expect(requestedScopes).toBe('scans:read scans:confirm scans:all-users');
  const adminRequest=await authorize(true,requestedScopes);await expect(page.getByRole('checkbox',{name:/Administrator: allow/})).toBeEnabled();const admin=await exchange(adminRequest);expect(admin.scope).toBe('scans:read scans:confirm scans:all-users');
  expect(payload(await rpc('list_open_batches',{allUsers:true},admin.access_token)).batches).toHaveLength(2);
  const adminCards=payload(await rpc('list_batch_cards',{sessionId:fixture.captures[1].sessionId},admin.access_token));expect(adminCards.cards[0].photoId).toBe(fixture.otherEntry.photoId);
  await page.goto('/settings/connections');await expect(page.getByRole('article').filter({hasText:'All users’ open batches'})).toHaveCount(1);
  await page.setViewportSize({width:390,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('connections-admin-phone.png'),fullPage:true});
  const after=snapshot();expect(after).toEqual(before);writeFileSync(testInfo.outputPath('conservation.json'),JSON.stringify({conserved:true,before,after,oauthOwnAndAdmin:true,actualPrivateImage:true,controlledReferenceImage:true,actualConfirmationAndReplay:true,revocation:true},null,2));
});
