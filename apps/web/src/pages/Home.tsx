// Home (/): explains Bookrunner to a newcomer in under two minutes and invites them to connect a
// wallet. Hero + live strip, how it works in five steps, the launch books, roles, safety, the setup
// checklist and the FAQ. Every figure is live from the API or the chain; nothing is projected.
import { Faq } from "../components/home/Faq";
import { Hero } from "../components/home/Hero";
import { HowItWorks } from "../components/home/HowItWorks";
import { LaunchBooks } from "../components/home/LaunchBooks";
import { Roles } from "../components/home/Roles";
import { Safety } from "../components/home/Safety";
import { StartSteps } from "../components/home/StartSteps";

export function HomePage() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <LaunchBooks />
      <Roles />
      <Safety />
      <StartSteps />
      <Faq />
    </>
  );
}
