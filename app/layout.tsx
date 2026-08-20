import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AppelResto",
  description: "Annonce vocale des commandes prêtes",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#1C1B1A",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // Le service worker n'est activé qu'en production.
              // En dev, il rentre en conflit avec le hot-reload de Next.js
              // (boucle de rafraîchissement infinie).
              if ('serviceWorker' in navigator && ${
                process.env.NODE_ENV === "production"
              }) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js').catch(() => {});
                });
              } else if ('serviceWorker' in navigator) {
                // Nettoie un éventuel service worker déjà enregistré
                // depuis un test précédent, pour casser la boucle actuelle.
                navigator.serviceWorker.getRegistrations().then((regs) => {
                  regs.forEach((r) => r.unregister());
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
