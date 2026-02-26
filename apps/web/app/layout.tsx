import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Matridx Ting",
  description: "Android PWA 录音、转写、日报与计划助手",
  manifest: "/manifest.webmanifest"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
