const { chromium } = require('playwright-core');
const path = require('path');

const SC = "/tmp/claude-0/-home-user-robinfun/86abfa8c-b22c-5168-bec6-424d0050a0c1/scratchpad";
const OUT = "/home/user/robinfun/brand/x-thread";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const files = {
  1:"01-cover",2:"02-problem",3:"03-edge",4:"04-fair",5:"05-safety",6:"06-cta"
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args:['--no-sandbox','--disable-gpu'] });
  const page = await browser.newPage({ viewport:{width:1600,height:900}, deviceScaleFactor:2 });
  for (const [i,name] of Object.entries(files)) {
    await page.goto('file://'+path.join(SC,`banner-${i}.html`), { waitUntil:'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const out = path.join(OUT, `robinfun-x-${name}.png`);
    // clip to exactly 1600x900 at 2x → crisp 3200x1800 PNG
    await page.screenshot({ path: out, clip:{x:0,y:0,width:1600,height:900} });
    console.log('shot', out);
  }
  await browser.close();
  console.log('DONE');
})().catch(e=>{ console.error(e); process.exit(1); });
