/** The deck's orange sparkle cluster that precedes the GAMENIGHTLY wordmark. */
export function Sparkles({ className = "brand-mark" }: { className?: string }) {
  const star = "M12 0C12.9 7 17 11.1 24 12 17 12.9 12.9 17 12 24 11.1 17 7 12.9 0 12 7 11.1 11.1 7 12 0Z";
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" fill="currentColor">
      <path d={star} transform="translate(9 5) scale(0.95)" />
      <path d={star} transform="translate(1 2) scale(0.38)" />
      <path d={star} transform="translate(2 21) scale(0.34)" />
    </svg>
  );
}
