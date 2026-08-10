import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

// GitHub Pages serves this at https://<org>.github.io/<repo>/ unless a custom domain is configured.
// Both are expressible without touching anything else: set DOCS_URL/DOCS_BASE_URL in the workflow.
const url = process.env.DOCS_URL ?? "https://everdict.github.io";
const baseUrl = process.env.DOCS_BASE_URL ?? "/everdict/";

const config: Config = {
  title: "Everdict",
  tagline: "Know if your agents actually work",
  favicon: "img/favicon.svg",
  url,
  baseUrl,
  organizationName: "everdict",
  projectName: "everdict",
  trailingSlash: true,

  // A dead link is a documentation bug, so it fails the build rather than shipping.
  onBrokenLinks: "throw",
  onBrokenAnchors: "warn",
  // The docs tree is plain CommonMark written for GitHub, not MDX. Without this, MDX v3 reads a literal
  // `<total>` or `{...}` in prose as JSX and fails the build — the content is the constraint here, not
  // the renderer.
  markdown: { format: "md", hooks: { onBrokenMarkdownLinks: "throw" } },

  i18n: { defaultLocale: "en", locales: ["en"] },

  presets: [
    [
      "classic",
      {
        docs: {
          // The content root is the repo's docs/ tree, consumed in place — no copy, no sync script,
          // no second source of truth. See docs/architecture/docs-site.md §2.
          path: "../docs",
          routeBasePath: "docs",
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/everdict/everdict/tree/main/",
          showLastUpdateTime: true,
          exclude: ["**/node_modules/**"],
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/scorecards.webp",
    colorMode: { defaultMode: "dark", respectPrefersColorScheme: true },
    navbar: {
      title: "Everdict",
      // The homepage at `/` is the hand-written static page in `static/index.html`, which Docusaurus
      // copies but does not register as a route — so a relative brand link reads as broken to the
      // link checker even though it resolves at runtime. An absolute href states the truth instead of
      // weakening `onBrokenLinks`.
      logo: { alt: "Everdict", src: "img/favicon.svg", href: `${url}${baseUrl}` },
      items: [
        { type: "docSidebar", sidebarId: "guideSidebar", position: "left", label: "Guide" },
        { type: "docSidebar", sidebarId: "referenceSidebar", position: "left", label: "Reference" },
        { type: "docSidebar", sidebarId: "internalsSidebar", position: "left", label: "Internals" },
        { href: "https://github.com/everdict/everdict", label: "GitHub", position: "right" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "What is Everdict", to: "/docs/guide/start/what-is-everdict" },
            { label: "Quickstart", to: "/docs/guide/start/quickstart" },
            { label: "Core concepts", to: "/docs/guide/concepts/" },
            { label: "Self-hosting", to: "/docs/guide/self-host/overview" },
          ],
        },
        {
          title: "Project",
          items: [
            { label: "GitHub", href: "https://github.com/everdict/everdict" },
            { label: "Releases", href: "https://github.com/everdict/everdict/releases" },
            { label: "License (Apache-2.0)", href: "https://github.com/everdict/everdict/blob/main/LICENSE" },
          ],
        },
      ],
      copyright: "Apache-2.0. Everdict — eval + verdict.",
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "yaml", "sql", "hcl"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
