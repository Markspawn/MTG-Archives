import { NextResponse } from "next/server";
import { GET as publicSuggestions } from "@/app/api/public/inventory/filter-suggestions/route";
import { publicInventoryUsername } from "@/lib/public-inventory-link";
import { getPublicInventoryMember } from "@/lib/public-inventory-member";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ username: string }> }) {
  const member = await getPublicInventoryMember(publicInventoryUsername((await params).username));
  if (!member) return NextResponse.json({ error: "Public inventory not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const url = new URL(request.url);
  url.searchParams.delete("ownerId");
  url.searchParams.set("owner", member.ownerPlayerId);
  const response = await publicSuggestions(new Request(url, { headers: request.headers }));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
