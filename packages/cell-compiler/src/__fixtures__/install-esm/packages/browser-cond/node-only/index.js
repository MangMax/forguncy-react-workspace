import { readFileSync } from "node:fs";

export function whichBranch() {
  return "node-only-branch";
}

export function readTheFilesystem() {
  return readFileSync;
}
