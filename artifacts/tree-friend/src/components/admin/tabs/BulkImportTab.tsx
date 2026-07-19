import { useState } from "react";
import { useAuth } from "@clerk/react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Upload } from "lucide-react";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

export function BulkImportTab() {
  const { getToken } = useAuth();
  const [csvText, setCsvText] = useState("");
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const TEMPLATE = `name,subcategory,variantform,variantname,price,discountprice,stock,deliverycharge,description,images,keybenefits,bestfor,caretips,scientificname,sunlight,watering,soiltype,matureheight,climatezone,bloomseason
"Alphonso Mango","Mango","grafted","Grafted Plant",850,,10,60,"Premium Alphonso mango grafted sapling, known for its rich flavour and early fruiting.","https://example.com/alphonso1.jpg|https://example.com/alphonso2.jpg","Early fruiting variety|Rich sweet flavour|Disease resistant","Home gardens|Orchards","Water regularly; reduce in winter|Full sun preferred","Mangifera indica","Full Sun","Moderate","Well-drained loamy soil","10-15 meters","Tropical|Subtropical","March-April"
"Alphonso Mango","Mango","seed","Seed Packet",50,,100,20,,,,,,,,,,,`;

  const FORMAT_NOTES = [
    { field: "name", note: "Product name (required)" },
    { field: "subcategory", note: "Subcategory name or slug — must match an existing subcategory (required)" },
    { field: "variantform", note: "One of: seed / sapling / grafted / potted (defaults to sapling)" },
    { field: "variantname", note: "Display name for this variant (e.g. Grafted Plant)" },
    { field: "price", note: "Price in BDT, numbers only (required)" },
    { field: "discountprice", note: "Sale price — leave empty if no discount" },
    { field: "stock", note: "Stock quantity for this variant" },
    { field: "deliverycharge", note: "Delivery charge for this variant in BDT" },
    { field: "description", note: "Full product description" },
    { field: "images", note: "Image URLs separated by |" },
    { field: "keybenefits", note: "Benefits separated by | (e.g. Early fruiting|Disease resistant)" },
    { field: "bestfor", note: "Ideal uses separated by | (e.g. Home gardens|Orchards)" },
    { field: "caretips", note: "Care instructions separated by | (e.g. Water regularly|Full sun preferred)" },
    { field: "scientificname", note: "Scientific / botanical name (e.g. Mangifera indica)" },
    { field: "sunlight", note: "Sunlight requirement (e.g. Full Sun)" },
    { field: "watering", note: "Watering frequency (e.g. Moderate)" },
    { field: "soiltype", note: "Soil type (e.g. Well-drained loamy soil)" },
    { field: "matureheight", note: "Expected mature height (e.g. 10-15 meters)" },
    { field: "climatezone", note: "Suitable climate zones separated by | (e.g. Tropical|Subtropical)" },
    { field: "bloomseason", note: "Bloom / fruiting season (e.g. March-April)" },
  ];

  async function handleImport() {
    if (!csvText.trim()) { setError("Please paste CSV content first."); return; }
    setLoading(true); setError(""); setResult(null);
    try {
      const r = await fetch(API+"/api/admin/products/bulk-import", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
        body: JSON.stringify({ csv: csvText }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? "Import failed"); return; }
      setResult(data);
    } finally { setLoading(false); }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setCsvText((ev.target?.result as string) ?? "");
    reader.readAsText(file);
  }

  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold">Bulk Product Import</h2>
        <p className="text-sm text-muted-foreground mt-1">Upload a CSV file or paste CSV content to import multiple products at once.</p>
      </div>

      {/* Template download */}
      <div className="bg-muted/40 border rounded-xl p-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Required CSV Format</p>
        <p className="text-xs text-muted-foreground mb-2">
          Tip: use the <span className="font-mono">name</span> + <span className="font-mono">subcategory</span> columns to group multiple rows into ONE product with several variants — the example below creates a single "Alphonso Mango" product with both a Grafted Plant and a Seed Packet variant.
        </p>
        <pre className="text-xs text-foreground/80 font-mono overflow-x-auto whitespace-pre-wrap">{TEMPLATE}</pre>
        <button
          onClick={() => { const blob = new Blob([TEMPLATE], { type: "text/csv" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "product_import_template.csv"; a.click(); }}
          className="mt-3 text-xs text-accent hover:underline"
        >
          Download Template CSV
        </button>
      </div>

      {/* File upload */}
      <div>
        <Label className="text-sm">Upload CSV File</Label>
        <input type="file" accept=".csv" onChange={handleFile} className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:bg-accent file:text-white hover:file:bg-accent/90 file:cursor-pointer" />
      </div>

      {/* Or paste */}
      <div>
        <Label className="text-sm">Or Paste CSV Content</Label>
        <Textarea
          className="mt-1 font-mono text-xs resize-none"
          rows={8}
          value={csvText}
          onChange={e => setCsvText(e.target.value)}
          placeholder="Paste your CSV content here?"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {result && (
        <div className={`rounded-xl p-4 ${result.errors > 0 ? "bg-yellow-50 border-yellow-200 border" : "bg-green-50 border-green-200 border"}`}>
          <p className="font-medium text-sm">{result.message}</p>
          {result.errorDetails?.length > 0 && (
            <ul className="mt-2 space-y-1">
              {result.errorDetails.map((e: string, i: number) => (
                <li key={i} className="text-xs text-red-600">• {e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Button onClick={handleImport} disabled={loading || !csvText.trim()} className="rounded-full gap-2">
        <Upload className="h-4 w-4" />
        {loading ? "Importing?" : "Import Products"}
      </Button>
    </div>
  );
}
