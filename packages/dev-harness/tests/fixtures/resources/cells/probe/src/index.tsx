/**
 * The dev-harness half of #98's shared fixture: the same shape of source the compiler compiles,
 * so "local and compiled behave the same" is a fact about one source rather than two examples.
 */
import "./panel.css";
import pixelUrl from "./pixel.png";

export const PIXEL_URL = pixelUrl;

export function App() {
  return (
    <section className="dev-resource-probe">
      <img alt="pixel" src={pixelUrl} width={1} height={1} />
    </section>
  );
}
