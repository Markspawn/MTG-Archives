import { prisma } from "@/lib/prisma";
import { getHandoffOptions } from "@/lib/card-handoffs";
import {
  handoffActor,
  handoffError,
  handoffJson,
} from "@/lib/card-handoff-api";
import { z } from "zod";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const actor = await handoffActor(request),
      input = z
        .object({
          itemIds: z.array(z.string().min(1).max(200)).max(1000),
        })
        .strict()
        .parse(await handoffJson(request, 262144));
    return Response.json(
      await getHandoffOptions(prisma, actor, input.itemIds),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handoffError(error);
  }
}
