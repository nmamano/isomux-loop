// The page: one HTML document with the stylesheet and the client script inlined.
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./page.css", import.meta.url), "utf8");
const js = readFileSync(new URL("./client.js", import.meta.url), "utf8");

export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loop</title>
<style>
${css}</style>
</head>
<body>
<header>
  <h1>Loop</h1>
  <nav id="tabs"></nav>
</header>
<main id="list"></main>
<script>
${js}</script>
</body>
</html>`;
