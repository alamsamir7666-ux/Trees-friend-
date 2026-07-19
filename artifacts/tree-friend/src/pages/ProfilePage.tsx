import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useUser, UserProfile, useAuth } from "@clerk/react";
import { LoyaltyBanner } from "@/components/ui/LoyaltyBanner";
import { ReferralSection } from "@/components/ui/ReferralSection";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Star, Users, Package2, ArrowRight, Sprout } from "lucide-react";
import { useGetMe, useListOrders, useGetMySeller, getGetMySellerQueryKey } from "@workspace/api-client-react";
import { useState, useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  confirmed: "bg-blue-100 text-blue-800",
  processing: "bg-purple-100 text-purple-800",
  shipped: "bg-indigo-100 text-indigo-800",
  delivered: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
};

export function ProfilePage() {
  const { user } = useUser();
  const { data: dbUser } = useGetMe({ query: { retry: false, queryKey: ["me"] } });
  const { data: orders, isLoading: ordersLoading } = useListOrders();
  const { data: seller } = useGetMySeller({ query: { retry: false, queryKey: getGetMySellerQueryKey() } });

  const { getToken } = useAuth();
  const [preOrders, setPreOrders] = useState<any[]>([]);
  useEffect(() => {
    getToken().then(token => {
      if (!token) return;
      fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/pre-orders/my`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.json()).then(d => { if (Array.isArray(d)) setPreOrders(d); }).catch(() => {});
    });
  }, []);

  const allRecent = [
    ...(orders ?? []).map((o: any) => ({ ...o, _type: "order" })),
    ...preOrders.map((o: any) => ({ ...o, _type: "preorder" }))
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 3);
  const recentOrders = (orders ?? []).slice(0, 3);
  const isAdmin = dbUser?.role === "admin";
  const [profileTab, setProfileTab] = useState("overview");

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb crumbs={[{ label: "My Profile", icon: <Star className="h-3 w-3" /> }]} className="mb-3" />
          <div className="flex items-center gap-4">
            {user?.imageUrl && (
              <img src={user.imageUrl} alt="Profile" className="h-14 w-14 rounded-full object-cover border" />
            )}
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-serif text-3xl font-medium">{user?.fullName ?? "Your Profile"}</h1>
                {isAdmin && (
                  <Link href="/admin">
                    <Badge className="bg-accent text-accent-foreground cursor-pointer hover:opacity-80 transition-opacity">
                      Admin
                    </Badge>
                  </Link>
                )}
                {seller?.status === "active" && (
                  <Link href="/seller/dashboard">
                    <Badge className="bg-emerald-100 text-emerald-700 cursor-pointer hover:opacity-80 transition-opacity gap-1">
                      <Sprout className="h-3 w-3" /> Seller
                    </Badge>
                  </Link>
                )}
                {seller?.status === "pending_verification" && (
                  <Link href="/become-seller">
                    <Badge className="bg-amber-100 text-amber-700 cursor-pointer hover:opacity-80 transition-opacity gap-1">
                      <Sprout className="h-3 w-3" /> Seller: Pending Review
                    </Badge>
                  </Link>
                )}
              </div>
              <p className="text-muted-foreground text-sm mt-0.5">{user?.primaryEmailAddress?.emailAddress}</p>
              {!seller && (
                <Link href="/become-seller">
                  <span className="inline-flex items-center gap-1 text-xs text-accent hover:underline mt-1.5 cursor-pointer">
                    <Sprout className="h-3 w-3" /> Become a Seller
                  </span>
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Loyalty points banner */}
        <div className="mb-6">
          <LoyaltyBanner />
        </div>

        {/* Profile tabs */}
        <Tabs value={profileTab} onValueChange={setProfileTab} className="mb-6">
          <TabsList className="rounded-full">
            <TabsTrigger value="overview" className="rounded-full text-xs gap-1.5">
              <Package2 className="h-3.5 w-3.5" />Overview
            </TabsTrigger>
            <TabsTrigger value="rewards" className="rounded-full text-xs gap-1.5">
              <Star className="h-3.5 w-3.5" />Rewards & Referral
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {profileTab === "rewards" && (
          <div className="mb-8">
            <ReferralSection />
          </div>
        )}

        {profileTab === "overview" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Recent orders */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-medium">Recent Orders</h2>
              <Link href="/orders">
                <span className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                  View all <ArrowRight className="h-3 w-3" />
                </span>
              </Link>
            </div>
            {ordersLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
              </div>
            ) : recentOrders.length === 0 ? (
              <div className="bg-card border rounded-xl p-8 text-center">
                <Package2 className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No orders yet</p>
              </div>
            ) : (
              <div className="space-y-3">
                {allRecent.map((order: any) => {
                  const isPreOrder = order._type === "preorder";
                  const href = isPreOrder ? `/pre-orders/${order.trackingId}` : `/orders/${order.id}?rank=${(orders ?? []).length - (orders ?? []).findIndex((o: any) => o.id === order.id)}`;
                  const label = isPreOrder ? `Pre-Order` : `Order #${(orders ?? []).length - (orders ?? []).findIndex((o: any) => o.id === order.id)}`;
                  const status = isPreOrder ? order.status : order.orderStatus;
                  const total = isPreOrder ? (Number(order.discountedPrice) * Number(order.quantity) + Number(order.deliveryCharge)) : order.totalAmount;
                  return (
                  <Link key={isPreOrder ? `pre-${order.id}` : order.id} href={href}>
                    <div className="bg-card border rounded-xl p-4 hover:shadow-sm transition-shadow cursor-pointer">
                      <div className="flex items-center justify-between">
                        <div>
                          {isPreOrder && <span className="text-xs font-bold bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 mr-1">PRE-ORDER</span>}
                          <p className="text-sm font-medium">{label}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{new Date(order.createdAt).toLocaleDateString()}</p>
                        </div>
                        <div className="text-right">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[status] ?? "bg-muted"}`}>{status}</span>
                          <p className="text-sm font-medium mt-1">Tk{Number(total).toLocaleString()}</p>
                        </div>
                      </div>
                    </div>
                  </Link>
                );})}
              </div>
            )}
          </div>

          {/* Account settings */}
          <div>
            <h2 className="font-medium mb-4">Account Settings</h2>
            <div className="bg-card border rounded-xl overflow-hidden">
              <UserProfile
                appearance={{
                  elements: {
                    card: "shadow-none border-0 p-0 rounded-none",
                    rootBox: "w-full",
                    pageScrollBox: "p-4",
                    navbar: "hidden",
                    navbarMobileMenuButton: "hidden",
                  },
                }}
              />
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
