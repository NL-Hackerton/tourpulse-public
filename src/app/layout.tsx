import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TourPulse — Find your next room",
  description: "Explore tour markets, neighborhoods and venues with Qloo cultural taste data. Build an evidence-backed tour day sheet.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
