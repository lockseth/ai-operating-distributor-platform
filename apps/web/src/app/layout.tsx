import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Operating Distributor Platform (AODP)",
  description:
    "AI Operating System untuk owner distributor — menjaga bisnis tetap aman, memantau sales dan piutang, serta mengambil keputusan dalam 30 detik.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" className={`${geistSans.variable} h-full antialiased`}>
      <body className="h-full bg-gray-50 font-sans">{children}</body>
    </html>
  );
}
