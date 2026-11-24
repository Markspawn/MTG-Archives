import { NextResponse } from "next/server";
import { publicInventoryUsername } from "@/lib/public-inventory-link";
import { getPublicInventoryMember } from "@/lib/public-inventory-member";
import { publicInventoryResponse } from "@/lib/public-inventory-response";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ username: string }> }) {
  const member = await getPublicInventoryMember(publicInventoryUsername((await params).username));
  if (!member) return NextResponse.json({ error: "Public inventory not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return publicInventoryResponse(request, member);
}
