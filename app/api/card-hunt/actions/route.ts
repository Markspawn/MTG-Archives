import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  handoffActor,
  handoffError,
  handoffJson,
} from "@/lib/card-handoff-api";
import { performHuntAction } from "@/lib/card-hunt-actions";
export async function POST(request: Request) {
  try {
    const actor = await handoffActor(request);
    const result = await performHuntAction(
      prisma,
      actor.userId,
      await handoffJson(request, 384000),
    );
    if (result.status === "APPLIED") {
      for (const destination of result.destinations)
        if (destination.deckId) revalidatePath(`/decks/${destination.deckId}`);
      revalidatePath("/inventory");
      revalidatePath("/inventory/handoffs");
      revalidatePath("/locations");
      revalidatePath("/card-hunt");
    }
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handoffError(error);
  }
}
