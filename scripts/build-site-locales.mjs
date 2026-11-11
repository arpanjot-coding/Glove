// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = fileURLToPath(new URL('../docs/', import.meta.url));
const css = await readFile(join(docs, 'assets/site.css'), 'utf8');
const cssVersion = createHash('sha256').update(css.replaceAll('\r\n', '\n')).digest('hex').slice(0, 12);
const base = 'https://arpanjot-coding.github.io/Glove/';
const repository = 'https://github.com/arpanjot-coding/Glove';
const socialImage = base + 'assets/glove-social.jpg';
const guides = ['compatibility', 'setup', 'developers', 'demos'];
const windowsCommands = [
  `git clone ${repository}.git`, 'cd Glove', 'npm ci', 'node node_modules/electron/install.js',
  'npm run build', 'npm start',
].join('\n');
const check = process.argv.includes('--check');
const english = { slug: '', lang: 'en', og: 'en_US', language: 'English', languageMenu: 'Language' };
const languages = [
  { slug: 'ar', lang: 'ar', og: 'ar_AR', rtl: true, skip: 'انتقل إلى المحتوى', nav: ['المزايا', 'الإعداد'] },
  { slug: 'de', lang: 'de', og: 'de_DE', skip: 'Zum Inhalt springen', nav: ['Funktionen', 'Einrichtung'] },
  { slug: 'es', lang: 'es', og: 'es_ES', skip: 'Saltar al contenido', nav: ['Funciones', 'Configuración'] },
  { slug: 'fr', lang: 'fr', og: 'fr_FR', skip: 'Aller au contenu', nav: ['Fonctionnalités', 'Configuration'] },
  { slug: 'hi', lang: 'hi', og: 'hi_IN', skip: 'सामग्री पर जाएँ', nav: ['सुविधाएँ', 'सेटअप'] },
  { slug: 'it', lang: 'it', og: 'it_IT', skip: 'Vai al contenuto', nav: ['Funzionalità', 'Configurazione'] },
  { slug: 'ja', lang: 'ja', og: 'ja_JP', skip: '本文へ移動', nav: ['機能', 'セットアップ'] },
  { slug: 'ru', lang: 'ru', og: 'ru_RU', skip: 'Перейти к содержанию', nav: ['Возможности', 'Установка'] },
  { slug: 'th', lang: 'th', og: 'th_TH', skip: 'ข้ามไปยังเนื้อหา', nav: ['ฟีเจอร์', 'การตั้งค่า'] },
  { slug: 'vi', lang: 'vi', og: 'vi_VN', skip: 'Chuyển đến nội dung', nav: ['Tính năng', 'Cài đặt'] },
  { slug: 'zh', lang: 'zh-Hans', og: 'zh_CN', skip: '跳至正文', nav: ['功能', '安装'] },
];
const fields = [
  'language', 'languageMenu', 'title', 'description', 'heroTitle', 'heroBody',
  'setupAction', 'demosAction', 'preview', 'featuresTitle', 'filesTitle', 'filesBody',
  'notificationsTitle', 'notificationsBody', 'developerTitle', 'developerBody',
  'setupTitle', 'setupBody', 'statusTitle', 'statusBody', 'sourceAction', 'docsAction',
  'englishNotice', 'screenshotTitle', 'screenshotAlt', 'artworkAlt', 'footer',
];
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = value => value.replace(/[&<>"']/g, char => entities[char]);
const plain = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const route = locale => locale.slug ? `${locale.slug}/` : '';
const urls = [{ lang: 'x-default', href: base }, ...[english, ...languages].map(locale => ({ lang: locale.lang, href: base + route(locale) }))];

async function loadLocale(locale) {
  const path = join(docs, 'locales', `${locale.slug}.json`);
  const values = JSON.parse(await readFile(path, 'utf8'));
  for (const field of fields) {
    if (!plain(values[field])) throw new Error(`${locale.slug}.json needs a nonempty plain string for ${field}.`);
  }
  if (!Array.isArray(values.setupSteps) || values.setupSteps.length !== 3 || !values.setupSteps.every(plain)) {
    throw new Error(`${locale.slug}.json needs exactly three plain strings in setupSteps.`);
  }
  const unknown = Object.keys(values).filter(field => field !== 'setupSteps' && !fields.includes(field));
  if (unknown.length) throw new Error(`${locale.slug}.json has unknown fields: ${unknown.join(', ')}.`);
  return { ...locale, ...values };
}

const locales = await Promise.all(languages.map(loadLocale));
const all = [english, ...locales];
const alternates = urls.map(({ lang, href }) => `  <link rel="alternate" hreflang="${lang}" href="${href}">`).join('\n');

function picker({ current, label, prefix }) {
  const options = all.map(locale => {
    const href = prefix + route(locale) || './';
    const selected = locale.lang === current ? ' aria-current="page"' : '';
    return `          <a href="${href}" hreflang="${locale.lang}" lang="${locale.lang}" dir="auto"${selected}>${escape(locale.language)}</a>`;
  });
  return [
    '      <details class="language-picker">',
    `        <summary>${escape(label)}</summary>`,
    `        <nav class="language-options" aria-label="${escape(label)}">`,
    ...options,
    '        </nav>',
    '      </details>',
  ].join('\n');
}

function localizedPage(locale) {
  const strings = Object.fromEntries(fields.map(key => [key, escape(locale[key])]));
  const url = base + route(locale);
  const dir = locale.rtl ? ' dir="rtl"' : '';
  const structuredData = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Glove',
    description: locale.description,
    inLanguage: locale.lang,
    url,
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Windows',
    license: repository + '/blob/main/LICENSE',
    screenshot: base + 'assets/glove-app.webp',
    image: socialImage,
  }, null, 2).replaceAll('<', '\\u003c');

  return `<!doctype html>
<!-- Generated by scripts/build-site-locales.mjs from docs/locales/${locale.slug}.json. -->
<html lang="${locale.lang}"${dir}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${strings.title}</title>
  <meta name="description" content="${strings.description}">
  <link rel="canonical" href="${url}">
${alternates}
  <link rel="icon" type="image/svg+xml" href="../assets/glove.svg">
  <link rel="stylesheet" href="../assets/site.css?v=${cssVersion}">
  <meta name="theme-color" content="#f8faff">
  <meta property="og:site_name" content="Glove">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${strings.title}">
  <meta property="og:description" content="${strings.description}">
  <meta property="og:url" content="${url}">
  <meta property="og:locale" content="${locale.og}">
  <meta property="og:image" content="${socialImage}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${strings.artworkAlt}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${strings.title}">
  <meta name="twitter:description" content="${strings.description}">
  <meta name="twitter:image" content="${socialImage}">
  <meta name="twitter:image:alt" content="${strings.artworkAlt}">
  <script type="application/ld+json">${structuredData}</script>
</head>
<body class="home-page localized-home">
  <a class="skip" href="#main">${locale.skip}</a>
  <header class="site-head">
    <div class="shell head-inner">
      <a class="brand" href="./" aria-current="page"><img src="../assets/glove.svg" width="34" height="34" alt="">Glove</a>
${picker({ current: locale.lang, label: locale.languageMenu, prefix: '../' })}
      <nav class="nav">
        <a href="#features">${escape(locale.nav[0])}</a>
        <a href="#getting-started">${escape(locale.nav[1])}</a>
        <a class="github" href="${repository}" hreflang="en">GitHub</a>
      </nav>
    </div>
  </header>
  <main id="main">
    <section class="hero" aria-labelledby="hero-title">
      <div class="shell hero-inner">
        <div class="hero-copy">
          <h1 id="hero-title">${strings.heroTitle}</h1>
          <p class="lead">${strings.heroBody}</p>
          <div class="actions">
            <a class="button" href="#getting-started">${strings.setupAction}</a>
            <a class="button secondary" href="../demos/" hreflang="en">${strings.demosAction} <span class="english-tag" dir="ltr" lang="en">(English)</span></a>
          </div>
          <p class="hero-note">${strings.preview}</p>
        </div>
        <figure class="hero-window" aria-label="${strings.screenshotTitle}">
          <img class="hero-window-image" src="../assets/glove-app.webp" width="1281" height="881" alt="${strings.screenshotAlt}" fetchpriority="high">
        </figure>
      </div>
    </section>
    <section class="section shell" id="features" aria-labelledby="features-title">
      <div class="section-heading"><h2 id="features-title">${strings.featuresTitle}</h2></div>
      <div class="feature-grid">
        <article class="feature"><h3>${strings.filesTitle}</h3><p>${strings.filesBody}</p></article>
        <article class="feature"><h3>${strings.notificationsTitle}</h3><p>${strings.notificationsBody}</p></article>
        <article class="feature"><h3>${strings.developerTitle}</h3><p>${strings.developerBody}</p></article>
      </div>
    </section>
    <section class="section section-tinted" id="getting-started" aria-labelledby="setup-title">
      <div class="shell localized-setup-grid">
        <div class="localized-prose">
          <h2 id="setup-title">${strings.setupTitle}</h2>
          <p class="lead">${strings.setupBody}</p>
          <ol class="localized-steps">
${locale.setupSteps.map(step => `          <li>${escape(step)}</li>`).join('\n')}
          </ol>
          <a class="text-link" href="../setup/#windows" hreflang="en" aria-describedby="english-guides">${strings.docsAction}</a>
          <p class="quiet" id="english-guides">${strings.englishNotice}</p>
        </div>
        <pre class="setup-commands" dir="ltr" tabindex="0" aria-label="PowerShell"><code>${windowsCommands}</code></pre>
      </div>
    </section>
    <section class="section night" aria-labelledby="status-title">
      <div class="shell release-grid">
        <div class="localized-prose">
          <h2 id="status-title">${strings.statusTitle}</h2>
          <p class="lead">${strings.statusBody}</p>
          <div class="actions"><a class="button" href="${repository}" hreflang="en">${strings.sourceAction}</a></div>
        </div>
        <figure class="product-art">
          <img src="../assets/glove-product.webp" width="1600" height="800" alt="${strings.artworkAlt}" loading="lazy" decoding="async">
        </figure>
      </div>
    </section>
  </main>
  <footer class="site-footer">
    <div class="shell foot-inner">
      <div class="foot-name">
        <a class="brand" href="./"><img src="../assets/glove.svg" width="34" height="34" alt="">Glove</a>
        <p>${strings.footer}</p>
      </div>
      <nav class="foot-links">
        <a href="${repository}/blob/main/LICENSE" hreflang="en">MIT</a>
      </nav>
    </div>
  </footer>
</body>
</html>
`;
}

function replaceRegion(source, name, markup) {
  const region = new RegExp(`(<!-- BEGIN ${name} -->)\\n[\\s\\S]*?( *<!-- END ${name} -->)`);
  if (!region.test(source)) throw new Error(`Missing ${name} markers in English page.`);
  return source.replace(region, (_match, start, end) => `${start}\n${markup}\n${end}`);
}

function sitemap() {
  const entries = all.map(locale => {
    const links = urls.map(({ lang, href }) => `    <xhtml:link rel="alternate" hreflang="${lang}" href="${href}"/>`);
    return ['  <url>', `    <loc>${base + route(locale)}</loc>`, ...links, '  </url>'].join('\n');
  });
  entries.push(...guides.map(guide => `  <url><loc>${base}${guide}/</loc></url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by scripts/build-site-locales.mjs. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join('\n')}
</urlset>
`;
}

async function readSite(relative) {
  return readFile(join(docs, relative), 'utf8').then(contents => contents.replaceAll('\r\n', '\n'));
}

function withCurrentStyles(source) {
  return source.replace(/href="((?:\.\.\/)?assets\/site\.css)(?:\?v=[a-f0-9]+)?"/, (_match, path) => `href="${path}?v=${cssVersion}"`);
}

const home = replaceRegion(withCurrentStyles(await readSite('index.html')), 'GLOVE ALTERNATES', alternates);
const files = [['index.html', replaceRegion(home, 'GLOVE LANGUAGES', picker({ current: english.lang, label: english.languageMenu, prefix: './' }))]];
for (const guide of guides) {
  const path = `${guide}/index.html`;
  files.push([path, replaceRegion(withCurrentStyles(await readSite(path)), 'GLOVE LANGUAGES', picker({ label: english.languageMenu, prefix: '../' }))]);
}
for (const locale of locales) files.push([`${locale.slug}/index.html`, localizedPage(locale)]);
files.push(['sitemap.xml', sitemap()]);

const drift = [];
for (const [relative, contents] of files) {
  const path = join(docs, relative);
  const current = await readSite(relative).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (current === contents) continue;
  if (check) {
    drift.push(relative);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  }
}
if (drift.length) {
  console.error(`Regenerate these files with node scripts/build-site-locales.mjs: ${drift.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`${check ? 'Checked' : 'Generated'} ${locales.length} localized Glove pages and their language navigation.`);
}
