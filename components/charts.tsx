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

const PIE_COLORS: Record<string, string> = {
  accent: "var(--accent)",
  cyan: "var(--info)",
  violet: "#9c7bff",
  amber: "var(--warn)",
  danger: "var(--danger)",
  muted: "var(--line-strong)",
};

/** Responsive SVG donut with native hover tooltips and a readable legend. */
export function PieChart({
  data,
  label = "Total",
  emptyLabel = "No data in this range",
}: {
  data: Array<{ label: string; value: number; detail?: string; tone?: string }>;
  label?: string;
  emptyLabel?: string;
}) {
  const visible = data.filter((item) => item.value > 0);
  const total = visible.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) {
    return <div className="chart-empty">{emptyLabel}</div>;
  }
  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="pie-layout">
      <svg className="pie-svg" viewBox="0 0 180 180" role="img" aria-label={`${label}: ${total}`}>
        <circle cx="90" cy="90" r={radius} fill="none" stroke="var(--line)" strokeWidth="22" />
        {visible.map((item) => {
          const length = (item.value / total) * circumference;
          const dash = `${Math.max(0.6, length - 1)} ${circumference - Math.max(0.6, length - 1)}`;
          const current = offset;
          offset += length;
          return (
            <circle
              key={item.label}
              cx="90"
              cy="90"
              r={radius}
              fill="none"
              stroke={PIE_COLORS[item.tone ?? "accent"] ?? PIE_COLORS.accent}
              strokeWidth="22"
              strokeDasharray={dash}
              strokeDashoffset={-current}
              transform="rotate(-90 90 90)"
            >
              <title>{`${item.label}: ${item.value.toLocaleString("en-GB")}${item.detail ? ` (${item.detail})` : ""}`}</title>
            </circle>
          );
        })}
        <text x="90" y="84" textAnchor="middle" className="pie-total">{total.toLocaleString("en-GB")}</text>
        <text x="90" y="101" textAnchor="middle" className="pie-caption">{label}</text>
      </svg>
      <div className="pie-legend">
        {data.map((item) => (
          <div className="pie-legend-row" key={item.label}>
            <span className="pie-swatch" style={{ background: PIE_COLORS[item.tone ?? "accent"] ?? PIE_COLORS.accent }} />
            <span className="pie-legend-label">
              <strong>{item.label}</strong>
              {item.detail ? <small>{item.detail}</small> : null}
            </span>
            <span className="pie-legend-value num">
              {item.value.toLocaleString("en-GB")}
              <small>{Math.round((item.value / total) * 100)}%</small>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Horizontal ranked bars for agent or model comparisons. */
export function RankingBars({
  data,
  valueLabel = "",
}: {
  data: Array<{ label: string; value: number; detail?: string }>;
  valueLabel?: string;
}) {
  const max = Math.max(1, ...data.map((item) => item.value));
  if (data.length === 0) return <div className="chart-empty">No data in this range</div>;
  return (
    <div className="ranking-list">
      {data.map((item) => (
        <div className="ranking-row" key={item.label}>
          <div className="between text-[12px] gap-2">
            <span className="truncate">{item.label}</span>
            <span className="num" style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>
              {item.value.toLocaleString("en-GB")}{valueLabel}
            </span>
          </div>
          <div className="bar mt-1.5">
            <span style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }} />
          </div>
          {item.detail ? <div className="text-[10.5px] mt-1" style={{ color: "var(--muted)" }}>{item.detail}</div> : null}
        </div>
      ))}
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
