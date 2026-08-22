export function Home(props: { sampleCount: number; personCount: number }) {
  return (
    <>
      <h1>Beeline</h1>
      <p>
        Holding {props.sampleCount.toLocaleString("en")} samples from {props.personCount.toLocaleString("en")} people.
      </p>
      <p>The self-service QC experience lands here (beeline-2c3.6).</p>
    </>
  );
}
