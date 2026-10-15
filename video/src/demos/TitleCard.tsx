import { AbsoluteFill, useCurrentFrame } from "remotion";
import { DEMO_CARDS } from "../demo-copy";
import { C } from "../theme";
import { LogoDisc } from "../ui/LogoDisc";
import { Stage } from "../ui/Stage";
import { Body, Headline, Label } from "../ui/Text";
import { ramp, rise } from "../ui/motion";

/** Stage pads its children; positioned content is laid out inside that safe box. */
const box = { position: "relative", width: "100%", height: "100%" } as const;
const column = { alignItems: "center", justifyContent: "center", flexDirection: "column", textAlign: "center" } as const;

/** Opening card (3 s): logo, network label, the clip's title and subtitle, rising in on the overview's Stage. */
export const TitleCard: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  return (
    <Stage format="landscape">
      <div style={box}>
        <AbsoluteFill style={{ ...column, gap: 30 }}>
          <LogoDisc size={128} style={{ opacity: ramp(frame, 0, 12) }} />
          <Label format="landscape" size={24} style={rise(frame, 2)}>
            {DEMO_CARDS.network}
          </Label>
          <Headline format="landscape" size={92} style={{ maxWidth: 1500, textWrap: "balance", ...rise(frame, 6) }}>
            {title}
          </Headline>
          <Body format="landscape" size={38} style={{ maxWidth: 1300, color: C.light, textWrap: "balance", ...rise(frame, 12) }}>
            {subtitle}
          </Body>
        </AbsoluteFill>
      </div>
    </Stage>
  );
};

/** Closing card (3 s): logo, site, X handle and the testnet disclaimer. */
export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Stage format="landscape">
      <div style={box}>
        <AbsoluteFill style={{ ...column, gap: 26, paddingBottom: 60 }}>
          <LogoDisc size={210} style={{ opacity: ramp(frame, 0, 14), transform: `scale(${0.92 + 0.08 * ramp(frame, 0, 20)})` }} />
          <Headline format="landscape" size={76} style={rise(frame, 6)}>
            {DEMO_CARDS.url}
          </Headline>
          <Label format="landscape" size={30} style={{ letterSpacing: "0.06em", textTransform: "none", ...rise(frame, 12) }}>
            {DEMO_CARDS.x}
          </Label>
        </AbsoluteFill>
        <Body
          format="landscape"
          size={30}
          style={{ position: "absolute", left: 0, right: 0, bottom: 0, color: C.light, textAlign: "center", opacity: ramp(frame, 18, 32) }}
        >
          {DEMO_CARDS.disclaimer}
        </Body>
      </div>
    </Stage>
  );
};
