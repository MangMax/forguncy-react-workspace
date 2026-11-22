import { depValue } from "fgc-fixture-transitive-dep";

export function transitive() {
  return `outer+${depValue()}`;
}
