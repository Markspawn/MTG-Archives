import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

function database<T>(body: string): T {
  const app = process.env.MTG_HANDOFF_CONTAINER ?? "";
  if (process.env.MTG_HANDOFF_TEST !== "1" || !/^[a-f0-9]{64}$/.test(app))
    throw Error("Explicit isolated handoff review required");
  const state = JSON.parse(
    execFileSync("docker", ["inspect", app], {
      encoding: "utf8",
      windowsHide: true,
    }),
  )[0];
  if (state.Config.Labels["mtg.archive.owner"] !== "card-handoffs-20261123")
    throw Error("Wrong review owner");
  return JSON.parse(
    execFileSync("docker", ["exec", "-i", app, "node", "-r", "tsx/cjs"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      input: `const{PrismaClient}=require('@prisma/client'),fs=require('fs');const p=new PrismaClient();(async()=>{const u=new URL(process.env.DATABASE_URL);if(u.hostname!=='mtg-handoff-db'||u.pathname!=='/review_handoffs')throw Error('Wrong database');${body}})().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());`,
    }),
  );
}
async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel(/username or email/i).fill(username);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL(/\/dashboard/);
}
test("quick external and Archive handoffs conserve stock and recover a lost acknowledgement", async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  test.skip(
    process.env.MTG_HANDOFF_TEST !== "1",
    "Requires task-owned handoff review",
  );
  expect(baseURL).toBe("http://127.0.0.1:13395");
  test.setTimeout(180000);
  const tag = "handoff-ui-" + randomUUID(),
    password = randomUUID();
  const f = database<any>(
    `if(await p.user.count())throw Error('Fresh synthetic review required');const f=await require('./scripts/verify-card-handoffs.ts').seedCardHandoffFixture(p,${JSON.stringify(tag)});const hash=await require('bcryptjs').hash(${JSON.stringify(password)},10);await p.user.updateMany({where:{id:{in:f.ids}},data:{passwordHash:hash}});await p.inventoryItem.deleteMany({where:{id:{in:[f.duplicateId,f.deckId]}}});const svg='<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" rx="16" fill="#133b2e"/><rect x="18" y="18" width="264" height="384" rx="8" fill="#d8bd87"/><text x="32" y="55" font-size="22">Handoff test card</text><rect x="32" y="75" width="236" height="160" fill="#54806e"/><text x="32" y="365" font-size="20">TST 7</text></svg>';await p.card.update({where:{id:f.cardId},data:{imageUri:'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')}});const image=(await p.card.findUniqueOrThrow({where:{id:f.cardId}})).imageUri;const last=await p.card.create({data:{name:'Last copy '+f.tag,scryfallId:require('crypto').randomUUID(),setCode:'tst',collectorNumber:'8',typeLine:'Creature',rarity:'common',imageUri:image}});f.lastCardId=last.id;f.lastName=last.name;await p.inventoryItem.update({where:{id:f.singleId},data:{cardId:last.id}});fs.writeFileSync('/tmp/handoff-ui-fixture.json',JSON.stringify(f));return f;`,
  );
  const inventory =
    "/inventory?displayMode=exact&cardName=" + encodeURIComponent(f.cardName);
  const original = database<any>(
    `return{source:await p.inventoryItem.findUniqueOrThrow({where:{id:${JSON.stringify(f.sourceId)}}}),foreign:await p.inventoryItem.findUniqueOrThrow({where:{id:${JSON.stringify(f.foreignId)}}}),card:await p.card.findUniqueOrThrow({where:{id:${JSON.stringify(f.cardId)}}}),quantity:(await p.inventoryItem.aggregate({_sum:{quantity:true}}))._sum.quantity};`,
  );
  expect(original.quantity).toBe(20);
  await login(page, f.ids[0], password);
  await page.goto(inventory);
  await page.getByRole("button", { name: "Table View", exact: true }).click();
  const open = async (cardName = f.cardName) => {
    await page
      .getByLabel("Actions for " + cardName, { exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Give / trade away", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Give / trade away",
      exact: true,
    });
    await expect(dialog.getByText("Loading available copies…")).toHaveCount(0);
    return dialog;
  };
  let dialog = await open();
  await dialog.getByLabel("Copies", { exact: true }).fill("2");
  await dialog
    .getByLabel("Recipient name", { exact: true })
    .fill("Pat O’Brien");
  await expect(dialog.getByText(/From .*Handoff box/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await dialog.screenshot({
    path: testInfo.outputPath("external-desktop.png"),
  });
  await dialog
    .getByRole("button", { name: "Confirm give · 2 copies", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "2 copies of" }),
  ).toContainText("Pat O’Brien");
  expect(
    database<number>(
      `return(await p.inventoryItem.findUniqueOrThrow({where:{id:${JSON.stringify(f.sourceId)}}})).quantity;`,
    ),
  ).toBe(8);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  let firstRequest: string | undefined,
    receiptId: string | undefined,
    attempts = 0,
    deniedRetries = 0;
  await page.route("**/api/inventory/handoffs", async (route) => {
    const request = route.request().postDataJSON();
    if (!firstRequest) firstRequest = request.requestId;
    expect(request.requestId).toBe(firstRequest);
    const response = await route.fetch();
    if (response.status() === 401) {
      deniedRetries++;
      const error = await response.json();
      expect(error.definite).toBe(true);
      expect(error.outcomeKnown).toBe(false);
      await route.fulfill({ response });
      return;
    }
    expect(response.status()).toBe(200);
    const result = await response.json();
    if (++attempts === 1) {
      receiptId = result.id;
      await route.abort("failed");
    } else {
      expect(result.id).toBe(receiptId);
      expect(result.replay).toBe(true);
      await route.fulfill({ response });
    }
  });
  const lastInventory =
    "/inventory?displayMode=exact&cardName=" + encodeURIComponent(f.lastName);
  await page.goto(lastInventory);
  dialog = await open(f.lastName);
  await dialog.getByLabel("Recipient name", { exact: true }).fill("Lee");
  await dialog
    .getByRole("combobox", { name: "Record as", exact: true })
    .selectOption("TRADE");
  await dialog
    .getByRole("button", { name: "Confirm trade away · 1 copy", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: "Retry same confirmation",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    database<number>(
      `return(await p.inventoryItem.findUniqueOrThrow({where:{id:${JSON.stringify(f.singleId)}}})).quantity;`,
    ),
  ).toBe(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await expect(
    page.getByLabel("Actions for " + f.lastName, { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Check pending handoff", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Give / trade away", exact: true });
  await expect(
    dialog.getByText(/Verify the previous confirmation/),
  ).toContainText("Lee");
  database(
    `return await p.authSession.deleteMany({where:{userId:${JSON.stringify(f.ids[0])}}});`,
  );
  await dialog
    .getByRole("button", { name: "Retry same confirmation", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Sign in");
  await expect(
    dialog.getByRole("button", {
      name: "Retry same confirmation",
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await login(page, f.ids[0], password);
  await page.goto(lastInventory);
  await page
    .getByRole("button", { name: "Check pending handoff", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Give / trade away", exact: true });
  await expect(
    dialog.getByText(/Verify the previous confirmation/),
  ).toContainText("Lee");
  await dialog
    .getByRole("button", { name: "Retry same confirmation", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(deniedRetries).toBe(1);
  await page.unroute("**/api/inventory/handoffs");
  expect(
    database<number>(
      `return await p.cardHandoff.count({where:{requestId:${JSON.stringify(firstRequest)}}});`,
    ),
  ).toBe(1);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.goto(inventory);
  dialog = await open();
  await dialog
    .getByRole("radio", { name: "Archive user", exact: true })
    .check();
  await dialog
    .getByRole("combobox", { name: "Archive recipient", exact: true })
    .selectOption(f.ids[1]);
  await dialog.getByLabel("Copies", { exact: true }).fill("3");
  await expect(dialog.getByText(/immediately removes/)).toContainText(
    "Unassigned",
  );
  await dialog.screenshot({ path: testInfo.outputPath("archive-desktop.png") });
  await dialog
    .getByRole("button", { name: "Confirm give · 3 copies", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "3 copies of" }),
  ).toContainText("saved to their Unassigned location");
  await page
    .getByRole("status")
    .filter({ hasText: "3 copies of" })
    .getByRole("link", { name: "View history", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Gifts and traded-away cards",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(3);
  await expect(
    page.getByText("Traded away to Lee · Outside Archive", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("history-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("searchbox", { name: "Search cards or people", exact: true })
    .fill("Pat");
  await page
    .getByRole("button", { name: "Filter history", exact: true })
    .click();
  await expect(page.getByRole("listitem")).toHaveCount(1);
  const result = database<any>(
    `const records=await p.cardHandoff.findMany({where:{fromPlayerId:${JSON.stringify(f.ids[0])}},orderBy:{createdAt:'asc'}});const receipt=records.find(x=>x.toPlayerId);return{source:await p.inventoryItem.findUniqueOrThrow({where:{id:${JSON.stringify(f.sourceId)}}}),foreign:await p.inventoryItem.findUniqueOrThrow({where:{id:${JSON.stringify(f.foreignId)}}}),card:await p.card.findUniqueOrThrow({where:{id:${JSON.stringify(f.cardId)}}}),received:await p.inventoryItem.findUniqueOrThrow({where:{id:receipt.receivedInventoryItemId},include:{location:true}}),quantity:(await p.inventoryItem.aggregate({_sum:{quantity:true}}))._sum.quantity,records:records.map(r=>({id:r.id,quantity:r.quantity,kind:r.kind,actor:r.actorUserId,to:r.toPlayerId,recipient:r.recipientName}))};`,
  );
  expect(result.source.quantity).toBe(5);
  expect(result.quantity).toBe(17);
  expect(result.foreign).toEqual(original.foreign);
  expect(result.card).toEqual(original.card);
  expect(result.received.quantity).toBe(3);
  expect(result.received.location.normalizedName).toBe("unassigned");
  expect(result.received.locationSection).toBeNull();
  for (const key of [
    "originalOpenerId",
    "foilStatus",
    "condition",
    "language",
    "notes",
    "acquiredFromPullId",
    "roundId",
  ]) {
    expect(result.source[key]).toEqual(original.source[key]);
    expect(result.received[key]).toEqual(original.source[key]);
  }
  expect(result.records).toHaveLength(3);
  expect(result.records.every((r: any) => r.actor === f.ids[0])).toBe(true);
  await context.clearCookies();
  await login(page, f.ids[1], password);
  await page.goto("/inventory/handoffs?direction=received");
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(
    page.getByText("Delivered to your Unassigned location", { exact: true }),
  ).toBeVisible();
  expect(await page.content()).not.toContain("Preserved lot note");
  expect(await page.content()).not.toContain("Handoff box");
  await page.setViewportSize({ width: 390, height: 900 });
  const phoneSearch = await page.getByRole("searchbox", {
    name: "Search cards or people", exact: true,
  }).boundingBox();
  expect(phoneSearch?.width).toBeGreaterThanOrEqual(250);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("received-phone.png"),
    fullPage: true,
  });
  await page.goto("/inventory/handoffs?owner=" + f.ids[0]);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "own handoff history",
  );
  await page.goto(inventory);
  await page
    .getByLabel("Actions for " + f.cardName, { exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "View details", exact: true }).click();
  await page
    .getByRole("dialog", { name: f.cardName, exact: true })
    .getByRole("button", { name: "Give / trade away", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Give / trade away", exact: true });
  await expect(dialog.getByLabel("Copies", { exact: true })).toBeVisible();
  await dialog
    .getByRole("radio", { name: "Archive user", exact: true })
    .check();
  await dialog
    .getByRole("combobox", { name: "Archive recipient", exact: true })
    .selectOption(f.ids[0]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await dialog.screenshot({ path: testInfo.outputPath("give-phone.png") });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const denied = await context.request.post(
    baseURL + "/api/inventory/handoffs",
    { headers: { Origin: "https://wrong.example" }, data: {} },
  );
  expect(denied.status()).toBe(403);
  const foreign = await context.request.post(
    baseURL + "/api/inventory/handoffs/options",
    { headers: { Origin: baseURL! }, data: { itemIds: [f.sourceId] } },
  );
  expect(foreign.status()).toBe(409);
  const final = database<any>(
    `return{quantity:(await p.inventoryItem.aggregate({_sum:{quantity:true}}))._sum.quantity,receipts:await p.cardHandoff.count(),source:(await p.inventoryItem.findUniqueOrThrow({where:{id:${JSON.stringify(f.sourceId)}}})).quantity};`,
  );
  expect(final).toEqual({ quantity: 17, receipts: 3, source: 5 });
  writeFileSync(
    testInfo.outputPath("conservation.json"),
    JSON.stringify(
      {
        passed: true,
        initialQuantity: 20,
        externalQuantityRemoved: 3,
        finalQuantity: 17,
        internalQuantityMoved: 3,
        sourceQuantity: 5,
        receipts: 3,
        sourceAndReceivedProvenancePreserved: true,
        otherOwnerLotUnchanged: true,
        catalogUnchanged: true,
        lostAcknowledgementAndReloadRecoveredOnce: true,
        lastCopyRecovery: true,
        expiredLoginRecovery: true,
        recipientHistoryPrivate: true,
        desktopAndPhone: true,
        final,
      },
      null,
      2,
    ),
  );
});
