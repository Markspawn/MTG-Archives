import { prisma } from "@/lib/prisma";
import { giveInventoryCard } from "@/lib/card-handoffs";
import {
  handoffActor,
  handoffError,
  handoffJson,
} from "@/lib/card-handoff-api";
import { revalidatePath } from "next/cache";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const actor = await handoffActor(request),
      input = await handoffJson(request);
    const result = await giveInventoryCard(prisma, actor, input);
    // Stock is already committed: a cache failure must never invite a new request.
    try {
      revalidatePath("/inventory");
      revalidatePath("/inventory/handoffs");
      revalidatePath("/trades");
      revalidatePath("/wishlist");
    } catch {}
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handoffError(error);
  }
}
