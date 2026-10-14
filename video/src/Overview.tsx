import { Series, useCurrentFrame } from "remotion";
import type { SceneId } from "./copy";
import type { Format } from "./theme";
import { SCENES } from "./timeline";
import { Stage } from "./ui/Stage";
import { Headline } from "./ui/Text";
import { fadeInOut, ramp } from "./ui/motion";
import { Book } from "./scenes/Book";
import { Charter } from "./scenes/Charter";
import { Mandate } from "./scenes/Mandate";
import { Next } from "./scenes/Next";
import { Hook } from "./scenes/Hook";
import { Problem } from "./scenes/Problem";
import { Proof } from "./scenes/Proof";
import { Waterfall } from "./scenes/Waterfall";

type SceneProps = { format: Format };

/** Temporary stub: shows the scene id so the timeline is visible end to end. Replaced scene by scene. */
const stub =
  (id: SceneId): React.FC<SceneProps> =>
  ({ format }) => <Headline format={format}>{id}</Headline>;

const SCENE_COMPONENTS: Record<SceneId, React.FC<SceneProps>> = {
  hook: Hook,
  problem: Problem,
  book: Book,
  charter: Charter,
  mandate: Mandate,
  waterfall: Waterfall,
  proof: Proof,
  live: stub("live"),
  next: Next,
};

/**
 * Sequence-local fade of the scene content; the Stage background stays put across scene changes. The closing scene
 * fades in only, so its CTA and disclaimer hold to the last frame.
 */
const Faded: React.FC<{ duration: number; fadeOut: boolean; children: React.ReactNode }> = ({ duration, fadeOut, children }) => {
  const frame = useCurrentFrame();
  const opacity = fadeOut ? fadeInOut(frame, duration) : ramp(frame, 0, 15);
  return <div style={{ position: "relative", width: "100%", height: "100%", opacity }}>{children}</div>;
};

export const Overview: React.FC<{ format: Format }> = ({ format }) => (
  <Series>
    {SCENES.map(({ id, frames }, i) => {
      const Scene = SCENE_COMPONENTS[id];
      return (
        <Series.Sequence key={id} durationInFrames={frames} name={id}>
          <Stage format={format}>
            <Faded duration={frames} fadeOut={i < SCENES.length - 1}>
              <Scene format={format} />
            </Faded>
          </Stage>
        </Series.Sequence>
      );
    })}
  </Series>
);
