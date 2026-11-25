import {redirect} from "next/navigation";
import {getCurrentUser,isAdminModeEnabled,isAdminUser} from "@/lib/auth";
import {connectorAuthorization} from "@/lib/scan-connector-policy";
import {Nav} from "@/components/Nav";
export const dynamic="force-dynamic";
export default async function AuthorizeConnector({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const raw=await searchParams;const query=new URLSearchParams();for(const[key,value]of Object.entries(raw)){if(typeof value==="string")query.set(key,value);else if(value)for(const entry of value)query.append(key,entry);}
  let request;try{request=connectorAuthorization(query);}catch{return <main className="p-6"><Nav/><h1>Connection unavailable</h1><p>Return to ChatGPT and start a new connection request.</p></main>;}
  const user=await getCurrentUser();if(!user)redirect("/login?next="+encodeURIComponent("/settings/connections/authorize?"+query.toString()));
  const admin=isAdminUser(user,user.player),adminMode=await isAdminModeEnabled(user);
  return <main className="mx-auto max-w-2xl p-6 space-y-5"><Nav/><h1 className="text-2xl font-semibold">Connect ChatGPT to MTG Archives</h1>
    <p>Connect as <strong>{user.displayName}</strong>. ChatGPT can read your open scan batches, private scan images, recognition evidence and printing choices.</p>
    <form method="post" action="/api/scan-connector/authorize" className="space-y-5 rounded border border-[var(--app-border)] p-4">
      <input type="hidden" name="authorization" value={query.toString()}/>
      {request.scopes.includes("scans:confirm")&&<label className="flex gap-2 items-start"><input type="checkbox" name="confirm" defaultChecked/><span>Allow ChatGPT to confirm card matches. Uncertain cards can stay pending; this permission does not add cards to Inventory.</span></label>}
      {request.scopes.includes("scans:all-users")&&<div className="space-y-2"><label className="flex gap-2 items-start"><input type="checkbox" name="allUsers" disabled={!admin||!adminMode}/><span>Administrator: allow reviewing open batches for all users.</span></label>
        {!adminMode&&<p className="text-sm">All-user access requires an administrator with Admin Mode enabled. Leave it unchecked to connect only your own batches.</p>}</div>}
      <p className="text-sm">Connections expire after 30 days. Revoke access at any time in Settings → Connections. Scan images and review evidence you request will be shared with your ChatGPT conversation.</p>
      <div className="flex gap-3 flex-wrap"><button type="submit" name="decision" value="allow" className="rounded border px-4 py-2">Connect account</button><button type="submit" name="decision" value="deny" className="rounded border px-4 py-2">Cancel</button></div>
    </form></main>;
}
