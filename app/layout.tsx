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
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the user's saved appearance before first paint so dark-mode
            users never see a light flash. The durable per-user copy
            (users.theme_preference) syncs via the theme hook after mount. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("superscriber.theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);document.documentElement.style.colorScheme=t;}}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <div id="app-root">{children}</div>
      </body>
    </html>
  );
}
