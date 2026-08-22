import type { Messages } from "../messages/index.js";

export function Home(props: { m: Messages; sampleCount: number; personCount: number }) {
  const { m } = props;
  return (
    <>
      <h1>{m.home.heading}</h1>
      <p>{m.home.holdings(props.sampleCount, props.personCount)}</p>
      <p>{m.home.qcTeaser}</p>
    </>
  );
}
