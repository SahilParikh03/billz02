import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// Geist stays as a system-safe fallback; Satoshi / Clash Display (Fontshare)
// and Instrument Serif (Google) are loaded via <link> below to match the FE.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BEAMR — AI Inference Router",
  description:
    "Consumer-facing AI inference router. Pay model providers over x402 — gasless USDC on Base. Every call settled on-chain, in real-time.",
};

// Set the theme class before first paint to avoid a flash. Follows the user's
// saved choice, else the OS preference.
const themeInit = `(function(){try{var t=localStorage.getItem("beamr-theme");var dark=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.add(dark?"dark":"light");}catch(e){document.documentElement.classList.add("dark");}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <link rel="preconnect" href="https://api.fontshare.com" crossOrigin="" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=clash-display@600,500,400&f[]=satoshi@400,500,700&display=swap"
          rel="stylesheet"
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col bg-bg text-ink">{children}</body>
    </html>
  );
}
