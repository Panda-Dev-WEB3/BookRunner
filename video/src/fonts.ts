import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { continueRender, delayRender, staticFile } from "remotion";
const { fontFamily: inter } = loadInter("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });
const handle = delayRender("serif font");
new FontFace("SourceSerif4", `url(${staticFile("fonts/source-serif-4.woff2")}) format("woff2")`, { weight: "200 900" })
  .load().then((f) => { document.fonts.add(f); continueRender(handle); });
export const FONT = { serif: "SourceSerif4, 'Times New Roman', serif", sans: `${inter}, Arial, sans-serif` };
