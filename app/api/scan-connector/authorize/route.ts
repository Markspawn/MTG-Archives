import {getCurrentUser,isAdminModeEnabled} from "@/lib/auth";
import {prisma} from "@/lib/prisma";
import {connectorForm,connectorJson} from "@/lib/scan-connector-http";
import {createConnectorAuthorization} from "@/lib/scan-connector-auth";
import {connectorAuthorization,sameConnectorOrigin} from "@/lib/scan-connector-policy";
export const runtime="nodejs";
export async function POST(request:Request){try{
  sameConnectorOrigin(request);const user=await getCurrentUser();if(!user)return connectorJson({error:"Login required"},401);
  const form=await connectorForm(request);const params=new URLSearchParams(form.get("authorization")??"");
  const authorization=connectorAuthorization(params);
  if(form.get("decision")==="deny"){
    const callback=new URL(authorization.redirect_uri);callback.searchParams.set("error","access_denied");callback.searchParams.set("state",authorization.state);callback.searchParams.set("iss",new URL(authorization.resource).origin);
    return new Response(null,{status:303,headers:{Location:callback.toString(),"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
  }
  if(form.get("decision")!=="allow")return connectorJson({error:"Choose whether to connect"},400);
  const callback=await createConnectorAuthorization(prisma,user.id,params,{confirm:form.get("confirm")==="on",allUsers:form.get("allUsers")==="on",adminMode:await isAdminModeEnabled(user)});
  return new Response(null,{status:303,headers:{Location:callback,"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
}catch{return connectorJson({error:"Connection request invalid or no longer authorized. Return to ChatGPT and reconnect."},400);}}
