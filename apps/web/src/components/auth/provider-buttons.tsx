"use client";
export function ProviderButtons({
  capabilities,
  returnTo,
  onNavigate,
}: {
  capabilities: Record<string, boolean>;
  returnTo: string;
  onNavigate: () => void;
}) {
  return (
    <div className="provider-buttons" aria-label="Sign-in services">
      {(["google", "telegram", "apple"] as const).map((provider) => {
        const enabled = Boolean(capabilities[provider]);
        return (
          <a
            key={provider}
            className={`button secondary ${enabled ? "" : "disabled"}`}
            href={
              enabled
                ? `/api/auth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`
                : undefined
            }
            aria-disabled={!enabled}
            tabIndex={enabled ? undefined : -1}
            title={enabled ? undefined : "Sign-in is not connected yet"}
            onClick={enabled ? onNavigate : undefined}
          >
            Continue with {provider[0].toUpperCase() + provider.slice(1)}
          </a>
        );
      })}
    </div>
  );
}
