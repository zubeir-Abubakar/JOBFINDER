import Link from "next/link";
import { Brand } from "@/components/icons";

export const metadata = {
  title: "Offline · AT AI Workforce",
};

export default function OfflinePage() {
  return (
    <main className="offline-page">
      <div className="card offline-card">
        <Brand href="/" />
        <p className="badge badge-warn">Offline</p>
        <h1>You are offline</h1>
        <p>
          The workspace shell is available, but vacancies, applications, documents and recruiter
          messages are never cached for offline use. Reconnect to continue securely.
        </p>
        <div className="row">
          <Link href="/dashboard" className="btn btn-primary">Try again</Link>
          <a href="/offline" className="btn">Reload shell</a>
        </div>
        <p className="hint">No candidate or Gmail data is stored in the offline cache.</p>
      </div>
    </main>
  );
}
