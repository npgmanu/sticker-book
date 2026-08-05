export function FlagIcon({ code, fallback }: { code: string; fallback: string }) {
  if (code === "ENG" || code === "SCO") {
    return <span className={`country-flag country-flag-${code.toLowerCase()}`} role="img" aria-label={`${code} flag`} />;
  }
  return <span role="img" aria-label={`${code} flag`}>{fallback}</span>;
}
