export function BarChart({
  data,
  height = 120,
  suffix = "",
}: {
  data: Array<{ label: string; value: number }>;
  height?: number;
  suffix?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const barWidth = 100 / Math.max(data.length, 1);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height, paddingTop: 8 }}>
        {data.map((item) => (
          <div key={item.label} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }} title={`${item.label}: ${item.value}${suffix}`}>
            <div
              style={{
                height: `${Math.max(2, (item.value / max) * 100)}%`,
                background: item.value > 0 ? "var(--accent)" : "var(--line)",
                borderRadius: "3px 3px 0 0",
                opacity: item.value > 0 ? 0.9 : 0.6,
                minHeight: 3,
              }}
            />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
        {data.map((item, index) => (
          <div key={`${item.label}-${index}`} style={{ flex: 1, fontSize: 9.5, color: "var(--muted)", textAlign: "center", overflow: "hidden", whiteSpace: "nowrap" }}>
            {data.length > 16 ? (index % 2 === 0 ? item.label : "") : item.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Funnel({ steps }: { steps: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <div className="stack" style={{ gap: 10 }}>
      {steps.map((step) => (
        <div key={step.label}>
          <div className="between text-[12px]">
            <span>{step.label}</span>
            <span className="num" style={{ color: "var(--muted)" }}>{step.value}</span>
          </div>
          <div className="bar mt-1.5">
            <span style={{ width: `${(step.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
