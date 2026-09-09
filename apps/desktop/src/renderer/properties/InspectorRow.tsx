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
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="anim-field">
      <span className="anim-field-label">{label}</span>
      <div className="anim-field-control">{children}</div>
    </div>
  );
}
