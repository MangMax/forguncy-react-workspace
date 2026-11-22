/**
 * A Cell with no stylesheet and no asset — the control for #98's "no installer for a style-free
 * artifact" assertion.
 *
 * Deliberately in the same directory as the style-carrying fixture so the two differ in exactly
 * one thing: what the Cell imports.
 */
export function App() {
  return "no resources";
}
