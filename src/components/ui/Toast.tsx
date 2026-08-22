import { createContext, useCallback, useContext, useEffect, useState, useRef, type ReactNode } from 'react';

type ToastVariant = 'info' | 'warning' | 'error' | 'success';

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  showToast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue>({
  showToast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

// Module-level export so non-React code can trigger toasts
let globalShowToast: (message: string, variant?: ToastVariant) => void = () => {};

export function showToastGlobal(message: string, variant?: ToastVariant) {
  globalShowToast(message, variant);
}

const VARIANT_STYLES: Record<ToastVariant, string> = {
  info: 'bg-blue-600',
  warning: 'bg-yellow-600',
  error: 'bg-red-600',
  success: 'bg-green-600',
};

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 3000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const showToast = useCallback((message: string, variant: ToastVariant = 'info') => {
    const id = nextId.current++;
    setToasts(prev => {
      const next = [...prev, { id, message, variant }];
      return next.slice(-MAX_TOASTS);
    });
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, AUTO_DISMISS_MS);
  }, []);

  // Register the global handle. In an effect, not during render: callers are
  // non-React code that only runs post-mount anyway.
  useEffect(() => {
    globalShowToast = showToast;
  }, [showToast]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Toast container */}
      {toasts.length > 0 && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-2 pointer-events-none max-w-sm w-full px-4">
          {toasts.map(t => (
            <div
              key={t.id}
              className={`${VARIANT_STYLES[t.variant]} text-white px-4 py-2 rounded-lg shadow-lg text-sm animate-fade-in pointer-events-auto`}
            >
              {t.message}
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
