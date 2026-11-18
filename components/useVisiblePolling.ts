"use client";
import {useCallback, useEffect, useRef} from "react";
import {createVisiblePoller} from "@/lib/visible-poller";

export function useVisiblePolling(load: (signal: AbortSignal) => Promise<void>, delay: number | null) {
  const interval = useRef(delay);
  useEffect(() => { interval.current = delay; }, [delay]);
  const current = useRef<ReturnType<typeof createVisiblePoller> | null>(null);
  useEffect(() => {
    const poller = createVisiblePoller(load, () => interval.current);
    current.current = poller;
    void poller.refresh().catch(() => {});
    return () => { poller.stop(); if (current.current === poller) current.current = null; };
  }, [load]);
  return useCallback(async () => { await current.current?.refresh(); }, []);
}
