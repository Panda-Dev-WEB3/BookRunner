import { AbsoluteFill, Composition, Img, staticFile } from "remotion";
import { FONT } from "./fonts";
import { C, FORMATS, FPS, type Format } from "./theme";

// Temporary proof-of-pipeline scene; replaced by the real Overview in a later task.
const Hello: React.FC = () => (
  <AbsoluteFill
    style={{ background: C.bg, alignItems: "center", justifyContent: "center", gap: 48, color: C.cream }}
  >
    <Img src={staticFile("logo.png")} style={{ width: 360 }} />
    <div style={{ fontFamily: FONT.serif, fontSize: 96, fontWeight: 600 }}>Run the book.</div>
  </AbsoluteFill>
);

export const RemotionRoot: React.FC = () => (
  <>
    {(Object.keys(FORMATS) as Format[]).map((f) => (
      <Composition
        key={f}
        id={FORMATS[f].id}
        component={Hello}
        durationInFrames={FPS * 5}
        fps={FPS}
        width={FORMATS[f].width}
        height={FORMATS[f].height}
      />
    ))}
  </>
);
