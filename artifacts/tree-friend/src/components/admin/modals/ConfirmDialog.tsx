import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

export function ConfirmDialog({ open, title, message, onConfirm, onCancel, danger = true }: {
  open: boolean; title: string; message: string;
  onConfirm: () => void; onCancel: () => void; danger?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-card rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 ${danger ? "bg-destructive/10" : "bg-warning"}`}>
          <AlertCircle className={`h-6 w-6 ${danger ? "text-destructive" : "text-warning-foreground"}`} />
        </div>
        <h3 className="text-lg font-semibold text-center text-foreground mb-2">{title}</h3>
        <p className="text-sm text-center text-muted-foreground mb-6">{message}</p>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 px-4 py-2.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors">Cancel</button>
          <button onClick={onConfirm} className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-destructive-foreground transition-colors ${danger ? "bg-destructive hover:bg-destructive/90" : "bg-warning hover:bg-warning/90 text-warning-foreground"}`}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
