"use client";

import { useEffect, useState } from "react";

export function UserAvatar({
  name,
  src,
  size = 32,
  className = "",
}: {
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initial = name.trim().slice(0, 1).toUpperCase() || "?";
  const showImage = Boolean(src) && !failed;

  useEffect(() => {
    setFailed(false);
  }, [src]);

  return (
    <span
      className={`user-avatar ${className}`}
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.36)) }}
      role={showImage ? undefined : "img"}
      aria-label={showImage ? undefined : `${name || "Account"} profile picture`}
    >
      {showImage ? (
        <img
          src={src ?? undefined}
          alt={`${name || "Account"} profile picture`}
          width={size}
          height={size}
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initial}</span>
      )}
    </span>
  );
}
