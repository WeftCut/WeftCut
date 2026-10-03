import { createContext, useContext, type ReactNode, type SyntheticEvent } from "react";

export const LayerReadOnly = createContext(false);
export const useLayerReadOnly = () => useContext(LayerReadOnly);

/** Disable editing controls, including custom pointer controls and portals.
 * Section headers live outside this boundary so locked values remain inspectable. */
export function EditControls({ children, className }: { children: ReactNode; className?: string }) {
  const readOnly = useLayerReadOnly();
  const block = (event: SyntheticEvent) => {
    if (!readOnly) return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <fieldset
      disabled={readOnly}
      aria-disabled={readOnly || undefined}
      className={`m-0 min-w-0 border-0 p-0 ${className ?? ""}`}
      style={{ display: className ? undefined : "contents" }}
      onPointerDownCapture={block}
      onClickCapture={block}
      onDoubleClickCapture={block}
      onContextMenuCapture={block}
      onKeyDownCapture={(event) => { if (event.key !== "Tab") block(event); }}
    >{children}</fieldset>
  );
}
