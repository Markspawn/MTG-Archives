import { prisma } from "../lib/prisma";
import { processHourlyWishlistDigests } from "../lib/wishlist-notification-digests";
import {
  builtInNotificationDeliveryHandlers,
  processNotificationDeliveryQueue,
} from "../lib/notification-delivery";
import {
  deliverNotificationWebhook,
  WEBHOOK_TRANSPORT,
} from "../lib/webhook-delivery";
import { deliverNotificationEmail } from "../lib/email-delivery";
import { processDailyPricingDigests } from "../lib/pricing-notification-digests";
import { EMAIL_TRANSPORT } from "../lib/email-config";

const deliveryHandlers = {
  ...builtInNotificationDeliveryHandlers,
  [WEBHOOK_TRANSPORT]: deliverNotificationWebhook,
  [EMAIL_TRANSPORT]: deliverNotificationEmail,
};

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const intervalMs = positiveInteger(
  process.env.NOTIFICATION_WORKER_INTERVAL_MS,
  60_000,
);
const runOnce = process.argv.includes("--once");
let stopping = false;
let nextLanguageCleanup = 0;
const languageCleanupIntervalMs = 24 * 60 * 60 * 1000;

async function tick() {
  if (Date.now() >= nextLanguageCleanup) {
    try {
      const [result] = await prisma.$queryRaw<{ repaired: number }[]>`
        SELECT normalize_inventory_english_rows() AS repaired
      `;
      nextLanguageCleanup = Date.now() + languageCleanupIntervalMs;
      if (result?.repaired) {
        console.info("[notification-worker] inventory languages normalized", result);
      }
    } catch (error) {
      console.error(
        "[notification-worker] inventory language normalization failed",
        error instanceof Error ? error.message : error,
      );
    }
  }
  try {
    const result = await processDailyPricingDigests();
    if (result.created) {
      console.info("[notification-worker] pricing digests created", result);
    }
  } catch (error) {
    console.error(
      "[notification-worker] pricing digest failed",
      error instanceof Error ? error.message : error,
    );
  }
  try {
    const result = await processHourlyWishlistDigests();
    if (result.activitiesProcessed || result.notificationsCreated) {
      console.info("[notification-worker] wishlist digest complete", {
        cutoff: result.cutoff.toISOString(),
        activitiesProcessed: result.activitiesProcessed,
        notificationsCreated: result.notificationsCreated,
        groupsProcessed: result.groupsProcessed,
      });
    }
  } catch (error) {
    console.error(
      "[notification-worker] wishlist digest failed",
      error instanceof Error ? error.message : error,
    );
  }
  try {
    const result = await processNotificationDeliveryQueue(deliveryHandlers);
    if (result.claimed) {
      console.info("[notification-worker] outbound delivery complete", result);
    }
  } catch (error) {
    console.error(
      "[notification-worker] outbound delivery failed",
      error instanceof Error ? error.message : error,
    );
  }
}

async function run() {
  console.info("[notification-worker] started", { intervalMs });
  if (runOnce) {
    await tick();
    return;
  }
  while (!stopping) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

void run();
