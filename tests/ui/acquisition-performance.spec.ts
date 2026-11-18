import {test,expect} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {writeFileSync} from "node:fs";

test.skip(process.env.MTG_ACQUISITION_PERFORMANCE_TEST!=="1","Explicit owned isolated backlog fixture required");
test.use({video:"off"});
function database(body:string) {
  const container=process.env.MTG_INVENTORY_TEST_CONTAINER??"";
  if(!/^[a-f0-9]{64}$/.test(container))throw Error("Immutable owned review container required");
  return JSON.parse(execFileSync("docker",["exec","-i",container,"node"],{encoding:"utf8",windowsHide:true,timeout:30000,
    input:`const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{if(new URL(process.env.DATABASE_URL).pathname!=='/review_pending_performance')throw Error('Wrong fixture');${body}})().then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());`}));
}
function fixture() {return database("return JSON.parse(require('fs').readFileSync('/tmp/pending-performance-fixture.json','utf8'));");}
function fingerprint() {
  return database(`const {rowFingerprintSql}=require('./tests/row-fingerprint.cjs');const result={};for(const name of ['AcquisitionSession','AcquisitionCaptureSlot','AcquisitionPhoto','AcquisitionCandidate','AcquisitionArtifact','AcquisitionObservation','AcquisitionProcessingJob','InventoryItem','AcquisitionCommit','AcquisitionCommitMember']){const [row]=await p.$queryRawUnsafe(rowFingerprintSql(name));result[name]=row;}return result;`);
}
let sourceSnapshot: unknown;
test.beforeAll(()=>{
  const result=database(`const {rowFingerprintSql}=require('./tests/row-fingerprint.cjs');return p.$transaction(async tx=>{await tx.$executeRawUnsafe('CREATE TEMP TABLE fingerprint_control(id text,value text) ON COMMIT DROP');await tx.$executeRawUnsafe("INSERT INTO fingerprint_control VALUES ('a','one'),('b','two')");const [before]=await tx.$queryRawUnsafe(rowFingerprintSql('fingerprint_control'));await tx.$executeRawUnsafe("UPDATE fingerprint_control SET value='changed' WHERE id='a'");const [changed]=await tx.$queryRawUnsafe(rowFingerprintSql('fingerprint_control'));await tx.$executeRawUnsafe('DELETE FROM fingerprint_control');await tx.$executeRawUnsafe("INSERT INTO fingerprint_control VALUES ('b','two'),('a','one')");const [reordered]=await tx.$queryRawUnsafe(rowFingerprintSql('fingerprint_control'));return {before,changed,reordered};});`);
  expect(result.before.count).toBe(2);expect(result.before.hash).toHaveLength(64);
  expect(result.changed.hash).not.toBe(result.before.hash);expect(result.reordered).toEqual(result.before);
  sourceSnapshot=fingerprint();
});
test.afterAll(()=>{expect(fingerprint()).toEqual(sourceSnapshot);});

for(const width of [1366,390,320])test(`retained backlog uses private previews without repeated originals at ${width}px`,async({page,browser,baseURL})=>{
  test.setTimeout(120000);
  expect(new URL(baseURL!).hostname).toBe("127.0.0.1");
  const f=fixture(),raw=`/api/acquisition/${f.batch}/photos/${f.photoId}`;
  const baseline=process.env.MTG_PERFORMANCE_BASELINE==="1";
  await page.setViewportSize({width,height:900});
  await page.context().addCookies([{name:"mtg_inventory_session",value:f.token,url:baseURL!,httpOnly:true,sameSite:"Lax"}]);
  const requests:string[]=[];
  page.on("request",request=>{if(new URL(request.url()).pathname===raw)requests.push(request.url());});
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.route(`**/api/acquisition/${f.batch}/review?*`,async route=>{
    const response=await route.fetch(),record=await response.json();
    await route.fulfill({response,json:{...record,recognitionStatus:"NO_MATCH",visualStatus:"COMPLETE",printingStatus:"COMPLETE",catalog:null,
      evidence:{geometry:{status:"PROPOSED",method:"declared-card-scan",quad:[[100,100],[1520,100],[1520,2060],[100,2060]]},
        rotation:null,observations:[],identifiers:{setCodes:[],collectors:[],languages:[]},
        readingZones:{title:{top:0,bottom:200},footer:{top:1100,bottom:1397}},photoText:null}}});
  });
  const start=Date.now();await page.goto(`/imports/scan?batch=${f.batch}`);
  const card=page.getByTestId("capture-card-1");await card.scrollIntoViewIfNeeded();
  const canvas=card.locator("canvas");
  const colour=()=>canvas.evaluate((el:HTMLCanvasElement)=>{
    if(!el.width||!el.height)return [];
    return Array.from(el.getContext("2d")!.getImageData(Math.floor(el.width/2),Math.floor(el.height/2),1,1).data);
  });
  await expect.poll(async()=>{const c=await colour();return c[0]>200&&c[1]<70&&c[2]<70&&c[3]===255;}).toBe(true);
  const firstVisibleMs=Date.now()-start;
  if(!baseline){expect(requests.filter(u=>!u.includes("preview=1"))).toHaveLength(0);expect(requests).toHaveLength(1);}
  await page.getByRole("button",{name:"Advanced",exact:true}).click();await card.scrollIntoViewIfNeeded();
  for(const name of ["Original","Reading zones","Full card image","Original"]){
    await card.getByRole("button",{name,exact:true}).click();
    await expect.poll(async()=>{const c=await colour();return c[3]===255;}).toBe(true);
  }
  if(!baseline)expect(requests).toHaveLength(1);
  const countBeforeOriginal=requests.length;
  const original=await page.request.get(raw);
  expect(original.status()).toBe(200);expect(original.headers()["cache-control"]).toBe("private, no-store");
  expect(createHash("sha256").update(await original.body()).digest("hex")).toBe(f.originalDigest);
  const preview=await page.request.get(raw+"?preview=1");expect(preview.status()).toBe(200);
  if(!baseline){expect(preview.headers()["x-photo-source-width"]).toBe("1620");expect(preview.headers()["x-photo-source-height"]).toBe("2160");}
  expect((await preview.body()).length).toBe(f.previewBytes);
  const anonymous=await browser.newContext({baseURL});
  try{for(const url of [raw,raw+"?preview=1"])expect((await anonymous.request.get(url)).status()).toBe(403);}
  finally{await anonymous.close();}
  expect(errors).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath(`review-${width}.png`)});
  await page.goto("about:blank");
  writeFileSync(test.info().outputPath("measurements.json"),JSON.stringify({width,baseline,firstVisibleMs,
    reviewImageRequests:countBeforeOriginal,originalBytes:f.originalBytes,previewBytes:f.previewBytes,conservation:"file-level before/after"},null,2));
});

test("unavailable preview falls back to the original and image retry recovers",async({page,baseURL})=>{
  test.setTimeout(60000);
  const f=fixture(),raw=`/api/acquisition/${f.batch}/photos/${f.photoId}`;
  await page.context().addCookies([{name:"mtg_inventory_session",value:f.token,url:baseURL!,httpOnly:true,sameSite:"Lax"}]);
  let fail=true,rawReads=0;
  await page.route(`**${raw}?preview=1`,async route=>{if(fail)await route.fulfill({status:503,body:"Fixture preview unavailable"});else await route.continue();});
  await page.route(`**${raw}`,async route=>{rawReads++;await route.fulfill({status:503,body:"Fixture original unavailable"});});
  await page.goto(`/imports/scan?batch=${f.batch}`);
  const card=page.getByTestId("capture-card-1");await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole("button",{name:"Retry scan image"})).toBeVisible();expect(rawReads).toBe(1);
  fail=false;await card.getByRole("button",{name:"Retry scan image"}).click();
  await expect.poll(()=>card.locator("canvas").evaluate((el:HTMLCanvasElement)=>el.width)).toBeGreaterThan(0);
  await expect(card.getByRole("button",{name:"Retry scan image"})).toHaveCount(0);expect(rawReads).toBe(1);
});
