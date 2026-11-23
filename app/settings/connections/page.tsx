import {revalidatePath} from "next/cache";
import {requireLogin} from "@/lib/auth";
import {prisma} from "@/lib/prisma";
import {Nav} from "@/components/Nav";
import {CONNECTOR_CLIENT_ID,connectorResource} from "@/lib/scan-connector-policy";
export const dynamic="force-dynamic";
export default async function ConnectionsPage(){
  const user=await requireLogin();let url:string|null=null;try{url=connectorResource();}catch{/* optional service disabled */}
  const grants=await prisma.scanConnectorGrant.findMany({where:{userId:user.id},orderBy:{createdAt:"desc"},take:50,select:{id:true,scopes:true,createdAt:true,expiresAt:true,revokedAt:true}});
  async function revoke(form:FormData){"use server";const actor=await requireLogin();const id=String(form.get("grantId")??"");await prisma.scanConnectorGrant.updateMany({where:{id,userId:actor.id,revokedAt:null},data:{revokedAt:new Date()}});revalidatePath("/settings/connections");}
  return <main className="p-6 max-w-3xl mx-auto space-y-5"><Nav/><a href="/settings" className="underline">Settings</a><h1 className="text-2xl font-semibold">Connections</h1>
    <section className="rounded border border-[var(--app-border)] p-4 space-y-3"><h2 className="text-lg font-semibold">ChatGPT scan review</h2>
      {url?<><p>In ChatGPT, add a custom MCP server using this URL and OAuth authentication.</p><label className="block text-sm">Server URL<input readOnly value={url} className="block w-full rounded border bg-[var(--app-control)] p-2"/></label><p>OAuth client ID: <code>{CONNECTOR_CLIENT_ID}</code>. This public client uses no client secret.</p>
        <p className="text-sm">Sign in with your MTG Archives account when prompted. Your connection can review your open batches. An administrator can separately grant all-user access while Admin Mode is enabled. ChatGPT may ask to reconnect when you request an additional permission.</p>
        <p className="text-sm">Try: “Review my open batches. Confirm clear exact-printing matches and leave uncertain cards pending.”</p><a className="underline" href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">Open ChatGPT plugins</a></>:
        <p>The administrator has not enabled the connector for this installation. Ordinary scan review is still available.</p>}
      <p className="text-sm">This connector can review and confirm cards. Inventory addition remains a separate action in MTG Archives.</p></section>
    <section aria-label="Connected accounts" className="space-y-3"><h2 className="text-lg font-semibold">Your connections</h2>{!grants.length&&<p>No connected accounts.</p>}
      {grants.map(grant=><article key={grant.id} className="rounded border border-[var(--app-border)] p-4 space-y-2"><h3 className="font-semibold">ChatGPT · {grant.scopes.includes("scans:all-users")?"All users’ open batches":"Your open batches"}</h3><p>{grant.scopes.includes("scans:confirm")?"Review and confirm":"Review only"} · {grant.revokedAt?"Revoked":grant.expiresAt.getTime()<=Date.now()?"Expired":"Connected"}</p><p className="text-sm">Expires {grant.expiresAt.toISOString().slice(0,10)}</p>
        {!grant.revokedAt&&<form action={revoke}><input type="hidden" name="grantId" value={grant.id}/><button className="rounded border px-3 py-2">Revoke access</button></form>}</article>)}
    </section></main>;
}
