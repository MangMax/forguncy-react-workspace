/**
 * The provider port's channel vocabulary, as a leaf module.
 *
 * Decision source: GitHub Issue #27 — "Spec: typed Forguncy runtime facade for
 * application-owned capabilities"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/27), declared in `contract.ts` and
 * kept here by #124.
 *
 * ## Why this is not in `contract.ts`
 *
 * `contract.ts` declares the port and also the boundary checks that read the capability registry
 * — `assertRuntimeFacadePortCoversAdmittedCapabilities()` and friends import `capabilities.ts`,
 * which is a large evidence table. `host-provider.ts` needs exactly three values from the port:
 * the channel list, the member map and the one hook name. Importing them from `contract.ts` put
 * the registry in the module graph of every production Cell. Moving them to this leaf is what
 * lets `cell.ts` bind the slim runtime without the registry; `contract.ts` imports and re-exports
 * them unchanged, so the root entry is still the one place a reader finds them.
 */

import type { RuntimeFacadeHostBindings } from "./contract.ts";

/** The channels the port provides. */
export const RUNTIME_FACADE_PORT_CHANNELS = ["cell-props", "use-data-source"] as const;

export type RuntimeFacadePortChannel = (typeof RUNTIME_FACADE_PORT_CHANNELS)[number];

/**
 * Which member of `RuntimeFacadeHostBindings` carries each channel.
 *
 * The `satisfies` is the load-bearing part: it makes the map exhaustive over the channel union
 * **and** forces every value to be an actual member name, so the channel definition and the port
 * shape are bound at the type level rather than being two lists a reviewer has to compare by eye.
 */
export const RUNTIME_FACADE_PORT_CHANNEL_MEMBERS = {
  "cell-props": "cellProps",
  "use-data-source": "useDataSource",
} as const satisfies Readonly<Record<RuntimeFacadePortChannel, keyof RuntimeFacadeHostBindings>>;

/** The one wrapper-local hook the port carries, by its confirmed name. */
export const RUNTIME_FACADE_PORT_HOOK_NAME = "useDataSource";
