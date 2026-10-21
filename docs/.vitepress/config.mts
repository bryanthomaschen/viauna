// The docs site, published to GitHub Pages by .github/workflows/docs.yml. Every page is
// plain Markdown under docs/, linked with relative .md paths, so it reads the same on
// GitHub; this file only adds navigation and the theme.
import { defineConfig } from "vitepress";

const repo = "https://github.com/bryanthomaschen/viauna";

export default defineConfig({
  title: "Viauna",
  description: "A fast, Gmail-style webmail client for any IMAP/SMTP server. Self-hosted and open source.",
  base: "/viauna/",
  cleanUrls: true,
  lastUpdated: true,
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/viauna/logo.svg" }]],
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Self-hosting", link: "/self-hosting/getting-started" },
      { text: "Using Viauna", link: "/using/basics" },
      { text: "Roadmap", link: "/roadmap" },
    ],
    sidebar: [
      {
        text: "Self-hosting",
        items: [
          { text: "Getting started", link: "/self-hosting/getting-started" },
          { text: "Reverse proxy", link: "/self-hosting/reverse-proxy" },
          { text: "Configuration", link: "/self-hosting/configuration" },
          { text: "Admin page and command line", link: "/self-hosting/admin" },
          { text: "Password changes", link: "/self-hosting/passwords" },
          { text: "Contacts and CardDAV", link: "/self-hosting/contacts" },
          { text: "Filters and vacation", link: "/self-hosting/filters" },
          { text: "Databases", link: "/self-hosting/databases" },
          { text: "Mail servers", link: "/self-hosting/mail-servers" },
          { text: "Mailu", link: "/self-hosting/mailu" },
          { text: "Upgrades and backups", link: "/self-hosting/upgrading" },
          { text: "Troubleshooting", link: "/self-hosting/troubleshooting" },
        ],
      },
      {
        text: "Using Viauna",
        items: [
          { text: "The basics", link: "/using/basics" },
          { text: "Search", link: "/using/search" },
          { text: "Contacts", link: "/using/contacts" },
          { text: "Calendar", link: "/using/calendar" },
          { text: "Filters and vacation", link: "/using/filters" },
          { text: "Command menu and shortcuts", link: "/using/shortcuts" },
        ],
      },
      {
        text: "How it works",
        items: [
          { text: "Overview", link: "/how-it-works/" },
          { text: "Mail sync", link: "/how-it-works/sync" },
          { text: "Live updates and settings", link: "/how-it-works/live-updates" },
          { text: "Sessions", link: "/how-it-works/sessions" },
          { text: "Your data", link: "/how-it-works/data" },
          { text: "Filters", link: "/how-it-works/filters" },
          { text: "Contacts", link: "/how-it-works/contacts" },
          { text: "Calendar", link: "/how-it-works/calendar" },
          { text: "Limits", link: "/how-it-works/limits" },
        ],
      },
      {
        text: "Project",
        items: [
          { text: "Architecture", link: "/architecture" },
          { text: "Development", link: "/development" },
          { text: "Roadmap", link: "/roadmap" },
          { text: "Contributing", link: `${repo}/blob/main/CONTRIBUTING.md` },
          { text: "Security policy", link: `${repo}/blob/main/SECURITY.md` },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
    search: { provider: "local" },
    footer: {
      message: "Released under the AGPL-3.0 licence. Viauna isn't affiliated with, or endorsed by, Google.",
    },
  },
});
