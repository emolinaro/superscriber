import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {themes as prismThemes} from 'prism-react-renderer';

// GitHub Pages documentation site for Superscriber.
//
// Docs content lives in the repo's normal locations (README.md, DESIGN.md,
// docs/operators/, ...) and is derived into website/content/ by
// scripts/stage-docs.sh - the sources are never moved or edited. Versioning
// site publishes one tree only, tracking latest main (versioning flattened
// by captain decision of 2026-08-14: no frozen release snapshots). Old
// versioned URLs collapse onto the current tree via client redirects.
// Search is fully local (@easyops-cn - Lunr index at
// build time), no external keys.

const config: Config = {
  title: 'Superscriber',
  tagline: 'Governed transcription appliance documentation',
  favicon: 'img/icon.svg',

  url: 'https://emolinaro.github.io',
  baseUrl: '/superscriber/',

  organizationName: 'emolinaro',
  projectName: 'superscriber',

  // Links into the source tree are retargeted to GitHub by the staging
  // script, so the build must stay warning-free.
  onBrokenLinks: 'throw',

  markdown: {
    format: 'detect', // staged sources are CommonMark (.md), MDX opt-in only
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: 'content',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          // One unversioned tree tracking latest main: the single current
          // version serves at routeBasePath itself (empty path), so no
          // /next/ or /vX.Y.Z/ subtrees remain routable.
          versions: {
            current: {
              label: 'latest (main)',
              path: '',
            },
          },
        },
        blog: false,
        theme: {
          customCss: ['./src/css/custom.css'],
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        // Collapse the retired versioned URL trees onto the current docs
        // paths (/superscriber/next/x and /superscriber/v0.4.0/x become
        // /superscriber/x). createRedirects receives and returns paths
        // relative to baseUrl; the plugin prepends baseUrl when writing the
        // redirect stubs.
        createRedirects(existingPath: string) {
          const suffix = existingPath === '/' ? '' : existingPath;
          return [`/next${suffix}`, `/v0.4.0${suffix}`, `/0.4.0${suffix}`];
        },
      },
    ],
  ],

  themes: [
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        hashed: true,
        indexDocs: true,
        indexBlog: false,
        indexPages: false,
        docsDir: 'content',
        docsRouteBasePath: '/',
        language: ['en'],
      },
    ],
  ],

  themeConfig: {
    image: 'img/icon.svg',
    navbar: {
      title: 'Superscriber',
      logo: {
        alt: 'Superscriber logo',
        src: 'img/icon.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'Documentation',
        },
        {
          // Single-version site: a fixed label, not a switcher.
          type: 'docsVersion',
          position: 'right',
        },
        {
          href: 'https://github.com/emolinaro/superscriber',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Design record', to: '/DESIGN'},
            {label: 'Operator runbooks', to: '/operators/authentik-oidc'},
            {label: 'Changelog', to: '/CHANGELOG'},
          ],
        },
        {
          title: 'Project',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/emolinaro/superscriber',
            },
            {
              label: 'Releases',
              href: 'https://github.com/emolinaro/superscriber/releases',
            },
          ],
        },
      ],
      // No copyright/powered-by line: keep the link columns only, per the
      // captain's trim of the default footer chrome.
    },
    prism: {
      theme: prismThemes.github,
      // nightOwl keeps the dark register blue-teal; dracula's purple accents
      // are off the app register.
      darkTheme: prismThemes.nightOwl,
      additionalLanguages: ['bash', 'json', 'yaml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
