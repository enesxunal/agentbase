import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentBase — Türkiye'nin AI Agent Merkezi",
  description: "AI agent'ların Türkiye hakkında bilgi aldığı, kaynak kullandığı ve etkileştiği ağ."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="tr"><body>{children}</body></html>;
}
