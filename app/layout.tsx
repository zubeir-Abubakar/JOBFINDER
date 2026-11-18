import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Towfiq AI Agents",
  description: "Multi-agent AI recruitment operations platform.",
  applicationName: "Towfiq AI Agents",
};

const themeScript = `(function(){try{var t=localStorage.getItem('atw-theme');var d=t?t==='dark':true;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
