import { StrictMode, useCallback, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

type Json = Record<string, unknown>;
type Tab = "overview" | "tasks" | "audit" | "approvals" | "schedules" | "memory";

async function api<T>(path: string, body?: Json): Promise<T> {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json", "x-firefly": "1" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Fetch a resource and refresh it every few seconds. */
function usePoll<T>(path: string, ms = 5000): { data: T | undefined; error: string | undefined; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api<T>(path).then(
      (d) => {
        setData(d);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  }, [path]);
  useEffect(() => {
    load();
    const t = setInterval(load, ms);
    return () => clearInterval(t);
  }, [load, ms]);
  return { data, error, reload: load };
}

const usd = (n: unknown) => `$${Number(n ?? 0).toFixed(Number(n) < 1 ? 4 : 2)}`;
const when = (s: unknown) => (s ? new Date(String(s)).toLocaleString() : "–");
const Pill = ({ v }: { v: unknown }) => <span className={`pill s-${String(v)}`}>{String(v ?? "–").replace(/_/g, " ")}</span>;

function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  return (
    <table>
      <thead>
        <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => <td key={j} className={j === 1 || j === 2 ? "wrap" : undefined}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

interface Status {
  paused: boolean;
  uptimeSeconds: number;
  pendingApprovals: number;
  running: { taskId: string; kind: string; name?: string; prompt: string; startedAt: string; waitingApproval: boolean }[];
  spend: { today: number; month: number; cap: number };
}

function Overview({ status, reloadStatus }: { status: Status | undefined; reloadStatus: () => void }) {
  const usage = usePoll<{ daily: { day: string; cost: number }[]; topTasks: Json[] }>("/api/usage", 30000);
  const max = Math.max(0.0001, ...(usage.data?.daily ?? []).map((d) => d.cost));
  return (
    <>
      <div className="grid">
        <div className="card">
          <h2>Agent</h2>
          <div className="big">
            <span className="dot" style={{ background: status?.paused ? "var(--warn)" : "var(--ok)" }} />
            {status ? (status.paused ? "Paused" : "Running") : "…"}
          </div>
          <button className="act" onClick={() => api("/api/pause", { paused: !status?.paused }).then(reloadStatus)}>
            {status?.paused ? "Resume" : "Pause"}
          </button>
        </div>
        <div className="card">
          <h2>Uptime</h2>
          <div className="big">{status ? `${Math.floor(status.uptimeSeconds / 3600)} h ${Math.floor((status.uptimeSeconds % 3600) / 60)} m` : "…"}</div>
        </div>
        <div className="card">
          <h2>Spend this month</h2>
          <div className="big">{usd(status?.spend.month)}</div>
          <span className="muted">of {usd(status?.spend.cap)} · today {usd(status?.spend.today)}</span>
        </div>
        <div className="card">
          <h2>Pending approvals</h2>
          <div className="big">{status?.pendingApprovals ?? "…"}</div>
        </div>
      </div>
      <section>
        <h2>Running now</h2>
        <Table
          head={["Kind", "Task", "Started", "State"]}
          empty="Nothing running."
          rows={(status?.running ?? []).map((r) => [r.kind === "routine" ? `🔁 ${r.name}` : "chat", r.prompt, when(r.startedAt), r.waitingApproval ? <Pill v="waiting_approval" /> : <Pill v="running" />])}
        />
      </section>
      <section>
        <h2>Spend, last 30 days</h2>
        <div className="card">
          <div className="chart" aria-label="Daily spend">
            {(usage.data?.daily ?? []).map((d) => (
              <div key={d.day} title={`${d.day}: ${usd(d.cost)}`} style={{ height: `${(d.cost / max) * 100}%` }} />
            ))}
          </div>
        </div>
      </section>
      <section>
        <h2>Most expensive tasks this month</h2>
        <Table head={["Cost", "Task", "When"]} empty="No spending yet." rows={(usage.data?.topTasks ?? []).map((t) => [usd(t.cost), String(t.prompt), when(t.created_at)])} />
      </section>
    </>
  );
}

function Tasks() {
  const { data } = usePoll<Json[]>("/api/tasks?limit=100");
  return (
    <Table
      head={["When", "Task", "Error", "Status", "Tools", "Cost"]}
      empty="No tasks yet."
      rows={(data ?? []).map((t) => [
        when(t.created_at),
        t.kind === "routine" ? `🔁 ${String(t.schedule_name)}` : String(t.prompt),
        t.error ? <span className="error">{String(t.error)}</span> : "",
        <Pill v={t.status} />,
        String(t.tool_calls),
        usd(t.cost),
      ])}
    />
  );
}

function Audit() {
  const { data } = usePoll<Json[]>("/api/tool-calls?limit=200");
  return (
    <Table
      head={["When", "Call", "Reason", "Decision", "Outcome", "ms"]}
      empty="No tool calls yet."
      rows={(data ?? []).map((c) => [
        when(c.created_at),
        <pre>
          <b>{String(c.tool)}</b> {JSON.stringify(c.args).slice(0, 300)}
        </pre>,
        String(c.reason),
        <Pill v={c.decision} />,
        <Pill v={c.outcome} />,
        String(c.duration_ms ?? ""),
      ])}
    />
  );
}

function Approvals({ reloadStatus }: { reloadStatus: () => void }) {
  const { data, reload } = usePoll<Json[]>("/api/approvals");
  const [error, setError] = useState<string>();
  const act = (id: unknown, action: "approve" | "deny") =>
    api(`/api/approvals/${String(id)}`, { action }).then(
      () => {
        reload();
        reloadStatus();
      },
      (e: Error) => setError(e.message),
    );
  return (
    <>
      {error && <p className="error">{error}</p>}
      <Table
        head={["Requested", "Action", "Task", "Status", ""]}
        empty="No approvals yet."
        rows={(data ?? []).map((a) => [
          when(a.requested_at),
          <pre>{String(a.summary)}</pre>,
          String(a.prompt),
          <Pill v={a.status} />,
          a.status === "pending" ? (
            <span style={{ display: "flex", gap: 6 }}>
              <button className="act primary" onClick={() => act(a.id, "approve")}>Approve</button>
              <button className="act" onClick={() => act(a.id, "deny")}>Deny</button>
            </span>
          ) : (
            when(a.resolved_at)
          ),
        ])}
      />
    </>
  );
}

function Schedules() {
  const { data, reload } = usePoll<Json[]>("/api/schedules", 15000);
  return (
    <Table
      head={["Name", "Task", "When", "Next run", ""]}
      empty="No routines yet."
      rows={(data ?? []).map((s) => [
        String(s.name),
        String(s.prompt),
        String(s.description),
        s.enabled ? when(s.next_run_at) : "off",
        <button className="act" onClick={() => api(`/api/schedules/${String(s.id)}`, { enabled: !s.enabled }).then(reload)}>
          {s.enabled ? "Turn off" : "Turn on"}
        </button>,
      ])}
    />
  );
}

function Memory() {
  const { data } = usePoll<{ topic: string; count: number; content: string }[]>("/api/memory", 30000);
  if (data && data.length === 0) return <p className="muted">Nothing remembered yet.</p>;
  return (
    <div className="grid">
      {(data ?? []).map((m) => (
        <div className="card" key={m.topic}>
          <h2>
            {m.topic} ({m.count})
          </h2>
          <pre>{m.content}</pre>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const status = usePoll<Status>("/api/status");
  const tabs: [Tab, string][] = [
    ["overview", "Overview"],
    ["tasks", "Tasks"],
    ["audit", "Audit log"],
    ["approvals", `Approvals${status.data?.pendingApprovals ? ` (${status.data.pendingApprovals})` : ""}`],
    ["schedules", "Schedules"],
    ["memory", "Memory"],
  ];
  return (
    <>
      <header>
        <h1>🪲 Firefly</h1>
        <nav>
          {tabs.map(([id, label]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        {status.error && <span className="error">{status.error}</span>}
      </header>
      <main>
        {tab === "overview" && <Overview status={status.data} reloadStatus={status.reload} />}
        {tab === "tasks" && <Tasks />}
        {tab === "audit" && <Audit />}
        {tab === "approvals" && <Approvals reloadStatus={status.reload} />}
        {tab === "schedules" && <Schedules />}
        {tab === "memory" && <Memory />}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
