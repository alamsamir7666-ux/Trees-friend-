import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { useUser, UserProfile, useAuth } from "@clerk/react";
import { LoyaltyBanner } from "@/components/ui/LoyaltyBanner";
import { ReferralSection } from "@/components/ui/ReferralSection";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Star, Users, Package2, ArrowRight, Sprout, ShieldCheck, ChevronRight,
  MapPin, Mail, Phone, Calendar, Edit3, Settings, LogOut, CreditCard,
  Truck, Heart, Gift, Store, BadgeCheck, Clock, CheckCircle2, XCircle,
  MoreHorizontal, Plus, ExternalLink, ShoppingBag,
} from "lucide-react";
import { StoreIcon } from "@/components/ui/StoreIcon";
import { BecomeSellerContent } from "@/pages/BecomeSellerPage";
import {
  useGetMe, useListOrders, useGetMySeller, getGetMySellerQueryKey,
  useListMyFollowedSellers, getListMyFollowedSellersQueryKey,
} from "@workspace/api-client-react";
import { useState, useEffect, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Link, useLocation } from "wouter";

const statusColors: Record<string, { bg: string; text: string; icon: React.ElementType }> = {
  pending:    { bg: "bg-amber-50", text: "text-amber-700", icon: Clock },
  confirmed:  { bg: "bg-blue-50", text: "text-blue-700", icon: CheckCircle2 },
  processing: { bg: "bg-violet-50", text: "text-violet-700", icon: Package2 },
  shipped:    { bg: "bg-indigo-50", text: "text-indigo-700", icon: Truck },
  delivered:  { bg: "bg-emerald-50", text: "text-emerald-700", icon: CheckCircle2 },
  cancelled:  { bg: "bg-red-50", text: "text-red-700", icon: XCircle },
};

export function ProfilePage() {
  const { user } = useUser();
  const [, navigate] = useLocation();
  const { data: dbUser } = useGetMe({ query: { retry: false, queryKey: ["me"] } });
  const { data: orders, isLoading: ordersLoading } = useListOrders();
  const { data: seller } = useGetMySeller({ query: { retry: false, queryKey: getGetMySellerQueryKey() } });
  const { data: followedSellers, isLoading: followedSellersLoading } = useListMyFollowedSellers({
    query: { queryKey: getListMyFollowedSellersQueryKey() },
  });

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
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5);
  const recentOrders = (orders ?? []).slice(0, 5);
  const isAdmin = dbUser?.role === "admin";
  const [profileTab, setProfileTab] = useState("overview");
  const tabsListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tabsListRef.current?.scrollTo({ left: 0 });
  }, []);

  // Quick action links for the overview
  const quickActions = [
    { label: "My Orders", icon: ShoppingBag, href: "/orders", count: orders?.length ?? 0 },
    { label: "Wishlist", icon: Heart, href: "/wishlist", count: undefined },
    { label: "Addresses", icon: MapPin, href: "/addresses", count: undefined },
    { label: "Loyalty", icon: Gift, href: "/loyalty", count: undefined },
  ];

  return (
    <div className="min-h-screen bg-[#F9F9F7]">
      {/* ── Profile Hero ──────────────────────────────────────────────────── */}
      <div className="bg-white border-b">
        <div className="container mx-auto px-4 pt-6 pb-8 max-w-4xl">
          <PageBreadcrumb crumbs={[{ label: "My Profile", icon: <Star className="h-3 w-3" /> }]} className="mb-5" />

          <div className="flex items-start gap-5">
            {/* Avatar */}
            <div className="relative shrink-0">
              {user?.imageUrl ? (
                <img src={user.imageUrl} alt="Profile" className="h-20 w-20 rounded-full object-cover border-2 border-white shadow-md" />
              ) : (
                <div className="h-20 w-20 rounded-full bg-gradient-to-br from-pink-400 to-rose-500 flex items-center justify-center shadow-md">
                  <span className="text-white text-2xl font-bold">{user?.firstName?.[0] ?? "U"}</span>
                </div>
              )}
              <Link href="/profile#settings" className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full bg-white border shadow-sm flex items-center justify-center hover:bg-gray-50 transition-colors">
                <Edit3 className="h-3.5 w-3.5 text-gray-500" />
              </Link>
            </div>

            {/* Name & details */}
            <div className="flex-1 min-w-0 pt-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="font-serif text-2xl sm:text-3xl font-medium text-gray-900">{user?.fullName ?? "Your Profile"}</h1>
                {isAdmin && (
                  <Link href="/admin">
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 hover:bg-amber-200 transition-colors cursor-pointer">
                      <ShieldCheck className="h-3 w-3" /> Admin
                    </span>
                  </Link>
                )}
                {seller?.status === "active" && (
                  <Link href="/seller/dashboard">
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors cursor-pointer">
                      <Sprout className="h-3 w-3" /> Seller
                    </span>
                  </Link>
                )}
                {seller?.status === "pending_verification" && (
                  <Link href="/become-seller">
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors cursor-pointer">
                      <Clock className="h-3 w-3" /> Seller: Pending
                    </span>
                  </Link>
                )}
                {(seller as any)?.isVerified && seller?.status === "active" && (
                  <Link href="/seller/dashboard">
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors cursor-pointer">
                      <BadgeCheck className="h-3 w-3" /> Verified Seller
                    </span>
                  </Link>
                )}
              </div>
              <p className="text-sm text-gray-500 mt-1">{user?.primaryEmailAddress?.emailAddress}</p>
              {!seller && (
                <Link href="/become-seller">
                  <span className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline mt-2 cursor-pointer font-medium">
                    <Sprout className="h-3 w-3" /> Become a Seller
                  </span>
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-6 max-w-4xl">
        {/* ── Profile Tabs ────────────────────────────────────────────────── */}
        <Tabs value={profileTab} onValueChange={setProfileTab} className="mb-6">
          <TabsList
            ref={tabsListRef}
            className="rounded-full h-auto p-1 flex w-full overflow-x-auto scrollbar-hide md:inline-flex md:w-auto gap-1 bg-white border"
          >
            <TabsTrigger value="overview" className="rounded-full text-xs gap-1.5 shrink-0 data-[state=active]:bg-gray-900 data-[state=active]:text-white">
              <Package2 className="h-3.5 w-3.5 shrink-0" />Overview
            </TabsTrigger>
            <TabsTrigger
              value="seller"
              className="rounded-full text-xs gap-1.5 shrink-0 data-[state=active]:bg-gray-900 data-[state=active]:text-white"
              onClick={(e) => {
                if (seller?.status === "active") {
                  e.preventDefault();
                  navigate("/seller/dashboard");
                }
              }}
            >
              <StoreIcon className="h-3.5 w-3.5 shrink-0" />
              {seller?.status === "active" ? "Seller Dashboard" : "Become a Seller"}
            </TabsTrigger>
            <TabsTrigger value="rewards" className="rounded-full text-xs gap-1.5 shrink-0 data-[state=active]:bg-gray-900 data-[state=active]:text-white">
              <Star className="h-3.5 w-3.5 shrink-0" />Rewards & Referral
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {profileTab === "seller" && seller?.status !== "active" && (
          <div className="mb-8">
            <BecomeSellerContent />
          </div>
        )}

        {profileTab === "rewards" && (
          <div className="mb-8">
            <ReferralSection />
          </div>
        )}

        {profileTab === "overview" && (
        <div className="space-y-6">

          {/* ── Loyalty Banner ──────────────────────────────────────────── */}
          <LoyaltyBanner />

          {/* ── Quick Actions ───────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {quickActions.map(({ label, icon: Icon, href, count }) => (
              <Link key={label} href={href}>
                <div className="bg-white rounded-2xl border border-gray-100 p-4 hover:shadow-md transition-all duration-200 cursor-pointer group text-center">
                  <div className="h-10 w-10 rounded-xl bg-gray-50 group-hover:bg-accent/10 flex items-center justify-center mx-auto mb-2 transition-colors">
                    <Icon className="h-5 w-5 text-gray-500 group-hover:text-accent transition-colors" />
                  </div>
                  <p className="text-sm font-medium text-gray-800">{label}</p>
                  {count !== undefined && count > 0 && (
                    <p className="text-xs text-gray-400 mt-0.5">{count} order{count !== 1 ? "s" : ""}</p>
                  )}
                </div>
              </Link>
            ))}
          </div>

          {/* ── Following ───────────────────────────────────────────────── */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-gray-800 text-sm">Following</h2>
                {!followedSellersLoading && (followedSellers?.length ?? 0) > 0 && (
                  <p className="text-xs text-gray-400 mt-0.5">{followedSellers!.length} {followedSellers!.length === 1 ? "store" : "stores"}</p>
                )}
              </div>
              {(followedSellers?.length ?? 0) > 0 && (
                <span className="text-xs text-gray-400">Tap to visit</span>
              )}
            </div>
            {followedSellersLoading ? (
              <div className="flex gap-3 overflow-x-auto pb-1">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-28 w-36 rounded-xl shrink-0" />
                ))}
              </div>
            ) : (followedSellers?.length ?? 0) === 0 ? (
              <div className="py-8 text-center">
                <Users className="h-8 w-8 text-gray-200 mx-auto mb-2" />
                <p className="text-sm text-gray-400">You're not following any stores yet.</p>
                <p className="text-xs text-gray-300 mt-1">Visit a seller's store page and tap Follow to see them here.</p>
              </div>
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
                {followedSellers!.map((s) => (
                  <Link key={s.id} href={`/store/${s.id}`} className="shrink-0 w-44">
                    <div className="bg-gray-50 rounded-xl p-3.5 h-full hover:bg-gray-100 transition-colors border border-gray-100">
                      <div className="flex items-center gap-2.5 mb-2">
                        <div className="w-10 h-10 rounded-full overflow-hidden border bg-white shrink-0">
                          {s.logoUrl ? (
                            <img src={s.logoUrl} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-xs font-semibold text-gray-400">
                              {s.nurseryName.slice(0, 1).toUpperCase()}
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1">
                            <p className="text-sm font-semibold text-gray-800 truncate">{s.nurseryName}</p>
                            {s.isVerified && <ShieldCheck className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
                          </div>
                          {s.location && (
                            <p className="text-xs text-gray-400 truncate mt-0.5 flex items-center gap-1">
                              <MapPin className="h-2.5 w-2.5 shrink-0" />{s.location}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* ── Recent Orders ───────────────────────────────────────────── */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-gray-800 text-sm">Recent Orders</h2>
                <p className="text-xs text-gray-400 mt-0.5">{orders?.length ?? 0} total orders</p>
              </div>
              <Link href="/orders">
                <span className="text-xs text-accent hover:underline flex items-center gap-1 font-medium">
                  View all <ArrowRight className="h-3 w-3" />
                </span>
              </Link>
            </div>
            {ordersLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
              </div>
            ) : allRecent.length === 0 ? (
              <div className="py-10 text-center">
                <Package2 className="h-10 w-10 text-gray-200 mx-auto mb-3" />
                <p className="text-sm text-gray-400 font-medium">No orders yet</p>
                <p className="text-xs text-gray-300 mt-1">Your orders will appear here once you make a purchase.</p>
                <Link href="/products">
                  <span className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline mt-3 font-medium">
                    <ShoppingBag className="h-3 w-3" /> Start Shopping
                  </span>
                </Link>
              </div>
            ) : (
              <div className="space-y-2.5">
                {allRecent.map((order: any) => {
                  const isPreOrder = order._type === "preorder";
                  const href = isPreOrder ? `/pre-orders/${order.trackingId}` : `/orders/${order.id}?rank=${(orders ?? []).length - (orders ?? []).findIndex((o: any) => o.id === order.id)}`;
                  const label = isPreOrder ? `Pre-Order` : `Order #${(orders ?? []).length - (orders ?? []).findIndex((o: any) => o.id === order.id)}`;
                  const status = isPreOrder ? order.status : order.orderStatus;
                  const total = isPreOrder ? (Number(order.discountedPrice) * Number(order.quantity) + Number(order.deliveryCharge)) : order.totalAmount;
                  const statusCfg = statusColors[status] ?? { bg: "bg-gray-50", text: "text-gray-600", icon: Package2 };
                  const StatusIcon = statusCfg.icon;
                  return (
                  <Link key={isPreOrder ? `pre-${order.id}` : order.id} href={href}>
                    <div className="flex items-center gap-4 px-4 py-3.5 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors cursor-pointer group border border-gray-100">
                      <div className={`h-10 w-10 rounded-xl ${statusCfg.bg} flex items-center justify-center shrink-0`}>
                        <StatusIcon className={`h-4.5 w-4.5 ${statusCfg.text}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {isPreOrder && (
                            <span className="text-[10px] font-bold bg-blue-100 text-blue-700 rounded-full px-1.5 py-0.5">PRE-ORDER</span>
                          )}
                          <p className="text-sm font-medium text-gray-800">{label}</p>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">{new Date(order.createdAt).toLocaleDateString()}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold text-gray-800">Tk{Number(total).toLocaleString()}</p>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${statusCfg.bg} ${statusCfg.text} capitalize`}>
                          {status}
                        </span>
                      </div>
                      <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-gray-500 transition-colors shrink-0" />
                    </div>
                  </Link>
                );})}
              </div>
            )}
          </div>

          {/* ── Account Settings ────────────────────────────────────────── */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden" id="settings">
            <div className="px-5 py-4 border-b border-gray-50">
              <h2 className="font-semibold text-gray-800 text-sm">Account Settings</h2>
              <p className="text-xs text-gray-400 mt-0.5">Manage your profile, email, and connected accounts</p>
            </div>

            {/* Profile details row */}
            <div className="px-5 py-4 border-b border-gray-50 flex items-center gap-4">
              <div className="shrink-0">
                {user?.imageUrl ? (
                  <img src={user.imageUrl} alt="" className="h-10 w-10 rounded-full object-cover border" />
                ) : (
                  <div className="h-10 w-10 rounded-full bg-gray-100 flex items-center justify-center">
                    <span className="text-sm font-semibold text-gray-400">{user?.firstName?.[0] ?? "U"}</span>
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-400 uppercase tracking-wider font-medium">Profile</p>
                <p className="text-sm font-medium text-gray-800 truncate">{user?.fullName ?? "Your Profile"}</p>
              </div>
              <Link href="/profile#settings">
                <span className="text-xs text-accent hover:underline font-medium cursor-pointer">Update profile</span>
              </Link>
            </div>

            {/* Email addresses */}
            <div className="px-5 py-4 border-b border-gray-50">
              <p className="text-xs text-gray-400 uppercase tracking-wider font-medium mb-3">Email addresses</p>
              {user?.emailAddresses.map((email) => (
                <div key={email.id} className="flex items-center gap-3 mb-2 last:mb-0">
                  <Mail className="h-4 w-4 text-gray-300 shrink-0" />
                  <span className="text-sm text-gray-700 flex-1 truncate">{email.emailAddress}</span>
                  {email.id === user.primaryEmailAddressId && (
                    <span className="text-[10px] font-medium bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Primary</span>
                  )}
                </div>
              ))}
            </div>

            {/* Connected accounts */}
            <div className="px-5 py-4 border-b border-gray-50">
              <p className="text-xs text-gray-400 uppercase tracking-wider font-medium mb-3">Connected accounts</p>
              {user?.externalAccounts && user.externalAccounts.length > 0 ? (
                user.externalAccounts.map((acc: any) => (
                  <div key={acc.id} className="flex items-center gap-3 mb-2 last:mb-0">
                    <div className="h-5 w-5 rounded flex items-center justify-center text-xs font-bold text-white bg-gray-800 shrink-0">
                      {(acc.provider ?? "G")[0].toUpperCase()}
                    </div>
                    <span className="text-sm text-gray-700 flex-1 truncate capitalize">{acc.provider} &middot; {acc.emailAddress ?? acc.username ?? "Connected"}</span>
                  </div>
                ))
              ) : (
                <p className="text-sm text-gray-400">No connected accounts</p>
              )}
            </div>

            {/* Clerk UserProfile embed */}
            <div>
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
