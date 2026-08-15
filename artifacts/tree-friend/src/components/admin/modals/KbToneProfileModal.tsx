import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { RefreshCw, AlertCircle } from "lucide-react";
import { useApiFetch } from "@/lib/useApiFetch";
import { fetchToneProfile, generateToneProfile, type KbToneProfileResponse } from "@/lib/kbApi";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Tone profile viewer modal — shows the full parsed tone profile for a
 * creator (adjectives, sentence style, vocabulary, greetings, example
 * phrases, summary) + status (generated/pending/needs-regeneration).
 *
 * Also has a "Regenerate" button that calls POST
 * /ai/admin/kb/creators/:id/tone-profile/generate (calls Gemini
 * immediately — useful when the admin wants to refresh the profile
 * after editing entries).
 */
export function KbToneProfileModal({
  open,
  onOpenChange,
  creatorId,
  creatorName,
  onRegenerated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creatorId: number | null;
  creatorName: string;
  onRegenerated: () => void; // refresh the parent's status list
}) {
  const apiFetch = useApiFetch();
  const [profile, setProfile] = useState<KbToneProfileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || creatorId === null) return;
    setError("");
    setLoading(true);
    fetchToneProfile(apiFetch, creatorId)
      .then((data) => setProfile(data))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load profile"))
      .finally(() => setLoading(false));
  }, [open, creatorId, apiFetch]);

  async function handleRegenerate() {
    if (creatorId === null) return;
    setRegenerating(true);
    setError("");
    try {
      await generateToneProfile(apiFetch, creatorId);
      // Re-fetch the profile to show the updated content.
      const data = await fetchToneProfile(apiFetch, creatorId);
      setProfile(data);
      onRegenerated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to regenerate");
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">Tone Profile: {creatorName}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-6 rounded-lg" />
            <Skeleton className="h-20 rounded-lg" />
            <Skeleton className="h-20 rounded-lg" />
          </div>
        ) : error ? (
          <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive flex items-start gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        ) : profile ? (
          <div className="space-y-4">
            {/* Status badges */}
            <div className="flex flex-wrap gap-2">
              <Badge variant={profile.hasProfile ? "default" : "secondary"}>
                {profile.hasProfile ? "✓ Profile Generated" : "Pending"}
              </Badge>
              {profile.entryCount >= profile.threshold ? (
                <Badge variant="outline">
                  Eligible ({profile.entryCount} ≥ {profile.threshold})
                </Badge>
              ) : (
                <Badge variant="outline">
                  Below threshold ({profile.entryCount}/{profile.threshold})
                </Badge>
              )}
              {profile.needsRegeneration && (
                <Badge variant="destructive">⚠ Needs regeneration</Badge>
              )}
            </div>

            {/* Match percentage */}
            <div className="rounded-xl border p-3 bg-muted/30">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                Tone Match Percentage
              </p>
              <p className="text-2xl font-bold">{profile.toneMatchPercentage}%</p>
              <p className="text-[11px] text-muted-foreground/70 mt-1">
                The AI adopts this percentage of the creator's tone in responses using their
                content.
              </p>
            </div>

            {/* Profile content */}
            {profile.profile ? (
              <div className="space-y-3">
                {/* Adjectives */}
                {profile.profile.adjectives.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                      Adjectives
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {profile.profile.adjectives.map((a) => (
                        <Badge key={a} variant="secondary">
                          {a}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Sentence style */}
                {profile.profile.sentenceStyle && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                      Sentence Style
                    </p>
                    <p className="text-sm">{profile.profile.sentenceStyle}</p>
                  </div>
                )}

                {/* Vocabulary level */}
                {profile.profile.vocabularyLevel && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                      Vocabulary Level
                    </p>
                    <p className="text-sm">{profile.profile.vocabularyLevel}</p>
                  </div>
                )}

                {/* Greeting style */}
                {profile.profile.greetingStyle && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                      Greeting Style
                    </p>
                    <p className="text-sm">{profile.profile.greetingStyle}</p>
                  </div>
                )}

                {/* Example phrases */}
                {profile.profile.examplePhrases.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                      Example Phrases
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {profile.profile.examplePhrases.map((p) => (
                        <Badge key={p} variant="outline" className="font-mono text-xs">
                          "{p}"
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tone summary */}
                {profile.profile.toneSummary && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                      Tone Summary
                    </p>
                    <div className="rounded-xl border-l-4 border-primary/50 bg-primary/5 px-3 py-2 text-sm italic">
                      {profile.profile.toneSummary}
                    </div>
                  </div>
                )}

                {/* Generation metadata */}
                {profile.lastGeneratedAt && (
                  <div className="text-[11px] text-muted-foreground/70 border-t pt-2">
                    <p>
                      Generated: {new Date(profile.lastGeneratedAt).toLocaleString()}
                      {profile.lastGeneratedEntryCount !== null && (
                        <> · based on {profile.lastGeneratedEntryCount} entries</>
                      )}
                      {profile.lastGeneratedModel && <> · model: {profile.lastGeneratedModel}</>}
                    </p>
                    {profile.needsRegeneration && (
                      <p className="text-amber-600 dark:text-amber-400 mt-1">
                        {profile.regenerationReason}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-xl border p-6 text-center text-sm text-muted-foreground">
                No profile generated yet.{" "}
                {profile.entryCount >= profile.threshold
                  ? 'Click "Regenerate" to generate one now.'
                  : `This creator has ${profile.entryCount} entries (threshold: ${profile.threshold}). Add more entries to enable tone matching.`}
              </div>
            )}

            {error && (
              <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="rounded-xl"
          >
            Close
          </Button>
          {profile && (profile.hasProfile || profile.entryCount >= profile.threshold) && (
            <Button
              type="button"
              onClick={handleRegenerate}
              disabled={regenerating}
              className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              <RefreshCw className={`h-4 w-4 ${regenerating ? "animate-spin" : ""}`} />
              {regenerating ? "Generating…" : profile.hasProfile ? "Regenerate" : "Generate"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
