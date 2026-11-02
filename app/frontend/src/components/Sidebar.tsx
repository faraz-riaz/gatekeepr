import { useRef, useState, type ReactNode } from "react";
import { cx } from "../lib/format";

/** A drag-resizable side panel. When closed it renders nothing (re-open controls live in the PDF toolbar). */
export function Sidebar({
  side,
  open,
  width,
  min,
  max,
  onWidth,
  children,
}: {
  side: "left" | "right";
  open: boolean;
  width: number;
  min: number;
  max: number;
  onWidth: (w: number) => void;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });

  if (!open) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - start.current.x;
    const w = start.current.w + (side === "left" ? dx : -dx);
    onWidth(Math.round(Math.min(max, Math.max(min, w))));
  };
  const onPointerUp = () => setDragging(false);

  return (
    <aside
      className={cx("relative h-full shrink-0 bg-surface", side === "left" ? "border-r border-line" : "border-l border-line", dragging && "select-none")}
      style={{ width }}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        className={cx("resize-handle", side === "left" ? "-right-[4px]" : "-left-[4px]", dragging && "dragging")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => onWidth(side === "left" ? 320 : 440)}
      />
      {dragging && <div className="fixed inset-0 z-10 cursor-col-resize" />}
    </aside>
  );
}
