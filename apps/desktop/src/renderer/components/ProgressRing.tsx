/// Measured progress as a ring: the status bar's work pill and the start
/// screen's unpack. The ring owns the accessible progress value; without a
/// percent it spins. The consumer's CSS sets its size (`.progress-ring` in
/// styles/status.css is the work pill's).
export function ProgressRing({ label, percent, className }: {
  label: string;
  percent: number | undefined;
  className?: string;
}) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  // The indeterminate arc: a short segment that the spin animation turns.
  const shown = percent ?? 30;
  const classes = ["progress-ring", percent === undefined && "is-indeterminate", className].filter(Boolean).join(" ");
  return (
    <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      {...(percent === undefined ? {} : { "aria-valuenow": percent })}
      className={classes}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="progress-ring-track" cx="8" cy="8" r={radius} />
        <circle className="progress-ring-fill" cx="8" cy="8" r={radius} transform="rotate(-90 8 8)"
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - shown / 100)} />
      </svg>
    </span>
  );
}
