import { useState } from "react";

export function SettingsTab() {
  const [shipmentDate, setShipmentDate] = useState(() => localStorage.getItem("nextShipmentDate") ?? "");
  const [shipmentSaved, setShipmentSaved] = useState(false);

  function saveShipmentDate() {
    localStorage.setItem("nextShipmentDate", shipmentDate);
    setShipmentSaved(true);
    setTimeout(() => setShipmentSaved(false), 2000);
  }

  return (
    <div className="max-w-2xl space-y-5">
      {[
        { label: "Store Name", value: "Tree Friend", desc: "Shown in the header and emails" },
        { label: "Support Email", value: "hello@treefriend.com", desc: "Customers will see this address" },
        { label: "Currency", value: "BDT (Tk)", desc: "Bangladeshi Taka" },
        { label: "Payment Methods", value: "bKash, Cash on Delivery", desc: "Enabled at checkout" },
      ].map(({ label, value, desc }) => (
        <div key={label} className="bg-white border rounded-2xl p-5 flex items-start justify-between gap-4">
          <div>
            <p className="font-medium text-gray-800">{label}</p>
            <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-sm font-semibold text-gray-700">{value}</p>
          </div>
        </div>
      ))}

      {/* Next Shipment Date */}
      <div className="bg-white border rounded-2xl p-5">
        <p className="font-medium text-gray-800 mb-1">Next Shipment Date</p>
        <p className="text-xs text-gray-400 mb-3">Set when the next batch arrives from Japan. This controls the estimated delivery date shown to pre-order customers.</p>
        <div className="flex gap-3">
          <input
            type="date"
            value={shipmentDate}
            onChange={e => setShipmentDate(e.target.value)}
            className="flex-1 rounded-xl border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            onClick={saveShipmentDate}
            className="px-4 py-2 rounded-xl text-sm font-semibold bg-primary text-primary-foreground"
          >
            {shipmentSaved ? "Saved ✓" : "Save"}
          </button>
        </div>
        {shipmentDate && (
          <p className="text-xs text-green-600 mt-2">
            Current: {new Date(shipmentDate).toLocaleDateString("en-BD", { day: "numeric", month: "long", year: "numeric" })}
          </p>
        )}
      </div>

      {/* Marketplace-aware note — the "demo mode" warning was misleading
          post-Phase-2: most of these are real backend settings (Admin →
          Sellers → payment configs, .env for Clerk/Cloudinary/Resend,
          per-category metadata on Categories tab). Only the Next Shipment
          Date control below is genuinely frontend-only because the
          pre-order shipment-date feature has no backend field yet. */}
      <div className="bg-sky-50 border border-sky-200 rounded-2xl p-4 text-sm text-sky-800 space-y-1">
        <p className="font-medium">Where to change each setting</p>
        <ul className="text-xs space-y-1 list-disc pl-5 text-sky-700/90">
          <li><strong>Store name / support email / payment methods</strong> — backend env vars on Render.</li>
          <li><strong>Seller payment configs (bKash credentials)</strong> — <em>Sellers</em> tab → expand seller → payment settings.</li>
          <li><strong>Categories &amp; their icons</strong> — <em>Categories</em> tab.</li>
          <li><strong>Homepage sections (Trending / New Arrivals tabs)</strong> — <em>Homepage Sections</em> tab.</li>
        </ul>
      </div>
    </div>
  );
}
