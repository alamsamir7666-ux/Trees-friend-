/**
 * CancelOrderModal — modal for cancelling an order with a reason.
 *
 * EXTRACTED from AdminPage.tsx to reduce the god-component's render surface.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface CancelOrderModalProps {
  open: boolean;
  reason: string;
  onReasonChange: (reason: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}

export function CancelOrderModal({
  open,
  reason,
  onReasonChange,
  onClose,
  onConfirm,
  isPending,
}: CancelOrderModalProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Cancel Order</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">Provide a reason for cancellation (optional). This will be visible to the customer.</p>
          <Textarea
            placeholder="e.g. Item out of stock, customer requested cancellation?"
            className="rounded-xl resize-none text-sm"
            rows={3}
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
          />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="rounded-xl" onClick={onClose}>
            Keep Order
          </Button>
          <Button
            className="rounded-xl bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            disabled={isPending}
            onClick={onConfirm}
          >
            Confirm Cancellation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
