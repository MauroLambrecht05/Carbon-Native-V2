import { PageTitle } from "../../components/PageTitle.tsx";
import { Hero } from "./Hero.tsx";
import { Features } from "./Features.tsx";
import { ProductSuite } from "./ProductSuite.tsx";
import { QuickStart } from "./QuickStart.tsx";
import { CloudTeaser } from "./CloudTeaser.tsx";
import { FinalCta } from "./FinalCta.tsx";

export function Home() {
  return (
    <>
      <PageTitle title="Carbon — Native apps, one runtime" />
      <Hero />
      <Features />
      <ProductSuite />
      <QuickStart />
      <CloudTeaser />
      <FinalCta />
    </>
  );
}
