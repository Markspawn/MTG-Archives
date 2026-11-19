import { prisma } from "@/lib/prisma";
import { acquisitionActor, acquisitionCommitError } from "@/lib/acquisition-api";
import {
  previewAcquisitionCommit,
  commitAcquisitionCards,
  previewConfirmedAcquisitionCommit,
} from "@/lib/acquisition-commit-service";
export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    const actor = await acquisitionActor(request),
      { sessionId } = await context.params;
    const body = await request.json();
    if (!body || !["preview", "preview-confirmed", "commit"].includes(body.action))
      throw new Error("Choose preview or commit");
    const { action, ...input } = body;
    const result =
      action === "preview-confirmed" ? await previewConfirmedAcquisitionCommit(prisma,actor,sessionId,input) : action === "preview"
        ? await previewAcquisitionCommit(prisma, actor, sessionId, input)
        : await commitAcquisitionCards(prisma, actor, sessionId, input);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return acquisitionCommitError(error);
  }
}
