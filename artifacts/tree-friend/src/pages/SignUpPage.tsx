import { SignUp } from "@clerk/react";

const basePath = (import.meta.env.BASE_URL as string).replace(/\/$/, "");

function AuthSkeleton() {
  return (
    <div className="w-full flex justify-center py-8">
      <div className="bg-card rounded-xl w-[440px] max-w-full border border-border shadow-lg p-8 space-y-6">
        <div className="flex justify-center"><div className="h-14 w-14 rounded-full bg-muted animate-pulse" /></div>
        <div className="space-y-2 text-center"><div className="h-7 w-48 bg-muted animate-pulse rounded mx-auto" /><div className="h-4 w-64 bg-muted animate-pulse rounded mx-auto" /></div>
        <div className="h-11 w-full bg-muted animate-pulse rounded-full" />
        <div className="flex items-center gap-2"><div className="flex-1 h-px bg-muted" /><div className="h-4 w-6 bg-muted animate-pulse rounded" /><div className="flex-1 h-px bg-muted" /></div>
        <div className="space-y-2"><div className="h-4 w-24 bg-muted animate-pulse rounded" /><div className="h-11 w-full bg-muted animate-pulse rounded" /></div>
        <div className="h-11 w-full bg-muted animate-pulse rounded-full" />
      </div>
    </div>
  );
}

export function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-background to-secondary px-4 py-12">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} fallback={<AuthSkeleton />} />
    </div>
  );
}
