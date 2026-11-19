import {test,expect} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {acquisitionDraftKey} from "../../lib/acquisition-browser-review-draft";

test.skip(process.env.MTG_SCAN_ACTIONS_TEST!=="1","Owned disposable scan actions fixture required");
test.use({video:"off",actionTimeout:15000});
function database(body:string) {
  const id=process.env.MTG_INVENTORY_TEST_CONTAINER??"";
  if(!/^[a-f0-9]{64}$/.test(id))throw Error("Immutable owned review container required");
  return JSON.parse(execFileSync("docker",["exec","-i",id,"node"],{windowsHide:true,encoding:"utf8",timeout:30000,
    input:`const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{if(new URL(process.env.DATABASE_URL).pathname!=='/review_pending_performance')throw Error('Wrong fixture');${body}})().then(value=>console.log(JSON.stringify(value))).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());`}));
}
function resetBatch(runId:string) {
  return database(`const runId=${JSON.stringify(runId)};
    const lots=[...new Set((await p.acquisitionCommitMember.findMany({where:{runId},select:{inventoryItemId:true}})).map(row=>row.inventoryItemId))];
    await p.acquisitionCommitMember.deleteMany({where:{runId}});await p.acquisitionCommit.deleteMany({where:{runId}});
    await p.inventoryAuditLog.deleteMany({where:{inventoryItemId:{in:lots}}});await p.inventoryItem.deleteMany({where:{id:{in:lots}}});return true;`);
}
test.beforeAll(()=>{
  const other=database("return JSON.parse(require('fs').readFileSync('/tmp/scan-actions-large-fixture.json','utf8'));");
  resetBatch(other.runId);
});
test.afterEach(async({page})=>{if(!page.isClosed()){await page.unrouteAll({behavior:"wait"});await page.close();}});
for(const width of [1366,390,320])test(`bulk exclusions and one-confirmation Inventory addition at ${width}px`,async({page,baseURL})=>{
  test.setTimeout(180000);expect(["http://127.0.0.1:13285","http://127.0.0.1:13295"]).toContain(baseURL);
  const f=database("return JSON.parse(require('fs').readFileSync('/tmp/scans-experience-fixture.json','utf8'));");
  const other=database("return JSON.parse(require('fs').readFileSync('/tmp/scan-actions-large-fixture.json','utf8'));");
  resetBatch(f.runId);
  database(`const runId=${JSON.stringify(f.runId)},user=${JSON.stringify(f.user)};
    await p.acquisitionCandidate.updateMany({where:{runId},data:{review:require('@prisma/client').Prisma.DbNull,revision:{increment:1}}});
    const last=await p.acquisitionCandidate.findFirstOrThrow({where:{runId,acquisitionOrder:13}});
    await p.acquisitionCandidate.update({where:{id:last.id},data:{review:{cardId:${JSON.stringify(f.printing.id)},finish:'UNKNOWN',condition:'NM',language:'en',actorId:user}}});
    return true;`);
  const original=database(`return p.acquisitionPhoto.findMany({where:{runId:${JSON.stringify(f.runId)}},orderBy:{id:'asc'},select:{id:true,digest:true,bytes:true}});`);
  await page.context().addCookies([{name:"mtg_inventory_session",value:f.token,url:baseURL!,httpOnly:true,sameSite:"Lax"}]);
  const draft=acquisitionDraftKey({userId:f.user,batchId:f.batch,photoId:f.photos[12]});
  await page.addInitScript(key=>localStorage.setItem(key,"controlled unsaved correction"),draft);
  const endpoint=`/api/acquisition/${f.batch}/review`,commits:string[]=[];
  let interrupted=false;
  await page.route(`**/api/acquisition/${f.batch}/commit`,async route=>{
    const body=route.request().postDataJSON();
    if(body.action==="commit") {
      commits.push(route.request().postData()!);
      if(width===1366&&!interrupted) {interrupted=true;await route.fetch();await route.abort("failed");return;}
    }
    await route.continue();
  });
  await page.route(`**${endpoint}?photoId=*`,async route=>{
    const photoId=new URL(route.request().url()).searchParams.get("photoId"),i=f.photos.indexOf(photoId);
    if(i===4){await route.fulfill({status:500,json:{error:"Controlled failed proposal read"}});return;}
    const response=await route.fetch(),record=await response.json();
    const printing={...f.printing,...(i===3?{lang:null}:{})};
    await route.fulfill({response,json:{...record,recognitionStatus:"NO_MATCH",visualStatus:"COMPLETE",printingStatus:"COMPLETE",catalog:null,
      suggestions:i===2?[]:[{printing,reasons:["Controlled bulk fixture"]}],
      evidence:{geometry:{status:"MISSING"},rotation:null,observations:[],...record.evidence,
        identifiers:{setCodes:[],collectors:[],...record.evidence?.identifiers,languages:i===1?["fr"]:i===5?["EN"]:[]}}}});
  });
  await page.setViewportSize({width,height:900});await page.goto(`/imports/scan?batch=${f.batch}`);
  await expect(page.getByTestId("scan-batch-destination")).toContainText("Review box → Section A");
  const bulk=page.getByRole("region",{name:"Bulk match review",exact:true});
  await bulk.getByRole("button",{name:"Bulk Confirm Match",exact:true}).click();
  await expect(bulk.getByRole("button",{name:"Confirm 8 selected matches",exact:true})).toBeEnabled();
  await expect(bulk).toContainText("Proposal could not be loaded");await expect(bulk).toContainText("conflicting with batch EN");
  await expect(bulk).toContainText("No printing proposed");await expect(bulk).toContainText("no language");
  await expect(bulk).toContainText("saved review is incomplete");
  await bulk.getByRole("button",{name:"Confirm 8 selected matches",exact:true}).click();
  await expect(bulk).toContainText("8 reviews saved");await expect(bulk).toContainText("individual attention");
  expect(database(`return p.inventoryItem.count({where:{currentOwnerId:${JSON.stringify(f.user)}}});`)).toBe(0);
  // Only this action and the final confirmation are needed; selection and
  // preview preparation happen automatically through the actual server route.
  await page.getByRole("link",{name:"Add all confirmed cards to Inventory",exact:true}).click();
  const confirmation=page.getByRole("region",{name:"Confirm Inventory addition",exact:true});
  await expect(confirmation).toContainText("8 copies");await expect(confirmation).toContainText("Review box");await expect(confirmation).toContainText("Section A");
  await expect(page.getByRole("button",{name:"Select reviewed cards",exact:true})).toBeHidden();
  await expect(page.getByRole("button",{name:"Preview selected cards",exact:true})).toBeHidden();
  await expect.poll(()=>confirmation.getByRole("button",{name:"Add 8 copies to Inventory",exact:true}).evaluate(element=>element.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
  await page.screenshot({path:`test-results/scan-actions-confirm-${width}.png`});
  await confirmation.getByRole("button",{name:"Add 8 copies to Inventory",exact:true}).click();
  if(width===1366) {
    await expect(confirmation.getByRole("button",{name:"Retry Inventory addition",exact:true})).toBeEnabled();
    await confirmation.getByRole("button",{name:"Retry Inventory addition",exact:true}).click();
    expect(commits).toHaveLength(2);expect(commits[0]).toBe(commits[1]);
  } else expect(commits).toHaveLength(1);
  await expect(page.getByText(/Added 8 copies to Inventory/)).toBeVisible();
  const saved=database(`return p.inventoryItem.findMany({where:{currentOwnerId:${JSON.stringify(f.user)}}});`);
  expect(saved.reduce((sum:number,row:{quantity:number})=>sum+row.quantity,0)).toBe(8);
  expect(saved.every((row:{locationId:string;locationSection:string;originalOpenerId:string;foilStatus:string})=>row.locationId===f.user&&row.locationSection==="Section A"&&row.originalOpenerId===f.user&&row.foilStatus==="NONFOIL")).toBe(true);
  expect(database(`return p.acquisitionCommitMember.count({where:{runId:${JSON.stringify(f.runId)}}});`)).toBe(8);
  expect(database(`return p.acquisitionCommitMember.count({where:{runId:${JSON.stringify(other.runId)}}});`)).toBe(0);
  expect(database(`return p.acquisitionPhoto.findMany({where:{runId:${JSON.stringify(f.runId)}},orderBy:{id:'asc'},select:{id:true,digest:true,bytes:true}});`)).toEqual(original);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await bulk.getByRole("button",{name:"Inspect card 3",exact:true}).click();
  await expect(page.getByTestId("capture-card-3")).toBeVisible();
});

test("all confirmed covers six pages and 501 copies with one approval and replay safety",async({page,baseURL})=>{
  test.setTimeout(180000);expect(["http://127.0.0.1:13285","http://127.0.0.1:13295"]).toContain(baseURL);
  const f=database("return JSON.parse(require('fs').readFileSync('/tmp/scan-actions-large-fixture.json','utf8'));");
  await page.context().addCookies([{name:"mtg_inventory_session",value:f.token,url:baseURL!,httpOnly:true,sameSite:"Lax"}]);
  await page.goto(`/imports/scan?batch=${f.batch}`);
  await expect(page.getByRole("navigation",{name:"Saved-card pages",exact:true})).toContainText("Page 1 of 6");
  await page.getByRole("link",{name:"Add all confirmed cards to Inventory",exact:true}).click();
  const confirmation=page.getByRole("region",{name:"Confirm Inventory addition",exact:true});
  await expect(confirmation).toContainText("501 copies");await expect(confirmation).toContainText("Section A");
  const requests:unknown[]=[];page.on("request",request=>{if(request.url().endsWith(`/api/acquisition/${f.batch}/commit`)&&request.method()==="POST"&&request.postDataJSON().action==="commit")requests.push(request.postDataJSON());});
  await confirmation.getByRole("button",{name:"Add 501 copies to Inventory",exact:true}).click();
  await expect(page.getByText(/Added 501 copies to Inventory/)).toBeVisible();expect(requests).toHaveLength(1);
  const replay=await page.request.post(`/api/acquisition/${f.batch}/commit`,{headers:{origin:baseURL!},data:requests[0]});
  expect(replay.ok()).toBe(true);expect((await replay.json()).replay).toBe(true);
  expect(database(`return p.acquisitionCommitMember.count({where:{runId:${JSON.stringify(f.runId)}}});`)).toBe(501);
});
