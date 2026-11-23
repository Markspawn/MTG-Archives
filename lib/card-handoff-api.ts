import { ZodError } from "zod";
import { getCurrentUser, isAdminModeEnabled } from "./auth";
import { HandoffError } from "./card-handoffs";
export async function handoffActor(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).host !== request.headers.get("host"))
    throw new HandoffError("Reload this page before confirming.", 403);
  const user = await getCurrentUser();
  if (!user) throw new HandoffError("Sign in before giving cards.", 401);
  return { userId: user.id, adminMode: await isAdminModeEnabled(user) };
}
export async function handoffJson(request: Request, limit = 8192) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HandoffError("Use the card handoff form.", 400);
  const reader = request.body?.getReader();
  if (!reader) throw new HandoffError("The handoff form was empty.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new HandoffError("Choose fewer source entries.", 400);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HandoffError("The handoff form was invalid.", 400);
  }
}
export function handoffError(error: unknown) {
  const definite = error instanceof HandoffError || error instanceof ZodError;
  return Response.json(
    {
      error:
        error instanceof HandoffError
          ? error.message
          : error instanceof ZodError
            ? "Check the recipient and copy quantity."
            : "The result could not be verified. Retry the same confirmation to check it safely.",
      definite,
      outcomeKnown: error instanceof HandoffError && error.outcomeKnown,
    },
    {
      status:
        error instanceof HandoffError
          ? error.status
          : error instanceof ZodError
            ? 400
            : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
