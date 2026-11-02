const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function main() {
  const media = path.resolve(__dirname, "..", "media");
  const browser = await chromium.launch();
  try {
    for (const [name, width, height, scale] of [
      ["icon", 256, 256, 1],
      ["logo", 760, 200, 2],
      ["social", 1280, 640, 1]
    ]) {
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: scale
      });
      const svg = await fs.readFile(path.join(media, `${name}.svg`), "utf8");
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator("svg").count(), 1);
      const overflowingText = await page.locator("svg").evaluate(element => {
        const bounds = element.viewBox.baseVal;
        return [...element.querySelectorAll("text")].some(text => {
          const box = text.getBBox();
          return box.x < 0 || box.y < 0 ||
            box.x + box.width > bounds.width || box.y + box.height > bounds.height;
        });
      });
      assert.equal(overflowingText, false, `${name} text fits the canvas`);
      const output = path.join(media, `${name}.png`);
      await page.screenshot({ path: output, omitBackground: true });
      const png = await fs.readFile(output);
      assert.equal(png.readUInt32BE(16), width * scale);
      assert.equal(png.readUInt32BE(20), height * scale);
      console.log(`${name}.png: ${width * scale} x ${height * scale}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
