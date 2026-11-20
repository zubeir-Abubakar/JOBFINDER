import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "AT AI Workforce",
    short_name: "AT Workforce",
    description: "Private multi-agent recruitment operations workspace.",
    lang: "en",
    dir: "ltr",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    // The app supports portrait and landscape; Android may rotate the standalone window.
    orientation: "any",
    background_color: "#070a10",
    theme_color: "#070a10",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
