import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {themes as prismThemes} from 'prism-react-renderer';

// GitHub Pages documentation site for Superscriber.
//
// Docs content lives in the repo's normal locations (README.md, DESIGN.md,
// docs/operators/, ...) and is derived into website/content/ by
// scripts/stage-docs.sh - the sources are never moved or edited. Versioning
// is native Docusaurus versioning; versions.json is cut from repo release
// tags (v0.4.0 and up). Search is fully local (@easyops-cn - Lunr index at
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
          // Versioning follows repo release tags: cut with
          // `cd website && npx docusaurus docs:version vX.Y.Z`.
          lastVersion: 'v0.4.0',
          versions: {
            current: {
              label: 'next (main)',
              path: 'next',
              banner: 'unreleased',
            },
            'v0.4.0': {
              label: 'v0.4.0',
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
          type: 'docsVersionDropdown',
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
