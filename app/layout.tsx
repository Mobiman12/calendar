import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { getSessionOrNull } from "@/lib/session";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Timevex Calendar",
  description: "Terminbuchung für Services und Salons.",
};

async function fetchTenantThemeSettings(tenantId: string): Promise<{ preset?: string; mode?: string } | null> {
  const baseUrl = process.env.CONTROL_PLANE_URL?.trim();
  if (!baseUrl) return null;
  const url = new URL("/api/internal/tenant/info", baseUrl);
  url.searchParams.set("tenantId", tenantId);
  const secret = process.env.PROVISION_SECRET?.trim();

  try {
    const response = await fetch(url.toString(), {
      cache: "no-store",
      headers: secret ? { "x-provision-secret": secret } : undefined,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { theme?: { preset?: string | null; mode?: string | null } } | null;
    return payload?.theme ?? null;
  } catch {
    return null;
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const hdrs = await headers();
  const headerPreset = hdrs.get("x-tenant-theme");
  const headerMode = hdrs.get("x-tenant-theme-mode");
  let themePreset = headerPreset ?? "emerald";
  let themeMode = headerMode === "light" ? "light" : "auto";

  if ((!headerPreset || !headerMode) && themePreset) {
    const session = await getSessionOrNull();
    if (session?.tenantId) {
      const theme = await fetchTenantThemeSettings(session.tenantId);
      if (theme?.preset && !headerPreset) {
        themePreset = theme.preset;
      }
      if (theme?.mode && !headerMode) {
        themeMode = theme.mode === "light" ? "light" : "auto";
      }
    }
  }
  return (
    <html lang="de" data-theme={themePreset} data-theme-mode={themeMode}>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
