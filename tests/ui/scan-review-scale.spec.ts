import {test,expect,type Page} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {resetDesktopReviewInventory} from "./scan-review-fixture";

test.skip(process.env.MTG_SCAN_SCALE_TEST!=="1","Owned scan-size fixture required");
test.use({video:"off",actionTimeout:15000});
function database(body:string){
  const app=process.env.MTG_INVENTORY_TEST_CONTAINER??"";
  if(!/^[a-f0-9]{64}$/.test(app))throw Error("Immutable review app required");
  const owner=execFileSync("docker",["inspect","--format","{{index .Config.Labels \"mtg.archive.owner\"}}",app],{encoding:"utf8",windowsHide:true}).trim();
  if(owner!=="scan-review-scale-20261119")throw Error("Wrong scale fixture owner");
  return JSON.parse(execFileSync("docker",["exec","-i",app,"node"],{encoding:"utf8",windowsHide:true,timeout:30000,input:`const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{if(new URL(process.env.DATABASE_URL).pathname!=='/review_pending_performance')throw Error('Wrong database');${body}})().then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());`}));
}
function fixture(){return database("return JSON.parse(require('fs').readFileSync('/tmp/scans-experience-fixture.json','utf8'));");}
async function setSize(page:Page,value:number){
  const slider=page.getByRole("slider",{name:"Card size",exact:true});
  await slider.press("Home");for(let step=75;step<value;step+=5)await slider.press("ArrowRight");
  await expect(slider).toHaveValue(String(value));await expect(slider).toHaveAttribute("aria-valuetext",`${value}%`);
}
async function frames(page:Page,cardNumber=1){
  const card=page.getByTestId(`capture-card-${cardNumber}`);
  await expect.poll(()=>card.locator("canvas").evaluate((el:HTMLCanvasElement)=>el.width)).toBeGreaterThan(0);
  const sizes=await card.locator('[data-testid$="comparison-frame"]').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {w:r.width,h:r.height,y:r.y}}));
  expect(sizes).toHaveLength(2);expect(Math.abs(sizes[0].w-sizes[1].w)).toBeLessThan(1);expect(Math.abs(sizes[0].h-sizes[1].h)).toBeLessThan(1);expect(Math.abs(sizes[0].y-sizes[1].y)).toBeLessThan(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);return sizes[0];
}
test.beforeAll(()=>resetDesktopReviewInventory("scan-review-scale-20261119"));
test.beforeEach(async({page,baseURL})=>{
  expect(baseURL).toBe("http://127.0.0.1:13305");const f=fixture();
  database(`return p.acquisitionCandidate.updateMany({where:{runId:${JSON.stringify(f.runId)}},data:{review:require('@prisma/client').Prisma.DbNull,revision:{increment:1}}});`);
  await page.setViewportSize({width:1366,height:900});
  await page.context().addCookies([{name:"mtg_inventory_session",value:f.token,url:baseURL!,httpOnly:true,sameSite:"Lax"}]);
});

test("equal live scaling, keyboard limits, reload/batch persistence and reset",async({page},testInfo)=>{
  test.setTimeout(120000);const f=fixture();await page.goto(`/imports/scan?batch=${f.batch}`);
  await page.getByRole("link",{name:"Review saved cards",exact:true}).click();
  const normal=await frames(page);await setSize(page,125);const medium=await frames(page);expect(medium.w).toBeGreaterThan(normal.w*1.2);
  await setSize(page,200);const large=await frames(page);expect(large.w).toBeGreaterThan(medium.w*1.5);
  await page.getByRole("button",{name:"Two-column list",exact:true}).click();await page.getByRole("link",{name:"Review saved cards",exact:true}).click();
  const listLarge=await frames(page);await setSize(page,75);const listSmall=await frames(page);expect(listLarge.w).toBeGreaterThan(listSmall.w*2);
  await setSize(page,150);await page.reload();await expect(page.getByRole("slider",{name:"Card size",exact:true})).toHaveValue("150");await frames(page);
  const other=database("return JSON.parse(require('fs').readFileSync('/tmp/scan-actions-large-fixture.json','utf8'));");
  await page.goto(`/imports/scan?batch=${other.batch}`);await expect(page.getByRole("slider",{name:"Card size",exact:true})).toHaveValue("150");
  await page.getByRole("link",{name:"Review saved cards",exact:true}).click();await frames(page);
  await page.screenshot({path:testInfo.outputPath("larger-overview.png")});
  await page.getByRole("button",{name:"Reset card size",exact:true}).click();await expect(page.getByRole("slider",{name:"Card size",exact:true})).toHaveValue("100");
  await page.reload();await expect(page.getByRole("slider",{name:"Card size",exact:true})).toHaveValue("100");
});

test("resizing preserves a correction and the chosen size through a real save",async({page})=>{
  test.setTimeout(120000);const f=fixture();
  const before=database(`return {photos:await p.acquisitionPhoto.findMany({where:{runId:${JSON.stringify(f.runId)}},orderBy:{id:'asc'},select:{id:true,digest:true,bytes:true}}),stock:await p.inventoryItem.findMany({where:{currentOwnerId:${JSON.stringify(f.user)}},orderBy:{id:'asc'}})};`);
  await page.goto(`/imports/scan?batch=${f.batch}`);await page.getByRole("link",{name:"Review saved cards",exact:true}).click();const first=page.getByTestId("capture-card-1");
  await first.getByRole("button",{name:"Correct",exact:true}).click();await first.getByRole("combobox",{name:"Card condition",exact:true}).selectOption("LP");
  await setSize(page,150);await expect(first.getByRole("combobox",{name:"Card condition",exact:true})).toHaveValue("LP");
  await page.reload();await expect(page.getByRole("slider",{name:"Card size",exact:true})).toHaveValue("150");await expect(first.getByRole("combobox",{name:"Card condition",exact:true})).toHaveValue("LP");
  await first.getByRole("button",{name:"Save and next",exact:true}).click();await expect(page.getByTestId("capture-card-2")).toBeVisible();await expect(page.getByRole("slider",{name:"Card size",exact:true})).toHaveValue("150");
  expect(database(`return {photos:await p.acquisitionPhoto.findMany({where:{runId:${JSON.stringify(f.runId)}},orderBy:{id:'asc'},select:{id:true,digest:true,bytes:true}}),stock:await p.inventoryItem.findMany({where:{currentOwnerId:${JSON.stringify(f.user)}},orderBy:{id:'asc'}})};`)).toEqual(before);
});

test("invalid or unavailable storage stays usable and large images fit a narrow window",async({page},testInfo)=>{
  test.setTimeout(90000);const f=fixture(),key=`mtg-acquisition-review-scale:${f.user}`;
  await page.addInitScript(({key})=>{localStorage.setItem(key,"999");localStorage.setItem("mtg-acquisition-review-scale:other-user","175");},{key});
  await page.goto(`/imports/scan?batch=${f.batch}`);await expect(page.getByRole("slider",{name:"Card size",exact:true})).toHaveValue("100");
  await page.evaluate(key=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException("Controlled blocked preference","QuotaExceededError");return original.call(this,k,v);};},key);
  await setSize(page,200);await page.setViewportSize({width:390,height:844});await page.getByRole("link",{name:"Review saved cards",exact:true}).click();await frames(page);
  await page.screenshot({path:testInfo.outputPath("large-narrow-window.png")});
});
