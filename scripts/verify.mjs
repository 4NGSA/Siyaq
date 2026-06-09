#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = [
  'index.html',
  'styles.css',
  'js/app.js',
  'js/api.js',
  'js/config.js',
];
const sources = new Map();
const results = [];

function lineNumber(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function location(file, source, offset) {
  return `${file}:${lineNumber(source, offset)}`;
}

function getAttribute(attributes, name) {
  const match = attributes.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function addCheck(name, verify) {
  const failures = [];
  const fail = (message) => failures.push(message);

  try {
    verify(fail);
  } catch (error) {
    fail(`Verifier error: ${error.message}`);
  }

  results.push({ name, failures });
}

function readProjectFile(file) {
  try {
    return readFileSync(resolve(projectRoot, file), 'utf8');
  } catch {
    return null;
  }
}

function exactVersionFromUrl(url) {
  const exactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  const candidates = [];

  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    for (const part of pathParts) {
      const atVersion = part.match(/@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
      if (atVersion) candidates.push(atVersion[1]);
      candidates.push(part);
    }

    for (const key of ['v', 'ver', 'version']) {
      const value = parsed.searchParams.get(key);
      if (value) candidates.push(value);
    }
  } catch {
    return false;
  }

  return candidates.some((candidate) => exactSemver.test(candidate));
}

addCheck('Required modular files exist', (fail) => {
  for (const file of requiredFiles) {
    const source = readProjectFile(file);
    if (source === null) {
      fail(`${file}: missing required file. Create it as part of the modularized static entry points.`);
    } else {
      sources.set(file, source);
    }
  }
});

addCheck('index.html contains no inline CSS or JavaScript', (fail) => {
  const file = 'index.html';
  const source = sources.get(file);
  if (source === undefined) return;

  const styleTag = /<style\b[^>]*>/gi.exec(source);
  if (styleTag) {
    fail(
      `${location(file, source, styleTag.index)}: inline <style> found. Move these rules to styles.css and link that stylesheet.`,
    );
  }

  const styleAttribute = /\sstyle\s*=/gi.exec(source);
  if (styleAttribute) {
    fail(
      `${location(file, source, styleAttribute.index)}: inline style attribute found. Replace it with a class defined in styles.css.`,
    );
  }

  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptPattern.exec(source)) !== null) {
    const src = getAttribute(scriptMatch[1], 'src');
    if (!src || scriptMatch[2].trim()) {
      fail(
        `${location(file, source, scriptMatch.index)}: inline script found. Move executable code to js/app.js and load it with a src attribute.`,
      );
      break;
    }
  }
});

addCheck('index.html contains no inline event handlers', (fail) => {
  const file = 'index.html';
  const source = sources.get(file);
  if (source === undefined) return;

  const eventHandler = /\son[a-z][\w:-]*\s*=/gi.exec(source);
  if (eventHandler) {
    fail(
      `${location(file, source, eventHandler.index)}: inline event handler found. Bind the event with addEventListener in js/app.js.`,
    );
  }
});

addCheck('Source files contain no privileged Supabase key', (fail) => {
  const jwtPattern = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

  for (const file of requiredFiles) {
    const source = sources.get(file);
    if (source === undefined) continue;

    const jwt = jwtPattern.exec(source);
    jwtPattern.lastIndex = 0;
    if (!jwt) continue;

    let payload;
    try {
      const base64 = jwt[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    } catch {
      fail(`${location(file, source, jwt.index)}: embedded JWT could not be inspected.`);
      continue;
    }

    if (payload.role !== 'anon') {
      fail(
        `${location(file, source, jwt.index)}: embedded Supabase role "${payload.role || 'unknown'}" is privileged. Browser code may contain only the publishable anon key.`,
      );
    }
  }
});

addCheck('External scripts use exact pinned versions', (fail) => {
  const file = 'index.html';
  const source = sources.get(file);
  if (source === undefined) return;

  const scriptTagPattern = /<script\b([^>]*)>/gi;
  let scriptTag;
  while ((scriptTag = scriptTagPattern.exec(source)) !== null) {
    const src = getAttribute(scriptTag[1], 'src');
    if (!src || !/^https?:\/\//i.test(src)) continue;

    if (!exactVersionFromUrl(src)) {
      fail(
        `${location(file, source, scriptTag.index)}: external script "${src}" is not pinned to an exact x.y.z version. Replace floating tags such as @2 or @latest with an exact release.`,
      );
    }
  }

  for (const jsFile of ['js/app.js', 'js/api.js']) {
    const jsSource = sources.get(jsFile);
    if (jsSource === undefined) continue;
    const externalImportPattern = /from\s+(['"])(https?:\/\/[^'"]+)\1/g;
    let externalImport;
    while ((externalImport = externalImportPattern.exec(jsSource)) !== null) {
      if (!exactVersionFromUrl(externalImport[2])) {
        fail(
          `${location(jsFile, jsSource, externalImport.index)}: external import "${externalImport[2]}" is not pinned to an exact x.y.z version.`,
        );
      }
    }
  }
});

addCheck('index.html provides essential RTL and accessibility landmarks', (fail) => {
  const file = 'index.html';
  const source = sources.get(file);
  if (source === undefined) return;

  const htmlTag = source.match(/<html\b([^>]*)>/i);
  const htmlAttributes = htmlTag?.[1] ?? '';
  const language = getAttribute(htmlAttributes, 'lang');
  const direction = getAttribute(htmlAttributes, 'dir');

  if (!language || !/^ar(?:-|$)/i.test(language)) {
    fail(`${file}: set lang="ar" (or an Arabic locale such as ar-SA) on the <html> element.`);
  }
  if (direction?.toLowerCase() !== 'rtl') {
    fail(`${file}: set dir="rtl" on the <html> element.`);
  }
  if (!/<title\b[^>]*>\s*[^<\s][^<]*<\/title\s*>/i.test(source)) {
    fail(`${file}: add a non-empty <title> for assistive technology and browser context.`);
  }
  if (!/<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/i.test(source)) {
    fail(`${file}: add a viewport meta tag for usable mobile scaling.`);
  }

  const mainTags = [...source.matchAll(/<main\b([^>]*)>/gi)];
  if (mainTags.length !== 1) {
    fail(`${file}: include exactly one <main> landmark; found ${mainTags.length}.`);
  }

  const mainId = mainTags.length === 1 ? getAttribute(mainTags[0][1], 'id') : null;
  if (mainTags.length === 1 && !mainId) {
    fail(`${location(file, source, mainTags[0].index)}: give <main> an id so the skip link can target it.`);
  } else if (mainId) {
    const anchors = [...source.matchAll(/<a\b([^>]*)>/gi)];
    const hasSkipLink = anchors.some((anchor) => {
      const href = getAttribute(anchor[1], 'href');
      const className = getAttribute(anchor[1], 'class') ?? '';
      return href === `#${mainId}` && className.split(/\s+/).includes('skip-link');
    });
    if (!hasSkipLink) {
      fail(
        `${file}: add <a class="skip-link" href="#${mainId}">…</a> before navigation so keyboard users can skip to main content.`,
      );
    }
  }

  const navTags = [...source.matchAll(/<nav\b([^>]*)>/gi)];
  if (navTags.length === 0) {
    fail(`${file}: add a <nav> landmark for primary navigation.`);
  } else {
    const unnamedNav = navTags.find((nav) => {
      const label = getAttribute(nav[1], 'aria-label');
      const labelledBy = getAttribute(nav[1], 'aria-labelledby');
      return !label?.trim() && !labelledBy?.trim();
    });
    if (unnamedNav) {
      fail(
        `${location(file, source, unnamedNav.index)}: give each <nav> an accessible name with aria-label or aria-labelledby.`,
      );
    }
  }

  if (!/<h1\b[^>]*>[\s\S]*?<\/h1\s*>/i.test(source)) {
    fail(`${file}: add an <h1> that names the page's primary content.`);
  }
});

addCheck('js/app.js avoids unbounded select("*") queries', (fail) => {
  const file = 'js/app.js';
  const source = sources.get(file);
  if (source === undefined) return;

  const selectAll = /\.select\s*\(\s*(['"`])\s*\*\s*\1\s*\)/g.exec(source);
  if (selectAll) {
    fail(
      `${location(file, source, selectAll.index)}: select('*') found. Request only the columns this view needs.`,
    );
  }
});

addCheck('Static source contains no transition: all', (fail) => {
  const transitionAll = /transition(?:-property)?\s*:\s*all\b/gi;

  for (const file of requiredFiles) {
    const source = sources.get(file);
    if (source === undefined) continue;

    const match = transitionAll.exec(source);
    transitionAll.lastIndex = 0;
    if (match) {
      fail(
        `${location(file, source, match.index)}: "${match[0]}" found. List only the properties that actually animate.`,
      );
    }
  }
});

console.log('Static project verification\n');

let failureCount = 0;
for (const result of results) {
  if (result.failures.length === 0) {
    console.log(`PASS  ${result.name}`);
    continue;
  }

  console.log(`FAIL  ${result.name}`);
  for (const failure of result.failures) {
    failureCount += 1;
    console.log(`      - ${failure}`);
  }
}

console.log(
  `\n${failureCount === 0 ? 'PASS' : 'FAIL'}: ${results.length} checks, ${failureCount} failure${failureCount === 1 ? '' : 's'}.`,
);

process.exitCode = failureCount === 0 ? 0 : 1;
