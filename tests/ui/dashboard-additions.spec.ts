import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

test("dashboard shows personal rolling additions and partial values on desktop and phones", async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(
    process.env.MTG_LOCAL_PILOT_TEST !== "1",
    "Requires an owned disposable database",
  );
  const container = process.env.MTG_ADDITIONS_TEST_CONTAINER ?? "";
  expect(container).toBe("mtg-dashboard-additions-review");
  expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  test.setTimeout(120000);
  const tag = `additions-ui-${randomUUID()}`,
    password = randomUUID();
  function database(body: string) {
    return JSON.parse(
      execFileSync("docker", ["exec", "-i", container, "node"], {
        input: `const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{${body}})().then(x=>console.log(JSON.stringify(x??null))).catch(e=>{console.error(e);process.exitCode=1}).finally(()=>p.$disconnect());`,
        encoding: "utf8",
        timeout: 30000,
      }),
    );
  }
  const fixture = database(`
    const users=[];for(const suffix of ['', '-other'])users.push(await p.user.create({data:{username:${JSON.stringify(tag)}+suffix,displayName:'Additions reviewer',passwordHash:await require('bcryptjs').hash(${JSON.stringify(password)},10),player:{create:{name:${JSON.stringify(tag)}+suffix,displayName:'Additions reviewer'}}}}));
    const card=await p.card.create({data:{scryfallId:${JSON.stringify(tag)},name:'Dashboard fixture',typeLine:'Artifact',setCode:'tst',collectorNumber:'1',rarity:'common',prices:{usd:'2.50'}}});
    const now=Date.now();const add=async(owner,hours,qty,action='acquisition_committed',extra={},before={quantity:0})=>p.inventoryAuditLog.create({data:{changeType:action,beforeJson:before,afterJson:{currentOwnerId:owner,cardId:card.id,quantity:qty,foilStatus:'NONFOIL',...extra},createdAt:new Date(now-hours*3600000)}});
    await add(users[0].playerId,1,2);await add(users[0].playerId,48,105,'inventory_added',{quantityAdded:5},{quantity:100});await add(users[0].playerId,120,7,'import_committed',{quantityImported:7});await add(users[0].playerId,360,9);await add(users[0].playerId,1,3,'acquisition_committed',{foilStatus:'FOIL'});
    await add(users[0].playerId,1,1000,'inventory_restored');await add(users[0].playerId,1,1000,'location_moved');await add(users[1].playerId,1,500);
    return {users:users.map(u=>({id:u.id,playerId:u.playerId})),cardId:card.id};
  `);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/login");
    await page.getByLabel(/username or email/i).fill(tag);
    await page.getByLabel(/^password$/i).fill(password);
    await page.getByRole("button", { name: /^log in$/i }).click();
    await page.waitForURL(/\/dashboard/);
    const section = page.getByRole("region", {
      name: "Cards added",
      exact: true,
    });
    for (const width of [1366, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(section).toBeVisible();
      const expected = [
        ["24 hours", "5", "$5.00"],
        ["3 days", "10", "$17.50"],
        ["7 days", "17", "$35.00"],
        ["30 days", "26", "$57.50"],
      ];
      for (const [period, copies, value] of expected) {
        const tile = section
          .getByRole("heading", { name: `Last ${period}`, exact: true })
          .locator("..");
        await expect(tile).toContainText(`${copies} copies`);
        await expect(tile).toContainText(value);
        await expect(tile).toContainText("Priced subtotal");
        await expect(tile).toContainText("3 unpriced copies");
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await section.screenshot({
        path: test.info().outputPath(`additions-${width}.png`),
      });
    }
    const other = await browser.newContext();
    try {
      const otherPage = await other.newPage();
      await otherPage.goto(`${baseURL}/login`);
      await otherPage.getByLabel(/username or email/i).fill(`${tag}-other`);
      await otherPage.getByLabel(/^password$/i).fill(password);
      await otherPage.getByRole("button", { name: /^log in$/i }).click();
      await otherPage.waitForURL(/\/dashboard/);
      const otherSection = otherPage.getByRole("region", {
        name: "Cards added",
        exact: true,
      });
      await expect(
        otherSection.getByText("500 copies", { exact: true }),
      ).toHaveCount(4);
      await expect(
        otherSection.getByText("$1,250.00", { exact: true }),
      ).toHaveCount(4);
      await expect(otherSection).not.toContainText("unpriced");
    } finally {
      await other.close();
    }
    const anonymous = await browser.newContext();
    try {
      const publicPage = await anonymous.newPage();
      await publicPage.goto(`${baseURL}/dashboard`);
      await expect(
        publicPage.getByRole("region", { name: "Cards added", exact: true }),
      ).toHaveCount(0);
    } finally {
      await anonymous.close();
    }
    expect(errors).toEqual([]);
  } finally {
    database(
      `const owners=${JSON.stringify(fixture.users.map((u: any) => u.playerId))};await p.inventoryAuditLog.deleteMany({where:{afterJson:{path:['cardId'],equals:${JSON.stringify(fixture.cardId)}}}});await p.user.deleteMany({where:{id:{in:${JSON.stringify(fixture.users.map((u: any) => u.id))}}}});await p.player.deleteMany({where:{id:{in:owners}}});await p.card.delete({where:{id:${JSON.stringify(fixture.cardId)}}});return true;`,
    );
  }
});
