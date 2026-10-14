import { Composition } from "remotion";
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
  </>
);
