import {acquisitionBatchSegments, type AcquisitionBatchStates} from "@/lib/acquisition-batch-state";

const format = (count: number) => count.toLocaleString("en-US");

export function AcquisitionBatchStateBar({total, states}: {total: number; states: AcquisitionBatchStates}) {
  const segments = acquisitionBatchSegments(total, states);
  const summary = segments.map(stage => `${format(stage.count)} ${stage.label.toLowerCase()}`).join(", ");
  return <figure aria-label="Batch card states" className="min-w-0 space-y-2" data-saved-total={total}>
    <figcaption className="text-sm"><span className="font-semibold tabular-nums">{format(total)}</span> saved cards</figcaption>
    <div className="flex h-4 overflow-hidden rounded bg-[var(--app-control)]" role="img"
      aria-label={`${format(total)} saved cards: ${summary}`}>
      {segments.map(stage => <span key={stage.key} data-state={stage.key} data-count={stage.count}
        className={`shrink-0 transition-[width] duration-300 ease-out motion-reduce:transition-none ${stage.color}`}
        style={{width: `${stage.width}%`}} title={`${stage.label}: ${format(stage.count)}`} />)}
    </div>
    <dl className="grid grid-cols-2 sm:grid-cols-5 gap-x-3 gap-y-2 text-sm">
      {segments.map(stage => <div key={stage.key} className="min-w-0" data-state-label={stage.key}>
        <dt className="flex items-start gap-1.5 text-xs text-[var(--app-muted)]">
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-sm ${stage.color}`} aria-hidden="true" />
          <span>{stage.label}</span>
        </dt>
        <dd className="font-semibold tabular-nums pl-3.5">{format(stage.count)}</dd>
      </div>)}
    </dl>
  </figure>;
}
