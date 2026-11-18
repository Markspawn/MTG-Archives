type Visibility = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

/** One request at a time, with the delay measured from completion. A manual
 * refresh during a read queues one fresh read, so a mutation never reuses a
 * response that began before it. No work accumulates in a hidden/unmounted tab. */
export function createVisiblePoller(
  load: (signal: AbortSignal) => Promise<void>,
  delay: () => number | null,
  visibility: Visibility | undefined = typeof document === "undefined" ? undefined : document,
) {
  let stopped = false, queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;
  const visible = () => !visibility?.hidden;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  function refresh(): Promise<void> {
    clear();
    if (stopped || !visible()) return Promise.resolve();
    if (running) { queued = true; return running; }
    running = (async () => {
      try {
        do {
          queued = false;
          controller = new AbortController();
          try { await load(controller.signal); }
          catch (error) { if (!controller.signal.aborted) throw error; }
        } while (queued && !stopped && visible());
      } finally {
        running = undefined;
        const ms = delay();
        if (!stopped && visible() && ms !== null)
          timer = setTimeout(() => { void refresh().catch(() => {}); }, ms);
      }
    })();
    return running;
  }
  const changed = () => {
    if (visible()) void refresh().catch(() => {});
    else { clear(); queued = false; controller?.abort(); }
  };
  visibility?.addEventListener("visibilitychange", changed);
  return {refresh, stop() {
    stopped = true; queued = false; clear(); controller?.abort();
    visibility?.removeEventListener("visibilitychange", changed);
  }};
}
