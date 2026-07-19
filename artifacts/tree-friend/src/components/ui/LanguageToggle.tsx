import { useI18n } from "@/lib/i18n";

export function LanguageToggle() {
  const { lang, setLang } = useI18n();

  return (
    <button
      onClick={() => setLang(lang === "en" ? "bn" : "en")}
      className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border border-border hover:bg-muted/60 transition-colors"
      aria-label={lang === "en" ? "Switch to Bengali" : "Switch to English"}
      title={lang === "en" ? "??????? ?????" : "View in English"}
    >
      <span className="text-base leading-none">{lang === "en" ? "📲" : "📲"}</span>
      <span>{lang === "en" ? "?????" : "EN"}</span>
    </button>
  );
}
