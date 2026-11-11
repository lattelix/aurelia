"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export function Dialog({
  title,
  children,
  onClose,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    const close = () => latestClose.current();
    dialog.addEventListener("cancel", close);
    return () => {
      dialog.removeEventListener("cancel", close);
      dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-label={title}
      onClick={(event) => {
        if (event.target === ref.current) {
          const rect = ref.current.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
