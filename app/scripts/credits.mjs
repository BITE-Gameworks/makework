// Writes CREDITS.md: the icon sets, fonts and sounds MakeWork ships, then every bundled library, each with its
// license text from node_modules. Shown in Settings > Appearance > Credits. Run from app/ after changing what the
// app bundles:
//   node scripts/credits.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Packages the app imports; what they depend on is found below.
const bundled = [
  "solid-js", "solid-transition-group", "trystero", "yjs", "fflate", "@noble/hashes", "uqr",
  "@sapphi-red/web-noise-suppressor", "lucide-static", "@material-symbols/svg-400", "@phosphor-icons/core",
  "@fontsource-variable/comfortaa", "@fontsource/barlow-condensed", "@fontsource/rajdhani", "d3-geo", "topojson-client",
  "world-atlas", "adblock-rs",
];

const packageDir = (name, from = ".") => {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === dirname(dir)) return null;
  }
};

const found = new Map();
const visit = (name, from) => {
  const dir = packageDir(name, from);
  if (!dir || found.has(dir)) return;
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  found.set(dir, pkg);
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir);
};
bundled.forEach((name) => visit(name, "."));

const licenseText = (dir) => {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  return file ? readFileSync(join(dir, file), "utf8").trim() : null;
};
const fence = (text) => "```text\n" + text.replaceAll("```", "'''") + "\n```";
const soundCredits = readFileSync("src/theme/sounds/CREDITS.md", "utf8").replace(/^# Default sounds\s*/, "");

const sections = [...found.values()]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((pkg) => {
    const dir = [...found].find(([, p]) => p === pkg)[0];
    const text = licenseText(dir);
    const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "see its repository";
    return `### ${pkg.name} ${pkg.version}\n\nLicense: ${license}${text ? `\n\n${fence(text)}` : ""}`;
  });

writeFileSync("CREDITS.md", `# Credits

MakeWork is built with the work of many people. Thank you all.

## Icons

- **Lucide** (the default icons): ISC License, Lucide Icons and Contributors; some icons from Feather, MIT License,
  Cole Bemis. https://lucide.dev
- **Sharp** icon pack: Material Symbols by Google, Apache License 2.0. https://fonts.google.com/icons
- **Phosphor** icon pack: Phosphor Icons, MIT License. https://phosphoricons.com
- **Runic** icon pack: icons from game-icons.net by Lorc, Delapouite and other contributors
  (https://game-icons.net), licensed under CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). Resized and
  recolored for the app.
- Icons found with the icon search in design channels come from Iconify (https://iconify.design); each set keeps
  its own license, shown under the search results.

## Fonts

All under the SIL Open Font License 1.1.

- **Comfortaa**: The Comfortaa Project Authors (https://github.com/alexeiva/comfortaa)
- **Barlow Condensed**: The Barlow Project Authors (https://github.com/jpt/barlow)
- **Rajdhani**: Indian Type Foundry

## Sounds

${soundCredits.trim()}

## Libraries and their licenses

The icon sets and fonts above are among these, with their full license texts.

${sections.join("\n\n")}
`);
console.log(`CREDITS.md: ${found.size} packages`);
