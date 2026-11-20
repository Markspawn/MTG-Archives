import {execFileSync} from "node:child_process";

/** Reset only the two named synthetic batches in this task's disposable clone. */
export function resetDesktopReviewInventory(expectedOwner = "scan-review-density-20261119") {
  const app=process.env.MTG_INVENTORY_TEST_CONTAINER??"";
  if(!/^[a-f0-9]{64}$/.test(app))throw Error("Immutable desktop fixture app required");
  const owner=execFileSync("docker",["inspect","--format","{{index .Config.Labels \"mtg.archive.owner\"}}",app],{encoding:"utf8",windowsHide:true}).trim();
  if(!["scan-review-density-20261119","scan-review-scale-20261119"].includes(expectedOwner) || owner!==expectedOwner)throw Error("Refusing to reset any other review environment");
  execFileSync("docker",["exec","-i",app,"node"],{encoding:"utf8",windowsHide:true,timeout:30000,input:`
    const {PrismaClient}=require('@prisma/client'),fs=require('fs');const p=new PrismaClient();
    (async()=>{
      if(new URL(process.env.DATABASE_URL).pathname!=='/review_pending_performance')throw Error('Wrong fixture database');
      const fixtures=['/tmp/scans-experience-fixture.json','/tmp/scan-actions-large-fixture.json'].map(file=>JSON.parse(fs.readFileSync(file,'utf8')));
      const runIds=fixtures.map(f=>f.runId);
      await p.$transaction(async tx=>{
        const lots=[...new Set((await tx.acquisitionCommitMember.findMany({where:{runId:{in:runIds}},select:{inventoryItemId:true}})).map(m=>m.inventoryItemId))];
        await tx.acquisitionCommitMember.deleteMany({where:{runId:{in:runIds}}});
        await tx.acquisitionCommit.deleteMany({where:{runId:{in:runIds}}});
        await tx.inventoryAuditLog.deleteMany({where:{inventoryItemId:{in:lots}}});
        await tx.inventoryItem.deleteMany({where:{id:{in:lots}}});
      });
    })().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());
  `});
}
