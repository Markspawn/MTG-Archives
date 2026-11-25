import { publicInventoryResponse } from "@/lib/public-inventory-response";
export async function GET(request: Request) {
  return publicInventoryResponse(request);
}
