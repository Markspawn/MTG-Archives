import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getHuntActionContext } from "@/lib/card-hunt-actions";
import { handoffError } from "@/lib/card-handoff-api";
export const dynamic = "force-dynamic";
export async function GET() {
  const user = await getCurrentUser();
  if (!user)
    return Response.json(
      { error: "Sign in to use Card Hunt." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  try {
    return Response.json(await getHuntActionContext(prisma, user.id), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handoffError(error);
  }
}
