import {test,expect, type Page} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {resetDesktopReviewInventory} from "./scan-review-fixture";

test.skip(process.env.MTG_SCAN_DESKTOP_TEST !== "1", "Owned disposable desktop scan-review fixture required");
test.use({video:"off",actionTimeout:15000});
test.beforeAll(()=>resetDesktopReviewInventory(process.env.MTG_SCAN_REVIEW_OWNER));
test.afterEach(async({page})=>{await page.unrouteAll({behavior:"wait"});await page.close();});
function database(body:string) {
  const id=process.env.MTG_INVENTORY_TEST_CONTAINER??"";
  if(!/^[a-f0-9]{64}$/.test(id))throw Error("Immutable owned review app required");
  const owner=execFileSync("docker",["inspect","--format","{{index .Config.Labels \"mtg.archive.owner\"}}",id],{encoding:"utf8",windowsHide:true}).trim();
  if(owner!==(process.env.MTG_SCAN_REVIEW_OWNER ?? "scan-review-density-20261119"))throw Error("Not the disposable desktop review");
  return JSON.parse(execFileSync("docker",["exec","-i",id,"node"],{encoding:"utf8",windowsHide:true,timeout:30000,
    input:`const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{if(new URL(process.env.DATABASE_URL).pathname!=='/review_pending_performance')throw Error('Wrong fixture');${body}})().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());`}));
}
async function stableViewport(page:Page,action:()=>Promise<unknown>) {
  await page.evaluate(()=>{
    const state=window as typeof window & {scanPositions?:number[];scanSampling?:boolean};
    state.scanPositions=[scrollY];state.scanSampling=true;
    const sample=()=>{state.scanPositions!.push(scrollY);if(state.scanSampling)requestAnimationFrame(sample);};requestAnimationFrame(sample);
  });
  await action();await page.waitForTimeout(800);
  const positions=await page.evaluate(()=>{const state=window as typeof window & {scanPositions?:number[];scanSampling?:boolean};state.scanSampling=false;return state.scanPositions!;});
  expect(Math.max(...positions)-Math.min(...positions),`Viewport movement: ${positions.join(",")}`).toBeLessThanOrEqual(2);
}
for(const viewport of [{width:1366,height:768},{width:1280,height:720},{width:1920,height:1080},{width:1024,height:768}]) {
 test(`desktop comparison, controls and stable confirmation at ${viewport.width}x${viewport.height}`,async({page,baseURL},testInfo)=>{
  test.setTimeout(180000);expect(["http://127.0.0.1:13295","http://127.0.0.1:13305"]).toContain(baseURL);
  const f=database("return JSON.parse(require('fs').readFileSync('/tmp/scans-experience-fixture.json','utf8'));");
  database(`return p.acquisitionCandidate.updateMany({where:{runId:${JSON.stringify(f.runId)}},data:{review:require('@prisma/client').Prisma.DbNull,revision:{increment:1}}});`);
  const originals=database(`return p.acquisitionPhoto.findMany({where:{runId:${JSON.stringify(f.runId)}},orderBy:{id:'asc'},select:{id:true,digest:true,bytes:true,purgedAt:true}});`);
  const inventory=database(`return p.inventoryItem.findMany({where:{currentOwnerId:${JSON.stringify(f.user)}},orderBy:{id:'asc'}});`);
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.setViewportSize(viewport);
  await page.context().addCookies([{name:"mtg_inventory_session",value:f.token,url:baseURL!,httpOnly:true,sameSite:"Lax"}]);
  await page.route(`**/api/acquisition/${f.batch}/review?photoId=*`,async route=>{
    await new Promise(resolve=>setTimeout(resolve,250));
    const response=await route.fetch(),record=await response.json();
    await route.fulfill({response,json:{...record,recognitionStatus:"NO_MATCH",visualStatus:"COMPLETE",printingStatus:"COMPLETE",catalog:null,
      suggestions:[{printing:f.printing,reasons:["UNLOCALIZED_NAME_HINT"]}],
      evidence:{geometry:{status:"MISSING"},rotation:null,observations:[],...record.evidence,identifiers:{...record.evidence?.identifiers,languages:["fr"]}}}});
  });
  await page.goto(`/imports/scan?batch=${f.batch}`);
  await page.getByRole("link",{name:"Review saved cards",exact:true}).click();
  const first=page.getByTestId("capture-card-1");
  await expect(first.getByRole("button",{name:"Confirm and next",exact:true})).toBeEnabled();
  await expect.poll(()=>first.locator("canvas").evaluate((e:HTMLCanvasElement)=>e.width)).toBeGreaterThan(0);
  await expect(first.getByRole("img",{name:/Printing:/})).toBeVisible();
  await expect.poll(()=>first.locator("img").first().evaluate((e:HTMLImageElement)=>e.naturalWidth)).toBeGreaterThan(0);
  const frames=await first.locator('[data-testid$="comparison-frame"]').evaluateAll(elements=>elements.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom}}));
  expect(frames).toHaveLength(2);expect(Math.abs(frames[0].w-frames[1].w)).toBeLessThan(1);expect(Math.abs(frames[0].h-frames[1].h)).toBeLessThan(1);expect(Math.abs(frames[0].y-frames[1].y)).toBeLessThan(1);
  for(const r of frames){expect(r.y).toBeGreaterThan(0);expect(r.bottom).toBeLessThanOrEqual(viewport.height);expect(r.h).toBeLessThanOrEqual(361);expect(r.h).toBeGreaterThanOrEqual(219);}
  const media=await first.locator("canvas, img").evaluateAll(elements=>elements.slice(0,2).map(e=>{const r=e.getBoundingClientRect();return {w:r.width,h:r.height}}));
  expect(Math.abs(media[0].w-media[1].w)).toBeLessThan(1);expect(Math.abs(media[0].h-media[1].h)).toBeLessThan(1);
  for(const name of ["Confirm and next","Confirm match","Correct"]){
    const button=first.getByRole("button",{name,exact:true});
    expect(await button.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
  }
  await expect(page.getByTestId("scan-batch-destination")).toContainText("Section A");
  expect(await page.getByTestId("scan-batch-destination").evaluate(e=>e.getBoundingClientRect().top>=0)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("focused-desktop.png")});
  const correctionBefore=await first.getByRole("button",{name:"Correct",exact:true}).boundingBox();
  await stableViewport(page,async()=>{
    await first.getByRole("button",{name:"Confirm match",exact:true}).click();
    await expect(first.getByTestId("scan-compact-status")).toHaveText("Review saved");
  });
  const correctionAfter=await first.getByRole("button",{name:"Correct",exact:true}).boundingBox();
  expect(Math.abs(correctionBefore!.x-correctionAfter!.x)).toBeLessThan(1);expect(Math.abs(correctionBefore!.y-correctionAfter!.y)).toBeLessThan(1);
  await stableViewport(page,async()=>{
    await page.getByRole("button",{name:"Next card",exact:true}).click();
    await expect(page.getByTestId("capture-card-2").getByRole("button",{name:"Confirm and next",exact:true})).toBeEnabled();
  });
  await stableViewport(page,async()=>{
    await page.getByTestId("capture-card-2").getByRole("button",{name:"Confirm and next",exact:true}).click();
    await expect(page.getByTestId("capture-card-3").getByRole("button",{name:"Confirm and next",exact:true})).toBeEnabled();
  });
  await page.getByRole("button",{name:"Two-column list",exact:true}).click();
  await page.getByRole("link",{name:"Review saved cards",exact:true}).click();
  const second=page.getByTestId("capture-card-2");
  const columns=await Promise.all([first,second].map(card=>card.boundingBox()));
  expect(Math.abs(columns[0]!.y-columns[1]!.y)).toBeLessThan(1);expect(columns[1]!.x).toBeGreaterThan(columns[0]!.x+columns[0]!.width);
  for(const card of [first,second]) {
    const correct=card.getByRole("button",{name:"Correct",exact:true});await expect(correct).toBeVisible();
    expect(await correct.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
  }
  await page.screenshot({path:testInfo.outputPath("two-column-desktop.png")});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(database(`return p.inventoryItem.findMany({where:{currentOwnerId:${JSON.stringify(f.user)}},orderBy:{id:'asc'}});`)).toEqual(inventory);
  expect(database(`return p.acquisitionPhoto.findMany({where:{runId:${JSON.stringify(f.runId)}},orderBy:{id:'asc'},select:{id:true,digest:true,bytes:true,purgedAt:true}});`)).toEqual(originals);
  expect(errors).toEqual([]);
  await testInfo.attach("frame-geometry",{body:JSON.stringify({viewport,frames,media}),contentType:"application/json"});
 });
}

test("pending two-column reviews keep Confirm and Correct visible on a laptop",async({page,baseURL},testInfo)=>{
  test.setTimeout(90000);expect(["http://127.0.0.1:13295","http://127.0.0.1:13305"]).toContain(baseURL);
  const f=database("return JSON.parse(require('fs').readFileSync('/tmp/scans-experience-fixture.json','utf8'));");
  database(`return p.acquisitionCandidate.updateMany({where:{runId:${JSON.stringify(f.runId)}},data:{review:require('@prisma/client').Prisma.DbNull,revision:{increment:1}}});`);
  await page.setViewportSize({width:1280,height:720});
  await page.context().addCookies([{name:"mtg_inventory_session",value:f.token,url:baseURL!,httpOnly:true,sameSite:"Lax"}]);
  await page.route(`**/api/acquisition/${f.batch}/review?photoId=*`,async route=>{
    const response=await route.fetch(),record=await response.json();
    await route.fulfill({response,json:{...record,recognitionStatus:"NO_MATCH",visualStatus:"COMPLETE",printingStatus:"COMPLETE",catalog:null,
      suggestions:[{printing:f.printing,reasons:["UNLOCALIZED_NAME_HINT"]}],
      evidence:{geometry:{status:"MISSING"},rotation:null,observations:[],...record.evidence,identifiers:{...record.evidence?.identifiers,languages:["fr"]}}}});
  });
  await page.goto(`/imports/scan?batch=${f.batch}`);
  await page.getByRole("button",{name:"Two-column list",exact:true}).click();
  await page.getByRole("link",{name:"Review saved cards",exact:true}).click();
  for(const number of [1,2]){
    const card=page.getByTestId(`capture-card-${number}`);
    for(const name of ["Confirm match","Correct"]){
      const button=card.getByRole("button",{name,exact:true});await expect(button).toBeEnabled();
      expect(await button.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
    }
    const frames=await card.locator('[data-testid$="comparison-frame"]').evaluateAll(elements=>elements.map(e=>{const r=e.getBoundingClientRect();return {w:r.width,h:r.height,y:r.y,bottom:r.bottom}}));
    expect(Math.abs(frames[0].w-frames[1].w)).toBeLessThan(1);expect(Math.abs(frames[0].h-frames[1].h)).toBeLessThan(1);expect(Math.abs(frames[0].y-frames[1].y)).toBeLessThan(1);
    expect(Math.max(...frames.map(r=>r.bottom))).toBeLessThanOrEqual(720);
  }
  await page.screenshot({path:testInfo.outputPath("pending-two-column-laptop.png")});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
