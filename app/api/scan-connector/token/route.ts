import {prisma} from "@/lib/prisma";
import {connectorForm,connectorJson} from "@/lib/scan-connector-http";
import {exchangeConnectorToken} from "@/lib/scan-connector-auth";
export const runtime="nodejs";
export async function POST(request:Request){
  try{const form=await connectorForm(request);if(form.get("client_secret"))return connectorJson({error:"invalid_client"},400);
    const token=await exchangeConnectorToken(prisma,form);return token?connectorJson(token):connectorJson({error:"invalid_grant"},400);
  }catch{return connectorJson({error:"invalid_grant"},400);}
}
