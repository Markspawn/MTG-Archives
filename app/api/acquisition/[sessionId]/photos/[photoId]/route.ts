import { prisma } from "@/lib/prisma";
import { acquisitionActor, acquisitionError } from "@/lib/acquisition-api";
import { getAcquisitionPhoto } from "@/lib/acquisition-store";
import { readAcquisitionPhotoBytes } from "@/lib/acquisition-files";
import { z } from "zod";
import { acquisitionPreviewFrame } from "@/lib/acquisition-preview";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string; photoId: string }> },
) {
  try {
    const { sessionId, photoId } = await params;
    const photo = await getAcquisitionPhoto(
      prisma,
      await acquisitionActor(request),
      sessionId,
      photoId,
    );
    const preview = new URL(request.url).searchParams.get("preview") === "1";
    let digest = photo.digest;
    let frame: {width: number; height: number} | undefined;
    if (preview) {
      const job = await prisma.acquisitionProcessingJob.findFirst({
        where: {
          runId: photo.runId,
          artifact: { sourceId: photo.id },
          stage: "photo-canonical-v1",
          status: "COMPLETE",
        },
        orderBy: [{createdAt: "desc"}, {id: "desc"}],
        select: {output: true},
      });
      if (!job) throw new Error("Photo preview unavailable");
      const prepared = z
        .object({ previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
          width: z.number().int().positive(), height: z.number().int().positive() })
        .passthrough()
        .parse(job.output);
      digest = prepared.previewDigest;
      frame = acquisitionPreviewFrame(photo.width, photo.height, prepared.width, prepared.height);
    }
    const bytes = await readAcquisitionPhotoBytes(
      photo.id,
      preview ? "preview" : "raw",
      digest,
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": preview ? "image/jpeg" : photo.mediaType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": 'inline; filename="card-photo"',
        ...(frame ? {"X-Photo-Source-Width": String(frame.width), "X-Photo-Source-Height": String(frame.height)} : {}),
      },
    });
  } catch (error) {
    return acquisitionError(error);
  }
}
