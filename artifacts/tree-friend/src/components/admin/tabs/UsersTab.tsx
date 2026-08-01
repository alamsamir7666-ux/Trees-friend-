import { useAdminContext } from "@/contexts/AdminContext";
import { Input } from "@/components/ui/input";
import { Search, UserCheck, Ban } from "lucide-react";

export function UsersTab() {
const {
    users,
    usersLoading,
    userSearch,
    setUserSearch,
    setActiveTab,
    setOrderSearch,
    handleToggleBlock,
    debouncedUserSearch,
  } = useAdminContext();

  const filteredUsers = (users ?? []).filter((u: any) =>
    !debouncedUserSearch ||
    `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase().includes(debouncedUserSearch.toLowerCase()) ||
    (u.email ?? "").toLowerCase().includes(debouncedUserSearch.toLowerCase())
  );
  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
          <Input
            placeholder="Search by name or email..."
            value={userSearch}
            onChange={e => setUserSearch(e.target.value)}
            className="pl-9 rounded-xl"
          />
        </div>
        <p className="text-xs text-muted-foreground/70 shrink-0">{filteredUsers.length} customers</p>
      </div>
      <div className="bg-card rounded-2xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">User</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Email</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Role</th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">Orders</th>
                <th className="px-5 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Joined</th>
                <th className="px-5 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-muted/50">
              {filteredUsers.map((u: any) => (
                <tr key={u.id} className={`hover:bg-primary/5 transition-colors ${u.isBlocked ? "opacity-60" : ""}`}>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${u.isBlocked ? "bg-destructive/10" : "bg-gradient-to-br from-primary/30 to-primary/50"}`}>
                        <span className={`text-xs font-bold ${u.isBlocked ? "text-destructive" : "text-primary-foreground"}`}>
                          {u.firstName?.[0] ?? ""}{u.lastName?.[0] ?? ""}{!u.firstName && !u.lastName ? "📱" : ""}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium text-foreground">
                          {u.firstName || u.lastName ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : "Unknown User"}
                        </p>
                        {u.isBlocked && <span className="text-xs text-destructive font-medium">Blocked</span>}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-muted-foreground text-xs">
                    {u.email?.endsWith("@clerk.user") ? "-" : u.email}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${u.role === "admin" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <button
                      onClick={() => {
                        const term = (u.email && !u.email.endsWith("@clerk.user"))
                          ? u.email
                          : `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
                        setUserSearch(""); setActiveTab("orders"); setTimeout(() => setOrderSearch(term), 50);
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-info/10 text-info-foreground text-xs font-semibold hover:bg-info/20 transition-colors"
                    >
                      {u.orderCount ?? 0} orders
                    </button>
                  </td>
                  <td className="px-5 py-3.5 text-right text-xs text-muted-foreground/70">{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td className="px-5 py-3.5 text-right">
                    {u.role !== "admin" && (
                      <button
                        onClick={() => handleToggleBlock(u.id, !u.isBlocked)}
                        className={`p-1.5 rounded-lg transition-colors ${
                          u.isBlocked
                            ? "text-muted-foreground/70 hover:text-success-foreground hover:bg-success/10"
                            : "text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10"
                        }`
                        }
                        title={u.isBlocked ? "Unblock user" : "Block user"}
                      >
                        {u.isBlocked ? <UserCheck className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr><td colSpan={6} className="text-center text-muted-foreground/70 py-12">No users found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
