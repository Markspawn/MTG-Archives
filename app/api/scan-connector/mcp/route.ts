import {WebStandardStreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {prisma} from "@/lib/prisma";
import {createScanConnectorServer} from "@/lib/scan-connector-tools";
import {connectorOrigin} from "@/lib/scan-connector-policy";
import {connectorJson} from "@/lib/scan-connector-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request){
  let origin;try{origin=connectorOrigin();}catch{return connectorJson({error:"Connector unavailable"},404);}
  if(request.headers.get("host")!==new URL(origin).host||request.headers.get("origin")&&![origin,"https://chatgpt.com"].includes(request.headers.get("origin")!))return connectorJson({error:"Request origin unavailable"},403);
  const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization")??"")?.[1]??"";
  const server=createScanConnectorServer(prisma,token),transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,maxRequestBodySize:65536});
  try{await server.connect(transport);const response=await transport.handleRequest(request);response.headers.set("Cache-Control","no-store");return response;}finally{await server.close();}
}
export async function GET(){return connectorJson({error:"Use stateless MCP POST requests"},405,{Allow:"POST"});}
