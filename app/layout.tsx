import "@fontsource-variable/public-sans";
import "@fontsource-variable/newsreader";
import "@fontsource/ibm-plex-mono/500.css";
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
      <body>
        <div id="app-root">{children}</div>
      </body>
    </html>
  );
}
