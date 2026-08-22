import { PageTitle } from "../../components/PageTitle.tsx";
import { CloudHero } from "./CloudHero.tsx";
import { HowItWorks } from "./HowItWorks.tsx";
import { CloudFeatures } from "./CloudFeatures.tsx";
import { Pricing } from "./Pricing.tsx";
import { FinalCta } from "../Home/FinalCta.tsx";

export function Cloud() {
  return (
    <>
      <PageTitle title="Carbon Cloud — Push a repo, get a signed release" />
      <CloudHero />
      <HowItWorks />
      <CloudFeatures />
      <Pricing />
      <FinalCta />
    </>
  );
}
