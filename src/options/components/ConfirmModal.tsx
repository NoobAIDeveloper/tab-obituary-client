import type { VNode } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal(props: ConfirmModalProps): VNode {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    // happy-dom / older Chromium both implement showModal/close; guard so a
    // missing polyfill doesn't take the whole page down during tests.
    if (props.open) {
      if (typeof dlg.showModal === 'function' && !dlg.open) {
        try {
          dlg.showModal();
        } catch {
          // already open or unsupported; fall through
        }
      }
    } else if (typeof dlg.close === 'function' && dlg.open) {
      dlg.close();
    }
  }, [props.open]);

  return (
    <dialog ref={ref} class="confirm-dialog" onCancel={props.onCancel}>
      <h2>{props.title}</h2>
      <p>{props.body}</p>
      <div class="confirm-dialog-actions">
        <button type="button" class="btn btn-ghost" onClick={props.onCancel}>
          {props.cancelLabel}
        </button>
        <button type="button" class="btn btn-destructive" onClick={props.onConfirm}>
          {props.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
