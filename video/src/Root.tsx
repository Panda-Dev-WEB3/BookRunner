import { Composition } from "remotion";
import { Demo, calculateDemoMetadata } from "./demos/Demo";
import { DEMO_CLIPS, DEMO_FPS } from "./demos/segments";
import { Overview } from "./Overview";
import { FORMATS, FPS, type Format } from "./theme";
import { TOTAL_FRAMES } from "./timeline";

export const RemotionRoot: React.FC = () => (
  <>
    {(Object.keys(FORMATS) as Format[]).map((f) => (
      <Composition
        key={f}
        id={FORMATS[f].id}
        component={Overview}
        defaultProps={{ format: f }}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={FORMATS[f].width}
        height={FORMATS[f].height}
      />
    ))}
    {/* Product demos: duration and timing plan come from public/demos/<n>-<id>.steps.json (calculateMetadata). */}
    {DEMO_CLIPS.map((c) => (
      <Composition
        key={c.comp}
        id={c.comp}
        component={Demo}
        defaultProps={{ clip: c.n, plan: null }}
        calculateMetadata={calculateDemoMetadata}
        durationInFrames={1}
        fps={DEMO_FPS}
        width={1920}
        height={1080}
      />
    ))}
  </>
);
