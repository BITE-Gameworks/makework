// Draws an SVG into a square PNG with Electron's renderer: electron scripts/icon.cjs <in.svg> <out.png> <size>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");

const [svgPath, outPath, sizeText] = process.argv.slice(-3);
const size = Number(sizeText);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const svg = Buffer.from(fs.readFileSync(svgPath)).toString("base64");
  const html = `<body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${svg}" style="width:${size}px;height:${size}px;display:block"></body>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await win.webContents.executeJavaScript("document.images[0].decode()");
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  fs.writeFileSync(outPath, image.resize({ width: size, height: size }).toPNG());
  app.quit();
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
