import {prisma} from "@/lib/prisma";
import {connectorForm,connectorJson,CONNECTOR_CLIENT_ID} from "@/lib/scan-connector-http";
import {connectorOrigin} from "@/lib/scan-connector-policy";
import {revokeConnectorToken} from "@/lib/scan-connector-auth";
export const runtime="nodejs";
export async function POST(request:Request){try{connectorOrigin();const form=await connectorForm(request);
  if(form.get("client_id")!==CONNECTOR_CLIENT_ID)return connectorJson({error:"invalid_client"},400);
  await revokeConnectorToken(prisma,form.get("token")??"");return connectorJson({});
}catch{return connectorJson({error:"invalid_request"},400);}}
