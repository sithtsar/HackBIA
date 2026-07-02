// ponytail: throwaway visual-verification script, not shipped
import { chromium } from "playwright";

const OUT = process.env.SHOT_DIR ?? ".";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE-ERR:", m.text());
});

// SSE keeps the connection open forever — networkidle never fires
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/1-initial.png` });

const res = await page.evaluate(() =>
  fetch("/api/replay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speed: 2 }),
  }).then((r) => r.status),
);
console.log("replay status:", res);
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/2-midreplay.png` });
await page.waitForTimeout(8000);
await page.screenshot({ path: `${OUT}/3-final.png` });
await browser.close();
console.log("DONE");
