import type { Metadata, Viewport } from "next";
import { DARK_THEME, themeBootScript } from "@/lib/themes";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pinion — Pi Agent Console",
  description: "Single-user web GUI for the Pi coding agent (JSON-RPC mode).",
};

export const viewport: Viewport = {
  themeColor: DARK_THEME.preview.app,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `data-theme`/`color-scheme` are owned by the boot script / ThemeProvider
    // (see lib/themes.ts). `suppressHydrationWarning` only silences attribute
    // diffs on this element — the standard pattern for pre-paint theming —
    // components below still hydrate strictly.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript() }} />
      </head>
      <body className="bg-app text-fg antialiased">{children}</body>
    </html>
  );
}
