import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useCurrentFrame, type CalculateMetadataFunction } from "remotion";
import { DEMO_COPY } from "../demo-copy";
import { C } from "../theme";
import { ramp } from "../ui/motion";
import { Caption } from "./Caption";
import { DEMO_CLIPS, DEMO_TIMING, planDemo, type DemoClip, type DemoPlan, type StepLog } from "./segments";
import { EndCard, TitleCard } from "./TitleCard";

/** `plan` is filled in by `calculateDemoMetadata` from the clip's step log (public/demos/<name>.steps.json). */
export type DemoProps = { clip: DemoClip["n"]; plan: DemoPlan | null };

export function demoClip(n: number): DemoClip {
  const c = DEMO_CLIPS.find((x) => x.n === n);
  if (!c) throw new Error(`no demo clip ${n}`);
  return c;
}

export const calculateDemoMetadata: CalculateMetadataFunction<DemoProps> = async ({ props }) => {
  const clip = demoClip(props.clip);
  const res = await fetch(staticFile(`demos/${clip.name}.steps.json`));
  if (!res.ok) throw new Error(`demos/${clip.name}.steps.json: HTTP ${res.status} (record the clip first: video/README.md)`);
  const plan = planDemo((await res.json()) as StepLog, Object.keys(DEMO_COPY[clip.id].steps), clip.lead);
  return { durationInFrames: plan.totalFrames, props: { ...props, plan } };
};

const Fade: React.FC<{ mode: "in" | "out"; at: number; children: React.ReactNode }> = ({ mode, at, children }) => {
  const frame = useCurrentFrame();
  const x = DEMO_TIMING.xfadeFrames;
  const opacity = mode === "in" ? ramp(frame, 0, x) : 1 - ramp(frame, at - x, at);
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

/**
 * A product demo clip: title card -> the recording (one OffthreadVideo per speed segment) with a lower-third caption
 * per step -> end card. The cards cross-fade over the recording.
 */
export const Demo: React.FC<DemoProps> = ({ clip: n, plan }) => {
  if (!plan) throw new Error("Demo: missing plan (calculateDemoMetadata did not run)");
  const clip = demoClip(n);
  const copy = DEMO_COPY[clip.id];
  const src = staticFile(`demos/${clip.name}.webm`);
  const T = DEMO_TIMING;
  return (
    <AbsoluteFill style={{ background: C.deep }}>
      <Sequence from={plan.videoFrom} durationInFrames={plan.videoFrames} name="recording">
        {plan.segments
          .filter((s) => s.frames > 0)
          .map((s) => (
            <Sequence key={s.from} from={s.from} durationInFrames={s.frames} name={`x${s.rate} @${(s.srcStartMs / 1000).toFixed(1)}s`}>
              <OffthreadVideo src={src} trimBefore={s.trimBefore} playbackRate={s.rate} muted />
            </Sequence>
          ))}
      </Sequence>
      {plan.captions.map((cue) => (
        <Sequence key={cue.key} from={cue.from} durationInFrames={cue.to - cue.from} name={`caption ${cue.key}`}>
          <Caption text={copy.steps[cue.key]} index={cue.index} count={plan.captions.length} frames={cue.to - cue.from} />
        </Sequence>
      ))}
      <Sequence durationInFrames={T.titleFrames} name="title">
        <Fade mode="out" at={T.titleFrames}>
          <TitleCard title={copy.title} subtitle={copy.subtitle} />
        </Fade>
      </Sequence>
      <Sequence from={plan.endFrom} name="end">
        <Fade mode="in" at={0}>
          <EndCard />
        </Fade>
      </Sequence>
    </AbsoluteFill>
  );
};
