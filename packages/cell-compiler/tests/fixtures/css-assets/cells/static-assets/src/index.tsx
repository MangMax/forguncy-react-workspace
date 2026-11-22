/**
 * The v1 resource fixture: one Cell that uses every supported kind in one place.
 *
 * Decision source: GitHub Issue #98
 * (https://github.com/MangMax/forguncy-react-workspace/issues/98).
 *
 * Both consumers point at this directory — `cell-compiler`'s compile tests and `dev-harness`'s
 * Vite tests — because the issue's acceptance criterion is that *the same* source behaves the
 * same way in both, and two fixtures that happen to look alike would not establish that.
 *
 * The assets are deliberately tiny: the point is that they exist as real files with real bytes,
 * not that they are pretty. A generated placeholder would also hide the one defect a fake cannot
 * reproduce — that a base64 URI decodes to exactly these bytes.
 */
import "./panel.css";
import pixelUrl from "./pixel.png";

export const PIXEL_URL = pixelUrl;

export function App() {
  return (
    <section className="css-assets-probe">
      <img alt="pixel" src={pixelUrl} width={1} height={1} />
    </section>
  );
}
