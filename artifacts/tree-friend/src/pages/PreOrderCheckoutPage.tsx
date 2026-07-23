import { useState } from "react";
import { useSearch, useLocation } from "wouter";
import { useListAddresses, getListAddressesQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { BKASH_ICON } from "@/lib/preorderIcons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Tag, MapPin, ChevronDown, ShoppingBag, CreditCard, Truck } from "lucide-react";
import { Link } from "wouter";
import { useUser, useAuth } from "@clerk/react";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";

const API = import.meta.env.VITE_API_BASE_URL ?? "";
type PaymentMethod = "bkash";

export function PreOrderCheckoutPage() {
  const searchStr = useSearch();
  const [, setLocation] = useLocation();
  const params = new URLSearchParams(searchStr);
  const { user } = useUser();
  const { getToken } = useAuth();

  const productId = Number(params.get("productId") ?? "0");
  const sellerListingVariantId = Number(params.get("sellerListingVariantId") ?? "0");
  const quantity = Number(params.get("qty") ?? "1");
  const productName = decodeURIComponent(params.get("name") ?? "");
  const productImage = decodeURIComponent(params.get("image") ?? "");
  const originalPrice = Number(params.get("price") ?? "0");
  const discountedPrice = Math.round(originalPrice * 0.95 * 100) / 100;
  const savings = Math.round((originalPrice - discountedPrice) * 100) / 100;
  const shipmentDate = localStorage.getItem("nextShipmentDate") ?? "";

  const { data: savedAddresses = [] } = useListAddresses({ query: { retry: false, queryKey: getListAddressesQueryKey() } });

  const [address, setAddress] = useState({ fullName: user?.fullName ?? "", phone: "", street: "", city: "", district: "", postalCode: "" });
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(null);
  const [showAddressPicker, setShowAddressPicker] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("bkash");
  const [bkashNumber, setBkashNumber] = useState("");
  const [whatsappPhone, setWhatsappPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const city = address.city.toLowerCase();
  const isDhaka = ["dhaka", "????"].some(k => city.includes(k));
  const deliveryCharge = address.city ? (isDhaka ? 80 : 120) : 80;

  function getDaysUntilShipment() {
    if (!shipmentDate) return "20-23 days";
    const today = new Date();
    const shipment = new Date(shipmentDate);
    const diff = Math.ceil((shipment.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (diff <= 0) return "2-5 days";
    return `${diff + 2}-${diff + 5} days`;
  }

  function applyAddress(addr: any) {
    setAddress({ fullName: addr.fullName ?? "", phone: addr.phone ?? "", street: addr.street ?? "", city: addr.city ?? "", district: addr.district ?? "", postalCode: addr.postalCode ?? "" });
    setSelectedAddressId(addr.id);
    setShowAddressPicker(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!sellerListingVariantId) {
      setError("Please select an option before pre-ordering."); return;
    }
    if (!address.fullName || !address.phone || !address.street || !address.city) {
      setError("Please fill in all required address fields."); return;
    }
    if (!bkashNumber.trim()) {
      setError("Please enter your bKash sending number."); return;
    }
    setLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(API + "/api/pre-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          productId, sellerListingVariantId, quantity,
          shippingAddress: { fullName: address.fullName, phone: address.phone, street: address.street, city: address.city, district: address.district, postalCode: address.postalCode || null },
          paymentMethod, senderNumber: bkashNumber,
          whatsappPhone: whatsappPhone || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to place pre-order"); return; }
      const _gk = "treefriend_guest_orders";
      const _ge = JSON.parse(localStorage.getItem(_gk) ?? "[]");
      localStorage.setItem(_gk, JSON.stringify([{ trackingId: data.trackingId, type: "preorder" }, ..._ge.filter((o: any) => (o.trackingId ?? o) !== data.trackingId)]));
      setLocation("/pre-orders/" + data.trackingId);
    } catch { setError("Something went wrong. Please try again."); }
    finally { setLoading(false); }
  }


  return (
    <div className="min-h-screen bg-background">
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb crumbs={[{ label: "Products", href: "/products", icon: <ShoppingBag className="h-3 w-3" /> }, { label: "Pre-Order", icon: <CreditCard className="h-3 w-3" /> }]} className="mb-3" />
          <h1 className="font-serif text-4xl font-medium">Pre-Order Checkout</h1>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        <form onSubmit={handleSubmit}>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
            <div className="lg:col-span-2 space-y-8">

              {/* Delivery Address */}
              <div className="bg-card border rounded-xl p-6">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="font-medium text-lg">Delivery Address</h2>
                  {(savedAddresses as any[]).length > 0 && (
                    <button type="button" onClick={() => setShowAddressPicker(!showAddressPicker)} className="flex items-center gap-1.5 text-sm text-accent hover:text-accent/80 font-medium transition-colors">
                      <MapPin className="h-4 w-4" /> Saved addresses
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAddressPicker ? "rotate-180" : ""}`} />
                    </button>
                  )}
                </div>
                {showAddressPicker && (savedAddresses as any[]).length > 0 && (
                  <div className="mb-5 space-y-2">
                    {(savedAddresses as any[]).map((addr: any) => (
                      <button key={addr.id} type="button" onClick={() => applyAddress(addr)}
                        className={`w-full text-left px-4 py-3 rounded-xl border transition-all text-sm ${selectedAddressId === addr.id ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30 hover:bg-muted/30"}`}>
                        <p className="font-medium">{addr.fullName}</p>
                        <p className="text-muted-foreground text-xs mt-0.5">{addr.street}, {addr.city}{addr.district ? `, ${addr.district}` : ""}{addr.phone ? ` ? ${addr.phone}` : ""}</p>
                      </button>
                    ))}
                    <p className="text-xs text-muted-foreground pl-1">Or enter a new address below</p>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="sm:col-span-2"><Label>Full Name *</Label><Input value={address.fullName} onChange={e => setAddress(a => ({ ...a, fullName: e.target.value }))} required className="mt-1.5" /></div>
                  <div><Label>Phone *</Label><Input value={address.phone} onChange={e => setAddress(a => ({ ...a, phone: e.target.value }))} required className="mt-1.5" placeholder="01XXXXXXXXX" /></div>
                  <div><Label>Postal Code</Label><Input value={address.postalCode} onChange={e => setAddress(a => ({ ...a, postalCode: e.target.value }))} className="mt-1.5" /></div>
                  <div className="sm:col-span-2"><Label>Street Address *</Label><Input value={address.street} onChange={e => setAddress(a => ({ ...a, street: e.target.value }))} required className="mt-1.5" placeholder="House, Road, Area" /></div>
                  <div><Label>City *</Label><Input value={address.city} onChange={e => setAddress(a => ({ ...a, city: e.target.value }))} required className="mt-1.5" /></div>
                  <div><Label>District</Label><Input value={address.district} onChange={e => setAddress(a => ({ ...a, district: e.target.value }))} className="mt-1.5" /></div>
                </div>
              </div>

              {/* WhatsApp notification */}
              <div className="bg-card border rounded-xl p-6">
                <h2 className="font-medium text-lg mb-3">WhatsApp Notification (Optional)</h2>
                <Input value={whatsappPhone} onChange={e => setWhatsappPhone(e.target.value)} placeholder="01XXXXXXXXX" className="mt-1.5" />
                <p className="text-xs text-muted-foreground mt-1.5">We will notify you on WhatsApp when your product arrives in Bangladesh</p>
              </div>

              {/* Payment */}
              <div className="bg-card border rounded-xl p-6">
                <h2 className="font-medium text-lg mb-5">Payment Method</h2>
                <p className="text-sm text-muted-foreground mb-4">Pay only the delivery charge now. Product price paid on delivery (COD).</p>
                <div className="bg-muted/30 rounded-lg p-4 space-y-3 text-sm">
                  <p className="font-medium flex items-center gap-2">
                    <img src={BKASH_ICON} className="h-6 w-6" /> bKash Payment Instructions
                  </p>
                  <p className="text-muted-foreground">
                    1. Send Tk{deliveryCharge} to our bKash number: <strong>01636575741</strong><br />
                    2. Use "Send Money" option<br />
                    3. Your pre-order will be confirmed automatically after payment
                  </p>
                  <div>
                    <Label>bKash Number *</Label>
                    <Input className="mt-1.5" value={bkashNumber} onChange={e => setBkashNumber(e.target.value)} placeholder="Your sending number" required />
                  </div>
                </div>
              </div>
            </div>

            {/* Order Summary */}
            <div>
              <div className="bg-card border rounded-xl p-6 sticky top-24 space-y-5">
                <h2 className="font-medium text-lg">Order Summary</h2>

                {/* Product */}
                <div className="flex gap-3">
                  {productImage && <img src={productImage} alt={productName} className="w-14 h-14 rounded-xl object-cover shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium line-clamp-2">{productName}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-sm font-semibold">Tk{discountedPrice.toLocaleString()}</span>
                      <span className="text-xs text-muted-foreground line-through">Tk{originalPrice.toLocaleString()}</span>
                      <Badge className="bg-green-100 text-green-700 border-green-200 text-xs">5% off</Badge>
                    </div>
                  </div>
                </div>

                {/* Delivery estimate */}
                <div className="flex items-center gap-2 text-sm bg-accent/10 rounded-lg px-3 py-2">
                  <Truck className="h-4 w-4 text-accent shrink-0" />
                  <span>Estimated delivery: <strong>{getDaysUntilShipment()}</strong></span>
                </div>

                <div className="border-t pt-4 space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Delivery charge</span><span>Tk{deliveryCharge}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Product price (Tk{discountedPrice.toLocaleString()})</span><span className="text-muted-foreground">COD</span></div>
                  <div className="flex justify-between font-semibold text-base pt-2 border-t"><span>Pay Now</span><span>Tk{deliveryCharge}</span></div>
                </div>

                {error && <p className="text-sm text-destructive text-center">{error}</p>}

                <Button type="submit" disabled={loading} className="w-full rounded-full" size="lg">
                  {loading ? "Placing Pre-Order..." : `Confirm Pre-Order - Pay Tk${deliveryCharge}`}
                </Button>

                <p className="text-xs text-center text-muted-foreground">You save Tk{savings.toLocaleString()} with 5% pre-order discount</p>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
