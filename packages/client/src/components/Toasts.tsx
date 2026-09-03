import { useStore } from '../store.js';

/**
 * Short messages, mostly refusals. A denied action needs a reason -- losing a
 * race for a card should look like losing a race, not like a bug.
 */
export function Toasts(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`}>
          {toast.text}
        </div>
      ))}
    </div>
  );
}
