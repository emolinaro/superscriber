import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Superscriber",
  description:
    "Sovereign transcription workspace for regulated institutions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
