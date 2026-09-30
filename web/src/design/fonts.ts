// The Night Market typeface, SELF-HOSTED from the @fontsource-variable/inter package (Inter, SIL Open
// Font License 1.1; the licence text ships with the site under licenses/inter-OFL-1.1.txt). AA 00047
// P8.1 (questions Q20): one variable face (weights 100–900) with real tabular figures replaces the
// MN Bank pair (Libre Caslon Text + Source Sans 3).
//
// Why not a font CDN: a request to a third-party font host hands every visitor's IP address to that
// host before they have done anything (a German court found exactly that to breach the GDPR, LG
// München I, 3 O 17493/20, January 2022). The market tells customers its servers keep nothing about
// them, so the page must not leak them to anyone else either. Self-hosting also keeps the site
// working under a strict CSP, offline, and in the browser tests, which refuse every request that
// leaves the page's own origin.
//
// The CSS declares one face per Unicode subset with its `unicode-range`: the browser downloads only
// the subsets the page's text uses (Latin, for the English UI). font-display: swap, so text shows
// at once in the fallback and never waits for the font.
import '@fontsource-variable/inter/wght.css';
