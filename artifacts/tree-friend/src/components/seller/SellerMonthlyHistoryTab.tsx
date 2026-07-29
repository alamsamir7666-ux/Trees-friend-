import { Calendar } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetSellerMonthlyHistory } from "@workspace/api-client-react";

/**
 * Seller "Monthly History" tab. Mirrors admin's MonthlyHistoryTab.tsx table
 * layout, but the data source is different by necessity: admin reads a
 * once-a-month archived snapshot (monthlyRecordsTable), while this reads
 * GET /api/seller/monthly-history, which computes the seller's own
 * per-month order count + delivered revenue live from ordersTable (see
 * routes/sellerMonthlyHistory.ts for why -- no per-seller archive table
 * exists). No "Archive Now" button here for the same reason: there's
 * nothing to archive, the numbers are always current.
 */

const monthNames = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function SellerMonthlyHistoryTab() {
  const { data, isLoading } = useGetSellerMonthlyHistory({});
  const records = data?.records ?? [];

  return (
    <div>
      <div className="mb-4">
        <p className="text-sm text-gray-500">
          Your monthly order count and delivered revenue, computed live from your own orders.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : records.length === 0 ? (
        <div className="bg-white rounded-2xl border p-14 text-center">
          <Calendar className="h-12 w-12 text-gray-200 mx-auto mb-4" />
          <p className="font-semibold text-gray-500 mb-1">No order history yet</p>
          <p className="text-sm text-gray-400">Once you have orders, your monthly totals will show up here.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Month</th>
                  <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Total Orders</th>
                  <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Revenue (Delivered)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {records.map((r) => (
                  <tr key={r.id} className="hover:bg-pink-50/30 transition-colors">
                    <td className="px-5 py-4">
                      <p className="font-semibold text-gray-800">{monthNames[r.month]} {r.year}</p>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="font-semibold text-gray-700">{r.totalOrders}</span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="font-semibold text-emerald-600">Tk{Number(r.totalRevenue).toLocaleString()}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
