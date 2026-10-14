import { Series, useCurrentFrame } from "remotion";
import type { SceneId } from "./copy";
import type { Format } from "./theme";
import { SCENES } from "./timeline";
import { Stage } from "./ui/Stage";
import { Headline } from "./ui/Text";
import { fadeInOut } from "./ui/motion";
import { Book } from "./scenes/Book";
import { Charter } from "./scenes/Charter";
import { Mandate } from "./scenes/Mandate";
import { Hook } from "./scenes/Hook";
import { Problem } from "./scenes/Problem";
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
  proof: stub("proof"),
  live: stub("live"),
  next: stub("next"),
};

/** Sequence-local fade of the scene content; the Stage background stays put across scene changes. */
const Faded: React.FC<{ duration: number; children: React.ReactNode }> = ({ duration, children }) => {
  const frame = useCurrentFrame();
  return <div style={{ position: "relative", width: "100%", height: "100%", opacity: fadeInOut(frame, duration) }}>{children}</div>;
};

export const Overview: React.FC<{ format: Format }> = ({ format }) => (
  <Series>
    {SCENES.map(({ id, frames }) => {
      const Scene = SCENE_COMPONENTS[id];
      return (
        <Series.Sequence key={id} durationInFrames={frames} name={id}>
          <Stage format={format}>
            <Faded duration={frames}>
              <Scene format={format} />
            </Faded>
          </Stage>
        </Series.Sequence>
      );
    })}
  </Series>
);
