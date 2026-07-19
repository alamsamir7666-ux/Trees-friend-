import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

export function ConfirmDialog({ open, title, message, onConfirm, onCancel, danger = true }: {
  open: boolean; title: string; message: string;
  onConfirm: () => void; onCancel: () => void; danger?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 ${danger ? "bg-red-100" : "bg-amber-100"}`}>
          <AlertCircle className={`h-6 w-6 ${danger ? "text-red-600" : "text-amber-600"}`} />
        </div>
        <h3 className="text-lg font-semibold text-center text-gray-900 mb-2">{title}</h3>
        <p className="text-sm text-center text-muted-foreground mb-6">{message}</p>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
          <button onClick={onConfirm} className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-white transition-colors ${danger ? "bg-red-500 hover:bg-red-600" : "bg-amber-500 hover:bg-amber-600"}`}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
