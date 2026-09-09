import type { ReactNode } from "react";

/// A property row the caller fills itself: caption in the panel's label
/// column, whatever it passes in the value column.
///
/// This is what a merged pair row is built from — `X | Y`, `Anchor X | Y` and
/// unlinked `Scale` are one row each, captioned once, holding two
/// `InspectorAnimField layout="cell"` axes (and, for scale, the chain toggle
/// after them). Keep them merged: two half-width rows per pair cost the panel
/// its single value edge and stack below a ~290 px panel (`.prop-field-pair`
/// in `editor.css`).
///
/// Not a `<label>` (unlike `Field`): the value column holds several controls,
/// and a label wrapping them would activate only the first — clicking the
/// caption would focus X and say nothing about Y.
export function InspectorRow({
  label,
  reserveStopwatch = false,
  children,
}: {
  label: string;
  /// Set on a row whose value column holds NO stopwatch — a mode switcher, a
  /// tangent choice. It reserves the stopwatch's footprint so the row's
  /// control starts on the panel's input edge instead of on the column of
  /// clock icons. (A `Field` gets this for free; these rows can't be one
  /// because a `<label>` wrapping buttons activates the first.)
  reserveStopwatch?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="anim-field">
      <span className="anim-field-label">{label}</span>
      <div className={reserveStopwatch ? "anim-field-control prop-value-slot" : "anim-field-control"}>
        {children}
      </div>
    </div>
  );
}
