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
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Search by name or email..."
            value={userSearch}
            onChange={e => setUserSearch(e.target.value)}
            className="pl-9 rounded-xl"
          />
        </div>
        <p className="text-xs text-gray-400 shrink-0">{filteredUsers.length} customers</p>
      </div>
      <div className="bg-white rounded-2xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">User</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Role</th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Orders</th>
                <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Joined</th>
                <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filteredUsers.map((u: any) => (
                <tr key={u.id} className={`hover:bg-pink-50/30 transition-colors ${u.isBlocked ? "opacity-60" : ""}`}>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${u.isBlocked ? "bg-red-100" : "bg-gradient-to-br from-pink-200 to-rose-300"}`}>
                        <span className={`text-xs font-bold ${u.isBlocked ? "text-red-500" : "text-rose-700"}`}>
                          {u.firstName?.[0] ?? ""}{u.lastName?.[0] ?? ""}{!u.firstName && !u.lastName ? "📱" : ""}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium text-gray-800">
                          {u.firstName || u.lastName ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : "Unknown User"}
                        </p>
                        {u.isBlocked && <span className="text-xs text-red-500 font-medium">Blocked</span>}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-gray-500 text-xs">
                    {u.email?.endsWith("@clerk.user") ? "-" : u.email}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${u.role === "admin" ? "bg-pink-100 text-pink-600" : "bg-gray-100 text-gray-500"}`}>
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
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-50 text-blue-600 text-xs font-semibold hover:bg-blue-100 transition-colors"
                    >
                      {u.orderCount ?? 0} orders
                    </button>
                  </td>
                  <td className="px-5 py-3.5 text-right text-xs text-gray-400">{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td className="px-5 py-3.5 text-right">
                    {u.role !== "admin" && (
                      <button
                        onClick={() => handleToggleBlock(u.id, !u.isBlocked)}
                        className={`p-1.5 rounded-lg transition-colors ${
                          u.isBlocked
                            ? "text-gray-400 hover:text-green-500 hover:bg-green-50"
                            : "text-gray-400 hover:text-red-500 hover:bg-red-50"
                        }`}
                        title={u.isBlocked ? "Unblock user" : "Block user"}
                      >
                        {u.isBlocked ? <UserCheck className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr><td colSpan={6} className="text-center text-gray-400 py-12">No users found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
