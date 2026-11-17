/**
 * Vector recreation of the Towfiq AI Agents monogram (TA + rising arrow + agent network).
 * Kept dependency-free and theme-safe so it can be reused by the wordmark, loader and icons.
 */
export function BrandMark({
  size = 34,
  className = "",
  idPrefix = "tw",
}: {
  size?: number | string;
  className?: string;
  idPrefix?: string;
}) {
  const navy = `${idPrefix}-navy`;
  const blue = `${idPrefix}-blue`;
  const cyan = `${idPrefix}-cyan`;

  return (
    <svg viewBox="0 0 512 512" width={size} height={size} className={className} role="img" aria-label="Towfiq AI Agents">
      <defs>
        <linearGradient id={navy} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#155a96" />
          <stop offset="0.55" stopColor="#0a3a67" />
          <stop offset="1" stopColor="#052544" />
        </linearGradient>
        <linearGradient id={blue} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#0a3f74" />
          <stop offset="0.55" stopColor="#0d7fc1" />
          <stop offset="1" stopColor="#25b9e6" />
        </linearGradient>
        <linearGradient id={cyan} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#0a6aa8" />
          <stop offset="0.5" stopColor="#1aa6dd" />
          <stop offset="1" stopColor="#6ee6ff" />
        </linearGradient>
      </defs>

      <g fill="none" stroke={`url(#${cyan})`} strokeWidth="3" opacity="0.5">
        <path d="M336 72 L388 112 L404 192" />
        <path d="M388 112 L448 158" />
      </g>
      <g fill={`url(#${cyan})`} opacity="0.9">
        <circle cx="336" cy="72" r="15" />
        <circle cx="388" cy="112" r="9" />
        <circle cx="404" cy="192" r="12" />
        <circle cx="448" cy="158" r="8" />
      </g>

      <path fill={`url(#${navy})`} d="M54 96h212l-14 50h-46l-14 256h-64l14-256H54z" />
      <path fill={`url(#${blue})`} d="M300 90l110 318h-68l-42-126-42 126h-68z" />
      <path fill={`url(#${blue})`} d="M252 314h104l-8 38h-88z" />

      <g transform="translate(272 268) rotate(45)">
        <path fill={`url(#${cyan})`} d="M-26 92V-92h-46L0-206l72 114h-46V92z" />
      </g>
    </svg>
  );
}
