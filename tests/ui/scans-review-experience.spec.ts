import {test, expect} from "@playwright/test";
import {execFileSync} from "node:child_process";

test.skip(process.env.MTG_SCANS_EXPERIENCE_TEST !== "1", "Owned disposable scan-review fixture required");
test.use({video: "off", actionTimeout: 15000});
function database(body: string) {
  const container = process.env.MTG_INVENTORY_TEST_CONTAINER ?? "";
  if (!/^[a-f0-9]{64}$/.test(container)) throw Error("Immutable owned review container required");
  return JSON.parse(execFileSync("docker", ["exec", "-i", container, "node"], {
    windowsHide: true, encoding: "utf8", timeout: 30000,
    input: `const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{if(new URL(process.env.DATABASE_URL).pathname!=='/review_pending_performance')throw Error('Wrong fixture');${body}})().then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());`,
  }));
}
for (const width of [1366, 390, 320]) test(`focused comparison and two-column overview at ${width}px`, async ({page, baseURL}) => {
  test.setTimeout(180000);
  expect(baseURL).toBe("http://127.0.0.1:13275");
  const f = database("return JSON.parse(require('fs').readFileSync('/tmp/scans-experience-fixture.json','utf8'));");
  database(`return p.acquisitionCandidate.updateMany({where:{runId:${JSON.stringify(f.runId)}},data:{review:null,revision:{increment:1}}});`);
  await page.context().addCookies([{name:"mtg_inventory_session", value:f.token, url:baseURL!, httpOnly:true, sameSite:"Lax"}]);
  const endpoint = `/api/acquisition/${f.batch}/review`;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route(`**${endpoint}?photoId=*`, async route => {
    const response = await route.fetch(), record = await response.json();
    await route.fulfill({response, json:{...record, recognitionStatus:"NO_MATCH", visualStatus:"COMPLETE", printingStatus:"COMPLETE", catalog:null,
      suggestions:[{printing:f.printing,reasons:["Controlled presentation fixture"]}]}});
  });
  await page.setViewportSize({width, height:900});
  await page.goto(`/imports/scan?batch=${f.batch}`);
  await page.getByRole("link", {name:"Review saved cards", exact:true}).click();
  const first=page.getByTestId("capture-card-1"), second=page.getByTestId("capture-card-2");
  await expect(page.getByRole("button",{name:"Focused review",exact:true})).toHaveAttribute("aria-pressed","true");
  await expect(first).toBeVisible(); await expect(second).toBeHidden();
  await expect(first.getByRole("img",{name:/Printing:/})).toBeVisible();
  await expect.poll(()=>first.locator("canvas").evaluate((el:HTMLCanvasElement)=>el.width)).toBeGreaterThan(0);
  await first.getByRole("button",{name:"Correct",exact:true}).click();
  await first.getByRole("combobox",{name:"Card condition",exact:true}).selectOption("LP");
  await page.getByRole("button",{name:"Next card",exact:true}).click();
  await expect(second).toBeVisible(); await expect(first).toBeHidden();
  await page.getByRole("button",{name:"Previous card",exact:true}).click();
  await expect(first.getByRole("combobox",{name:"Card condition",exact:true})).toHaveValue("LP");
  await page.getByRole("button",{name:"Two-column list",exact:true}).click();
  await expect(first).toBeVisible(); await expect(second).toBeVisible();
  const a=await first.boundingBox(),b=await second.boundingBox();
  expect(Math.abs(a!.y-b!.y)<5).toBe(width>=1024);
  await page.screenshot({path:`test-results/scans-overview-${width}.png`,fullPage:false});
  await first.getByRole("button",{name:"Focus card 1",exact:true}).click();
  await expect(first.getByRole("combobox",{name:"Card condition",exact:true})).toHaveValue("LP");
  // A rejected save keeps the selected card, draft and physical order.
  let reject=true;
  await page.route(`**${endpoint}`,async route=>{
    if(route.request().method()==="POST" && reject) await route.fulfill({status:409,json:{error:"Controlled stale review"}});
    else await route.continue();
  });
  await first.getByRole("button",{name:"Save and next",exact:true}).click();
  await expect(first).toContainText("Controlled stale review"); await expect(second).toBeHidden();
  await expect(first.getByRole("combobox",{name:"Card condition",exact:true})).toHaveValue("LP");
  reject=false;
  await first.getByRole("button",{name:"Save and next",exact:true}).click();
  await expect(second).toBeVisible(); await expect(second).toBeFocused();
  const saved=await (await page.request.get(`${endpoint}?photoId=${f.photos[0]}`)).json();
  expect(saved.review.condition).toBe("LP"); expect(saved.review.finish).toBe("NONFOIL");
  expect(saved.review.openerPlayerId).toBe(f.user);
  await second.getByRole("button",{name:"Confirm and next",exact:true}).click();
  await expect(page.getByTestId("capture-card-3")).toBeVisible();
  const show=page.getByRole("combobox",{name:"Show cards",exact:true});
  await show.selectOption("added"); await expect(page.getByRole("combobox",{name:"Jump to card",exact:true})).toBeDisabled();
  await expect(page.getByText("No cards in this view. Choose All to return to the batch.",{exact:true})).toBeVisible();
  await show.selectOption("all");
  await page.getByRole("combobox",{name:"Jump to card",exact:true}).selectOption(f.slots[13]);
  await expect(page.getByTestId("capture-card-14")).toBeVisible();
  await expect(page.getByRole("button",{name:"Next card",exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"Previous card",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"Batch settings",exact:true}).click();
  await expect(page.getByRole("button",{name:"Save batch defaults",exact:true})).toBeVisible();
  await page.getByRole("link",{name:"Review saved cards",exact:true}).click();
  await page.screenshot({path:`test-results/scans-focus-${width}.png`,fullPage:false});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(database(`return p.inventoryItem.count({where:{ownerPlayerId:${JSON.stringify(f.user)}}});`)).toBe(0);
  expect(errors).toEqual([]);
});
