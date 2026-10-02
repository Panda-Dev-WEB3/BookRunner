// Modal dialog and side drawer on the native <dialog> element: the browser provides the focus trap,
// Escape to close, the inert background and top-layer stacking; we add the close button, backdrop
// click, scroll lock and focus return. Bottom sheet on phones, centred card from sm up.
import { type MouseEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { cx } from "./cx";
import { IconClose } from "./icons";

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
      const prev = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      return () => {
        document.documentElement.style.overflow = prev;
        if (d.open) d.close();
        opener?.focus?.();
      };
    }
    if (!open && d.open) d.close();
    return undefined;
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, []);
  /** A click that lands on the <dialog> itself (not its content) is a backdrop click. */
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) closeRef.current();
  };
  return { ref, onBackdrop };
}

const SIZES = { sm: "sm:max-w-[420px]", md: "sm:max-w-[560px]", lg: "sm:max-w-[760px]" } as const;

export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const { ref, onBackdrop } = useDialog(props.open, props.onClose);
  const titleId = useId();
  const descId = useId();
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={props.description ? descId : undefined}
      onClick={onBackdrop}
      className="dialog-reset fixed inset-0 h-dvh w-screen bg-transparent"
    >
      {props.open && (
        // pointer-events-none: clicks on the empty area reach the <dialog> itself (backdrop click)
        <div className="pointer-events-none flex h-full w-full items-end justify-center sm:items-center sm:p-6">
          <div
            className={cx(
              "sheet-in pointer-events-auto flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[16px] border border-line bg-surface shadow-pop sm:max-h-[86dvh] sm:rounded-card",
              SIZES[props.size ?? "md"],
              props.className,
            )}
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 pt-4 pb-3 sm:px-6 sm:pt-5">
              <div className="min-w-0">
                <h2 id={titleId} className="text-[17px] font-semibold tracking-[-0.01em]">
                  {props.title}
                </h2>
                {props.description && (
                  <p id={descId} className="mt-1 text-[13px] text-ink-2">
                    {props.description}
                  </p>
                )}
              </div>
              <button type="button" className="btn btn-ghost btn-icon -mt-1 -mr-2 shrink-0" onClick={props.onClose} aria-label="Close dialog">
                <IconClose size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6 sm:py-5">{props.children}</div>
            {props.footer && <div className="border-t border-line bg-surface-2/60 px-5 py-3 sm:px-6">{props.footer}</div>}
          </div>
        </div>
      )}
    </dialog>
  );
}

/** Side sheet (mobile navigation and similar). Slides in from the right, full height. */
export function Drawer(props: { open: boolean; onClose: () => void; title: ReactNode; children?: ReactNode; className?: string }) {
  const { ref, onBackdrop } = useDialog(props.open, props.onClose);
  const titleId = useId();
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClick={onBackdrop} className="dialog-reset fixed inset-0 h-dvh w-screen bg-transparent">
      {props.open && (
        <div
          className={cx(
            "drawer-in ml-auto flex h-full w-[min(360px,88vw)] flex-col border-l border-line bg-surface shadow-pop",
            props.className,
          )}
        >
          <div className="flex h-16 items-center justify-between gap-3 border-b border-line px-4">
            <h2 id={titleId} className="text-[15px] font-semibold">
              {props.title}
            </h2>
            <button type="button" className="btn btn-ghost btn-icon" onClick={props.onClose} aria-label="Close menu">
              <IconClose size={18} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
        </div>
      )}
    </dialog>
  );
}
