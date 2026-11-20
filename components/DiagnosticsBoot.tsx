import Script from "next/script";

export function DiagnosticsBoot({ nonce }: { nonce?: string }) {
  return <Script src="/diagnostics.js?v=1" strategy="beforeInteractive" nonce={nonce} />;
}
