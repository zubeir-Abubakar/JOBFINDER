/**
 * Pure-CSS welcome scene. The track is intentionally a dedicated container so
 * a custom mini-me sprite can replace the built-in illustration without
 * touching the login form or authentication flow.
 */
export function AuthScene({ idPrefix = "mini-me" }: { idPrefix?: string }) {
  const bodyGradient = `${idPrefix}-body`;
  const visorGradient = `${idPrefix}-visor`;
  return (
    <div className="auth-scene" aria-hidden="true">
      <div className="auth-scene-glow" />
      <div className="auth-scene-path">
        <span className="auth-scene-pulse auth-scene-pulse-a" />
        <span className="auth-scene-pulse auth-scene-pulse-b" />
        <span className="auth-scene-pulse auth-scene-pulse-c" />
      </div>
      <div className="auth-mascot-track">
        <div className="auth-mascot">
          <span className="auth-mascot-shadow" />
          <svg className="auth-mascot-svg" viewBox="0 0 96 128" role="presentation">
            <defs>
              <linearGradient id={bodyGradient} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#67e8f9" />
                <stop offset="0.55" stopColor="#38bdf8" />
                <stop offset="1" stopColor="#818cf8" />
              </linearGradient>
              <linearGradient id={visorGradient} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#0f172a" />
                <stop offset="1" stopColor="#1e293b" />
              </linearGradient>
            </defs>
            <ellipse cx="48" cy="120" rx="24" ry="4" fill="rgba(2, 6, 23, 0.28)" />
            <g className="auth-mascot-leg auth-mascot-leg-back">
              <path d="M42 96l-3 18" stroke="#c7d2fe" strokeWidth="7" strokeLinecap="round" />
              <path d="M35 116h13" stroke="#f8fafc" strokeWidth="6" strokeLinecap="round" />
            </g>
            <g className="auth-mascot-leg auth-mascot-leg-front">
              <path d="M54 96l4 18" stroke="#a5b4fc" strokeWidth="7" strokeLinecap="round" />
              <path d="M52 116h14" stroke="#f8fafc" strokeWidth="6" strokeLinecap="round" />
            </g>
            <rect x="27" y="48" width="42" height="51" rx="16" fill={`url(#${bodyGradient})`} />
            <path d="M32 61c-8 2-12 8-12 16" stroke="#67e8f9" strokeWidth="7" strokeLinecap="round" className="auth-mascot-arm auth-mascot-arm-back" />
            <path d="M64 61c8 2 12 8 12 16" stroke="#818cf8" strokeWidth="7" strokeLinecap="round" className="auth-mascot-arm auth-mascot-arm-front" />
            <rect x="32" y="18" width="33" height="32" rx="13" fill="#f8fafc" />
            <rect x="35" y="24" width="27" height="13" rx="6.5" fill={`url(#${visorGradient})`} />
            <circle cx="44" cy="30.5" r="2.2" fill="#67e8f9" />
            <circle cx="54" cy="30.5" r="2.2" fill="#67e8f9" />
            <path d="M43 40c3 2 7 2 10 0" stroke="#475569" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M65 45c5-1 8 1 10 5" stroke="#c7d2fe" strokeWidth="2" strokeLinecap="round" />
            <circle cx="67" cy="51" r="5.5" fill="#0f172a" stroke="#5eead4" strokeWidth="1.5" />
            <path d="M67 47v8M63 51h8" stroke="#5eead4" strokeWidth="1" />
            <rect x="39" y="66" width="19" height="15" rx="4" fill="rgba(8, 47, 73, 0.28)" />
            <path d="M43 71h11M43 75h7" stroke="#e0f2fe" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="48" cy="17" r="3" fill="#fbbf24" />
            <path d="M48 14V8" stroke="#fbbf24" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </div>
      </div>
      <div className="auth-scene-caption">
        <span className="dot" /> 8 specialist agents · one coordinated workforce
      </div>
    </div>
  );
}
