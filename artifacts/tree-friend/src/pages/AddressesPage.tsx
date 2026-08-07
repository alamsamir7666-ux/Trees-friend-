import { useState } from "react";
import { MapPin, Plus, Pencil, Trash2, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useListAddresses, useAddAddress, useUpdateAddress, useDeleteAddress, getListAddressesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { updateSEO } from "@/lib/seo";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";

updateSEO({ title: "My Addresses", noIndex: true });

const EMPTY = { fullName: "", phone: "", street: "", city: "", district: "", postalCode: "", isDefault: false };

export function AddressesPage() {
  const qc = useQueryClient();
  const { data: addresses = [], isLoading } = useListAddresses({ query: { queryKey: getListAddressesQueryKey() } });
  const createAddress = useAddAddress();
  const updateAddress = useUpdateAddress();
  const deleteAddress = useDeleteAddress();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(EMPTY);
  const [deleting, setDeleting] = useState<number | null>(null);

  function openAdd() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function openEdit(a: any) {
    setEditing(a);
    setForm({ fullName: a.fullName, phone: a.phone, street: a.street, city: a.city, district: a.district ?? "", postalCode: a.postalCode ?? "", isDefault: a.isDefault });
    setOpen(true);
  }

  function handleSave() {
    if (!form.fullName.trim() || !form.street.trim() || !form.city.trim()) return;
    const payload = { data: { ...form } };
    if (editing) {
      updateAddress.mutate({ id: editing.id, ...payload }, {
        onSuccess: () => { qc.invalidateQueries({ queryKey: getListAddressesQueryKey() }); setOpen(false); },
      });
    } else {
      createAddress.mutate(payload, {
        onSuccess: () => { qc.invalidateQueries({ queryKey: getListAddressesQueryKey() }); setOpen(false); },
      });
    }
  }

  function handleDelete(id: number) {
    setDeleting(id);
    deleteAddress.mutate({ id }, {
      onSuccess: () => { qc.invalidateQueries({ queryKey: getListAddressesQueryKey() }); setDeleting(null); },
      onError: () => setDeleting(null),
    });
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="container mx-auto px-4 py-10 max-w-2xl">
      <PageBreadcrumb crumbs={[{ label: "My Addresses", icon: <MapPin className="h-3 w-3" /> }]} className="mb-4" />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-serif text-2xl font-medium flex items-center gap-2">
            <MapPin className="h-6 w-6 text-accent" />
            My Addresses
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your saved delivery addresses</p>
        </div>
        <Button size="sm" className="rounded-full gap-1.5" onClick={openAdd}>
          <Plus className="h-4 w-4" /> Add New
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1,2].map(i => <div key={i} className="h-28 rounded-2xl bg-muted animate-pulse" />)}
        </div>
      ) : addresses.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <MapPin className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No saved addresses yet</p>
          <p className="text-sm mt-1">Add an address to speed up checkout</p>
          <Button className="mt-4 rounded-full" onClick={openAdd}>Add Address</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {addresses.map((a: any) => (
            <div key={a.id} className="bg-card border rounded-2xl p-5 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="h-8 w-8 rounded-full bg-accent/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <MapPin className="h-4 w-4 text-accent" />
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="font-medium text-sm">{a.fullName}</p>
                    {a.isDefault && <Badge variant="secondary" className="text-xs">Default</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">{a.phone}</p>
                  <p className="text-sm text-muted-foreground">{a.street}, {a.city}{a.district ? `, ${a.district}` : ""}{a.postalCode ? ` ${a.postalCode}` : ""}</p>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => openEdit(a)} aria-label="Edit address">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-destructive hover:text-destructive" onClick={() => handleDelete(a.id)} disabled={deleting === a.id} aria-label="Delete address">
                  {deleting === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Address" : "Add New Address"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label>Full Name *</Label>
                <Input className="mt-1" value={form.fullName} onChange={set("fullName")} placeholder="Your full name" />
              </div>
              <div className="col-span-2">
                <Label>Phone *</Label>
                <Input className="mt-1" value={form.phone} onChange={set("phone")} placeholder="01XXXXXXXXX" />
              </div>
              <div className="col-span-2">
                <Label>Street Address *</Label>
                <Input className="mt-1" value={form.street} onChange={set("street")} placeholder="House, Road, Area" />
              </div>
              <div>
                <Label>City *</Label>
                <Input className="mt-1" value={form.city} onChange={set("city")} />
              </div>
              <div>
                <Label>District</Label>
                <Input className="mt-1" value={form.district} onChange={set("district")} />
              </div>
              <div>
                <Label>Postal Code</Label>
                <Input className="mt-1" value={form.postalCode} onChange={set("postalCode")} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm(f => ({ ...f, isDefault: e.target.checked }))} className="accent-pink-500" />
              Set as default address
            </label>
            <Button className="w-full rounded-full" onClick={handleSave} disabled={createAddress.isPending || updateAddress.isPending}>
              {(createAddress.isPending || updateAddress.isPending) ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Check className="h-4 w-4 mr-2" />}
              {editing ? "Save Changes" : "Add Address"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
