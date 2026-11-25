import {connectorJson,connectorMetadata} from "@/lib/scan-connector-http";
export const dynamic="force-dynamic";
export async function GET(){try{return connectorJson(connectorMetadata("authorization"));}catch{return connectorJson({error:"Connector unavailable"},404);}}
