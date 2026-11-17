import { BrandMark } from "./BrandMark";

export function BrandLoader({
  label = "Loading",
  sub,
  size = 54,
}: {
  label?: string;
  sub?: string;
  size?: number;
}) {
  return (
    <div className="page-loader">
      <div className="brand-loader" role="status" aria-live="polite">
        <div className="brand-loader-ring" style={{ width: size, height: size }}>
          <BrandMark size={size} idPrefix="loader" className="brand-loader-mark" />
        </div>
        <div className="text-center">
          <p className="text-[12.5px] font-semibold" style={{ color: "var(--ink)" }}>
            {label}
          </p>
          {sub ? (
            <p className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
              {sub}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function BrandSpinner({ size = 14 }: { size?: number }) {
  return <span className="brand-spinner" style={{ width: size, height: size }} aria-hidden />;
}
